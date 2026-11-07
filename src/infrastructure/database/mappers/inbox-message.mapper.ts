/**
 * Mappers de InboxMessage — entity ↔ domain (README §6.5).
 */

import type { InboxMessage as InboxMessageEntity } from "../entities/inbox-message.entity.js";
import {
  InboxMessage as InboxMessageDomain,
  type InboxMessageState,
} from "../../../domain/inbox-message.js";

/** Entity → estado de reidratação do domain. */
export function toInboxMessageState(
  entity: InboxMessageEntity,
): InboxMessageState {
  return {
    id: entity.id,
    messageId: entity.messageId,
    consumerName: entity.consumerName,
    payloadHash: entity.payloadHash,
    receivedAt: entity.receivedAt,
    processedAt: entity.processedAt,
  };
}

/** Entity → domain (reidratação). */
export function toInboxMessageDomain(
  entity: InboxMessageEntity,
): InboxMessageDomain {
  return InboxMessageDomain.rehydrate(toInboxMessageState(entity));
}
