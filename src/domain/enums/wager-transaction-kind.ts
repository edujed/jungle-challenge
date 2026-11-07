/**
 * Tipo de transação de aposta.
 */

export const WagerTransactionKind = {
  OPENING: "OPENING",
  BET: "BET",
  WIN: "WIN",
  LOSS: "LOSS",
  REFUND: "REFUND",
  ROLLBACK: "ROLLBACK",
} as const;
export type WagerTransactionKind = (typeof WagerTransactionKind)[keyof typeof WagerTransactionKind];
