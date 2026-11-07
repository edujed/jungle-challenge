/**
 * Mappers de transação — convertem entities/resultados em DTOs de API.
 */

import type { WagerTransaction } from "../../infrastructure/database/entities/wager-transaction.entity.js";
import type { SubmitTransactionOutput } from "../../usecases/apply-wager-transaction.js";

/** DTO de resposta para GET de transação. */
export interface TransactionResponse {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string | null;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId: string | null;
  status: string;
  failureCode: string | null;
  processedAt: Date | null;
  createdAt: Date;
}

/** DTO de resposta para POST de transação (submit). */
export interface SubmitTransactionResponse {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string } | null;
  failureCode: string | null;
  idempotentReplay: boolean;
}

/** Converte a entity WagerTransaction para o DTO de consulta. */
export function toTransactionResponse(tx: WagerTransaction): TransactionResponse {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    playerId: tx.playerId,
    walletId: tx.walletId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: { amount: String(tx.amount), currency: tx.currency },
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    status: tx.status,
    failureCode: tx.failureCode,
    processedAt: tx.processedAt,
    createdAt: tx.createdAt,
  };
}

/** Converte o resultado do use case para o DTO de submit. */
export function toSubmitTransactionResponse(
  result: SubmitTransactionOutput,
  currency: string,
): SubmitTransactionResponse {
  return {
    transactionId: result.transactionId ?? "",
    status: result.status,
    balance: result.balanceAfter ? { amount: result.balanceAfter, currency } : null,
    failureCode: result.failureCode,
    idempotentReplay: result.idempotentReplay,
  };
}
