/**
 * SQS Consumer — lê mensagens da fila FIFO e processa via use case.
 *
 * Regras (seção 10 do README):
 *   - Reutiliza o mesmo use case do HTTP (applyWagerTransactionUseCase).
 *   - Dedup via inbox persistente (consumer_name, message_id).
 *   - Ack (DeleteMessage) SOMENTE após commit.
 *   - Erros de negócio (terminal) → ack.
 *   - Erros transitórios → retry com backoff (deixar a mensagem visível).
 *   - Erros permanentes → DLQ (após limite de tentativas).
 *   - SIGTERM → concluir mensagens em andamento ou devolver visibilidade.
 *
 * Ciclo de vida NestJS: OnModuleInit (start) / OnModuleDestroy (stop).
 */

import { Injectable, OnModuleInit, OnModuleDestroy, Inject } from "@nestjs/common";
import { DATABASE, SQS_CLIENT, ENV } from "../../api/tokens.js";
import type { Database } from "../database/db.js";
import type { SqsClient } from "../sqs/sqs-client.js";
import { applyWagerTransactionUseCase } from "../../usecases/apply-wager-transaction.js";
import { AppLogger } from "../../observability/app-logger.js";
import type { Logger } from "../../observability/logger.js";
import { MetricsCollector } from "../../observability/metrics.js";

@Injectable()
export class SqsConsumer implements OnModuleInit, OnModuleDestroy {
  private stopRequested = false;
  private pollInterval: ReturnType<typeof setTimeout> | null = null;
  private readonly log: Logger;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SQS_CLIENT) private readonly sqs: SqsClient,
    @Inject(ENV) private readonly env: { sqsQueueUrl: string; sqsConsumerName: string; instanceId: string },
    private readonly appLogger: AppLogger,
    private readonly metrics: MetricsCollector,
  ) {
    this.log = this.appLogger.child("sqs-consumer");
  }

  onModuleInit(): void {
    if (!this.env.sqsQueueUrl) return;
    this.stopRequested = false;
    this.log.info("started", { consumerName: this.env.sqsConsumerName });
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

  private async processMessage(message: any): Promise<void> {
    const messageId = message.MessageId ?? "unknown";
    const rawBody = message.Body ?? "";
    const receiptHandle = message.ReceiptHandle ?? "";

    let parsed: any;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      // Mensagem malformada → ack (vai para DLQ via redrive policy)
      this.log.error("malformed message, acking for DLQ", { messageId });
      this.metrics.recordDlq();
      if (receiptHandle) await this.sqs.deleteMessage(this.env.sqsQueueUrl, receiptHandle);
      return;
    }

    const data = parsed.data;
    if (!data) {
      this.log.error("message has no data, acking for DLQ", { messageId });
      this.metrics.recordDlq();
      if (receiptHandle) await this.sqs.deleteMessage(this.env.sqsQueueUrl, receiptHandle);
      return;
    }

    try {
      const result = await applyWagerTransactionUseCase(this.db, {
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        idempotencyKey: data.idempotencyKey,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind,
        amount: data.money.amount,
        currency: data.money.currency,
        referenceExternalTransactionId: data.referenceExternalTransactionId ?? null,
        consumerName: this.env.sqsConsumerName,
        messageId,
      });

      // Sucesso (PROCESSED, REJECTED, PENDING_REFERENCE) → ack
      this.metrics.recordTransaction(result.status);
      if (result.idempotentReplay) this.metrics.recordDuplicate();
      this.log.info("message processed", {
        messageId,
        transactionId: result.transactionId ?? undefined,
        status: result.status,
        providerId: data.providerId,
        walletId: data.walletId,
        correlationId: data.externalTransactionId,
      });
      if (receiptHandle) await this.sqs.deleteMessage(this.env.sqsQueueUrl, receiptHandle);
    } catch (error: unknown) {
      const err = error as { message?: string };
      this.log.error("error processing message", {
        messageId,
        error: err.message,
        providerId: data.providerId,
        walletId: data.walletId,
        correlationId: data.externalTransactionId,
      });

      // Verifica tentativas (ApproximateReceiveCount)
      const attempts = parseInt(
        message.Attributes?.ApproximateReceiveCount ?? "1",
        10,
      );

      this.metrics.recordRetry();
      if (attempts >= 5) {
        // Limite esgotado → ack (SQS redrive para DLQ automaticamente)
        this.metrics.recordDlq();
        this.log.error("message exceeded max retries, acking for DLQ", {
          messageId,
          attempts,
        });
        if (receiptHandle) await this.sqs.deleteMessage(this.env.sqsQueueUrl, receiptHandle);
      }
      // Caso contrário: não ack → mensagem fica visível novamente após VisibilityTimeout
    }
  }

  private async poll(): Promise<void> {
    if (this.stopRequested) return;

    try {
      const messages = await this.sqs.receiveMessages(
        this.env.sqsQueueUrl,
        10,
        5,
      );

      for (const message of messages) {
        if (this.stopRequested) break;
        await this.processMessage(message);
      }
    } catch (error: unknown) {
      const err = error as { message?: string };
      this.log.error("poll error", { error: err.message });
    }

    if (!this.stopRequested) {
      this.pollInterval = setTimeout(() => void this.poll(), 100);
    }
  }
}
