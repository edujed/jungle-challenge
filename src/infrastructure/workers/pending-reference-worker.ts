/**
 * PENDING_REFERENCE Worker — varre transações com status PENDING_REFERENCE
 * e reprocessa com backoff exponencial.
 *
 * Backoff: base 1s, fator 2, teto 60s, 10 tentativas (~10 min).
 * Esgotado → REJECTED com REFERENCE_NOT_FOUND + evento publicado.
 *
 * Usa FOR UPDATE SKIP LOCKED (LockMode.PESSIMISTIC_PARTIAL_WRITE) para
 * evitar que múltiplos workers processem a mesma transação simultaneamente.
 *
 * Ciclo de vida NestJS: OnModuleInit (start) / OnModuleDestroy (stop).
 */

import { Injectable, OnModuleInit, OnModuleDestroy, Inject } from "@nestjs/common";
import { LockMode } from "@mikro-orm/core";
import { DATABASE } from "../../api/tokens.js";
import type { Database } from "../database/db.js";
import { WagerTransaction } from "../database/entities/wager-transaction.entity.js";
import { OutboxMessage } from "../database/entities/outbox-message.entity.js";
import { OutboxMessage as OutboxMessageDomain } from "../../domain/outbox-message.js";
import { toWagerTransactionDomain } from "../database/mappers/wager-transaction.mapper.js";
import { toOutboxMessageEntityData } from "../database/mappers/outbox-message.mapper.js";
import { WagerTransactionRejected } from "../../domain/events/wager-transaction-rejected.js";
import { applyWagerTransactionUseCase } from "../../usecases/apply-wager-transaction.js";
import { AppLogger } from "../../observability/app-logger.js";
import type { Logger } from "../../observability/logger.js";
import { MetricsCollector } from "../../observability/metrics.js";

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private stopRequested = false;
  private pollInterval: ReturnType<typeof setTimeout> | null = null;
  private readonly log: Logger;

  // Configuração (mesma do main.ts antigo)
  private readonly pollIntervalMs = 2_000;
  private readonly maxAttempts = 10;
  private readonly baseDelayMs = 1_000;
  private readonly maxDelayMs = 60_000;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly appLogger: AppLogger,
    private readonly metrics: MetricsCollector,
  ) {
    this.log = this.appLogger.child("pending-ref-worker");
  }

  onModuleInit(): void {
    this.stopRequested = false;
    this.log.info("started");
    void this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopRequested = true;
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }
    this.log.info("stopped");
  }

  private async processPending(): Promise<void> {
    // SELECT ... FOR UPDATE SKIP LOCKED: pega transações prontas para retry
    // sem bloquear outras instâncias.
    const pendingTxs = await this.db.em.transactional(async (forkedEm) => {
      // em.find com lockMode gera FOR UPDATE SKIP LOCKED (PESSIMISTIC_PARTIAL_WRITE).
      // O filtro de due (nextAttemptAt IS NULL OR <= now) é expresso via $or.
      const now = new Date();
      return forkedEm.find(
        WagerTransaction,
        {
          status: "PENDING_REFERENCE",
          $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
        },
        {
          orderBy: { nextAttemptAt: "ASC" },
          limit: 10,
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        },
      );
    });

    for (const tx of pendingTxs) {
      try {
        // Chama o use case novamente (a referência pode ter chegado)
        const applyResult = await applyWagerTransactionUseCase(this.db, {
          providerId: tx.providerId,
          externalTransactionId: tx.externalTransactionId,
          idempotencyKey: tx.idempotencyKey,
          playerId: tx.playerId,
          walletId: tx.walletId!,
          roundId: tx.roundId,
          gameId: tx.gameId,
          kind: tx.kind,
          amount: String(tx.amount),
          currency: tx.currency,
          referenceExternalTransactionId: tx.referenceExternalTransactionId,
          consumerName: null,
          messageId: null,
        });

        if (applyResult.status === "PROCESSED") {
          this.metrics.recordTransaction("PROCESSED");
          this.log.info("transaction resolved", {
            transactionId: tx.id,
            status: "PROCESSED",
            walletId: tx.walletId ?? undefined,
            providerId: tx.providerId,
            correlationId: tx.externalTransactionId,
          });
        } else if (applyResult.status === "PENDING_REFERENCE") {
          // Ainda pendente — incrementa attempts e agenda próximo retry.
          const newAttempts = Number(tx.attempts) + 1;
          if (newAttempts >= this.maxAttempts) {
            // Esgotou tentativas → REJECTED (transição no domain)
            await this.db.em.transactional(async (forkedEm) => {
              const txDomain = toWagerTransactionDomain(tx);
              txDomain.reject("REFERENCE_NOT_FOUND");
              await forkedEm.nativeUpdate(
                WagerTransaction,
                { id: tx.id },
                {
                  status: txDomain.status,
                  failureCode: txDomain.failureCode,
                  processedAt: new Date(),
                  attempts: newAttempts,
                  nextAttemptAt: null,
                },
              );

              // Evento de rejeição no outbox (envelope via classe abstrata — seção 11)
              const rejectedEvent = WagerTransactionRejected.from(
                {
                  id: tx.id,
                  providerId: tx.providerId,
                  externalTransactionId: tx.externalTransactionId,
                  walletId: tx.walletId,
                  failureCode: "REFERENCE_NOT_FOUND",
                },
                { correlationId: tx.externalTransactionId },
              );
              const outbox = forkedEm.create(OutboxMessage, toOutboxMessageEntityData(OutboxMessageDomain.enqueue(rejectedEvent)));
              await forkedEm.persist(outbox);
              await forkedEm.flush();
            });

            this.metrics.recordTransaction("REJECTED");
            this.log.warn("transaction exhausted attempts → REJECTED", {
              transactionId: tx.id,
              failureCode: "REFERENCE_NOT_FOUND",
              attempts: newAttempts,
              walletId: tx.walletId ?? undefined,
              providerId: tx.providerId,
              correlationId: tx.externalTransactionId,
            });
          } else {
            // Backoff exponencial — agenda o próximo retry
            const delayMs = Math.min(
              this.baseDelayMs * Math.pow(2, newAttempts - 1),
              this.maxDelayMs,
            );
            const nextAttemptAt = new Date(Date.now() + delayMs);
            this.metrics.recordRetry();
            await this.db.em.nativeUpdate(
              WagerTransaction,
              { id: tx.id },
              { attempts: newAttempts, nextAttemptAt },
            );
            this.log.debug("transaction retry scheduled", {
              transactionId: tx.id,
              attempts: newAttempts,
              nextAttemptAt: nextAttemptAt.toISOString(),
              walletId: tx.walletId ?? undefined,
            });
          }
        }
      } catch (error: unknown) {
        const err = error as { message?: string };
        this.log.error("error processing transaction", {
          transactionId: tx.id,
          error: err.message,
          walletId: tx.walletId ?? undefined,
          providerId: tx.providerId,
          correlationId: tx.externalTransactionId,
        });
      }
    }
  }

  private async poll(): Promise<void> {
    if (this.stopRequested) return;

    try {
      await this.processPending();
    } catch (error: unknown) {
      const err = error as { message?: string };
      this.log.error("poll error", { error: err.message });
    }

    if (!this.stopRequested) {
      this.pollInterval = setTimeout(() => void this.poll(), this.pollIntervalMs);
    }
  }
}
