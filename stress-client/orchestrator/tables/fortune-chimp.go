package tables

import (
	"context"
	"fmt"
	"sync"

	"github.com/jungle-gaming/wagering-clients/core"
)

// FortuneChimp implements the core.Table interface for the slot machine.
type FortuneChimp struct {
	*core.BaseTable
}

// NewFortuneChimp creates a FortuneChimp table.
func NewFortuneChimp(cfg *core.TableConfig) *FortuneChimp {
	return &FortuneChimp{BaseTable: core.NewBaseTable(cfg)}
}

func (t *FortuneChimp) Run(ctx context.Context, c *core.Core) (*core.TableResult, error) {
	return t.BaseTable.Run(ctx, c, t)
}

func (t *FortuneChimp) RunRound(ctx context.Context, c *core.Core, round int) error {
	var wg sync.WaitGroup
	errCh := make(chan error, t.Config().PlayersPerRound*4)

	for i := 0; i < len(t.Wallets()); i++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		walletIdx := i
		if t.Config().HotWallet && t.Rng().Float64() < 0.8 {
			walletIdx = 0
		}
		wallet := t.Wallets()[walletIdx]

		bet := core.RandomMoney(t.Config().MinBetCents, t.Config().MaxBetCents, "BRL", t.Rng())
		extID := fmt.Sprintf("%s-round-%d-player-%d", t.Name(), round, i)
		idemKey := fmt.Sprintf("%s:%s", t.Config().ProviderID, extID)

		wg.Add(1)
		go func(wallet core.WalletRef, bet core.Money, extID, idemKey string) {
			defer wg.Done()

			t.Prog().RecordBets(1, bet.Cents)
			if err := t.SendTransaction(ctx, c, core.TxRequest{
				Wallet:  wallet,
				Kind:    "BET",
				Money:   bet,
				ExtID:   extID,
				IdemKey: idemKey,
				Round:   round,
			}, errCh); err != nil {
				errCh <- fmt.Errorf("player %s: %w", wallet.PlayerID, err)
			}

			if t.Rng().Float64() < t.Config().WinRate {
				winExtID := fmt.Sprintf("%s-round-%d-player-%d-win", t.Name(), round, i)
				winIdemKey := fmt.Sprintf("%s:%s", t.Config().ProviderID, winExtID)
				winMoney := core.Money{Cents: bet.Cents * t.Config().WinMult, Currency: "BRL"}
				if err := t.SendTransaction(ctx, c, core.TxRequest{
					Wallet:       wallet,
					Kind:         "WIN",
					Money:        winMoney,
					ExtID:        winExtID,
					IdemKey:      winIdemKey,
					Round:        round,
					RefExtID:     extID,
					OutcomeKind:  "WIN",
					OutcomeCents: winMoney.Cents,
				}, errCh); err != nil {
					errCh <- fmt.Errorf("player %s: %w", wallet.PlayerID, err)
				}
			}
		}(wallet, bet, extID, idemKey)
	}

	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.LogRoundError(round, err)
	}
	return nil
}
