/**
 * Evento: transação de aposta rejeitada.
 */

import { randomUUID } from "node:crypto";
import { IntegrationEvent, type EventContext } from "./integration-event.js";

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  failureCode: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  /**
   * Fábrica a partir da transação persistida (seção 11 do README).
   * `walletId` pode ser null (WALLET_NOT_FOUND) — nesse caso o
   * `aggregateId` usa o `transactionId` como fallback.
   */
  static from(
    tx: {
      id: string;
      providerId: string;
      externalTransactionId: string;
      walletId: string | null;
      failureCode: string;
    },
    ctx: EventContext,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected({
      eventId: randomUUID(),
      aggregateId: tx.walletId ?? tx.id,
      correlationId: tx.externalTransactionId,
      causationId: ctx.causationId,
      occurredAt: new Date(),
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId ?? "",
        failureCode: tx.failureCode,
      },
    });
  }
}
