package core

import (
	"context"
	"fmt"
	"math/rand"
	"sync"
	"sync/atomic"
	"time"
)

// Table is the interface each game table implements.
//
// The generic machinery (wallet creation, round loop, metrics, partial
// reports, result assembly) lives in BaseTable. A concrete table embeds
// *BaseTable and only implements RunRound with its game-specific logic.
type Table interface {
	// Name returns the table identifier (e.g. "fortune-chimp").
	Name() string

	// Config returns the table-specific configuration.
	Config() *TableConfig

	// Wallets returns the wallets created by this table (for reconciliation).
	Wallets() []WalletRef

	// Run executes the table's game simulation.
	Run(ctx context.Context, c *Core) (*TableResult, error)

	// RunRound executes a single round of the game.
	RunRound(ctx context.Context, c *Core, round int) error
}

// TableConfig holds per-table parameters.
type TableConfig struct {
	GameID          string
	ProviderID      string
	MinBetCents     int64
	MaxBetCents     int64
	PlayersPerRound int
	Rounds          int
	RoundDuration   time.Duration
	WinRate         float64 // 0.0–1.0
	WinMult         int64   // WIN payout multiplier (0 = table defines its own)
	RefundRate      float64 // 0.0–1.0
	OutOfOrderRate  float64 // 0.0–1.0
	Channel         string  // "http", "sqs", or "mixed"
	HotWallet       bool    // concentrate 80% of bets on one wallet

	// Instances: number of concurrent table instances (each with its own
	// wallets and round loop). PlayersPerRound is split across instances.
	// 0 or 1 = single instance (default behavior).
	Instances int
	// InstanceIdx: index of this instance (0-based). Set by the orchestrator
	// when spawning instances; 0 for standalone runs.
	InstanceIdx int

	// PartialReportInterval: emit a partial report every N bets (0 = disabled).
	PartialReportInterval int
	// OnPartialReport: callback invoked when PartialReportInterval bets are reached.
	OnPartialReport func(TableSnapshot)
	// OnLog: optional logger for table events (partial reports, round errors).
	OnLog func(format string, args ...any)
}

// TableResult holds the outcome of a table run.
type TableResult struct {
	Table           string        `json:"table"`
	RoundsCompleted int           `json:"roundsCompleted"`
	TotalBets       int           `json:"totalBets"`
	TotalWins       int           `json:"totalWins"`
	TotalLosses     int           `json:"totalLosses"`
	TotalRefunds    int           `json:"totalRefunds"`
	TotalRollbacks  int           `json:"totalRollbacks"`
	TotalRejections int           `json:"totalRejections"`
	TotalDuplicates int           `json:"totalDuplicates"`
	SendFailures    int           `json:"sendFailures"`
	BetsTotal       string        `json:"betsTotal"`
	WinsTotal       string        `json:"winsTotal"`
	RefundsTotal    string        `json:"refundsTotal"`
	RollbacksTotal  string        `json:"rollbacksTotal"`
	Net             string        `json:"net"`
	Duration        time.Duration `json:"duration"`
	P50             time.Duration `json:"p50"`
	P95             time.Duration `json:"p95"`
	P99             time.Duration `json:"p99"`
	Errors          []string      `json:"errors,omitempty"`
}

// TableSnapshot is a partial view of a table's progress, emitted every
// PartialReportInterval bets. It has the same shape as TableResult but
// represents an in-progress state (not the final outcome).
type TableSnapshot struct {
	Table           string        `json:"table"`
	RoundsCompleted int           `json:"roundsCompleted"`
	TotalBets       int           `json:"totalBets"`
	TotalWins       int           `json:"totalWins"`
	TotalLosses     int           `json:"totalLosses"`
	TotalRefunds    int           `json:"totalRefunds"`
	TotalRollbacks  int           `json:"totalRollbacks"`
	TotalRejections int           `json:"totalRejections"`
	TotalDuplicates int           `json:"totalDuplicates"`
	SendFailures    int           `json:"sendFailures"`
	BetsTotal       string        `json:"betsTotal"`
	WinsTotal       string        `json:"winsTotal"`
	RefundsTotal    string        `json:"refundsTotal"`
	RollbacksTotal  string        `json:"rollbacksTotal"`
	Net             string        `json:"net"`
	Elapsed         time.Duration `json:"elapsed"`
	P50             time.Duration `json:"p50"`
	P95             time.Duration `json:"p95"`
	P99             time.Duration `json:"p99"`
	Timestamp       time.Time     `json:"timestamp"`
}

