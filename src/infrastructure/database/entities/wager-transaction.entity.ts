/**
 * WagerTransaction (tabela `wager_transactions`).
 *
 * Invariantes garantidas no schema (migrations/001_tables.sql + 002_constraints.sql + 003_triggers.sql):
 *   - UNIQUE (idempotency_key)
 *   - UNIQUE (provider_id, external_transaction_id)
 *   - CHECK (kind IN (...)), CHECK (status IN (...))
 *   - CHECK (amount >= 0)
 *   - CHECK (currency ~ '^[A-Z]{3}$')
 *   - CHECK: REFUND/ROLLBACK exigem reference_external_transaction_id
 *   - Trigger: bloqueia transição a partir de estado terminal
 */

import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
  Index,
} from "@mikro-orm/decorators/legacy";
import type { WagerTransactionKind } from "../../../domain/enums/wager-transaction-kind.js";
import type { WagerTransactionStatus } from "../../../domain/enums/wager-transaction-status.js";
import type { FailureCode } from "../../../domain/enums/failure-code.js";

@Entity({ tableName: "wager_transactions" })
@Unique({ name: "uq_wager_transactions_idempotency_key", properties: ["idempotencyKey"] })
@Unique({ name: "uq_wager_transactions_provider_ext", properties: ["providerId", "externalTransactionId"] })
export class WagerTransaction {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "string", length: 128 })
  providerId!: string;

  @Property({ type: "string", length: 256 })
  externalTransactionId!: string;

  @Property({ type: "string", length: 256 })
  idempotencyKey!: string;

  @Property({ type: "string", length: 64 })
  payloadHash!: string;

  @Property({ type: "uuid", nullable: true })
  walletId!: string | null;

  @Property({ type: "uuid" })
  playerId!: string;

  @Index({ name: "idx_wager_transactions_round" })
  @Property({ type: "string", length: 256 })
  roundId!: string;

  @Property({ type: "string", length: 128 })
  gameId!: string;

  @Property({ type: "string", length: 10 })
  kind!: WagerTransactionKind;

  /** String decimal com 2 casas ("25.00"). */
  @Property({ type: "decimal", precision: 15, scale: 2 })
  amount!: string;

  @Property({ type: "character", length: 3 })
  currency!: string;

  @Property({ type: "string", length: 256, nullable: true })
  referenceExternalTransactionId!: string | null;

  @Property({ type: "uuid", nullable: true })
  referenceTransactionId!: string | null;

  @Property({ type: "string", length: 20 })
  status!: WagerTransactionStatus;

  @Property({ type: "string", length: 50, nullable: true })
  failureCode!: FailureCode | null;

  @Property({ type: "int" })
  attempts!: number;

  @Index({ name: "idx_wager_transactions_pending_ref" })
  @Property({ type: "datetime", nullable: true })
  nextAttemptAt!: Date | null;

  @Property({ type: "datetime", onCreate: () => new Date() })
  createdAt!: Date;

  @Property({ type: "datetime", nullable: true })
  processedAt!: Date | null;
}
