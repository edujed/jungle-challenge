/**
 * Mappers de WagerTransaction — entity ↔ domain (README §6.3).
 *
 * A entity é o "shell" de persistência; o domain encapsula as invariantes
 * e as transições de estado.
 */

import type { WagerTransaction as WagerTransactionEntity } from "../entities/wager-transaction.entity.js";
import type { WagerTransactionKind } from "../../../domain/enums/wager-transaction-kind.js";
import type { WagerTransactionStatus } from "../../../domain/enums/wager-transaction-status.js";
import type { FailureCode } from "../../../domain/enums/failure-code.js";
import {
  WagerTransaction as WagerTransactionDomain,
  type WagerTransactionState,
} from "../../../domain/wager-transaction.js";

/** Entity → estado de reidratação do domain. */
export function toWagerTransactionState(
  entity: WagerTransactionEntity,
): WagerTransactionState {
  return {
    id: entity.id,
    providerId: entity.providerId,
    externalTransactionId: entity.externalTransactionId,
    idempotencyKey: entity.idempotencyKey,
    payloadHash: entity.payloadHash,
    walletId: entity.walletId,
    playerId: entity.playerId,
    roundId: entity.roundId,
    gameId: entity.gameId,
    kind: entity.kind,
    amount: String(entity.amount),
    currency: entity.currency,
    referenceExternalTransactionId: entity.referenceExternalTransactionId,
    referenceTransactionId: entity.referenceTransactionId,
    status: entity.status,
    failureCode: entity.failureCode,
    attempts: entity.attempts,
    nextAttemptAt: entity.nextAttemptAt,
    createdAt: entity.createdAt,
    processedAt: entity.processedAt,
  };
}

/** Entity → domain (reidratação). */
export function toWagerTransactionDomain(
  entity: WagerTransactionEntity,
): WagerTransactionDomain {
  return WagerTransactionDomain.rehydrate(toWagerTransactionState(entity));
}

/** Domain → dados para `em.upsert(WagerTransaction, ...)` (MikroORM v7 exige todos os campos). */
export function toWagerTransactionEntityData(tx: WagerTransactionDomain): {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string | null;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  processedAt: Date | null;
  attempts: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
} {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    amount: tx.money.amount,
    currency: tx.money.currency,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    referenceTransactionId: tx.referenceTransactionId,
    status: tx.status,
    failureCode: tx.failureCode,
    processedAt: tx.processedAt,
    attempts: tx.attempts,
    nextAttemptAt: tx.nextAttemptAt,
    createdAt: tx.createdAt,
  };
}
