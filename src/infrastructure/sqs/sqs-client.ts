/**
 * Cliente SQS — wrapper fino sobre @aws-sdk/client-sqs.
 *
 * Configuração:
 *   - Endpoint: LocalStack/MiniStack (SQS_ENDPOINT)
 *   - Região: us-east-1
 *   - Credenciais: test/test (LocalStack)
 */

import {
  SQSClient,
  ReceiveMessageCommand,
  SendMessageCommand,
  DeleteMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";

export interface SqsClient {
  receiveMessages(queueUrl: string, maxMessages: number, waitTimeSeconds: number): Promise<Message[]>;
  sendMessage(queueUrl: string, body: string, messageGroupId: string, messageDeduplicationId: string): Promise<string>;
  deleteMessage(queueUrl: string, receiptHandle: string): Promise<void>;
  close(): void;
}

export function createSqsClient(endpoint: string, region: string): SqsClient {
  const client = new SQSClient({
    endpoint,
    region,
    credentials: {
      accessKeyId: "test",
      secretAccessKey: "test",
    },
  });

  return {
    async receiveMessages(queueUrl, maxMessages, waitTimeSeconds) {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: maxMessages,
          WaitTimeSeconds: waitTimeSeconds,
        }),
      );
      return response.Messages ?? [];
    },

    async sendMessage(queueUrl, body, messageGroupId, messageDeduplicationId) {
      const response = await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: body,
          MessageGroupId: messageGroupId,
          MessageDeduplicationId: messageDeduplicationId,
        }),
      );
      return response.MessageId ?? "";
    },

    async deleteMessage(queueUrl, receiptHandle) {
      await client.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
    },

    close() {
      client.destroy();
    },
  };
}
