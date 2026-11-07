/**
 * Evento: saldo da wallet alterado.
 */

import { randomUUID } from "node:crypto";
import type { MoneyProps } from "../money.js";
import type { LedgerDirection } from "../enums/ledger-direction.js";
import { IntegrationEvent, type EventContext } from "./integration-event.js";

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  /**
   * Fábrica a partir da wallet + ledger entry (seção 11 do README).
   * O `walletVersion` é o version da wallet APÓS o UPDATE atômico
   * (a entity em memória pode estar stale — por isso o parâmetro explícito).
   */
  static from(
    wallet: { id: string; currency: string },
    entry: {
      transactionId: string;
      direction: LedgerDirection;
      amount: string;
      currency: string;
      balanceBefore: string;
      balanceAfter: string;
    },
    walletVersion: number,
    ctx: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: randomUUID(),
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: new Date(),
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: { amount: entry.amount, currency: entry.currency },
        balanceBefore: { amount: entry.balanceBefore, currency: entry.currency },
        balanceAfter: { amount: entry.balanceAfter, currency: entry.currency },
        walletVersion,
      },
    });
  }
}
