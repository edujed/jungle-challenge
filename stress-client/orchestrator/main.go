package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jungle-gaming/wagering-clients/core"
	"github.com/jungle-gaming/wagering-clients/orchestrator/tables"
)

// TableSpec describes a table to run in the orchestrator.
type TableSpec struct {
	Name            string
	ProviderID      string
	MinBetCents     int64
	MaxBetCents     int64
	PlayersPerRound int
	Rounds          int
	RoundDuration   time.Duration
	WinRate         float64
	WinMult         int64
	RefundRate      float64
	OutOfOrderRate  float64
	Channel         string
	HotWallet       bool
	Instances       int
	Build           func(*core.TableConfig) core.Table
}

// jitterInt applies a random ±7% variation to a base value (stress load).
func jitterInt(base int) int {
	j := 1.0 + (rand.Float64()*2-1)*0.11
	return int(float64(base) * j)
}

func defaultSpecs() []TableSpec {
	return []TableSpec{
		{
			Name:            "fortune-chimp",
			ProviderID:      "provider-fortune-chimp",
			MinBetCents:     100,
			MaxBetCents:     1000, // R$ 10.00 max to avoid exhausting balance
			PlayersPerRound: jitterInt(1000),
			Rounds:          50,
			RoundDuration:   0, // no sleep — max throughput
			WinRate:         0.08,
			WinMult:         2, // EV = 0.08 * 2 = 0.16 → house edge 84%
			Channel:         "http",
			Instances:       10,
			Build:           func(cfg *core.TableConfig) core.Table { return tables.NewFortuneChimp(cfg) },
		},
		{
			Name:            "fortune-chimp-v2",
			ProviderID:      "provider-fortune-chimp-v2",
			MinBetCents:     100,
			MaxBetCents:     1000, // R$ 10.00 max to avoid exhausting balance
			PlayersPerRound: jitterInt(1000),
			Rounds:          50,
			RoundDuration:   0, // no sleep — max throughput
			WinRate:         0.10,
			WinMult:         2, // EV = 0.10 * 2 = 0.20 → house edge 80%
			Channel:         "sqs",
			Instances:       10,
			Build:           func(cfg *core.TableConfig) core.Table { return tables.NewFortuneChimpV2(cfg) },
		},
		{
			Name:            "blackjack",
			ProviderID:      "provider-blackjack",
			MinBetCents:     500,
			MaxBetCents:     5000,
			PlayersPerRound: jitterInt(1000),
			Rounds:          50,
			RoundDuration:   0, // no sleep — max throughput
			WinRate:         0.45,
			WinMult:         1, // EV = 0.45 * 1 = 0.45 → house edge 55% (payout = stake)
			RefundRate:      0.02,
			OutOfOrderRate:  0.30,
			Channel:         "sqs",
			Instances:       10,
			Build:           func(cfg *core.TableConfig) core.Table { return tables.NewBlackjack(cfg) },
		},
		{
			Name:            "roulette",
			ProviderID:      "provider-roulette",
			MinBetCents:     500,
			MaxBetCents:     20000,
			PlayersPerRound: jitterInt(1000),
			Rounds:          100,
			RoundDuration:   0, // no sleep — max throughput
			WinRate:         0.25,
			WinMult:         3, // EV = 0.25 * 3 = 0.75 → house edge 25%
			RefundRate:      0.02,
			OutOfOrderRate:  0.20,
			Channel:         "mixed",
			Instances:       10,
			Build:           func(cfg *core.TableConfig) core.Table { return tables.NewRoulette(cfg) },
		},
		{
			Name:            "crash",
			ProviderID:      "provider-crash",
			MinBetCents:     50,
			MaxBetCents:     5000, // R$ 50.00 max to avoid exhausting balance
			PlayersPerRound: jitterInt(1000),
			Rounds:          100,
			RoundDuration:   0, // no sleep — max throughput
			WinRate:         0.50,
			WinMult:         1, // EV = 0.50 * 1 = 0.50 → house edge 50% (payout = stake)
			RefundRate:      0.01,
			OutOfOrderRate:  0.10,
			Channel:         "sqs",
			Instances:       10,
			Build:           func(cfg *core.TableConfig) core.Table { return tables.NewCrash(cfg) },
		},
	}
}

