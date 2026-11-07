/**
 * Bloco transacional de aplicação de transação de aposta (ADR-012).
 *
 * Substitui a antiga stored procedure `apply_wager_transaction`.
 * Orquestra ~8 operações em uma única transação PostgreSQL via
 * `em.transactional(forkedEm)`:
 *
 *   1. Inbox dedup (SQS) — upsert ON CONFLICT DO NOTHING
 *   2. Idempotência — find por idempotency_key
 *   3. Validações (wallet, currency, player, kind, referência)
 *   4. UPDATE atômico do saldo (WHERE balance >= amount)
 *   5. INSERT transação (ON CONFLICT idempotency_key DO NOTHING)
 *   6. INSERT ledger entry (balanceBefore/After derivados)
 *   7. INSERT outbox events
 *
 * Concorrência: o UPDATE ... WHERE balance >= :amount RETURNING balance
 * é a primitiva atômica. Duas apostas de 80 com saldo 100 → uma
 * PROCESSED, uma REJECTED (INSUFFICIENT_BALANCE). Sem lock pessimista.
 *
 * Regra de ouro: SEMPRE usar o `forkedEm` dentro do `transactional`.
 */

import { raw } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/core";
import type { SqlEntityManager } from "@mikro-orm/sql";
import type { Database } from "./db.js";
import { Money } from "../../domain/money.js";
import type { WagerTransactionKind } from "../../domain/enums/wager-transaction-kind.js";
import type { WagerTransactionStatus } from "../../domain/enums/wager-transaction-status.js";
import type { FailureCode } from "../../domain/enums/failure-code.js";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed.js";
import { WagerTransactionRejected } from "../../domain/events/wager-transaction-rejected.js";
import { WagerTransactionPendingReference } from "../../domain/events/wager-transaction-pending-reference.js";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed.js";
import { Wallet } from "./entities/wallet.entity.js";
import { WagerTransaction } from "./entities/wager-transaction.entity.js";
import { WalletLedgerEntry } from "./entities/wallet-ledger-entry.entity.js";
import { InboxMessage } from "./entities/inbox-message.entity.js";
import { OutboxMessage } from "./entities/outbox-message.entity.js";
import { toWalletDomain } from "./mappers/wallet.mapper.js";
import { toWagerTransactionDomain } from "./mappers/wager-transaction.mapper.js";
import type { WagerTransaction as WagerTransactionDomain } from "../../domain/wager-transaction.js";
import { toLedgerEntryEntityData } from "./mappers/wallet-ledger-entry.mapper.js";
import { toOutboxMessageEntityData } from "./mappers/outbox-message.mapper.js";
import { WalletLedgerEntry as WalletLedgerEntryDomain } from "../../domain/wallet-ledger-entry.js";
import { OutboxMessage as OutboxMessageDomain } from "../../domain/outbox-message.js";
import type { IntegrationEvent } from "../../domain/events/integration-event.js";

export interface ApplyTransactionParams {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string | null;
  /** Nome do consumer SQS (NULL para HTTP). */
  consumerName?: string | null;
  /** ID da mensagem SQS (NULL para HTTP). */
  messageId?: string | null;
}

