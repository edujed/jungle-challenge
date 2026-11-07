/**
 * Status de transação de aposta.
 */

export const WagerTransactionStatus = {
  PENDING: "PENDING",
  PENDING_REFERENCE: "PENDING_REFERENCE",
  PROCESSED: "PROCESSED",
  REJECTED: "REJECTED",
  FAILED: "FAILED",
} as const;
export type WagerTransactionStatus = (typeof WagerTransactionStatus)[keyof typeof WagerTransactionStatus];

/** Status que não podem transicionar (terminais). */
export const TERMINAL_STATUSES: readonly WagerTransactionStatus[] = [
  WagerTransactionStatus.PROCESSED,
  WagerTransactionStatus.REJECTED,
  WagerTransactionStatus.FAILED,
] as const;
