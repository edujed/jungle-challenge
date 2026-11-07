/**
 * Direção de lançamento no ledger da wallet.
 */

export const LedgerDirection = {
  DEBIT: "DEBIT",
  CREDIT: "CREDIT",
} as const;
export type LedgerDirection = (typeof LedgerDirection)[keyof typeof LedgerDirection];
