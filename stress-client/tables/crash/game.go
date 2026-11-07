package main

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/jungle-gaming/wagering-clients/core"
)

// Crash implements the core.Table interface for the crash (multiplier) table.
//
// Perfil (CLIENTS.md §3.4):
//   - canal SQS (alta frequência)
//   - WIN variável: aposta × multiplicador (1.01x–49.99x)
//   - ROLLBACK em massa: 1% das rodadas têm falha do servidor de crash →
//     ROLLBACK de todas as BETs da rodada
//   - fora de ordem: 10% dos ROLLBACK chegam antes da BET
type Crash struct {
	*core.BaseTable
}

func NewCrash(cfg *core.TableConfig) *Crash {
	return &Crash{BaseTable: core.NewBaseTable(cfg)}
}

func (t *Crash) Run(ctx context.Context, c *core.Core) (*core.TableResult, error) {
	return t.BaseTable.Run(ctx, c, t)
}

// RunRound executes a single crash round:
// 1. Each player places a BET (SQS)
// 2. Outcome: WIN (winRate — cash out, valor = aposta × multiplicador) or LOSS
// 3. If the round has a server failure (refundRate): ALL players receive a ROLLBACK
func (t *Crash) RunRound(ctx context.Context, c *core.Core, round int) error {
	var wg sync.WaitGroup
	errCh := make(chan error, t.Config().PlayersPerRound*2)

	roundFailed := t.Rng().Float64() < t.Config().RefundRate
	rollbackFirst := roundFailed && t.Rng().Float64() < t.Config().OutOfOrderRate

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
		var winMoney core.Money
		if t.Rng().Float64() < t.Config().WinRate {
			outcome = "WIN"
			if t.Config().WinMult > 0 {
				winMoney = core.Money{Cents: bet.Cents * t.Config().WinMult, Currency: "BRL"}
			} else {
				mult := 101 + t.Rng().Int63n(4900) // 101..4999 → 1.01x..49.99x
				winMoney = core.Money{
					Cents:    int64(float64(bet.Cents)*float64(mult)/100.0 + 0.5),
					Currency: "BRL",
				}
			}
		}

		wg.Add(1)
		go func(wallet core.WalletRef, bet core.Money, betExtID, betIdemKey string, outcome string, winMoney core.Money, rollbackFirst bool, i int) {
			defer wg.Done()

			if rollbackFirst {
				t.sendRollback(ctx, c, wallet, bet, betExtID, round, i, errCh)
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
				UseSQS:  true,
			}, errCh); err != nil {
				errCh <- err
			}

			if outcome == "WIN" {
				winExtID := fmt.Sprintf("%s-r%d-p%d-win", t.Name(), round, i)
				winIdemKey := fmt.Sprintf("%s:%s", t.Config().ProviderID, winExtID)
				if err := t.SendTransaction(ctx, c, core.TxRequest{
					Wallet:       wallet,
					Kind:         "WIN",
					Money:        winMoney,
					ExtID:        winExtID,
					IdemKey:      winIdemKey,
					Round:        round,
					RefExtID:     betExtID,
					UseSQS:       true,
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
					UseSQS:      true,
					OutcomeKind: "LOSS",
				}, errCh); err != nil {
					errCh <- err
				}
			}

			if roundFailed && !rollbackFirst {
				t.sendRollback(ctx, c, wallet, bet, betExtID, round, i, errCh)
			}
		}(wallet, bet, betExtID, betIdemKey, outcome, winMoney, rollbackFirst, i)
	}

	wg.Wait()
	close(errCh)
	return t.DrainErrCh(round, errCh)
}

func (t *Crash) sendRollback(ctx context.Context, c *core.Core, wallet core.WalletRef, bet core.Money, betExtID string, round, playerIdx int, errCh chan<- error) {
	extID := fmt.Sprintf("%s-r%d-p%d-rollback", t.Name(), round, playerIdx)
	idemKey := fmt.Sprintf("%s:%s", t.Config().ProviderID, extID)

	if err := t.SendTransaction(ctx, c, core.TxRequest{
		Wallet:       wallet,
		Kind:         "ROLLBACK",
		Money:        bet,
		ExtID:        extID,
		IdemKey:      idemKey,
		Round:        round,
		RefExtID:     betExtID,
		UseSQS:       true,
		OutcomeKind:  "ROLLBACK",
		OutcomeCents: bet.Cents,
	}, errCh); err != nil {
		errCh <- fmt.Errorf("ROLLBACK %s: %w", extID, err)
	}
}
