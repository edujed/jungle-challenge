/**
 * OutboxMessage (tabela `outbox_messages`) — transactional outbox.
 *
 * Eventos de integração publicados após o commit da transação financeira.
 * Worker com FOR UPDATE SKIP LOCKED (LockMode.PESSIMISTIC_PARTIAL_WRITE)
 * e backoff exponencial.
 */

import {
  Entity,
  PrimaryKey,
  Property,
  Index,
} from "@mikro-orm/decorators/legacy";

@Entity({ tableName: "outbox_messages" })
export class OutboxMessage {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Index({ name: "idx_outbox_aggregate" })
  @Property({ type: "uuid" })
  aggregateId!: string;

  @Index({ name: "idx_outbox_event_type" })
  @Property({ type: "string", length: 64 })
  eventType!: string;

  @Property({ type: "json" })
  payload!: Record<string, unknown>;

  @Property({ type: "datetime" })
  occurredAt!: Date;

  @Property({ type: "int" })
  attempts!: number;

  @Property({ type: "datetime", nullable: true })
  nextAttemptAt!: Date | null;

  @Property({ type: "datetime", nullable: true })
  publishedAt!: Date | null;

  @Index({ name: "idx_outbox_pending" })
  @Property({ type: "datetime", onCreate: () => new Date() })
  createdAt!: Date;
}
