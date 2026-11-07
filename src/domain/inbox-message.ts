/**
 * InboxMessage — dedup persistente de mensagens SQS (README §6.5).
 *
 * Construtor privado + factories estáticas (`receive`, `rehydrate`).
 * Invariante garantida no schema: UNIQUE (consumer_name, message_id).
 *
 * A reidratação (`rehydrate`) não revalida transições (README §6.0).
 */

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt?: Date;
}

export interface InboxMessageState {
  id: string;
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export class InboxMessage {
  readonly id: string;
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;

  private _processedAt: Date | null;

  private constructor(
    id: string,
    messageId: string,
    consumerName: string,
    payloadHash: string,
    receivedAt: Date,
    processedAt: Date | null,
  ) {
    this.id = id;
    this.messageId = messageId;
    this.consumerName = consumerName;
    this.payloadHash = payloadHash;
    this.receivedAt = receivedAt;
    this._processedAt = processedAt;
  }

  /** Registra o recebimento de uma mensagem (primeira entrega). */
  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(
      crypto.randomUUID(),
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt ?? new Date(),
      null,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.id,
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | null {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== null;
  }

  /** Marca a mensagem como processada (após o commit da transação). */
  markProcessed(at: Date): void {
    this._processedAt = at;
  }
}
