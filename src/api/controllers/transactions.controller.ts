/**
 * Transactions controller — submissão e consulta de transações.
 *
 * - POST /wagering/transactions → submete transação
 * - GET /wagering/transactions/:transactionId → consulta por ID interno
 * - GET /providers/:providerId/wagering/transactions/:extId → consulta por provider
 *
 * Mapeamento HTTP (decisão ADR-006):
 *   200 → PROCESSED
 *   202 → PENDING_REFERENCE
 *   422 → REJECTED (com failureCode no body)
 *   409 → IDEMPOTENCY_CONFLICT
 *   400 → VALIDATION_ERROR
 *   404 → WALLET_NOT_FOUND
 *   503 → INFRASTRUCTURE_ERROR
 */

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Headers,
  Res,
  Inject,
} from "@nestjs/common";
import type { Response } from "express";
import { DATABASE } from "../tokens.js";
import type { Database } from "../../infrastructure/database/db.js";
import { WagerTransaction } from "../../infrastructure/database/entities/wager-transaction.entity.js";
import { applyWagerTransactionUseCase } from "../../usecases/apply-wager-transaction.js";
import { submitTransactionSchema, type SubmitTransactionInput } from "../schemas/submit-transaction.schema.js";
import { AppLogger } from "../../observability/app-logger.js";
import type { Logger } from "../../observability/logger.js";
import { MetricsCollector } from "../../observability/metrics.js";
import { toTransactionResponse, toSubmitTransactionResponse } from "../mappers/transaction.mapper.js";

@Controller()
export class TransactionsController {
  private readonly log: Logger;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly appLogger: AppLogger,
    private readonly metrics: MetricsCollector,
  ) {
    this.log = this.appLogger.child("transactions");
  }

  /**
   * POST /wagering/transactions
   *
   * Header obrigatório: Idempotency-Key
   */
  @Post("wagering/transactions")
  async submitTransaction(
    @Body() body: unknown,
    @Headers("Idempotency-Key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    // 1. Validação do header Idempotency-Key
    if (!idempotencyKey || idempotencyKey.length === 0) {
      res.status(400);
      return { code: "VALIDATION_ERROR", message: "Idempotency-Key header is required" };
    }
    if (idempotencyKey.length > 256) {
      res.status(400);
      return { code: "VALIDATION_ERROR", message: "Idempotency-Key must be at most 256 characters" };
    }

    // 2. Validação do body
    const parsed = submitTransactionSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400);
      return {
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        details: parsed.error.flatten(),
      };
    }

    const input: SubmitTransactionInput = parsed.data;

    // 3. Chama o use case
    try {
      const start = Date.now();
      const result = await applyWagerTransactionUseCase(this.db, {
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey,
        playerId: input.playerId,
        walletId: input.walletId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        amount: input.money.amount,
        currency: input.money.currency,
        referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
        consumerName: null, // HTTP não usa inbox dedup
        messageId: null,
      });

      // 4. Métricas: transação por status + duplicata (replay idempotente)
      this.metrics.recordTransaction(result.status);
      if (result.idempotentReplay) this.metrics.recordDuplicate();
      this.metrics.recordLatency("http", Date.now() - start);

      // 5. Mapeia status → HTTP
      if (result.status === "PROCESSED") {
        return toSubmitTransactionResponse(result, input.money.currency);
      }

      if (result.status === "PENDING_REFERENCE") {
        res.status(202);
        return toSubmitTransactionResponse(result, input.money.currency);
      }

      // IDEMPOTENCY_CONFLICT → 409 (independentemente do status)
      if (result.failureCode === "IDEMPOTENCY_CONFLICT") {
        res.status(409);
        return toSubmitTransactionResponse(result, input.money.currency);
      }

      if (result.status === "REJECTED") {
        // WALLET_NOT_FOUND → 404
        if (result.failureCode === "WALLET_NOT_FOUND") {
          res.status(404);
          return toSubmitTransactionResponse(result, input.money.currency);
        }

        // Demais rejeições → 422
        res.status(422);
        return toSubmitTransactionResponse(result, input.money.currency);
      }

      // PENDING ou FAILED → 503
      res.status(503);
      return toSubmitTransactionResponse(result, input.money.currency);
    } catch (error: unknown) {
      const err = error as { message?: string; code?: string };
      this.log.error("submitTransaction error", {
        error: err.message,
        code: err.code,
        providerId: input.providerId,
        walletId: input.walletId,
        correlationId: input.externalTransactionId,
      });
      res.status(503);
      return { code: "INFRASTRUCTURE_ERROR", message: err.message ?? "Internal error" };
    }
  }

  /**
   * GET /wagering/transactions/:transactionId
   */
  @Get("wagering/transactions/:transactionId")
  async getTransaction(
    @Param("transactionId") transactionId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tx = await this.db.em.fork().findOne(WagerTransaction, { id: transactionId });

    if (!tx) {
      res.status(404);
      return { code: "VALIDATION_ERROR", message: "Transaction not found" };
    }

    return toTransactionResponse(tx);
  }

  /**
   * GET /providers/:providerId/wagering/transactions/:externalTransactionId
   */
  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getTransactionByProvider(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tx = await this.db.em.fork().findOne(WagerTransaction, {
      providerId,
      externalTransactionId,
    });

    if (!tx) {
      res.status(404);
      return { code: "VALIDATION_ERROR", message: "Transaction not found" };
    }

    return toTransactionResponse(tx);
  }
}
