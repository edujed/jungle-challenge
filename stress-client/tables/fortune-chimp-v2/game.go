package main

import (
	"context"
	"fmt"
	"sync"

	"github.com/jungle-gaming/wagering-clients/core"
)

// FortuneChimpV2 is identical to FortuneChimp but with a different
// providerId/gameId and a higher win rate.
type FortuneChimpV2 struct {
	*core.BaseTable
}

func NewFortuneChimpV2(cfg *core.TableConfig) *FortuneChimpV2 {
	return &FortuneChimpV2{BaseTable: core.NewBaseTable(cfg)}
}

func (t *FortuneChimpV2) Run(ctx context.Context, c *core.Core) (*core.TableResult, error) {
	return t.BaseTable.Run(ctx, c, t)
}

func (t *FortuneChimpV2) RunRound(ctx context.Context, c *core.Core, round int) error {
	var wg sync.WaitGroup
	errCh := make(chan error, t.Config().PlayersPerRound)

	for i := 0; i < t.Config().PlayersPerRound; i++ {
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
				UseSQS:  true,
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
					UseSQS:       true,
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
	return t.DrainErrCh(round, errCh)
}