// Core bundles the shared dependencies passed to each table.
type Core struct {
	HTTP      *HTTPClient
	SQS       *SQSProducer
	Metrics   *Metrics
	Log       *Logger
	Cfg       *Config
	Instances *InstanceTracker

	// Ctx carries the load deadline (set by the orchestrator from -duration).
	// When it expires, in-flight rounds abort promptly instead of running to
	// completion. Nil = no deadline (standalone CLIs without -duration).
	Ctx context.Context
}

// WalletRef identifies a created wallet for later reconciliation.
type WalletRef struct {
	ID       string
	PlayerID string
	Currency string
}

// CreateWallets creates n wallets and returns their references.
//
// Player IDs are synthetic and deterministic (per index), so re-running the
// same table against the same backend reuses the existing wallets (409 path).
// The 409 response body is expected to carry the existing wallet (id + balance);
// if it does not, we fail loudly instead of guessing.
//
// instanceIdx namespaces the player IDs across concurrent table instances,
// so each instance owns a disjoint set of wallets (0 = no namespace).
func (c *Core) CreateWallets(ctx context.Context, n int, instanceIdx int) ([]WalletRef, error) {
	const workers = 16

	wallets := make([]WalletRef, n)
	jobs := make(chan int)
	errCh := make(chan error, n)

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				w, err := c.createWallet(ctx, i, instanceIdx)
				if err != nil {
					errCh <- err
					return
				}
				wallets[i] = w
			}
		}()
	}
	go func() {
		for i := 0; i < n; i++ {
			select {
			case <-ctx.Done():
				return
			case jobs <- i:
			}
		}
		close(jobs)
	}()
	go func() {
		wg.Wait()
		close(errCh)
	}()

	for err := range errCh {
		if err != nil {
			return nil, err
		}
	}
	return wallets, nil
}

// createWallet creates (or reuses, on 409) the wallet for player index i.
func (c *Core) createWallet(ctx context.Context, i, instanceIdx int) (WalletRef, error) {
	// Deterministic UUID in RFC 4122 v4 format derived from the player index.
	// The version (4) and variant (8) bits are fixed so the result is a valid
	// UUID (the backend validates with a strict RFC 4122 regex); the index is
	// folded into the last group. The instanceIdx is folded into the index so
	// each instance owns a disjoint set of wallets.
	idx := i
	if instanceIdx > 0 {
		idx = i + instanceIdx*1000000
	}
	playerID := fmt.Sprintf("00000000-0000-4000-8000-%012d", idx)
	body := map[string]any{
		"playerId": playerID,
		"initialBalance": map[string]string{
			"amount":   "100.00",
			"currency": "BRL",
		},
	}

	result, err := c.HTTP.CreateWallet(ctx, body)
	if err != nil {
		return WalletRef{}, fmt.Errorf("create wallet %d: %w", i, err)
	}

	var w struct {
		ID string `json:"id"`
	}
	if err := result.JSON(&w); err != nil {
		return WalletRef{}, fmt.Errorf("parse wallet %d: %w", i, err)
	}

	switch {
	case result.StatusCode == 201:
		// created
	case result.StatusCode == 409:
		// already exists — the response must carry the existing wallet id
		if w.ID == "" {
			return WalletRef{}, fmt.Errorf(
				"wallet for player %s already exists but the 409 response has no id: %s",
				playerID, string(result.Body),
			)
		}
	default:
		return WalletRef{}, fmt.Errorf("create wallet %d: HTTP %d: %s", i, result.StatusCode, string(result.Body))
	}

	return WalletRef{ID: w.ID, PlayerID: playerID, Currency: "BRL"}, nil
}

// ---------------------------------------------------------------------------
// BaseTable — generic table machinery shared by all game tables.
//
// Concrete tables embed *BaseTable and implement only RunRound. The generic
// Run handles wallet creation, the round loop, context cancellation, per-table
// metrics (TableProgress), partial reports, and final result assembly.
// ---------------------------------------------------------------------------

// BaseTable holds the shared state and behavior for a game table.
type BaseTable struct {
	cfg     *TableConfig
	wallets []WalletRef
	rng     *lockedRand
	prog    *TableProgress
}

