/**
 * Schema de validação (zod) para valores monetários na API.
 */

import { z } from "zod";

export const moneySchema = z.object({
  amount: z.string().regex(/^\d+\.\d{2}$/, "Amount must be a decimal string with exactly 2 decimal places"),
  currency: z.string().length(3, "Currency must be 3 characters (ISO-4217)"),
});

export type MoneyInput = z.infer<typeof moneySchema>;
