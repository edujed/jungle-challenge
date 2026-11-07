/**
 * OutboxMessage — transactional outbox (README §6.5).
 *
 * Construtor privado + factories estáticas (`enqueue`, `rehydrate`).
 * Eventos de integração publicados após o commit da transação financeira.
 * Worker com FOR UPDATE SKIP LOCKED e backoff exponencial.
 *
 * A reidratação (`rehydrate`) não revalida transições (README §6.0).
 */

import type { IntegrationEvent } from "./events/integration-event.js";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
  createdAt: Date;
}

export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly createdAt: Date;

  private _attempts: number;
  private _nextAttemptAt: Date | null;
  private _publishedAt: Date | null;

  private constructor(
    id: string,
    aggregateId: string,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
    occurredAt: Date,
    attempts: number,
    nextAttemptAt: Date | null,
    publishedAt: Date | null,
    createdAt: Date,
  ) {
    this.id = id;
    this.aggregateId = aggregateId;
    this.eventType = eventType;
    this.payload = payload;
    this.occurredAt = occurredAt;
    this._attempts = attempts;
    this._nextAttemptAt = nextAttemptAt;
    this._publishedAt = publishedAt;
    this.createdAt = createdAt;
  }

  /** Enfileira um evento de integração (primeira tentativa, imediata). */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      crypto.randomUUID(),
      event.aggregateId,
      event.eventType,
      event.toJSON() as Record<string, unknown>,
      event.occurredAt,
      0,
      null,
      null,
      new Date(),
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.createdAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | null {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | null {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === null;
  }

  /** Mensagem pronta para publicação (sem nextAttemptAt ou já vencida). */
  isDue(now: Date): boolean {
    return this._nextAttemptAt === null || this._nextAttemptAt <= now;
  }

  /** Marca como publicado (após o "envio" do evento). */
  markPublished(at: Date): void {
    this._publishedAt = at;
  }

  /** Incrementa attempts e agenda o próximo retry (backoff). */
  scheduleRetry(attempts: number, nextAttemptAt: Date): void {
    this._attempts = attempts;
    this._nextAttemptAt = nextAttemptAt;
  }
}
