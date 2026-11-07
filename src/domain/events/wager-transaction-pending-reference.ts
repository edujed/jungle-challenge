/**
 * Evento: transação aguardando referência (ex.: WIN/LOSS antes do BET).
 */

import { randomUUID } from "node:crypto";
import { IntegrationEvent, type EventContext } from "./integration-event.js";

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  /**
   * Fábrica a partir da transação persistida (seção 11 do README).
   */
  static from(
    tx: {
      id: string;
      providerId: string;
      externalTransactionId: string;
      walletId: string;
      referenceExternalTransactionId: string | null;
    },
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
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
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? "",
      },
    });
  }
}
