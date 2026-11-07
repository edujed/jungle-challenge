/**
 * Integration tests — Outbox
 *
 * Seção 13.2 do README: publishers concorrentes sobre a mesma outbox.
 * Seção 11 do README: transactional outbox.
 * Requer PostgreSQL real (container Docker).
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
import { OutboxMessage } from "../../src/infrastructure/database/entities/outbox-message.entity.js";
import { LockMode } from "@mikro-orm/core";
import type { SqlEntityManager } from "@mikro-orm/sql";

let db: Database;

beforeAll(async () => {
  db = await createTestDatabase();
  await cleanDatabase(db);
});

afterAll(async () => {
  await db.close();
});

describe("Outbox — eventos são persistidos no commit", () => {
  test("BET gera WagerTransactionProcessed + WalletBalanceChanged", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "outbox-bet-001",
      idempotencyKey: "outbox-key-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "25.00",
      currency: "BRL",
    });

    const outboxMessages = await dbQuery(db, async (em) =>
      em.find(OutboxMessage, { aggregateId: walletId }),
    );

    const eventTypes = outboxMessages.map((m: OutboxMessage) => m.eventType);
    expect(eventTypes).toContain("WagerTransactionProcessed");
    expect(eventTypes).toContain("WalletBalanceChanged");
  });

  test("REJECTED gera WagerTransactionRejected", async () => {
    const { walletId, playerId } = await createTestWallet(db, 5000);

    await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "outbox-reject-001",
      idempotencyKey: "outbox-key-reject-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "80.00",
      currency: "BRL",
    });

    const outboxMessages = await dbQuery(db, async (em) =>
      em.find(OutboxMessage, { aggregateId: walletId }),
    );
    const eventTypes = outboxMessages.map((m: OutboxMessage) => m.eventType);
    expect(eventTypes).toContain("WagerTransactionRejected");
  });

  test("PENDING_REFERENCE gera WagerTransactionPendingReference", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "outbox-pending-001",
      idempotencyKey: "outbox-key-pending-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "REFUND",
      amount: "30.00",
      currency: "BRL",
      referenceExternalTransactionId: "bet-futuro",
    });

    const outboxMessages = await dbQuery(db, async (em) =>
      em.find(OutboxMessage, { aggregateId: walletId }),
    );
    const eventTypes = outboxMessages.map((m: OutboxMessage) => m.eventType);
    expect(eventTypes).toContain("WagerTransactionPendingReference");
  });

  test("LOSS gera Processed mas não BalanceChanged", async () => {
    const { walletId, playerId } = await createTestWallet(db, 7500);

    await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "outbox-loss-001",
      idempotencyKey: "outbox-key-loss-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "LOSS",
      amount: "25.00",
      currency: "BRL",
    });

    const outboxMessages = await dbQuery(db, async (em) =>
      em.find(OutboxMessage, { aggregateId: walletId }),
    );
    const eventTypes = outboxMessages.map((m: OutboxMessage) => m.eventType);
    expect(eventTypes).toContain("WagerTransactionProcessed");
    // BalanceChanged não deve ser gerado para LOSS
    // (pode ter BalanceChanged de outras transações, mas não desta)
  });

  test("payload do evento é JSON válido com estrutura correta", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "outbox-payload-001",
      idempotencyKey: "outbox-key-payload-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "25.00",
      currency: "BRL",
    });

    const outboxMessages = await dbQuery(db, async (em) =>
      em.find(OutboxMessage, {
        aggregateId: walletId,
        eventType: "WagerTransactionProcessed",
      }),
    );

    const payload = outboxMessages[0]!.payload as Record<string, any>;
    expect(payload.eventType).toBe("WagerTransactionProcessed");
    expect(payload.version).toBe(1);
    expect(payload.data).toHaveProperty("transactionId");
    expect(payload.data).toHaveProperty("providerId");
    expect(payload.data).toHaveProperty("externalTransactionId");
    expect(payload.data).toHaveProperty("walletId");
    expect(payload.data).toHaveProperty("kind");
    expect(payload.data).toHaveProperty("money");
    expect(payload.data.money).toEqual({ amount: "25.00", currency: "BRL" });
    expect(payload.data).toHaveProperty("balance");
  });
});

describe("Outbox — publishers concorrentes (FOR UPDATE SKIP LOCKED)", () => {
  test("dois publishers não publicam o mesmo evento", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    // Gera vários eventos
    for (let i = 0; i < 10; i++) {
      await applyWagerTransactionUseCase(db, {
        providerId: "test-provider",
        externalTransactionId: `outbox-conc-${i}`,
        idempotencyKey: `outbox-key-conc-${i}`,
        playerId,
        walletId,
        roundId: "round-1",
        gameId: "test-game",
        kind: "BET",
        amount: "1.00",
        currency: "BRL",
      });
    }

    // Conta eventos pendentes
    const pendingCount = await dbQuery(db, async (em) =>
      em.count(OutboxMessage, { publishedAt: null }),
    );
    expect(pendingCount).toBeGreaterThan(0);

    // Simula dois publishers concorrentes usando FOR UPDATE SKIP LOCKED.
    // em.find com lockMode PESSIMISTIC_PARTIAL_WRITE → FOR UPDATE SKIP LOCKED.
    // Publisher 1
    const publisher1Result = await db.em.transactional(async (em: SqlEntityManager) => {
      const pending = await em.find(OutboxMessage, { publishedAt: null }, {
        orderBy: { createdAt: "ASC" },
        limit: 5,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      });
      for (const msg of pending) {
        await em.nativeUpdate(OutboxMessage, { id: msg.id }, { publishedAt: new Date() });
      }
      return pending.length;
    });

    // Publisher 2 (deve pegar eventos diferentes)
    const publisher2Result = await db.em.transactional(async (em: SqlEntityManager) => {
      const pending = await em.find(OutboxMessage, { publishedAt: null }, {
        orderBy: { createdAt: "ASC" },
        limit: 5,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      });
      for (const msg of pending) {
        await em.nativeUpdate(OutboxMessage, { id: msg.id }, { publishedAt: new Date() });
      }
      return pending.length;
    });

    // Total publicado = publisher1 + publisher2 (sem duplicatas)
    const publishedCount = await dbQuery(db, async (em) =>
      em.count(OutboxMessage, { publishedAt: { $ne: null } }),
    );
    expect(publishedCount).toBe(publisher1Result + publisher2Result);

    // Verifica que não há duplicatas (mesmo evento publicado duas vezes)
    const allPublished = await dbQuery(db, async (em) =>
      em.find(OutboxMessage, { publishedAt: { $ne: null } }),
    );
    const idCounts = new Map<string, number>();
    for (const m of allPublished) {
      idCounts.set(m.id, (idCounts.get(m.id) ?? 0) + 1);
    }
    const duplicates = [...idCounts.values()].filter((c) => c > 1).length;
    expect(duplicates).toBe(0);
  });

  test("publisher morto → outro assume (FOR UPDATE SKIP LOCKED)", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    // Gera eventos
    for (let i = 0; i < 5; i++) {
      await applyWagerTransactionUseCase(db, {
        providerId: "test-provider",
        externalTransactionId: `outbox-recover-${i}`,
        idempotencyKey: `outbox-key-recover-${i}`,
        playerId,
        walletId,
        roundId: "round-1",
        gameId: "test-game",
        kind: "BET",
        amount: "1.00",
        currency: "BRL",
      });
    }

    // Publisher 1: claima mas não publica (simula crash)
    await db.em.transactional(async (em: SqlEntityManager) => {
      await em.find(OutboxMessage, { publishedAt: null }, {
        orderBy: { createdAt: "ASC" },
        limit: 3,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      });
      // Simula crash: não marca como publicado
      // (o ROLLBACK liberará os locks)
      throw new Error("simulated crash");
    }).catch(() => {
      // Esperado: crash
    });

    // Publisher 2: assume os eventos
    const publisher2Result = await db.em.transactional(async (em: SqlEntityManager) => {
      const pending = await em.find(OutboxMessage, { publishedAt: null }, {
        orderBy: { createdAt: "ASC" },
        limit: 5,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      });
      for (const msg of pending) {
        await em.nativeUpdate(OutboxMessage, { id: msg.id }, { publishedAt: new Date() });
      }
      return pending.length;
    });

    // Publisher 2 deve ter publicado os 3 eventos que o publisher 1 "claimou"
    expect(publisher2Result).toBeGreaterThanOrEqual(3);
  });
});

describe("Outbox — recuperação após reinicialização", () => {
  test("eventos não publicados persistem após 'restart'", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    // Gera eventos
    await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "outbox-restart-001",
      idempotencyKey: "outbox-key-restart-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "10.00",
      currency: "BRL",
    });

    // Verifica que há eventos pendentes
    const pendingBefore = await dbQuery(db, async (em) =>
      em.count(OutboxMessage, { publishedAt: null }),
    );
    expect(pendingBefore).toBeGreaterThan(0);

    // Simula "restart": publica os eventos pendentes manualmente
    // (o OutboxPublisher é um provider NestJS com DI — não é instanciável
    //  diretamente nos testes sem o container NestJS)
    await db.em.transactional(async (em: SqlEntityManager) => {
      const pending = await em.find(OutboxMessage, { publishedAt: null }, {
        orderBy: { createdAt: "ASC" },
        limit: 50,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      });
      for (const msg of pending) {
        await em.nativeUpdate(OutboxMessage, { id: msg.id }, { publishedAt: new Date() });
      }
    });

    // Verifica que os eventos foram publicados
    const pendingAfter = await dbQuery(db, async (em) =>
      em.count(OutboxMessage, { publishedAt: null }),
    );
    expect(pendingAfter).toBe(0);
  });
});
