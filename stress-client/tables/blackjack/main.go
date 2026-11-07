package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jungle-gaming/wagering-clients/core"
)

const (
	gameID     = "blackjack"
	providerID = "provider-blackjack"
)

func main() {
	var (
		baseURLs    string
		sqsEndpoint string
		sqsQueue    string
		players     int
		rounds      int
		minBet      string
		maxBet      string
		winRate     float64
		refundRate  float64
		outOfOrder  float64
		roundDur    int
		channel     string
		duration    int
		report      string
		verbose     bool
	)

	flag.StringVar(&baseURLs, "base", "http://localhost:3000", "Comma-separated backend base URLs")
	flag.StringVar(&sqsEndpoint, "sqs", "http://localhost:4566", "SQS endpoint")
	flag.StringVar(&sqsQueue, "sqs-queue", "wager-transactions.fifo", "SQS FIFO queue name")
	flag.IntVar(&players, "players", 7, "Players per round")
	flag.IntVar(&rounds, "rounds", 50, "Number of rounds")
	flag.StringVar(&minBet, "min-bet", "10.00", "Minimum bet amount")
	flag.StringVar(&maxBet, "max-bet", "500.00", "Maximum bet amount")
	flag.Float64Var(&winRate, "win-rate", 0.42, "Probability of WIN (0.0-1.0)")
	flag.Float64Var(&refundRate, "refund-rate", 0.03, "Probability of REFUND (0.0-1.0)")
	flag.Float64Var(&outOfOrder, "out-of-order", 0.3, "Probability of sending REFUND before BET (0.0-1.0)")
	flag.IntVar(&roundDur, "round-duration", 5000, "Round duration in milliseconds")
	flag.StringVar(&channel, "channel", "sqs", "Channel: http, sqs, or mixed")
	flag.IntVar(&duration, "duration", 0, "Max duration in seconds")
	flag.StringVar(&report, "report", "", "Path to write JSON report")
	flag.BoolVar(&verbose, "verbose", false, "Verbose logging")
	flag.Parse()

	cfg := &core.Config{
		BaseURLs:    core.ParseBaseURLs(baseURLs),
		SQSEndpoint: sqsEndpoint,
		SQSQueue:    sqsQueue,
		Duration:    time.Duration(duration) * time.Second,
		ReportPath:  report,
		Verbose:     verbose,
		AuthToken:   os.Getenv("AUTH_TOKEN"),
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Println("shutdown signal received")
		cancel()
	}()

	coreInst, err := core.NewCore(ctx, cfg, core.WithSQS())
	if err != nil {
		log.Fatalf("failed to initialize core: %v", err)
	}

	minMoney, err := core.NewMoney(minBet, "BRL")
	if err != nil {
		log.Fatalf("invalid min-bet: %v", err)
	}
	maxMoney, err := core.NewMoney(maxBet, "BRL")
	if err != nil {
		log.Fatalf("invalid max-bet: %v", err)
	}

	tableCfg := &core.TableConfig{
		GameID:          gameID,
		ProviderID:      providerID,
		MinBetCents:     minMoney.Cents,
		MaxBetCents:     maxMoney.Cents,
		PlayersPerRound: players,
		Rounds:          rounds,
		RoundDuration:   time.Duration(roundDur) * time.Millisecond,
		WinRate:         winRate,
		WinMult:         1, // EV = 0.42 * 1 = 0.42 → house edge 58% (payout = stake)
		RefundRate:      refundRate,
		OutOfOrderRate:  outOfOrder,
		Channel:         channel,
	}

	table := NewBlackjack(tableCfg)
	result, err := table.Run(ctx, coreInst)
	if err != nil {
		log.Fatalf("table run failed: %v", err)
	}

	log.Println("running reconciliation...")
	issues := coreInst.ReconcileAll(ctx, table.Wallets())
	if len(issues) > 0 {
		log.Printf("RECONCILIATION ISSUES (%d):", len(issues))
		for _, issue := range issues {
			log.Printf("  %s", issue)
		}
	} else {
		log.Println("reconciliation: all wallets consistent")
	}

	invariants := core.CheckInvariants(ctx, coreInst, table.Wallets())
	for _, inv := range invariants {
		status := "PASS"
		if !inv.Passed {
			status = "FAIL"
		}
		log.Printf("invariant %-30s %s %s", inv.Name, status, inv.Message)
	}

	if report != "" {
		if err := core.WriteReport(report, result, invariants); err != nil {
			log.Printf("warning: failed to write report: %v", err)
		}
	}

	log.Printf("blackjack done: %d rounds, %d bets, %d wins, %d losses, %d refunds, %d rollbacks, %d rejections",
		result.RoundsCompleted, result.TotalBets, result.TotalWins, result.TotalLosses,
		result.TotalRefunds, result.TotalRollbacks, result.TotalRejections)
}