// NewBaseTable creates a BaseTable with a fresh RNG and progress tracker.
func NewBaseTable(cfg *TableConfig) *BaseTable {
	return &BaseTable{
		cfg:  cfg,
		rng:  newLockedRand(),
		prog: NewTableProgress(cfg.GameID, cfg),
	}
}

// Name returns the table identifier.
func (b *BaseTable) Name() string { return b.cfg.GameID }

// Config returns the table configuration.
func (b *BaseTable) Config() *TableConfig { return b.cfg }

// Wallets returns the wallets created by this table.
func (b *BaseTable) Wallets() []WalletRef { return b.wallets }

// Rng returns the table's thread-safe RNG.
func (b *BaseTable) Rng() *lockedRand { return b.rng }

// Prog returns the table's progress tracker (per-table metrics).
func (b *BaseTable) Prog() *TableProgress { return b.prog }

// LoadCtx returns the load context (with the -duration deadline) if set by the
// orchestrator, or ctx otherwise. Tables use it to abort in-flight rounds
// promptly when the load window expires.
func (c *Core) LoadCtx(ctx context.Context) context.Context {
	if c.Ctx != nil {
		return c.Ctx
	}
	return ctx
}

// Run executes the generic table lifecycle:
// 1. Create wallets
// 2. Run rounds (calling t.RunRound for each)
// 3. Handle context cancellation
// 4. Assemble the final TableResult from per-table metrics
func (b *BaseTable) Run(ctx context.Context, c *Core, t Table) (*TableResult, error) {
	start := time.Now()

	// loadCtx carries the -duration deadline (when set by the orchestrator) so
	// that wallet creation and in-flight rounds abort promptly when the load
	// window expires, instead of running to completion.
	loadCtx := c.LoadCtx(ctx)

	players := b.cfg.PlayersPerRound
	if b.cfg.Instances > 1 {
		players = playersPerInstance(b.cfg.PlayersPerRound, b.cfg.Instances, b.cfg.InstanceIdx)
	}

	if c.Log != nil {
		if b.cfg.Instances > 1 {
			c.Log.Infof("[%s] instance %d/%d: creating %d wallets...", b.Name(), b.cfg.InstanceIdx+1, b.cfg.Instances, players)
		} else {
			c.Log.Infof("[%s] creating %d wallets...", b.Name(), players)
		}
	}
	wallets, err := c.CreateWallets(loadCtx, players, b.cfg.InstanceIdx)
	if err != nil {
		return nil, fmt.Errorf("create wallets: %w", err)
	}
	b.wallets = wallets

	result := &TableResult{Table: b.Name()}

	if len(wallets) == 0 {
		// Instance got no players (PlayersPerRound < Instances). Nothing to do.
		b.fillResult(c, result, start, b.cfg.Rounds)
		return result, nil
	}

	for round := 0; round < b.cfg.Rounds; round++ {
		select {
		case <-loadCtx.Done():
			// Load window expired (or shutdown signal). Return the partial
			// result with a nil error so the orchestrator keeps the partial
			// metrics and prints the final summary.
			b.fillResult(c, result, start, round)
			return result, nil
		default:
		}

		if err := t.RunRound(loadCtx, c, round); err != nil {
			result.Errors = append(result.Errors, fmt.Sprintf("round %d: %v", round, err))
		}
		result.RoundsCompleted = round + 1

		if b.cfg.RoundDuration > 0 {
			select {
			case <-loadCtx.Done():
			case <-time.After(b.cfg.RoundDuration):
			}
		}
	}

	b.fillResult(c, result, start, b.cfg.Rounds)
	return result, nil
}

// playersPerInstance splits n players across instances. Instance i gets
// floor(n/instances) + (1 if i < n%instances else 0), so the sum equals n.
func playersPerInstance(n, instances, idx int) int {
	base := n / instances
	extra := n % instances
	if idx < extra {
		return base + 1
	}
	return base
}

// LogRoundError logs a non-fatal round error via the table's OnLog hook
// (falls back to fmt.Printf when no logger is attached).
func (b *BaseTable) LogRoundError(round int, err error) {
	if b.cfg.OnLog != nil {
		b.cfg.OnLog("[%s] round %d: %v", b.Name(), round, err)
	} else {
		fmt.Printf("[%s] round %d: %v\n", b.Name(), round, err)
	}
}

