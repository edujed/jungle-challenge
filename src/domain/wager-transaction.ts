/**
 * WagerTransaction (README §6.3).
 *
 * Construtor privado + factories estáticas (`create`, `rehydrate`).
 * Nasce em PENDING. Transições:
 *
 *   PENDING            → PROCESSED   (markProcessed)
 *   PENDING            → REJECTED    (reject)
 *   PENDING            → FAILED      (fail)
 *   PENDING            → PENDING_REFERENCE (markPendingReference)
 *   PENDING_REFERENCE  → PROCESSED   (markProcessed)
 *   PENDING_REFERENCE  → REJECTED    (reject)
 *   PENDING_REFERENCE  → FAILED      (fail)
 *
 * `PROCESSED`, `REJECTED` e `FAILED` são terminais: tentar transicionar
 * a partir deles lança `InvalidTransactionStateError` (erro de
 * programação, não caminho de negócio).
 *
 * A reidratação (`rehydrate`) não revalida transições (README §6.0).
 */

import { Money } from "./money.js";
import type { WagerTransactionKind } from "./enums/wager-transaction-kind.js";
import type { WagerTransactionStatus } from "./enums/wager-transaction-status.js";
import type { FailureCode } from "./enums/failure-code.js";
import type { LedgerDirection } from "./enums/ledger-direction.js";
import { InvalidTransactionStateError } from "./errors/invalid-transaction-state-error.js";

export interface CreateWagerTransactionProps {
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
  money: Money;
  referenceExternalTransactionId?: string | null;
  createdAt: Date;
}

export interface WagerTransactionState {
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
  attempts: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  processedAt: Date | null;
}

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string | null;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | null;
  readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | null;
  private _failureCode: FailureCode | null;
  private _processedAt: Date | null;
  private _attempts: number;
  private _nextAttemptAt: Date | null;

  private constructor(
    id: string,
    providerId: string,
    externalTransactionId: string,
    idempotencyKey: string,
    payloadHash: string,
    walletId: string | null,
    playerId: string,
    roundId: string,
    gameId: string,
    kind: WagerTransactionKind,
    money: Money,
    referenceExternalTransactionId: string | null,
    createdAt: Date,
    status: WagerTransactionStatus,
    referenceTransactionId: string | null,
    failureCode: FailureCode | null,
    processedAt: Date | null,
    attempts: number,
    nextAttemptAt: Date | null,
  ) {
    this.id = id;
    this.providerId = providerId;
    this.externalTransactionId = externalTransactionId;
    this.idempotencyKey = idempotencyKey;
    this.payloadHash = payloadHash;
    this.walletId = walletId;
    this.playerId = playerId;
    this.roundId = roundId;
    this.gameId = gameId;
    this.kind = kind;
    this.money = money;
    this.referenceExternalTransactionId = referenceExternalTransactionId;
    this.createdAt = createdAt;
    this._status = status;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = failureCode;
    this._processedAt = processedAt;
    this._attempts = attempts;
    this._nextAttemptAt = nextAttemptAt;
  }

  /**
   * Cria uma transação nova (nasce em PENDING).
   * Valida a exigência de referência por kind (REFUND/ROLLBACK exigem
   * `referenceExternalTransactionId`).
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (
      (props.kind === "REFUND" || props.kind === "ROLLBACK") &&
      !props.referenceExternalTransactionId
    ) {
      throw new Error(
        `kind ${props.kind} requires referenceExternalTransactionId`,
      );
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId ?? null,
      props.createdAt,
      "PENDING",
      null,
      null,
      null,
      0,
      null,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.from(state.amount, state.currency),
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.attempts,
      state.nextAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | null {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | null {
    return this._failureCode;
  }

  get processedAt(): Date | null {
    return this._processedAt;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | null {
    return this._nextAttemptAt;
  }

  // ─── Transições ──────────────────────────────────────────────────────────

  /** PENDING/PENDING_REFERENCE → PROCESSED (terminal). */
  markProcessed(referenceTransactionId: string | null, at: Date): void {
    this.assertTransitionable("PROCESSED");
    this._status = "PROCESSED";
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._nextAttemptAt = null;
  }

  /** PENDING → PENDING_REFERENCE (referência ausente). */
  markPendingReference(): void {
    this.assertTransitionable("PENDING_REFERENCE");
    this._status = "PENDING_REFERENCE";
  }

  /** PENDING/PENDING_REFERENCE → REJECTED (terminal). */
  reject(code: FailureCode): void {
    this.assertTransitionable("REJECTED");
    this._status = "REJECTED";
    this._failureCode = code;
  }

  /** PENDING/PENDING_REFERENCE → FAILED (terminal, auditável). */
  fail(code: FailureCode): void {
    this.assertTransitionable("FAILED");
    this._status = "FAILED";
    this._failureCode = code;
  }

  /** Incrementa `attempts` e agenda o próximo retry (backoff). */
  scheduleRetry(attempts: number, nextAttemptAt: Date): void {
    this._attempts = attempts;
    this._nextAttemptAt = nextAttemptAt;
  }

  // ─── Consultas de domínio ────────────────────────────────────────────────

  isTerminal(): boolean {
    return (
      this._status === "PROCESSED" ||
      this._status === "REJECTED" ||
      this._status === "FAILED"
    );
  }

  /** `false` para LOSS (não move saldo). */
  affectsBalance(): boolean {
    return this.kind !== "LOSS";
  }

  /** `true` para REFUND e ROLLBACK. */
  requiresReference(): boolean {
    return this.kind === "REFUND" || this.kind === "ROLLBACK";
  }

  /** Mesma idempotency key com payload diferente é conflito, não replay. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento no ledger.
   * - BET → DEBIT
   * - WIN/REFUND → CREDIT
   * - ROLLBACK → inverso da referência (BET→CREDIT, WIN/REFUND→DEBIT)
   * - LOSS → null (não gera lançamento)
   */
  ledgerDirectionFor(reference?: WagerTransaction | null): LedgerDirection | null {
    switch (this.kind) {
      case "BET":
        return "DEBIT";
      case "WIN":
      case "REFUND":
        return "CREDIT";
      case "ROLLBACK": {
        if (!reference) return null;
        return reference.kind === "BET" ? "CREDIT" : "DEBIT";
      }
      case "LOSS":
      case "OPENING":
        return null;
    }
  }

  private assertTransitionable(target: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, target);
    }
  }
}
