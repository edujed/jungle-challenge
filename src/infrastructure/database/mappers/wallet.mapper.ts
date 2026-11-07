/**
 * Mappers de Wallet — entity ↔ domain (README §6.2).
 *
 * A entity é o "shell" de persistência; o domain encapsula as invariantes.
 */

import type { Wallet as WalletEntity } from "../entities/wallet.entity.js";
import { Wallet as WalletDomain, type WalletState } from "../../../domain/wallet.js";

/** Entity → estado de reidratação do domain. */
export function toWalletState(entity: WalletEntity): WalletState {
  return {
    id: entity.id,
    playerId: entity.playerId,
    currency: entity.currency,
    balance: String(entity.balance),
    version: Number(entity.version),
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}

/** Entity → domain (reidratação). */
export function toWalletDomain(entity: WalletEntity): WalletDomain {
  return WalletDomain.rehydrate(toWalletState(entity));
}

/** Domain → dados para `em.create(Wallet, ...)` (MikroORM v7 exige todos os campos). */
export function toWalletEntityData(wallet: WalletDomain): {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
} {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}
