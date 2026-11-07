/**
 * Integration tests — SQS Inbox (dedup, redelivery, crash recovery)
 *
 * Seção 13.2 do README: inbox e redelivery.
 * Requer PostgreSQL real.
 *
 * Arquivo separado de sqs.test.ts para isolar a contaminação de estado:
 * os testes de inbox criam entries na tabela inbox_messages, e o teste
 * "HTTP não usa inbox" verifica que consumerName=null não gera entry.
 * Com cleanDatabase apenas em beforeAll, testes anteriores no mesmo
 * arquivo contaminariam a contagem.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createTestDatabase,
  createTestWallet,
  cleanDatabase,
  dbQuery,
  type Database,
} from "../helpers.js";
import { applyWagerTransactionUseCase } from "../../src/usecases/apply-wager-transaction.js";
import { InboxMessage } from "../../src/infrastructure/database/entities/inbox-message.entity.js";
import { randomUUID } from "node:crypto";
import type { SqlEntityManager } from "@mikro-orm/sql";

let db: Database;

beforeAll(async () => {
  db = await createTestDatabase();
  await cleanDatabase(db);
});

afterAll(async () => {
  await db.close();
});

describe("SQS — inbox dedup", () => {
  test("mesma mensagem SQS (consumer + messageId) → dedup via inbox", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    const input = {
      providerId: "test-provider",
      externalTransactionId: "sqs-bet-001",
      idempotencyKey: "sqs-key-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET" as const,
      amount: "25.00",
      currency: "BRL",
      consumerName: "test-consumer",
      messageId: "msg-001",
    };

    // Primeira entrega
    const first = await applyWagerTransactionUseCase(db, input);
    expect(first.status).toBe("PROCESSED");
    expect(first.idempotentReplay).toBe(false);

    // Segunda entrega (redelivery) — mesma consumer + messageId
    const second = await applyWagerTransactionUseCase(db, input);
    expect(second.status).toBe("PROCESSED");
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
  });

  test("inbox entry é persistida", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "sqs-bet-002",
      idempotencyKey: "sqs-key-002",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "10.00",
      currency: "BRL",
      consumerName: "test-consumer",
      messageId: "msg-002",
    });

    const inboxMessage = await dbQuery(db, async (em) =>
      em.findOne(InboxMessage, { messageId: "msg-002" }),
    );
    expect(inboxMessage).not.toBeNull();
    expect(inboxMessage!.consumerName).toBe("test-consumer");
  });

  test("HTTP não usa inbox (consumerName = null)", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "http-bet-001",
      idempotencyKey: "http-key-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "10.00",
      currency: "BRL",
      consumerName: null,
      messageId: null,
    });

    // Não deve ter entry no inbox para consumerName = null.
    // O filtro por consumerName: null garante que entries de outros
    // testes (com consumerName = 'test-consumer') não contaminam a contagem.
    const inboxCount = await dbQuery(db, async (em) =>
      em.count(InboxMessage, { consumerName: null }),
    );
    expect(inboxCount).toBe(0);
  });

  test("redelivery após crash (inbox existe, transação não) → reprocessa", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    // Simula: inbox foi inserida, mas a transação não (crash entre os dois)
    const { createHash } = await import("node:crypto");
    const payloadHash = createHash("sha256")
      .update("simulated-crash")
      .digest("hex");

    await db.em.transactional(async (em: SqlEntityManager) => {
      const inbox = em.create(InboxMessage, {
        id: randomUUID(),
        consumerName: "test-consumer",
        messageId: "msg-crash-001",
        payloadHash,
        receivedAt: new Date(),
        processedAt: null,
      });
      await em.persist(inbox);
      await em.flush();
    });

    // Agora a mensagem é reentregue — deve processar normalmente
    const result = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "sqs-bet-crash",
      idempotencyKey: "sqs-key-crash",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "15.00",
      currency: "BRL",
      consumerName: "test-consumer",
      messageId: "msg-crash-001",
    });

    expect(result.status).toBe("PROCESSED");
    expect(result.idempotentReplay).toBe(false);
  });
});
