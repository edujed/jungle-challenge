package core

import (
	"context"
	"fmt"
	"sync"
)

// ReconcileAll calls the reconciliation endpoint for every wallet (concurrently)
// and returns any inconsistencies found.
func (c *Core) ReconcileAll(ctx context.Context, wallets []WalletRef) []string {
	const workers = 16

	type outcome struct {
		idx   int
		issue string // non-empty when the wallet has a problem
	}

	jobs := make(chan int)
	results := make(chan outcome, len(wallets))

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				w := wallets[i]
				issue := c.reconcileOne(ctx, w, i+1, len(wallets))
				results <- outcome{idx: i, issue: issue}
			}
		}()
	}
	go func() {
		for i := range wallets {
			jobs <- i
		}
		close(jobs)
	}()
	go func() {
		wg.Wait()
		close(results)
	}()

	issues := make([]string, 0)
	for r := range results {
		if r.issue != "" {
			issues = append(issues, r.issue)
		}
	}
	return issues
}

// reconcileOne reconciles a single wallet and returns an issue string (empty when OK).
func (c *Core) reconcileOne(ctx context.Context, w WalletRef, pos, total int) string {
	result, err := c.HTTP.Reconcile(ctx, w.ID)
	if err != nil {
		c.logf(LogError, "reconcile wallet %s: %v", w.ID, err)
		return fmt.Sprintf("wallet %s: reconcile error: %v", w.ID, err)
	}

	if result.StatusCode < 200 || result.StatusCode >= 300 {
		c.logf(LogError, "reconcile wallet %s: HTTP %d: %s", w.ID, result.StatusCode, string(result.Body))
		return fmt.Sprintf("wallet %s: HTTP %d: %s", w.ID, result.StatusCode, string(result.Body))
	}

	// The response wraps Money objects, so we need a nested parse
	var recFull struct {
		WalletID      string `json:"walletId"`
		StoredBalance struct {
			Amount   string `json:"amount"`
			Currency string `json:"currency"`
		} `json:"storedBalance"`
		CalculatedBalance struct {
			Amount   string `json:"amount"`
			Currency string `json:"currency"`
		} `json:"calculatedBalance"`
		Difference struct {
			Amount   string `json:"amount"`
			Currency string `json:"currency"`
		} `json:"difference"`
		Consistent     bool `json:"consistent"`
		CheckedEntries int  `json:"checkedEntries"`
	}
	if err := result.JSON(&recFull); err != nil {
		c.logf(LogError, "reconcile wallet %s: parse error: %v", w.ID, err)
		return fmt.Sprintf("wallet %s: parse reconciliation: %v", w.ID, err)
	}

	if !recFull.Consistent {
		c.logf(LogError, "reconcile wallet %s: INCONSISTENT stored=%s calculated=%s diff=%s entries=%d",
			w.ID, recFull.StoredBalance.Amount, recFull.CalculatedBalance.Amount,
			recFull.Difference.Amount, recFull.CheckedEntries)
		return fmt.Sprintf(
			"wallet %s: INCONSISTENT stored=%s calculated=%s diff=%s entries=%d",
			w.ID, recFull.StoredBalance.Amount, recFull.CalculatedBalance.Amount,
			recFull.Difference.Amount, recFull.CheckedEntries,
		)
	}
	if c.Cfg.Verbose {
		c.logf(LogDebug, "reconcile wallet %s: OK stored=%s entries=%d (%d/%d)",
			w.ID, recFull.StoredBalance.Amount, recFull.CheckedEntries, pos, total)
	}
	return ""
}

// logf is a safe no-op if no logger is set.
func (c *Core) logf(level LogLevel, format string, args ...any) {
	if c.Log != nil {
		c.Log.Logf(level, format, args...)
	}
}
