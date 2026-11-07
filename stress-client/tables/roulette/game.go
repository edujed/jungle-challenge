package main

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/jungle-gaming/wagering-clients/core"
)

// Roulette implements the core.Table interface for the roulette table.
//
// Perfil (CLIENTS.md §3.3):
//   - canal misto: metade dos jogadores usa HTTP, metade usa SQS
//   - REFUND em massa: quando a rodada é anulada, TODOS os jogadores
//     recebem REFUND (burst de créditos)
//   - fora de ordem: 20% dos REFUND chegam antes da BET
type Roulette struct {
	*core.BaseTable
}

func NewRoulette(cfg *core.TableConfig) *Roulette {
	return &Roulette{BaseTable: core.NewBaseTable(cfg)}
}

func (t *Roulette) Run(ctx context.Context, c *core.Core) (*core.TableResult, error) {
	return t.BaseTable.Run(ctx, c, t)
}

// RunRound executes a single roulette round:
// 1. Each player places a BET (channel: HTTP for even idx, SQS for odd idx)
// 2. Outcome: WIN (winRate) or LOSS
// 3. If the round is voided (refundRate): ALL players receive a REFUND
func (t *Roulette) RunRound(ctx context.Context, c *core.Core, round int) error {
	var wg sync.WaitGroup
	errCh := make(chan error, t.Config().PlayersPerRound*3)

	roundVoided := t.Rng().Float64() < t.Config().RefundRate
	refundFirst := roundVoided && t.Rng().Float64() < t.Config().OutOfOrderRate

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

		outcome := "LOSS"
		if t.Rng().Float64() < t.Config().WinRate {
			outcome = "WIN"
		}

		useSQS := t.Config().Channel == "sqs" || (t.Config().Channel == "mixed" && i%2 == 1)

		wg.Add(1)
		go func(wallet core.WalletRef, bet core.Money, betExtID, betIdemKey, outcome string, useSQS, refundFirst bool, i int) {
			defer wg.Done()

			if refundFirst {
				t.sendRefund(ctx, c, wallet, bet, betExtID, round, i, useSQS, errCh)
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
				UseSQS:  useSQS,
			}, errCh); err != nil {
				errCh <- err
			}

			if outcome == "WIN" {
				winExtID := fmt.Sprintf("%s-r%d-p%d-win", t.Name(), round, i)
				winIdemKey := fmt.Sprintf("%s:%s", t.Config().ProviderID, winExtID)
				mult := t.Config().WinMult
				if mult == 0 {
					mult = 36
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
					UseSQS:       useSQS,
					OutcomeKind:  "WIN",
					OutcomeCents: winMoney.Cents,
				}, errCh); err != nil {
					errCh <- err
				}
			} else {
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
					UseSQS:      useSQS,
					OutcomeKind: "LOSS",
				}, errCh); err != nil {
					errCh <- err
				}
			}

			if roundVoided && !refundFirst {
				t.sendRefund(ctx, c, wallet, bet, betExtID, round, i, useSQS, errCh)
			}
		}(wallet, bet, betExtID, betIdemKey, outcome, useSQS, refundFirst, i)
	}

	wg.Wait()
	close(errCh)
	return t.DrainErrCh(round, errCh)
}

func (t *Roulette) sendRefund(ctx context.Context, c *core.Core, wallet core.WalletRef, bet core.Money, betExtID string, round, playerIdx int, useSQS bool, errCh chan<- error) {
	extID := fmt.Sprintf("%s-r%d-p%d-refund", t.Name(), round, playerIdx)
	idemKey := fmt.Sprintf("%s:%s", t.Config().ProviderID, extID)

	if err := t.SendTransaction(ctx, c, core.TxRequest{
		Wallet:       wallet,
		Kind:         "REFUND",
		Money:        bet,
		ExtID:        extID,
		IdemKey:      idemKey,
		Round:        round,
		RefExtID:     betExtID,
		UseSQS:       useSQS,
		OutcomeKind:  "REFUND",
		OutcomeCents: bet.Cents,
	}, errCh); err != nil {
		errCh <- fmt.Errorf("REFUND %s: %w", extID, err)
	}
}