export interface ApplyTransactionResult {
  transactionId: string | null;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  balanceAfter: string | null;
  idempotentReplay: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Cria um resultado REJECTED padronizado.
 */
function rejectedResult(
  transactionId: string,
  failureCode: FailureCode,
): ApplyTransactionResult {
  return {
    transactionId,
    status: "REJECTED" as WagerTransactionStatus,
    failureCode,
    balanceAfter: null,
    idempotentReplay: false,
  };
}

/**
 * Cria um resultado PENDING_REFERENCE padronizado.
 */
function pendingReferenceResult(transactionId: string): ApplyTransactionResult {
  return {
    transactionId,
    status: "PENDING_REFERENCE" as WagerTransactionStatus,
    failureCode: null,
    balanceAfter: null,
    idempotentReplay: false,
  };
}

/**
 * Cria e persiste uma mensagem de outbox a partir de um evento.
 */
async function persistOutboxEvent(
  em: EntityManager,
  event: IntegrationEvent<unknown>,
): Promise<void> {
  const outbox = em.create(OutboxMessage, toOutboxMessageEntityData(OutboxMessageDomain.enqueue(event)));
  await em.persist(outbox);
  await em.flush();
}

/**
 * Lê uma transação existente pelo (provider_id, external_transaction_id).
 */
async function fetchExistingByProvider(
  em: EntityManager,
  providerId: string,
  externalTransactionId: string,
): Promise<ApplyTransactionResult | null> {
  const tx = await em.findOne(WagerTransaction, { providerId, externalTransactionId });
  if (!tx) return null;

  const ledger = await em.findOne(WalletLedgerEntry, { transaction: tx.id });
  return {
    transactionId: tx.id,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    balanceAfter: ledger?.balanceAfter != null ? String(ledger.balanceAfter) : null,
    idempotentReplay: true,
  };
}

/**
 * UPDATE atômico do saldo via QueryBuilder (decisão #3 — migrado de SQL raw).
 *
 * - direction "DEBIT":  balance = balance - amount, exige balance >= amount
 * - direction "CREDIT": balance = balance + amount
 * - direction "REVERT_DEBIT":  balance = balance + amount (reverte um débito)
 * - direction "REVERT_CREDIT": balance = balance - amount (reverte um crédito)
 *
 * Retorna o novo saldo (string) ou null se nenhuma linha foi afetada.
 */
async function atomicBalanceUpdate(
  em: SqlEntityManager,
  walletId: string,
  amount: string,
  direction: "DEBIT" | "CREDIT" | "REVERT_DEBIT" | "REVERT_CREDIT",
): Promise<string | null> {
  const op = direction === "DEBIT" || direction === "REVERT_CREDIT" ? "-" : "+";
  const qb = em
    .createQueryBuilder(Wallet, "w")
    .update({
      balance: raw(`balance ${op} ?::NUMERIC`, [amount]),
      version: raw("version + 1"),
    })
    .where({ id: walletId });

  // DEBIT e REVERT_CREDIT podem reduzir o saldo — exigem balance >= amount
  // para garantir o invariante de não-negatividade (seção 5.9 do README).
  if (direction === "DEBIT" || direction === "REVERT_CREDIT") {
    qb.andWhere("w.balance >= ?::NUMERIC", [amount]);
  }

  const result = await qb.returning("balance").execute("run");
  const row = result.row as { balance: string } | undefined;
  return row ? String(row.balance) : null;
}

/**
 * Insere uma transação com status e failure code específicos.
 * Usado nos caminhos de rejeição (antes do row lock na wallet).
 */
async function insertTransaction(
  em: EntityManager,
  txId: string,
  params: ApplyTransactionParams,
  status: WagerTransactionStatus,
  failureCode: FailureCode | null,
  referenceTransactionId: string | null,
  walletIdOverride?: string | null,
): Promise<void> {
  // walletIdOverride permite passar null no caso WALLET_NOT_FOUND
  // (wallet inexistente → wallet_id = NULL, válido no schema)
  const effectiveWalletId = walletIdOverride !== undefined ? walletIdOverride : params.walletId;

  await em.upsert(
    WagerTransaction,
    {
      id: txId,
      providerId: params.providerId,
      externalTransactionId: params.externalTransactionId,
      idempotencyKey: params.idempotencyKey,
      payloadHash: params.payloadHash,
      walletId: effectiveWalletId,
      playerId: params.playerId,
      roundId: params.roundId,
      gameId: params.gameId,
      kind: params.kind,
      amount: params.amount,
      currency: params.currency,
      referenceExternalTransactionId: params.referenceExternalTransactionId ?? null,
      referenceTransactionId,
      status,
      failureCode,
      processedAt: status === "PROCESSED" ? new Date() : null,
      attempts: 0,
      // PENDING_REFERENCE: worker de retry varre por next_attempt_at (seção 7.1).
      // Primeira tentativa imediata (now) — o backoff exponencial é aplicado
      // pelo pending-reference-worker a cada nova tentativa.
      nextAttemptAt: status === "PENDING_REFERENCE" ? new Date() : null,
      createdAt: new Date(),
    },
    { onConflictFields: ["idempotencyKey"], onConflictAction: "ignore" },
  );

  // Eventos de outbox para estados não-PROCESSED (seção 11 do README):
  //   - REJECTED → WagerTransactionRejected
  //   - PENDING_REFERENCE → WagerTransactionPendingReference
  if (status === "REJECTED") {
    const event = WagerTransactionRejected.from(
      {
        id: txId,
        providerId: params.providerId,
        externalTransactionId: params.externalTransactionId,
        walletId: effectiveWalletId,
        failureCode: failureCode ?? "UNKNOWN",
      },
      { correlationId: params.externalTransactionId },
    );
    await persistOutboxEvent(em, event);
  } else if (status === "PENDING_REFERENCE") {
    const event = WagerTransactionPendingReference.from(
      {
        id: txId,
        providerId: params.providerId,
        externalTransactionId: params.externalTransactionId,
        walletId: params.walletId,
        referenceExternalTransactionId: params.referenceExternalTransactionId ?? null,
      },
      { correlationId: params.externalTransactionId },
    );
    await persistOutboxEvent(em, event);
  }
}

// ─── Função principal ──────────────────────────────────────────────────────

export async function applyWagerTransaction(
  db: Database,
  params: ApplyTransactionParams,
): Promise<ApplyTransactionResult> {
  const txId = crypto.randomUUID();

  return db.em.transactional(async (forkedEm) => {
    // ── 1. Inbox dedup (somente SQS) ────────────────────────────────────
    if (params.consumerName && params.messageId) {
      await forkedEm.upsert(
        InboxMessage,
        {
          consumerName: params.consumerName,
          messageId: params.messageId,
          payloadHash: params.payloadHash,
          processedAt: null,
        },
        { onConflictFields: ["consumerName", "messageId"], onConflictAction: "ignore" },
      );

      // Verifica se a mensagem já existia (replay SQS)
      const existingInbox = await forkedEm.findOne(InboxMessage, {
        consumerName: params.consumerName,
        messageId: params.messageId,
      });
      if (existingInbox) {
        // Mensagem já vista → tenta replay idempotente
        const existing = await fetchExistingByProvider(
          forkedEm,
          params.providerId,
          params.externalTransactionId,
        );
        if (existing) return existing;
        // Mensagem já vista mas transação não existe (ex: crash entre inbox e tx)
        // → continua o fluxo normal
      }
    }

    // ── 2. Idempotência: SELECT rápido (sem lock) ───────────────────────
    const existingCheck = await forkedEm.findOne(WagerTransaction, {
      idempotencyKey: params.idempotencyKey,
    });

    if (existingCheck) {
      if (existingCheck.payloadHash !== params.payloadHash) {
        return rejectedResult(existingCheck.id, "IDEMPOTENCY_CONFLICT" as FailureCode);
      }
      const ledger = await forkedEm.findOne(WalletLedgerEntry, { transaction: existingCheck.id });
      return {
        transactionId: existingCheck.id,
        status: existingCheck.status,
        failureCode: existingCheck.failureCode ?? null,
        balanceAfter: ledger?.balanceAfter != null ? String(ledger.balanceAfter) : null,
        idempotentReplay: true,
      };
    }

    // ── 3. Validações PRÉ-INSERT (sem lock) ─────────────────────────────
    const walletEntity = await forkedEm.findOne(Wallet, { id: params.walletId });

    if (!walletEntity) {
      // Wallet inexistente → persiste com wallet_id = NULL (válido no schema)
      await insertTransaction(forkedEm, txId, params, "REJECTED", "WALLET_NOT_FOUND", null, null);
      return rejectedResult(txId, "WALLET_NOT_FOUND" as FailureCode);
    }

    const wallet = toWalletDomain(walletEntity);

    if (wallet.currency !== params.currency) {
      await insertTransaction(forkedEm, txId, params, "REJECTED", "CURRENCY_MISMATCH", null);
      return rejectedResult(txId, "CURRENCY_MISMATCH" as FailureCode);
    }

    if (wallet.playerId !== params.playerId) {
      await insertTransaction(forkedEm, txId, params, "REJECTED", "PLAYER_WALLET_MISMATCH", null);
      return rejectedResult(txId, "PLAYER_WALLET_MISMATCH" as FailureCode);
    }

    if (params.kind === "OPENING") {
      await insertTransaction(forkedEm, txId, params, "REJECTED", "OPENING_NOT_ALLOWED", null);
      return rejectedResult(txId, "OPENING_NOT_ALLOWED" as FailureCode);
    }

    // ── 4. Referências (REFUND/ROLLBACK) ────────────────────────────────
    let referenceTx: WagerTransaction | null = null;
    let referenceTxDomain: WagerTransactionDomain | null = null;

    if (params.kind === "REFUND" || params.kind === "ROLLBACK") {
      if (!params.referenceExternalTransactionId) {
        await insertTransaction(forkedEm, txId, params, "REJECTED", "REFERENCE_NOT_FOUND", null);
        return rejectedResult(txId, "REFERENCE_NOT_FOUND" as FailureCode);
      }

      referenceTx = await forkedEm.findOne(WagerTransaction, {
        providerId: params.providerId,
        externalTransactionId: params.referenceExternalTransactionId,
      });

      if (!referenceTx) {
        await insertTransaction(forkedEm, txId, params, "PENDING_REFERENCE", null, null);
        return pendingReferenceResult(txId);
      }

      referenceTxDomain = toWagerTransactionDomain(referenceTx);

      if (referenceTxDomain.status !== "PROCESSED") {
        await insertTransaction(forkedEm, txId, params, "PENDING_REFERENCE", null, null);
        return pendingReferenceResult(txId);
      }

      if (params.kind === "REFUND" && referenceTxDomain.kind !== "BET") {
        await insertTransaction(forkedEm, txId, params, "REJECTED", "INVALID_REFERENCE_KIND", null);
        return rejectedResult(txId, "INVALID_REFERENCE_KIND" as FailureCode);
      }

      if (params.kind === "ROLLBACK" && !["BET", "WIN", "REFUND"].includes(referenceTxDomain.kind)) {
        await insertTransaction(forkedEm, txId, params, "REJECTED", "INVALID_REFERENCE_KIND", null);
        return rejectedResult(txId, "INVALID_REFERENCE_KIND" as FailureCode);
      }

      if (
        referenceTxDomain.walletId !== params.walletId ||
        referenceTxDomain.playerId !== params.playerId ||
        referenceTxDomain.money.currency !== params.currency ||
        referenceTxDomain.roundId !== params.roundId
      ) {
        await insertTransaction(forkedEm, txId, params, "REJECTED", "REFERENCE_MISMATCH", null);
        return rejectedResult(txId, "REFERENCE_MISMATCH" as FailureCode);
      }

      if (referenceTxDomain.money.amount !== params.amount) {
        await insertTransaction(forkedEm, txId, params, "REJECTED", "AMOUNT_MISMATCH", null);
        return rejectedResult(txId, "AMOUNT_MISMATCH" as FailureCode);
      }

      // Verifica se já existe uma reversão PROCESSED para esta referência
      const alreadyReversed = await forkedEm.findOne(WagerTransaction, {
        referenceExternalTransactionId: params.referenceExternalTransactionId,
        kind: { $in: ["REFUND", "ROLLBACK"] },
        status: "PROCESSED",
      });
      if (alreadyReversed) {
        await insertTransaction(forkedEm, txId, params, "REJECTED", "ALREADY_REVERSED", null);
        return rejectedResult(txId, "ALREADY_REVERSED" as FailureCode);
      }
    }

    // ── 5. UPDATE atômico do saldo (ROW LOCK) ───────────────────────────
    // ESTA É A PRIMEIRA OPERAÇÃO QUE ADQUIRE ROW LOCK NA WALLET.
    // Todas as validações acima são read-only (sem lock).
    // O UPDATE ... WHERE balance >= :amount RETURNING balance é atômico.

    const isDebit = params.kind === "BET";
    const isCredit = ["WIN", "REFUND", "ROLLBACK"].includes(params.kind);
    const noBalanceChange = params.kind === "LOSS";

    let balanceAfter: string | null = null;
    let balanceBefore: string | null = null;

    if (isDebit) {
      // UPDATE atômico: balance = balance - amount WHERE balance >= amount
      balanceAfter = await atomicBalanceUpdate(forkedEm, params.walletId, params.amount, "DEBIT");

      if (balanceAfter === null) {
        await insertTransaction(forkedEm, txId, params, "REJECTED", "INSUFFICIENT_BALANCE", null);
        return rejectedResult(txId, "INSUFFICIENT_BALANCE" as FailureCode);
      }
      // Usa Money para evitar erros de ponto flutuante
      const afterMoney = Money.from(balanceAfter, params.currency);
      const amountMoney = Money.from(params.amount, params.currency);
      balanceBefore = afterMoney.add(amountMoney).amount;
      wallet.applyAtomicUpdate(afterMoney, wallet.version + 1);
    } else if (isCredit) {
      // UPDATE atômico: balance = balance + amount
      balanceAfter = await atomicBalanceUpdate(forkedEm, params.walletId, params.amount, "CREDIT");

      if (balanceAfter === null) {
        await insertTransaction(forkedEm, txId, params, "REJECTED", "WALLET_NOT_FOUND", null);
        return rejectedResult(txId, "WALLET_NOT_FOUND" as FailureCode);
      }
      // Usa Money para evitar erros de ponto flutuante
      const afterMoney = Money.from(balanceAfter, params.currency);
      const amountMoney = Money.from(params.amount, params.currency);
      balanceBefore = afterMoney.sub(amountMoney).amount;
      wallet.applyAtomicUpdate(afterMoney, wallet.version + 1);
    } else {
      // LOSS: saldo não muda
      balanceAfter = wallet.balance.amount;
      balanceBefore = wallet.balance.amount;
    }

    // ── 6. INSERT transação (DEPOIS do row lock) ─────────────────────────
    // Agora que o row lock está adquirido, inserimos a transação.
    // Se houver race condition na idempotency_key, ON CONFLICT DO NOTHING
    // retorna affectedRows=0 e fazemos replay.
    await forkedEm.upsert(
      WagerTransaction,
      {
        id: txId,
        providerId: params.providerId,
        externalTransactionId: params.externalTransactionId,
        idempotencyKey: params.idempotencyKey,
        payloadHash: params.payloadHash,
        walletId: params.walletId,
        playerId: params.playerId,
        roundId: params.roundId,
        gameId: params.gameId,
        kind: params.kind,
        amount: params.amount,
        currency: params.currency,
        referenceExternalTransactionId: params.referenceExternalTransactionId ?? null,
        referenceTransactionId: referenceTx?.id ?? null,
        status: "PROCESSED",
        failureCode: null,
        processedAt: new Date(),
        attempts: 0,
        nextAttemptAt: null,
        createdAt: new Date(),
      },
      { onConflictFields: ["idempotencyKey"], onConflictAction: "ignore" },
    );

    // Verifica se o INSERT realmente inseriu (ou se já existia)
    const checkInserted = await forkedEm.findOne(WagerTransaction, { idempotencyKey: params.idempotencyKey });
    if (checkInserted && checkInserted.id !== txId) {
      // Race condition: outra transação inseriu a mesma key.
      // Reverte o UPDATE do saldo e faz replay.
      if (isDebit) {
        await atomicBalanceUpdate(forkedEm, params.walletId, params.amount, "REVERT_DEBIT");
      } else if (isCredit) {
        await atomicBalanceUpdate(forkedEm, params.walletId, params.amount, "REVERT_CREDIT");
      }

      if (checkInserted.payloadHash !== params.payloadHash) {
        return rejectedResult(checkInserted.id, "IDEMPOTENCY_CONFLICT" as FailureCode);
      }
      const ledger = await forkedEm.findOne(WalletLedgerEntry, { transaction: checkInserted.id });
      return {
        transactionId: checkInserted.id,
        status: checkInserted.status,
        failureCode: checkInserted.failureCode ?? null,
        balanceAfter: ledger?.balanceAfter != null ? String(ledger.balanceAfter) : null,
        idempotentReplay: true,
      };
    }

    // ── 7. Ledger entry (se houve mudança de saldo) ─────────────────────
    if (!noBalanceChange) {
      const direction = isDebit ? "DEBIT" : "CREDIT";
      const ledgerEntry = WalletLedgerEntryDomain.create({
        id: crypto.randomUUID(),
        walletId: wallet.id,
        transactionId: txId,
        direction,
        money: Money.from(params.amount, params.currency),
        balanceBefore: Money.from(balanceBefore!, params.currency),
        balanceAfter: Money.from(balanceAfter!, params.currency),
        createdAt: new Date(),
      });
      const persistedEntry = forkedEm.create(WalletLedgerEntry, toLedgerEntryEntityData(ledgerEntry));
      await forkedEm.persist(persistedEntry);
      await forkedEm.flush();
    }

    // ── 8. Outbox events ────────────────────────────────────────────────

    const processedEvent = WagerTransactionProcessed.from(
      {
        id: txId,
        providerId: params.providerId,
        externalTransactionId: params.externalTransactionId,
        walletId: params.walletId,
        kind: params.kind,
        amount: params.amount,
        currency: params.currency,
      },
      Money.from(balanceAfter!, params.currency),
      { correlationId: params.externalTransactionId },
    );
    await persistOutboxEvent(forkedEm, processedEvent);

    if (!noBalanceChange) {
      const balanceEvent = WalletBalanceChanged.from(
        { id: wallet.id, currency: wallet.currency },
        {
          transactionId: txId,
          direction: isDebit ? "DEBIT" : "CREDIT",
          amount: params.amount,
          currency: params.currency,
          balanceBefore: balanceBefore!,
          balanceAfter: balanceAfter!,
        },
        wallet.version,
        { correlationId: params.externalTransactionId },
      );
      await persistOutboxEvent(forkedEm, balanceEvent);
    }

    return {
      transactionId: txId,
      status: "PROCESSED" as WagerTransactionStatus,
      failureCode: null,
      balanceAfter,
      idempotentReplay: false,
    };
  });
}
