/**
 * Use case: ApplyWagerTransaction
 *
 * Único caminho de processamento — usado tanto pelo HTTP (síncrono) quanto
 * pelo SQS (assíncrono). Normaliza o payload, calcula o payloadHash, chama
 * a stored procedure, e interpreta o resultado.
 */

import { createHash } from "node:crypto";
import type { Database } from "../infrastructure/database/db.js";
import { applyWagerTransaction, type ApplyTransactionResult } from "../infrastructure/database/apply-wager-transaction.js";
import type { WagerTransactionKind } from "../domain/enums/wager-transaction-kind.js";

export interface SubmitTransactionInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string | null;
  /** Nome do consumer (para dedup de inbox SQS). NULL para HTTP. */
  consumerName?: string | null;
  /** ID da mensagem SQS. NULL para HTTP. */
  messageId?: string | null;
}

export interface SubmitTransactionOutput {
  transactionId: string | null;
  status: string;
  failureCode: string | null;
  balanceAfter: string | null;
  idempotentReplay: boolean;
}

/**
 * Calcula o hash SHA-256 do JSON canônico dos campos de negócio.
 *
 * JSON canônico: chaves ordenadas alfabeticamente, sem espaços extras.
 * Campos incluídos: providerId, externalTransactionId, playerId, walletId,
 * roundId, gameId, kind, amount, currency, referenceExternalTransactionId.
 *
 * O header Idempotency-Key e metadados de transporte NÃO entram no hash.
 */
export function computePayloadHash(input: {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string | null;
}): string {
  const canonical = JSON.stringify({
    amount: input.amount,
    currency: input.currency,
    externalTransactionId: input.externalTransactionId,
    gameId: input.gameId,
    kind: input.kind,
    playerId: input.playerId,
    providerId: input.providerId,
    referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
    roundId: input.roundId,
    walletId: input.walletId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export async function applyWagerTransactionUseCase(
  db: Database,
  input: SubmitTransactionInput,
): Promise<SubmitTransactionOutput> {
  const payloadHash = computePayloadHash(input);

  const result: ApplyTransactionResult = await applyWagerTransaction(db, {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    idempotencyKey: input.idempotencyKey,
    payloadHash,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    amount: input.amount,
    currency: input.currency,
    referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
    consumerName: input.consumerName ?? null,
    messageId: input.messageId ?? null,
  });

  return {
    transactionId: result.transactionId,
    status: result.status,
    failureCode: result.failureCode,
    balanceAfter: result.balanceAfter,
    idempotentReplay: result.idempotentReplay,
  };
}
