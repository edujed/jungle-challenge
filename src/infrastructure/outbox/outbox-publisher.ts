/**
 * Outbox Publisher — publica eventos pendentes da outbox.
 *
 * Funciona com múltiplos publishers concorrentes (seção 13.6):
 *   - SELECT ... FOR UPDATE SKIP LOCKED para claimar eventos.
 *   - Marca como publicado (published_at) após "publicar".
 *   - Em produção, "publicar" = enviar para SNS/Kafka/etc.
 *   - Neste desafio, "publicar" = logar (o outbox é a garantia; o transporte
 *     é opcional).
 *
 * Cenário que precisa funcionar (seção 11):
 *   1. PostgreSQL confirma o commit.
 *   2. Processo morre antes de publicar.
 *   3. Outra instância assume o trabalho.
 *   4. O evento é publicado.
 *   5. Publicação duplicada continua segura (idempotente).
 *
 * Ciclo de vida NestJS: OnModuleInit (start) / OnModuleDestroy (stop).
 */

import { Injectable, OnModuleInit, OnModuleDestroy, Inject } from "@nestjs/common";
import { LockMode } from "@mikro-orm/core";
import { DATABASE } from "../../api/tokens.js";
import type { Database } from "../database/db.js";
import { OutboxMessage } from "../database/entities/outbox-message.entity.js";
import { toOutboxMessageDomain } from "../database/mappers/outbox-message.mapper.js";
import { AppLogger } from "../../observability/app-logger.js";
import type { Logger } from "../../observability/logger.js";
import { MetricsCollector } from "../../observability/metrics.js";

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private stopRequested = false;
  private pollInterval: ReturnType<typeof setTimeout> | null = null;
  private readonly log: Logger;

  // Configuração (mesma do main.ts antigo)
  private readonly pollIntervalMs = 1_000;
  private readonly batchSize = 50;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly appLogger: AppLogger,
    private readonly metrics: MetricsCollector,
  ) {
    this.log = this.appLogger.child("outbox-publisher");
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

  private async publishPending(): Promise<void> {
    await this.db.em.transactional(async (forkedEm) => {
      // Claima eventos pendentes com FOR UPDATE SKIP LOCKED.
      // em.find com lockMode gera o SQL correto (PESSIMISTIC_PARTIAL_WRITE
      // → FOR UPDATE SKIP LOCKED no PostgreSQL).
      const pending = await forkedEm.find(OutboxMessage, { publishedAt: null }, {
        orderBy: { createdAt: "ASC" },
        limit: this.batchSize,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      });

      for (const msg of pending) {
        try {
          // "Publica" o evento (loga — em produção, enviaria para SNS/Kafka)
          const event = msg.payload as Record<string, any>;

          // Outbox lag: tempo entre occurredAt e publishedAt (agora)
          const lagMs = Date.now() - msg.occurredAt.getTime();
          this.metrics.recordOutboxLag(lagMs);

          this.log.info("event published", {
            eventId: event.eventId ?? msg.id,
            eventType: event.eventType ?? msg.eventType,
            aggregateId: msg.aggregateId,
            correlationId: event.correlationId,
            outboxLagMs: lagMs,
          });

          // Marca como publicado (transição no domain; persiste via nativeUpdate)
          const publishedAt = new Date();
          toOutboxMessageDomain(msg).markPublished(publishedAt);
          await forkedEm.nativeUpdate(
            OutboxMessage,
            { id: msg.id },
            { publishedAt },
          );
        } catch (error: unknown) {
          const err = error as { message?: string };
          this.log.error("error publishing event", {
            eventId: msg.id,
            error: err.message,
          });
          // Não marca como publicado → será reprocessado no próximo poll
        }
      }
    });
  }

  private async poll(): Promise<void> {
    if (this.stopRequested) return;

    try {
      await this.publishPending();
    } catch (error: unknown) {
      const err = error as { message?: string };
      this.log.error("poll error", { error: err.message });
    }

    if (!this.stopRequested) {
      this.pollInterval = setTimeout(() => void this.poll(), this.pollIntervalMs);
    }
  }
}
