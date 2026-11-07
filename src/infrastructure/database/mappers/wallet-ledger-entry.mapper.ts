/**
 * Mappers de WalletLedgerEntry — entity ↔ domain (README §6.4).
 *
 * A entity é o "shell" de persistência; o domain é imutável e valida
 * a aritmética na factory `create`.
 */

import type { WalletLedgerEntry as WalletLedgerEntryEntity } from "../entities/wallet-ledger-entry.entity.js";
import type { LedgerDirection } from "../../../domain/enums/ledger-direction.js";
import {
  WalletLedgerEntry as WalletLedgerEntryDomain,
  type LedgerEntryState,
} from "../../../domain/wallet-ledger-entry.js";

/** Entity → estado de reidratação do domain. */
export function toLedgerEntryState(
  entity: WalletLedgerEntryEntity,
): LedgerEntryState {
  return {
    id: entity.id,
    walletId: entity.wallet.id,
    transactionId: entity.transaction.id,
    direction: entity.direction,
    amount: String(entity.amount),
    currency: entity.currency,
    balanceBefore: String(entity.balanceBefore),
    balanceAfter: String(entity.balanceAfter),
    createdAt: entity.createdAt,
  };
}

/** Entity → domain (reidratação). */
export function toLedgerEntryDomain(
  entity: WalletLedgerEntryEntity,
): WalletLedgerEntryDomain {
  return WalletLedgerEntryDomain.rehydrate(toLedgerEntryState(entity));
}

/** Domain → dados para `em.create(WalletLedgerEntry, ...)` (MikroORM v7 exige todos os campos). */
export function toLedgerEntryEntityData(
  entry: WalletLedgerEntryDomain,
): {
  id: string;
  wallet: string;
  transaction: string;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
} {
  return {
    id: entry.id,
    wallet: entry.walletId,
    transaction: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.amount,
    balanceAfter: entry.balanceAfter.amount,
    createdAt: entry.createdAt,
  };
}