// DrainErrCh drains an error channel, logging each error via LogRoundError.
// Returns a single error summarizing the count (nil if no errors), so the
// caller can propagate it to result.Errors via RunRound's return value.
func (b *BaseTable) DrainErrCh(round int, errCh <-chan error) error {
	var count int
	for err := range errCh {
		b.LogRoundError(round, err)
		count++
	}
	if count == 0 {
		return nil
	}
	return fmt.Errorf("%d error(s) in round %d", count, round)
}

// fillResult populates the TableResult from per-table metrics + global latencies.
func (b *BaseTable) fillResult(c *Core, result *TableResult, start time.Time, rounds int) {
	result.Duration = time.Since(start)
	result.RoundsCompleted = rounds

	// Per-table counters (accurate, not polluted by other tables)
	result.TotalBets = int(b.prog.Bets.Load())
	result.TotalWins = int(b.prog.Wins.Load())
	result.TotalLosses = int(b.prog.Losses.Load())
	result.TotalRefunds = int(b.prog.Refunds.Load())
	result.TotalRollbacks = int(b.prog.Rollbacks.Load())
	result.TotalRejections = int(b.prog.Rejections.Load())
	result.TotalDuplicates = int(b.prog.Duplicates.Load())
	result.SendFailures = int(b.prog.SendFailures.Load())

	// Amounts (audit)
	result.BetsTotal = CentsToDecimal(b.prog.BetsCents.Load())
	result.WinsTotal = CentsToDecimal(b.prog.WinsCents.Load())
	result.RefundsTotal = CentsToDecimal(b.prog.RefundsCents.Load())
	result.RollbacksTotal = CentsToDecimal(b.prog.RollbacksCents.Load())
	result.Net = CentsToDecimal(b.prog.BetsCents.Load() - b.prog.WinsCents.Load() - b.prog.RefundsCents.Load() - b.prog.RollbacksCents.Load())

	// Latency percentiles from the global metrics (shared across tables)
	if c.Metrics != nil {
		snap := c.Metrics.Snapshot()
		result.P50, result.P95, result.P99 = snap.P50, snap.P95, snap.P99
	}
}

// ---------------------------------------------------------------------------
// Transaction sending — shared by all tables.
// ---------------------------------------------------------------------------

// TxRequest describes a single wager transaction to send.
type TxRequest struct {
	Wallet   WalletRef
	Kind     string // "BET", "WIN", "LOSS", "REFUND", "ROLLBACK"
	Money    Money
	ExtID    string
	IdemKey  string
	Round    int
	RefExtID string // for WIN/LOSS/REFUND/ROLLBACK (reference to the BET)
	UseSQS   bool   // override channel (for "mixed" channel tables)

	// OutcomeKind is the outcome category recorded in TableProgress when the
	// transaction is sent ("WIN", "LOSS", "REFUND", "ROLLBACK"). Empty for BET.
	// This replaces the separate RecordOutcome calls in each table.
	OutcomeKind string

	// OutcomeCents is the amount recorded as "paid" for this outcome (WIN
	// payout, REFUND/ROLLBACK credit). Only used when OutcomeKind is set.
	OutcomeCents int64
}

