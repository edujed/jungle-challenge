/**
 * Schema de validação (zod) para o endpoint de submissão de transação.
 */

import { z } from "zod";
import { moneySchema } from "./money.schema.js";

export const submitTransactionSchema = z.object({
  providerId: z.string().min(1).max(128),
  externalTransactionId: z.string().min(1).max(256),
  playerId: z.string().uuid(),
  walletId: z.string().uuid(),
  roundId: z.string().min(1).max(256),
  gameId: z.string().min(1).max(128),
  kind: z.enum(["OPENING", "BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
  money: moneySchema,
  referenceExternalTransactionId: z.string().max(256).nullable().optional(),
});

export type SubmitTransactionInput = z.infer<typeof submitTransactionSchema>;
