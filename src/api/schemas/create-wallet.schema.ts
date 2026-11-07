/**
 * Schema de validação (zod) para o endpoint de criação de wallet.
 */

import { z } from "zod";
import { moneySchema } from "./money.schema.js";

export const createWalletSchema = z.object({
  playerId: z.string().uuid(),
  initialBalance: moneySchema,
});

export type CreateWalletInput = z.infer<typeof createWalletSchema>;
