/**
 * InboxMessage (tabela `inbox_messages`) — dedup persistente de mensagens SQS.
 *
 * Invariante garantida no schema: UNIQUE (consumer_name, message_id).
 */

import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
  Index,
} from "@mikro-orm/decorators/legacy";

@Entity({ tableName: "inbox_messages" })
@Unique({ name: "uq_inbox_consumer_message", properties: ["consumerName", "messageId"] })
export class InboxMessage {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "string", length: 128 })
  consumerName!: string;

  @Property({ type: "string", length: 256 })
  messageId!: string;

  @Property({ type: "string", length: 64 })
  payloadHash!: string;

  @Index({ name: "idx_inbox_received" })
  @Property({ type: "datetime", onCreate: () => new Date() })
  receivedAt!: Date;

  @Property({ type: "datetime", nullable: true })
  processedAt!: Date | null;
}
