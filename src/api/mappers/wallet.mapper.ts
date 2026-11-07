/**
 * Mappers de wallet — convertem entities em DTOs de API.
 */

import type { Wallet } from "../../infrastructure/database/entities/wallet.entity.js";

/** DTO de resposta para GET/POST de wallet. */
export interface WalletResponse {
  id: string;
  playerId: string;
  currency: string;
  balance: { amount: string; currency: string };
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Converte a entity Wallet para o DTO de API. */
export function toWalletResponse(wallet: Wallet): WalletResponse {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: {
      amount: String(wallet.balance),
      currency: wallet.currency,
    },
    version: Number(wallet.version),
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}