// SendTransaction sends a wager transaction via HTTP or SQS based on the
// table's channel config (or the explicit UseSQS override).
//
// For HTTP: records latency in global metrics and classifies the response.
// For SQS: fire-and-forget (no response to classify).
//
// If req.OutcomeKind is set, the outcome is recorded in the per-table
// progress (counters + amounts) at send time — the same moment the old
// RecordOutcome calls happened in each table.
//
// Returns an error only for transport failures (not for business rejections).
func (b *BaseTable) SendTransaction(ctx context.Context, c *Core, req TxRequest, errCh chan<- error) error {
	body := map[string]any{
		"providerId":            b.cfg.ProviderID,
		"externalTransactionId": req.ExtID,
		"playerId":              req.Wallet.PlayerID,
		"walletId":              req.Wallet.ID,
		"roundId":               fmt.Sprintf("round-%d", req.Round),
		"gameId":                b.cfg.GameID,
		"kind":                  req.Kind,
		"money":                 req.Money.ToJSON(),
	}
	if req.RefExtID != "" {
		body["referenceExternalTransactionId"] = req.RefExtID
	}

	useSQS := req.UseSQS || b.cfg.Channel == "sqs"

	if useSQS {
		if c.SQS == nil {
			return fmt.Errorf("SQS not configured for %s", b.Name())
		}
		payload := map[string]any{
			"messageId":  fmt.Sprintf("msg-%s", req.ExtID),
			"type":       "WagerTransactionRequested",
			"occurredAt": time.Now().UTC().Format(time.RFC3339),
			"data":       body,
		}
		payload["data"].(map[string]any)["idempotencyKey"] = req.IdemKey
		if err := c.SQS.Send(ctx, req.Wallet.ID, payload); err != nil {
			if req.OutcomeKind != "" {
				b.prog.RecordOutcome(req.OutcomeKind, req.OutcomeCents)
			}
			b.prog.SendFailures.Add(1)
			return fmt.Errorf("%s %s: %w", req.Kind, req.ExtID, err)
		}
		if req.OutcomeKind != "" {
			b.prog.RecordOutcome(req.OutcomeKind, req.OutcomeCents)
		}
		return nil
	}

	httpResult, err := c.HTTP.SubmitTransaction(ctx, req.IdemKey, body)
	if err != nil {
		return fmt.Errorf("%s %s: %w", req.Kind, req.ExtID, err)
	}
	if c.Instances != nil {
		c.Instances.Record(b.Name(), httpResult.Header.Get("X-Instance-Id"))
	}
	ClassifyHTTP(httpResult, c.Metrics, b.prog, errCh)
	if req.OutcomeKind != "" {
		b.prog.RecordOutcome(req.OutcomeKind, req.OutcomeCents)
	}
	return nil
}

// ClassifyHTTP records an HTTP response in global metrics + per-table progress.
// Non-fatal errors (unexpected status codes) are sent to errCh.
func ClassifyHTTP(result *HTTPResult, m *Metrics, prog *TableProgress, errCh chan<- error) {
	switch {
	case result.StatusCode == 200:
		m.Record(result.Latency, CatSuccess)
	case result.StatusCode == 422:
		m.Record(result.Latency, CatRejection)
		if prog != nil {
			prog.RecordRejection()
		}
	case result.StatusCode == 409:
		m.Record(result.Latency, CatConflict)
		if prog != nil {
			prog.RecordDuplicate()
		}
	case result.StatusCode == 503:
		m.Record(result.Latency, CatError)
		if errCh != nil {
			errCh <- fmt.Errorf("HTTP %d: %s", result.StatusCode, string(result.Body))
		}
	case result.StatusCode == 202:
		m.Record(result.Latency, CatPendingRef)
	default:
		m.Record(result.Latency, CatError)
		if errCh != nil {
			errCh <- fmt.Errorf("HTTP %d: %s", result.StatusCode, string(result.Body))
		}
	}
}

// ---------------------------------------------------------------------------
// TableProgress — per-table metrics (fixes the global-metrics pollution bug).
// ---------------------------------------------------------------------------

// TableProgress is the per-table state used to track outcomes and emit
// partial reports. It is owned by a single table (one Run call) and shared
// with its goroutines via atomics.
type TableProgress struct {
	Name       string
	Start      time.Time
	Bets       atomic.Int64
	Wins       atomic.Int64
	Losses     atomic.Int64
	Refunds    atomic.Int64
	Rollbacks  atomic.Int64
	Rejections atomic.Int64
	Duplicates atomic.Int64

	// SendFailures counts SQS SendMessage calls that failed after all
	// retries (rate limit, network, etc.). These are NOT duplicates — the
	// message never reached the queue. Tracked separately from HTTP 409
	// conflicts so the report can distinguish "never sent" from "sent twice".
	SendFailures atomic.Int64

	// Amounts (integer cents) for audit: total bet value, total paid out.
	BetsCents      atomic.Int64
	WinsCents      atomic.Int64
	RefundsCents   atomic.Int64
	RollbacksCents atomic.Int64

	cfg *TableConfig
}

// NewTableProgress creates a TableProgress for a table run.
func NewTableProgress(name string, cfg *TableConfig) *TableProgress {
	return &TableProgress{Name: name, Start: time.Now(), cfg: cfg}
}

