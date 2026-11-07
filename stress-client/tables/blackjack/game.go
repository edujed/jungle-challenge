package main

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/jungle-gaming/wagering-clients/core"
)

// Blackjack implements the core.Table interface for the blackjack table.
// It generates BET → (WIN | LOSS) sequences, with optional REFUND and ROLLBACK.
type Blackjack struct {
	*core.BaseTable
}

func NewBlackjack(cfg *core.TableConfig) *Blackjack {
	return &Blackjack{BaseTable: core.NewBaseTable(cfg)}
}

func (t *Blackjack) Run(ctx context.Context, c *core.Core) (*core.TableResult, error) {
	return t.BaseTable.Run(ctx, c, t)
}

// RunRound executes a single blackjack round:
// 1. Each player places a BET
// 2. Outcome: WIN (winRate), LOSS, or PUSH
// 3. Optional: REFUND or ROLLBACK (round-level)
// 4. Out-of-order: REFUND/ROLLBACK may be sent before the BET
func (t *Blackjack) RunRound(ctx context.Context, c *core.Core, round int) error {
	var wg sync.WaitGroup
	errCh := make(chan error, t.Config().PlayersPerRound*3)

	hasRefund := t.Rng().Float64() < t.Config().RefundRate
	hasRollback := !hasRefund && t.Rng().Float64() < 0.01

	for i := 0; i < t.Config().PlayersPerRound; i++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		wallet := t.Wallets()[i]
		bet := core.RandomMoney(t.Config().MinBetCents, t.Config().MaxBetCents, "BRL", t.Rng())
		betExtID := fmt.Sprintf("%s-r%d-p%d-bet", t.Name(), round, i)
		betIdemKey := fmt.Sprintf("%s:%s", t.Config().ProviderID, betExtID)

		outcomeRoll := t.Rng().Float64()
		var outcome string
		switch {
		case outcomeRoll < t.Config().WinRate:
			outcome = "WIN"
		case outcomeRoll < t.Config().WinRate+0.55:
			outcome = "LOSS"
		default:
			outcome = "PUSH"
		}

		wg.Add(1)
		go func(wallet core.WalletRef, bet core.Money, betExtID, betIdemKey, outcome string, i int) {
			defer wg.Done()

			if (hasRefund || hasRollback) && t.Rng().Float64() < t.Config().OutOfOrderRate {
				t.sendReversal(ctx, c, wallet, bet, betExtID, round, i, hasRefund, errCh)
				time.Sleep(time.Duration(t.Rng().Intn(3000)) * time.Millisecond)
			}

			t.Prog().RecordBets(1, bet.Cents)
			if err := t.SendTransaction(ctx, c, core.TxRequest{
				Wallet:  wallet,
				Kind:    "BET",
				Money:   bet,
				ExtID:   betExtID,
				IdemKey: betIdemKey,
				Round:   round,
			}, errCh); err != nil {
				errCh <- err
			}

			if outcome == "WIN" {
				winExtID := fmt.Sprintf("%s-r%d-p%d-win", t.Name(), round, i)
				winIdemKey := fmt.Sprintf("%s:%s", t.Config().ProviderID, winExtID)
				mult := t.Config().WinMult
				if mult == 0 {
					mult = 2
				}
				winMoney := core.Money{Cents: bet.Cents * mult, Currency: "BRL"}
				if err := t.SendTransaction(ctx, c, core.TxRequest{
					Wallet:       wallet,
					Kind:         "WIN",
					Money:        winMoney,
					ExtID:        winExtID,
					IdemKey:      winIdemKey,
					Round:        round,
					RefExtID:     betExtID,
					OutcomeKind:  "WIN",
					OutcomeCents: winMoney.Cents,
				}, errCh); err != nil {
					errCh <- err
				}
			} else if outcome == "LOSS" {
				lossExtID := fmt.Sprintf("%s-r%d-p%d-loss", t.Name(), round, i)
				lossIdemKey := fmt.Sprintf("%s:%s", t.Config().ProviderID, lossExtID)
				if err := t.SendTransaction(ctx, c, core.TxRequest{
					Wallet:      wallet,
					Kind:        "LOSS",
					Money:       bet,
					ExtID:       lossExtID,
					IdemKey:     lossIdemKey,
					Round:       round,
					RefExtID:    betExtID,
					OutcomeKind: "LOSS",
				}, errCh); err != nil {
					errCh <- err
				}
			}

			if (hasRefund || hasRollback) && t.Rng().Float64() >= t.Config().OutOfOrderRate {
				t.sendReversal(ctx, c, wallet, bet, betExtID, round, i, hasRefund, errCh)
			}
		}(wallet, bet, betExtID, betIdemKey, outcome, i)
	}

	wg.Wait()
	close(errCh)
	return t.DrainErrCh(round, errCh)
}

func (t *Blackjack) sendReversal(ctx context.Context, c *core.Core, wallet core.WalletRef, bet core.Money, betExtID string, round, playerIdx int, isRefund bool, errCh chan<- error) {
	kind := "REFUND"
	if !isRefund {
		kind = "ROLLBACK"
	}
	extID := fmt.Sprintf("%s-r%d-p%d-%s", t.Name(), round, playerIdx, kind)
	idemKey := fmt.Sprintf("%s:%s", t.Config().ProviderID, extID)

	if err := t.SendTransaction(ctx, c, core.TxRequest{
		Wallet:       wallet,
		Kind:         kind,
		Money:        bet,
		ExtID:        extID,
		IdemKey:      idemKey,
		Round:        round,
		RefExtID:     betExtID,
		OutcomeKind:  kind,
		OutcomeCents: bet.Cents,
	}, errCh); err != nil {
		errCh <- fmt.Errorf("%s %s: %w", kind, extID, err)
	}
}
