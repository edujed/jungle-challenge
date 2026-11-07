/**
 * Mappers de OutboxMessage — entity ↔ domain (README §6.5).
 */

import type { OutboxMessage as OutboxMessageEntity } from "../entities/outbox-message.entity.js";
import {
  OutboxMessage as OutboxMessageDomain,
  type OutboxMessageState,
} from "../../../domain/outbox-message.js";

/** Entity → estado de reidratação do domain. */
export function toOutboxMessageState(
  entity: OutboxMessageEntity,
): OutboxMessageState {
  return {
    id: entity.id,
    aggregateId: entity.aggregateId,
    eventType: entity.eventType,
    payload: entity.payload,
    occurredAt: entity.occurredAt,
    attempts: entity.attempts,
    nextAttemptAt: entity.nextAttemptAt,
    publishedAt: entity.publishedAt,
    createdAt: entity.createdAt,
  };
}

/** Entity → domain (reidratação). */
export function toOutboxMessageDomain(
  entity: OutboxMessageEntity,
): OutboxMessageDomain {
  return OutboxMessageDomain.rehydrate(toOutboxMessageState(entity));
}

/** Domain → dados para `em.create(OutboxMessage, ...)` (MikroORM v7 exige todos os campos). */
export function toOutboxMessageEntityData(
  msg: OutboxMessageDomain,
): {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
  createdAt: Date;
} {
  return {
    id: msg.id,
    aggregateId: msg.aggregateId,
    eventType: msg.eventType,
    payload: { ...msg.payload },
    occurredAt: msg.occurredAt,
    attempts: msg.attempts,
    nextAttemptAt: msg.nextAttemptAt,
    publishedAt: msg.publishedAt,
    createdAt: msg.createdAt,
  };
}