// RecordBets records n submitted bets (with their total amount) and emits a
// partial report if the counter crossed a multiple of cfg.PartialReportInterval.
func (p *TableProgress) RecordBets(n int64, amountCents int64) {
	if p.cfg == nil || p.cfg.PartialReportInterval <= 0 {
		return
	}
	total := p.Bets.Add(n)
	p.BetsCents.Add(amountCents)
	interval := int64(p.cfg.PartialReportInterval)
	if total/interval > (total-n)/interval && p.cfg.OnPartialReport != nil {
		p.cfg.OnPartialReport(p.Snapshot())
	}
}

// RecordOutcome records a single outcome category and its amount.
// amountCents is the amount paid/credited by this outcome (WIN payout,
// REFUND/ROLLBACK credit). 0 for LOSS.
func (p *TableProgress) RecordOutcome(kind string, amountCents int64) {
	switch kind {
	case "WIN":
		p.Wins.Add(1)
		p.WinsCents.Add(amountCents)
	case "LOSS":
		p.Losses.Add(1)
	case "REFUND":
		p.Refunds.Add(1)
		p.RefundsCents.Add(amountCents)
	case "ROLLBACK":
		p.Rollbacks.Add(1)
		p.RollbacksCents.Add(amountCents)
	}
}

// RecordRejection records a rejected transaction (HTTP 422).
func (p *TableProgress) RecordRejection() { p.Rejections.Add(1) }

// RecordDuplicate records a duplicate/conflict transaction (HTTP 409).
func (p *TableProgress) RecordDuplicate() { p.Duplicates.Add(1) }

// Snapshot builds a TableSnapshot from the current counters.
func (p *TableProgress) Snapshot() TableSnapshot {
	snap := TableSnapshot{
		Table:           p.Name,
		TotalBets:       int(p.Bets.Load()),
		TotalWins:       int(p.Wins.Load()),
		TotalLosses:     int(p.Losses.Load()),
		TotalRefunds:    int(p.Refunds.Load()),
		TotalRollbacks:  int(p.Rollbacks.Load()),
		TotalRejections: int(p.Rejections.Load()),
		TotalDuplicates: int(p.Duplicates.Load()),
		SendFailures:    int(p.SendFailures.Load()),
		BetsTotal:       CentsToDecimal(p.BetsCents.Load()),
		WinsTotal:       CentsToDecimal(p.WinsCents.Load()),
		RefundsTotal:    CentsToDecimal(p.RefundsCents.Load()),
		RollbacksTotal:  CentsToDecimal(p.RollbacksCents.Load()),
		Net:             CentsToDecimal(p.BetsCents.Load() - p.WinsCents.Load() - p.RefundsCents.Load() - p.RollbacksCents.Load()),
		Elapsed:         time.Since(p.Start),
		Timestamp:       time.Now().UTC(),
	}
	if p.cfg != nil && p.cfg.OnLog != nil {
		p.cfg.OnLog("[%s] partial report: bets=%d (%s) wins=%d (%s) losses=%d refunds=%d (%s) rollbacks=%d (%s) rejections=%d duplicates=%d sendFailures=%d net=%s elapsed=%s",
			p.Name, snap.TotalBets, snap.BetsTotal, snap.TotalWins, snap.WinsTotal, snap.TotalLosses,
			snap.TotalRefunds, snap.RefundsTotal, snap.TotalRollbacks, snap.RollbacksTotal,
			snap.TotalRejections, snap.TotalDuplicates, snap.SendFailures, snap.Net, snap.Elapsed)
	}
	return snap
}

// ---------------------------------------------------------------------------
// lockedRand — thread-safe RNG (fixes the data race on rand.Rand).
// ---------------------------------------------------------------------------

// lockedRand wraps rand.Rand with a mutex for safe use across goroutines.
type lockedRand struct {
	mu  sync.Mutex
	rnd *rand.Rand
}

func newLockedRand() *lockedRand {
	return &lockedRand{
		rnd: rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

// Float64 returns a pseudo-random float64 in [0, 1).
func (l *lockedRand) Float64() float64 {
	l.mu.Lock()
	v := l.rnd.Float64()
	l.mu.Unlock()
	return v
}

// Int63n returns a pseudo-random int64 in [0, n).
func (l *lockedRand) Int63n(n int64) int64 {
	l.mu.Lock()
	v := l.rnd.Int63n(n)
	l.mu.Unlock()
	return v
}

// Intn returns a pseudo-random int in [0, n).
func (l *lockedRand) Intn(n int) int {
	l.mu.Lock()
	v := l.rnd.Intn(n)
	l.mu.Unlock()
	return v
}