func main() {
	var (
		baseURLs    string
		sqsEndpoint string
		sqsQueue    string
		duration    int
		tablesFlag  string
		report      string
		verbose     bool
		logFile     string
		logLevel    string
		token       string
	)

	flag.StringVar(&baseURLs, "base", "http://localhost:8080", "Comma-separated backend base URLs (default: NGINX LB)")
	flag.StringVar(&sqsEndpoint, "sqs", "http://localhost:4566", "SQS endpoint")
	flag.StringVar(&sqsQueue, "sqs-queue", "wager-transactions.fifo", "SQS FIFO queue name")
	flag.IntVar(&duration, "duration", 120, "Max duration in seconds")
	flag.StringVar(&tablesFlag, "tables", "all", "Tables to run (comma-separated, or 'all')")
	flag.StringVar(&report, "report", "", "Path to write JSON report")
	flag.BoolVar(&verbose, "verbose", false, "Verbose logging")
	flag.StringVar(&logFile, "log-file", "", "Path to write log file (empty = stdout only)")
	flag.StringVar(&logLevel, "log-level", "info", "Log level: debug, info, warn, error")
	flag.StringVar(&token, "token", os.Getenv("AUTH_TOKEN"), "Bearer token for API auth (default: $AUTH_TOKEN or dev token)")
	flag.Parse()

	// Parse log level
	var level core.LogLevel
	switch logLevel {
	case "debug":
		level = core.LogDebug
	case "info":
		level = core.LogInfo
	case "warn":
		level = core.LogWarn
	case "error":
		level = core.LogError
	default:
		log.Fatalf("invalid log level: %s (use debug, info, warn, error)", logLevel)
	}

	// Create logger
	logger, err := core.NewLogger(logFile, level)
	if err != nil {
		log.Fatalf("failed to create logger: %v", err)
	}
	defer logger.Close()

	cfg := &core.Config{
		BaseURLs:    core.ParseBaseURLs(baseURLs),
		SQSEndpoint: sqsEndpoint,
		SQSQueue:    sqsQueue,
		Duration:    time.Duration(duration) * time.Second,
		ReportPath:  report,
		LogFile:     logFile,
		LogLevel:    level,
		Verbose:     verbose,
		AuthToken:   token,
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

	// loadCtx carries the -duration deadline. When it expires, in-flight rounds
	// abort promptly (via Core.LoadCtx) so the run ends near the requested
	// duration and the final summary is printed, instead of finishing the
	// current round (which can add minutes for large tables).
	var loadCtx context.Context
	if duration > 0 {
		loadCtx, _ = context.WithTimeout(ctx, time.Duration(duration)*time.Second)
	} else {
		loadCtx = ctx
	}

	// 1. Validate connectivity
	logger.Infof("validating connectivity...")
	httpClient := core.NewHTTPClient(cfg.BaseURLs)
	httpClient.SetAuthToken(cfg.AuthToken)
	if err := httpClient.CheckReadiness(ctx); err != nil {
		logger.Errorf("backend not ready: %v", err)
		log.Fatalf("backend not ready: %v", err)
	}
	logger.Infof("backend ready: %d instances", len(cfg.BaseURLs))

	sqsProducer, err := core.NewSQSProducer(ctx, sqsEndpoint, sqsQueue)
	if err != nil {
		logger.Errorf("SQS not available: %v", err)
		log.Fatalf("SQS not available: %v", err)
	}
	if err := sqsProducer.CheckReachable(ctx); err != nil {
		logger.Errorf("SQS queue not reachable: %v", err)
		log.Fatalf("SQS queue not reachable: %v", err)
	}
	logger.Infof("SQS queue reachable")

	// Attach logger to HTTP client and SQS producer
	httpClient.SetLogger(logger)
	sqsProducer.SetLogger(logger)

	// Rate-limit SQS sends to avoid overwhelming LocalStack's SQS (which has
	// a much lower throughput than real AWS SQS). 1500 msg/s is the target
	// throughput for the stress test.
	sqsProducer.SetRateLimit(1500)
	logger.Infof("SQS rate limit set to 1500 msg/s")

	coreInst := &core.Core{
		HTTP:      httpClient,
		SQS:       sqsProducer,
		Metrics:   core.NewMetrics(),
		Log:       logger,
		Cfg:       cfg,
		Instances: core.NewInstanceTracker(),
		Ctx:       loadCtx,
	}

	// 2. Select tables
	specs := defaultSpecs()
	if tablesFlag != "all" {
		selected := make(map[string]bool)
		for _, name := range strings.Split(tablesFlag, ",") {
			selected[strings.TrimSpace(name)] = true
		}
		var filtered []TableSpec
		for _, s := range specs {
			if selected[s.Name] {
				filtered = append(filtered, s)
			}
		}
		if len(filtered) == 0 {
			log.Fatalf("no tables selected (available: %s)", strings.Join(specNames(specs), ", "))
		}
		specs = filtered
	}

	// 3. Run all tables concurrently
	logger.Infof("running %d tables concurrently: %s", len(specs), strings.Join(specNames(specs), ", "))
	start := time.Now()

	type tableOutcome struct {
		spec    TableSpec
		result  *core.TableResult
		wallets []core.WalletRef
		err     error
	}

	outcomes := make([]tableOutcome, len(specs))
	var wg sync.WaitGroup

	for i, spec := range specs {
		wg.Add(1)
		go func(idx int, spec TableSpec) {
			defer wg.Done()

			instances := spec.Instances
			if instances < 1 {
				instances = 1
			}
			logger.Infof("[%s] starting table (provider=%s, players=%d, instances=%d, rounds=%d, channel=%s)",
				spec.Name, spec.ProviderID, spec.PlayersPerRound, instances, spec.Rounds, spec.Channel)

			var instWG sync.WaitGroup
			instResults := make([]*core.TableResult, instances)
			instWallets := make([][]core.WalletRef, instances)
			instErrs := make([]error, instances)

			for inst := 0; inst < instances; inst++ {
				instWG.Add(1)
				go func(inst int) {
					defer instWG.Done()

					tableCfg := &core.TableConfig{
						GameID:                spec.Name,
						ProviderID:            spec.ProviderID,
						MinBetCents:           spec.MinBetCents,
						MaxBetCents:           spec.MaxBetCents,
						PlayersPerRound:       spec.PlayersPerRound,
						Rounds:                spec.Rounds,
						RoundDuration:         spec.RoundDuration,
						WinRate:               spec.WinRate,
						WinMult:               spec.WinMult,
						RefundRate:            spec.RefundRate,
						OutOfOrderRate:        spec.OutOfOrderRate,
						Channel:               spec.Channel,
						HotWallet:             spec.HotWallet,
						Instances:             instances,
						InstanceIdx:           inst,
						PartialReportInterval: 100,
						OnPartialReport: func(snap core.TableSnapshot) {
							writePartialReport(spec.Name, snap)
						},
						OnLog: func(format string, args ...any) {
							logger.Infof(format, args...)
						},
					}

					table := spec.Build(tableCfg)
					result, err := table.Run(ctx, coreInst)
					if err != nil {
						instErrs[inst] = err
						return
					}
					instResults[inst] = result
					instWallets[inst] = tableWallets(table)
				}(inst)
			}
			instWG.Wait()

			// Aggregate instance results into one table outcome.
			var agg *core.TableResult
			var aggErr error
			for inst := 0; inst < instances; inst++ {
				if instErrs[inst] != nil {
					aggErr = instErrs[inst]
					continue
				}
				r := instResults[inst]
				if agg == nil {
					agg = &core.TableResult{Table: spec.Name, Duration: r.Duration, P50: r.P50, P95: r.P95, P99: r.P99}
				}
				agg.RoundsCompleted += r.RoundsCompleted
				agg.TotalBets += r.TotalBets
				agg.TotalWins += r.TotalWins
				agg.TotalLosses += r.TotalLosses
				agg.TotalRefunds += r.TotalRefunds
				agg.TotalRollbacks += r.TotalRollbacks
				agg.TotalRejections += r.TotalRejections
				agg.TotalDuplicates += r.TotalDuplicates
				agg.SendFailures += r.SendFailures
				agg.BetsTotal = addDecimal(agg.BetsTotal, r.BetsTotal)
				agg.WinsTotal = addDecimal(agg.WinsTotal, r.WinsTotal)
				agg.RefundsTotal = addDecimal(agg.RefundsTotal, r.RefundsTotal)
				agg.RollbacksTotal = addDecimal(agg.RollbacksTotal, r.RollbacksTotal)
				agg.Errors = append(agg.Errors, r.Errors...)
			}
			if agg != nil {
				agg.Net = addDecimal(agg.BetsTotal, "-"+addDecimal(agg.WinsTotal, addDecimal(agg.RefundsTotal, agg.RollbacksTotal)))
			}
			for _, w := range instWallets {
				outcomes[idx].wallets = append(outcomes[idx].wallets, w...)
			}

			if aggErr != nil {
				logger.Errorf("[%s] table failed: %v", spec.Name, aggErr)
				outcomes[idx] = tableOutcome{spec: spec, err: aggErr}
				return
			}
			if agg != nil {
				logger.Infof("[%s] table finished: rounds=%d, bets=%d, wins=%d, losses=%d, p50=%s, p95=%s, p99=%s",
					spec.Name, agg.RoundsCompleted, agg.TotalBets, agg.TotalWins, agg.TotalLosses,
					agg.P50, agg.P95, agg.P99)
				outcomes[idx] = tableOutcome{spec: spec, result: agg, wallets: outcomes[idx].wallets}
			}
		}(i, spec)
	}

	wg.Wait()

	// 4. Collect all wallets for reconciliation
	var allWallets []core.WalletRef
	for _, o := range outcomes {
		if o.err != nil {
			log.Printf("[%s] ERROR: %v", o.spec.Name, o.err)
			continue
		}
		allWallets = append(allWallets, o.wallets...)
	}

	// 5. Reconcile all wallets
	logger.Infof("reconciling %d wallets...", len(allWallets))
	issues := coreInst.ReconcileAll(ctx, allWallets)
	if len(issues) > 0 {
		logger.Errorf("RECONCILIATION ISSUES (%d):", len(issues))
		for _, issue := range issues {
			logger.Errorf("  %s", issue)
		}
	} else {
		logger.Infof("reconciliation: all wallets consistent")
	}

	// 6. Invariants
	invariants := core.CheckInvariants(ctx, coreInst, allWallets)
	for _, inv := range invariants {
		status := "PASS"
		if !inv.Passed {
			status = "FAIL"
		}
		logger.Infof("invariant %-30s %s %s", inv.Name, status, inv.Message)
	}

	// 7. Report
	totalTx := int64(0)
	totalErrors := 0
	tablesReport := make(map[string]map[string]any)
	for _, o := range outcomes {
		if o.err != nil {
			continue
		}
		r := o.result
		totalTx += int64(r.TotalBets)
		totalErrors += len(r.Errors) + r.SendFailures
		tablesReport[o.spec.Name] = map[string]any{
			"rounds":                r.RoundsCompleted,
			"bets":                  r.TotalBets,
			"wins":                  r.TotalWins,
			"losses":                r.TotalLosses,
			"refunds":               r.TotalRefunds,
			"rollbacks":             r.TotalRollbacks,
			"rejections":            r.TotalRejections,
			"duplicates":            r.TotalDuplicates,
			"send_failures":         r.SendFailures,
			"bets_total":            r.BetsTotal,
			"wins_total":            r.WinsTotal,
			"refunds_total":         r.RefundsTotal,
			"rollbacks_total":       r.RollbacksTotal,
			"net":                   r.Net,
			"p50":                   r.P50.String(),
			"p95":                   r.P95.String(),
			"p99":                   r.P99.String(),
			"instance_distribution": coreInst.Instances.SnapshotForTable(o.spec.Name),
		}
	}

	invariantsReport := make(map[string]bool)
	for _, inv := range invariants {
		invariantsReport[inv.Name] = inv.Passed
	}

	// Instance distribution (HTTP traffic only — SQS does not go through the LB)
	instanceDist := coreInst.Instances.Snapshot()
	logger.Infof("instance distribution (HTTP): %v", instanceDist)

	reportData := map[string]any{
		"timestamp":             time.Now().UTC().Format(time.RFC3339),
		"duration":              time.Since(start).String(),
		"instances":             len(cfg.BaseURLs),
		"tables":                tablesReport,
		"invariants":            invariantsReport,
		"totalTransactions":     totalTx,
		"totalErrors":           totalErrors,
		"instance_distribution": instanceDist,
	}

	if report != "" {
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetIndent("", "  ")
		if err := enc.Encode(reportData); err != nil {
			logger.Warnf("failed to encode report: %v", err)
		} else if err := os.WriteFile(report, buf.Bytes(), 0644); err != nil {
			logger.Warnf("failed to write report: %v", err)
		} else {
			logger.Infof("report written to %s", report)
		}
	}

	logger.Infof("orchestrator done: %d tables, %d wallets, %d total transactions, %d errors",
		len(specs), len(allWallets), totalTx, totalErrors)
}

var partialReportMu sync.Mutex

// writePartialReport appends a JSON line to /tmp/test-reports/partial-<table>.jsonl.
func writePartialReport(table string, snap core.TableSnapshot) {
	partialReportMu.Lock()
	defer partialReportMu.Unlock()

	dir := "/tmp/test-reports"
	if err := os.MkdirAll(dir, 0755); err != nil {
		return
	}

	f, err := os.OpenFile(fmt.Sprintf("%s/partial-%s.jsonl", dir, table), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return
	}
	defer f.Close()

	enc := json.NewEncoder(f)
	enc.Encode(snap)
}

// addDecimal adds two decimal strings ("12.34" + "5.67" = "18.01").
// Empty strings are treated as zero. Negative values are supported.
func addDecimal(a, b string) string {
	if a == "" {
		return b
	}
	if b == "" {
		return a
	}
	var negA, negB bool
	if a[0] == '-' {
		negA = true
		a = a[1:]
	}
	if b[0] == '-' {
		negB = true
		b = b[1:]
	}
	ai, _ := parseCents(a)
	bi, _ := parseCents(b)
	sum := ai + bi
	if negA {
		sum -= 2 * ai
	}
	if negB {
		sum -= 2 * bi
	}
	if sum < 0 {
		return fmt.Sprintf("-%.2f", float64(-sum)/100.0)
	}
	return fmt.Sprintf("%.2f", float64(sum)/100.0)
}

// parseCents converts a decimal string to integer cents.
func parseCents(s string) (int64, error) {
	var intPart, fracPart string
	if idx := strings.IndexByte(s, '.'); idx >= 0 {
		intPart = s[:idx]
		fracPart = s[idx+1:]
	} else {
		intPart = s
	}
	if intPart == "" {
		intPart = "0"
	}
	for len(fracPart) < 2 {
		fracPart += "0"
	}
	fracPart = fracPart[:2]
	i, err := strconv.ParseInt(intPart, 10, 64)
	if err != nil {
		return 0, err
	}
	f, err := strconv.ParseInt(fracPart, 10, 64)
	if err != nil {
		return 0, err
	}
	return i*100 + f, nil
}

func specNames(specs []TableSpec) []string {
	names := make([]string, len(specs))
	for i, s := range specs {
		names[i] = s.Name
	}
	return names
}

// tableWallets extracts the wallets from a table implementation.
func tableWallets(t core.Table) []core.WalletRef {
	type walletGetter interface {
		Wallets() []core.WalletRef
	}
	if wg, ok := t.(walletGetter); ok {
		return wg.Wallets()
	}
	return nil
}
