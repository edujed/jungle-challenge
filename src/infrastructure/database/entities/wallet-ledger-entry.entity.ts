/**
 * WalletLedgerEntry (tabela `wallet_ledger_entries`) — IMUTÁVEL.
 *
 * Fonte de verdade auditável do saldo. Invariantes garantidas no schema
 * (migrations/001_tables.sql + 002_constraints.sql + 003_triggers.sql):
 *   - CHECK (amount > 0)
 *   - CHECK (balance_before >= 0), CHECK (balance_after >= 0)
 *   - CHECK de aritmética: DEBIT → before - amount = after; CREDIT → before + amount = after
 *   - UNIQUE (transaction_id)
 *   - Triggers bloqueiam UPDATE e DELETE
 */

import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
  Index,
  ManyToOne,
} from "@mikro-orm/decorators/legacy";
import type { Rel } from "@mikro-orm/core";
import type { LedgerDirection } from "../../../domain/enums/ledger-direction.js";
import { Wallet } from "./wallet.entity.js";
import { WagerTransaction } from "./wager-transaction.entity.js";

@Entity({ tableName: "wallet_ledger_entries" })
@Unique({ name: "uq_ledger_transaction", properties: ["transaction"] })
export class WalletLedgerEntry {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Index({ name: "idx_ledger_wallet_created" })
  @ManyToOne(() => Wallet, { fieldName: "wallet_id" })
  wallet!: Rel<Wallet>;

  @ManyToOne(() => WagerTransaction, { fieldName: "transaction_id" })
  transaction!: Rel<WagerTransaction>;

  @Property({ type: "string", length: 6 })
  direction!: LedgerDirection;

  /** String decimal com 2 casas ("25.00"). */
  @Property({ type: "decimal", precision: 15, scale: 2 })
  amount!: string;

  @Property({ type: "character", length: 3 })
  currency!: string;

  @Property({ type: "decimal", precision: 15, scale: 2 })
  balanceBefore!: string;

  @Property({ type: "decimal", precision: 15, scale: 2 })
  balanceAfter!: string;

  @Property({ type: "datetime", onCreate: () => new Date() })
  createdAt!: Date;
}
