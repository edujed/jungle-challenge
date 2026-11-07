/**
 * Evento: transação de aposta processada com sucesso.
 */

import { randomUUID } from "node:crypto";
import { Money, type MoneyProps } from "../money.js";
import { IntegrationEvent, type EventContext } from "./integration-event.js";

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  money: MoneyProps;
  balance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  /**
   * Fábrica a partir da transação persistida (seção 11 do README).
   * O `balance` é o saldo apó a transação (para LOSS, o saldo inalterado).
   */
  static from(
    tx: {
      id: string;
      providerId: string;
      externalTransactionId: string;
      walletId: string;
      kind: string;
      amount: string;
      currency: string;
    },
    balance: Money,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: randomUUID(),
      aggregateId: tx.walletId,
      correlationId: tx.externalTransactionId,
      causationId: ctx.causationId,
      occurredAt: new Date(),
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        money: { amount: tx.amount, currency: tx.currency },
        balance: balance.toProps(),
      },
    });
  }
}
