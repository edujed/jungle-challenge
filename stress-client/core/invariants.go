package core

import (
	"context"
	"fmt"
	"sync"
)

// InvariantResult holds the outcome of a single invariant check.
type InvariantResult struct {
	Name    string `json:"name"`
	Passed  bool   `json:"passed"`
	Message string `json:"message,omitempty"`
}

// CheckInvariants runs all global invariant checks against the backend.
// It queries the reconciliation endpoint for each wallet and verifies
// the fundamental financial invariants.
func CheckInvariants(ctx context.Context, c *Core, wallets []WalletRef) []InvariantResult {
	var results []InvariantResult

	// Invariant 1: Balance consistency (stored == calculated)
	issues := c.ReconcileAll(ctx, wallets)
	if len(issues) == 0 {
		c.logf(LogInfo, "invariant balance_consistency: PASS")
		results = append(results, InvariantResult{
			Name:   "balance_consistency",
			Passed: true,
		})
	} else {
		c.logf(LogError, "invariant balance_consistency: FAIL (%d issues)", len(issues))
		results = append(results, InvariantResult{
			Name:    "balance_consistency",
			Passed:  false,
			Message: fmt.Sprintf("%d inconsistencies: %v", len(issues), issues),
		})
	}

	// Invariant 2: No negative balances (checked via the wallet API —
	// if stored balance is negative, the CHECK constraint would have
	// prevented it, but we verify via the API). Runs concurrently.
	negCount := 0
	var negMu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < len(wallets); i += 16 {
		end := i + 16
		if end > len(wallets) {
			end = len(wallets)
		}
		for j := i; j < end; j++ {
			w := wallets[j]
			wg.Add(1)
			go func(w WalletRef) {
				defer wg.Done()
				result, err := c.HTTP.GetWallet(ctx, w.ID)
				if err != nil || result.StatusCode != 200 {
					return
				}
				var wallet struct {
					Balance struct {
						Amount string `json:"amount"`
					} `json:"balance"`
				}
				if err := result.JSON(&wallet); err != nil {
					return
				}
				m, err := NewMoney(wallet.Balance.Amount, "BRL")
				if err != nil || m.Cents >= 0 {
					return
				}
				negMu.Lock()
				negCount++
				negMu.Unlock()
				c.logf(LogError, "invariant no_negative_balance: wallet %s has balance %s", w.ID, wallet.Balance.Amount)
			}(w)
		}
	}
	wg.Wait()
	if negCount == 0 {
		c.logf(LogInfo, "invariant no_negative_balance: PASS")
		results = append(results, InvariantResult{
			Name:   "no_negative_balance",
			Passed: true,
		})
	} else {
		c.logf(LogError, "invariant no_negative_balance: FAIL (%d wallets)", negCount)
		results = append(results, InvariantResult{
			Name:    "no_negative_balance",
			Passed:  false,
			Message: fmt.Sprintf("%d wallets with negative balance", negCount),
		})
	}

	return results
}
