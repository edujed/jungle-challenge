/**
 * Wallet — Aggregate Root (tabela `wallets`).
 *
 * Saldo materializado (cache derivado do ledger). Invariantes garantidas
 * no schema (migrations/001_tables.sql + 002_constraints.sql + 003_triggers.sql):
 *   - UNIQUE (player_id, currency)
 *   - CHECK (balance >= 0)
 *   - CHECK (version >= 1)
 *
 * Money é mapeado como string decimal (NUMERIC(15,2) no banco) — ver
 * ARCHITECTURE.md (decisão de mapeamento).
 */

import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
  Index,
  OneToMany,
} from "@mikro-orm/decorators/legacy";
import { Collection } from "@mikro-orm/core";
import { WalletLedgerEntry } from "./wallet-ledger-entry.entity.js";

@Entity({ tableName: "wallets" })
@Unique({ name: "uq_wallets_player_currency", properties: ["playerId", "currency"] })
export class Wallet {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Index({ name: "idx_wallets_player_id" })
  @Property({ type: "uuid" })
  playerId!: string;

  @Property({ type: "character", length: 3 })
  currency!: string;

  /** Saldo materializado — string decimal com 2 casas ("25.00"). */
  @Property({ type: "decimal", precision: 15, scale: 2 })
  balance!: string;

  @Property({ type: "bigint", runtimeType: "number" })
  version!: number;

  @Property({ type: "datetime", onCreate: () => new Date() })
  createdAt!: Date;

  @Property({ type: "datetime", onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt!: Date;

  @OneToMany(() => WalletLedgerEntry, (entry) => entry.wallet)
  ledgerEntries!: Collection<WalletLedgerEntry, Wallet>;
}
