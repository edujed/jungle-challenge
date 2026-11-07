/**
 * Coletor de métricas — seção 12 do README.
 *
 * Métricas obrigatórias:
 *   - transações por status
 *   - duplicatas detectadas
 *   - retries
 *   - mensagens em DLQ
 *   - conflitos de lock
 *   - outbox lag
 *   - latência de processamento
 *
 * Provider NestJS (singleton do módulo). Em produção, seria exposto via
 * /metrics (Prometheus) ou OpenTelemetry — ambos opcionais no README.
 */

import { Injectable } from "@nestjs/common";

export interface MetricsSnapshot {
  /** Transações por status (PROCESSED, REJECTED, PENDING_REFERENCE, ...). */
  transactionsByStatus: Record<string, number>;
  /** Duplicatas detectadas (idempotent replay + inbox dedup). */
  duplicatesDetected: number;
  /** Retries (SQS redelivery + pending-reference retries). */
  retries: number;
  /** Mensagens enviadas para DLQ. */
  dlqMessages: number;
  /** Conflitos de lock (row lock contention no hot-path). */
  lockConflicts: number;
  /** Outbox lag: max/avg (ms) entre occurredAt e publishedAt. */
  outboxLag: { max: number; avg: number; count: number };
  /** Latência de processamento: max/avg (ms) por canal (http/sqs). */
  processingLatency: Record<string, { max: number; avg: number; count: number }>;
}

@Injectable()
export class MetricsCollector {
  private transactionsByStatus: Record<string, number> = {};
  private duplicatesDetected = 0;
  private retries = 0;
  private dlqMessages = 0;
  private lockConflicts = 0;
  private outboxLags: number[] = [];
  private latencies: Record<string, number[]> = {};

  recordTransaction(status: string): void {
    this.transactionsByStatus[status] = (this.transactionsByStatus[status] ?? 0) + 1;
  }

  recordDuplicate(): void {
    this.duplicatesDetected += 1;
  }

  recordRetry(): void {
    this.retries += 1;
  }

  recordDlq(): void {
    this.dlqMessages += 1;
  }

  recordLockConflict(): void {
    this.lockConflicts += 1;
  }

  recordOutboxLag(ms: number): void {
    // Mantém as últimas 1000 amostras para não crescer indefinidamente.
    this.outboxLags.push(ms);
    if (this.outboxLags.length > 1000) this.outboxLags.shift();
  }

  recordLatency(channel: string, ms: number): void {
    if (!this.latencies[channel]) this.latencies[channel] = [];
    this.latencies[channel].push(ms);
    if (this.latencies[channel].length > 1000) this.latencies[channel].shift();
  }

  snapshot(): MetricsSnapshot {
    const summarize = (arr: number[]) => {
      if (arr.length === 0) return { max: 0, avg: 0, count: 0 };
      const max = Math.max(...arr);
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      return { max, avg, count: arr.length };
    };

    const latency: MetricsSnapshot["processingLatency"] = {};
    for (const [channel, arr] of Object.entries(this.latencies)) {
      latency[channel] = summarize(arr);
    }

    return {
      transactionsByStatus: { ...this.transactionsByStatus },
      duplicatesDetected: this.duplicatesDetected,
      retries: this.retries,
      dlqMessages: this.dlqMessages,
      lockConflicts: this.lockConflicts,
      outboxLag: summarize(this.outboxLags),
      processingLatency: latency,
    };
  }

  reset(): void {
    this.transactionsByStatus = {};
    this.duplicatesDetected = 0;
    this.retries = 0;
    this.dlqMessages = 0;
    this.lockConflicts = 0;
    this.outboxLags = [];
    this.latencies = {};
  }
}


