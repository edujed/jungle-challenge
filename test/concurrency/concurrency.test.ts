/**
 * Concurrency tests — paralelismo real
 *
 * Seção 13.3 do README:
 *   1. mesma aposta 50x em paralelo → um único débito
 *   2. operações concorrentes disputando saldo (seção 8)
 *   3. wallets distintas em paralelo
 *   4. ≥ 3 processos/instâncias simultâneos
 *   5. worker morto depois do commit e antes do ack
 *   6. dois publishers sobre a mesma outbox
 *   7. ROLLBACK/REFUND antes da referência
 *   8. reinício do serviço com consistência final
 *
 * Requer PostgreSQL real (container Docker).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createTestDatabase,
  createTestWallet,
  cleanDatabase,
  verifyBalanceInvariant,
  verifyNoNegativeBalance,
  verifyNoDuplicateLedgerEntries,
  dbQuery,
  type Database,
} from "../helpers.js";
import { applyWagerTransactionUseCase } from "../../src/usecases/apply-wager-transaction.js";
import { Wallet } from "../../src/infrastructure/database/entities/wallet.entity.js";
import { WalletLedgerEntry } from "../../src/infrastructure/database/entities/wallet-ledger-entry.entity.js";
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

describe("Concorrência 1: mesma aposta 50x em paralelo → um único débito", () => {
  test("50 BETs idênticas em paralelo → 1 PROCESSED, 49 idempotentReplay", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000); // R$ 100.00

    const input = {
      providerId: "test-provider",
      externalTransactionId: "conc-bet-50",
      idempotencyKey: "conc-key-50",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET" as const,
      amount: "25.00",
      currency: "BRL",
    };

    // 50 requisições em paralelo
    const results = await Promise.all(
      Array.from({ length: 50 }, () => applyWagerTransactionUseCase(db, input)),
    );

    // Conta os resultados
    const processed = results.filter((r) => r.status === "PROCESSED");
    const replays = results.filter((r) => r.idempotentReplay);
    const nonReplays = results.filter((r) => !r.idempotentReplay);

    // Deve ter exatamente 1 transação (1 PROCESSED original + 49 replays)
    expect(processed.length).toBe(50); // todas PROCESSED
    expect(replays.length).toBe(49); // 49 são replays
    expect(nonReplays.length).toBe(1); // 1 é o original

    // Todos devem ter o mesmo transactionId
    const txIds = new Set(results.map((r) => r.transactionId));
    expect(txIds.size).toBe(1);

    // Saldo: 100 - 25 = 75 (um único débito)
    const invariant = await verifyBalanceInvariant(db, walletId);
    expect(invariant.stored).toBe(75);
    expect(invariant.calculated).toBe(75);
    expect(invariant.consistent).toBe(true);

    // Ledger: exatamente 1 entry
    const ledgerCount = await dbQuery(db, async (em) =>
      em.count(WalletLedgerEntry, { wallet: walletId }),
    );
    // 1 entry da BET + 1 entry do OPENING = 2
    expect(ledgerCount).toBe(2);
  });

  test("50 BETs com keys diferentes em paralelo → todas processadas (se saldo permitir)", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000); // R$ 100.00

    // 50 BETs de R$ 1.00 cada, com keys diferentes
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        applyWagerTransactionUseCase(db, {
          providerId: "test-provider",
          externalTransactionId: `conc-bet-diff-${i}`,
          idempotencyKey: `conc-key-diff-${i}`,
          playerId,
          walletId,
          roundId: "round-1",
          gameId: "test-game",
          kind: "BET",
          amount: "1.00",
          currency: "BRL",
        }),
      ),
    );

    // Todas devem ser PROCESSED (100 - 50 = 50 restante)
    const processed = results.filter((r) => r.status === "PROCESSED");
    expect(processed.length).toBe(50);

    // Saldo: 100 - 50 = 50
    const invariant = await verifyBalanceInvariant(db, walletId);
    expect(invariant.stored).toBe(50);
    expect(invariant.calculated).toBe(50);
    expect(invariant.consistent).toBe(true);
  });
});

describe("Concorrência 2: cenário da seção 8 (2× R$80 com saldo R$100)", () => {
  test("duas BETs de R$80 em paralelo → 1 PROCESSED, 1 REJECTED", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000); // R$ 100.00

    const results = await Promise.all([
      applyWagerTransactionUseCase(db, {
        providerId: "test-provider",
        externalTransactionId: "conc-80-a",
        idempotencyKey: "conc-key-80-a",
        playerId,
        walletId,
        roundId: "round-1",
        gameId: "test-game",
        kind: "BET",
        amount: "80.00",
        currency: "BRL",
      }),
      applyWagerTransactionUseCase(db, {
        providerId: "test-provider",
        externalTransactionId: "conc-80-b",
        idempotencyKey: "conc-key-80-b",
        playerId,
        walletId,
        roundId: "round-1",
        gameId: "test-game",
        kind: "BET",
        amount: "80.00",
        currency: "BRL",
      }),
    ]);

    const processed = results.filter((r) => r.status === "PROCESSED");
    const rejected = results.filter((r) => r.status === "REJECTED");

    expect(processed.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.failureCode).toBe("INSUFFICIENT_BALANCE");

    // Saldo: 100 - 80 = 20
    const invariant = await verifyBalanceInvariant(db, walletId);
    expect(invariant.stored).toBe(20);
    expect(invariant.calculated).toBe(20);
    expect(invariant.consistent).toBe(true);

    // Ledger: 1 entry da BET + 1 do OPENING = 2
    const ledgerCount = await dbQuery(db, async (em) =>
      em.count(WalletLedgerEntry, { wallet: walletId }),
    );
    expect(ledgerCount).toBe(2);
  });

  test("saldo nunca fica negativo (invariante)", async () => {
    const negatives = await verifyNoNegativeBalance(db);
    expect(negatives).toBe(0);
  });
});

describe("Concorrência 3: wallets distintas em paralelo", () => {
  test("10 wallets × 10 BETs cada em paralelo → todas consistentes", async () => {
    const walletData: { walletId: string; playerId: string }[] = [];

    // Cria 10 wallets
    for (let i = 0; i < 10; i++) {
      const { walletId, playerId } = await createTestWallet(db, 10000);
      walletData.push({ walletId, playerId });
    }

    // 10 BETs por wallet, todas em paralelo
    const allBets = walletData.flatMap(({ walletId, playerId }) =>
      Array.from({ length: 10 }, (_, j) => ({ walletId, playerId, j })),
    );

    // Executa todas em paralelo
    const results = await Promise.all(
      allBets.map(({ walletId, j, playerId }) =>
        applyWagerTransactionUseCase(db, {
          providerId: "test-provider",
          externalTransactionId: `conc-multi-${walletId.slice(0, 8)}-${j}`,
          idempotencyKey: `conc-key-multi-${walletId.slice(0, 8)}-${j}`,
          playerId,
          walletId,
          roundId: "round-1",
          gameId: "test-game",
          kind: "BET",
          amount: "5.00",
          currency: "BRL",
        }),
      ),
    );

    // Todas devem ser PROCESSED
    const processed = results.filter((r) => r.status === "PROCESSED");
    expect(processed.length).toBe(100);

    // Verifica invariante em cada wallet
    for (const { walletId } of walletData) {
      const invariant = await verifyBalanceInvariant(db, walletId);
      expect(invariant.consistent).toBe(true);
      expect(invariant.stored).toBe(50); // 100 - 50 = 50
    }
  });
});

describe("Concorrência 4: múltiplos pools (simula ≥3 instâncias)", () => {
  test("3 pools independentes disputando a mesma wallet → consistência", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000); // R$ 100.00

    // Cria 3 pools independentes (simula 3 instâncias)
    const pool1 = await createTestDatabase();
    const pool2 = await createTestDatabase();
    const pool3 = await createTestDatabase();

    try {
      // Cada pool faz 5 BETs de R$ 5.00
      const results = await Promise.all([
        ...Array.from({ length: 5 }, (_, i) =>
          applyWagerTransactionUseCase(pool1, {
            providerId: "test-provider",
            externalTransactionId: `conc-pool1-${i}`,
            idempotencyKey: `conc-key-pool1-${i}`,
            playerId,
            walletId,
            roundId: "round-1",
            gameId: "test-game",
            kind: "BET",
            amount: "5.00",
            currency: "BRL",
          }),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          applyWagerTransactionUseCase(pool2, {
            providerId: "test-provider",
            externalTransactionId: `conc-pool2-${i}`,
            idempotencyKey: `conc-key-pool2-${i}`,
            playerId,
            walletId,
            roundId: "round-1",
            gameId: "test-game",
            kind: "BET",
            amount: "5.00",
            currency: "BRL",
          }),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          applyWagerTransactionUseCase(pool3, {
            providerId: "test-provider",
            externalTransactionId: `conc-pool3-${i}`,
            idempotencyKey: `conc-key-pool3-${i}`,
            playerId,
            walletId,
            roundId: "round-1",
            gameId: "test-game",
            kind: "BET",
            amount: "5.00",
            currency: "BRL",
          }),
        ),
      ]);

      // Todas devem ser PROCESSED (100 - 75 = 25)
      const processed = results.filter((r) => r.status === "PROCESSED");
      expect(processed.length).toBe(15);

      // Verifica invariante
      const invariant = await verifyBalanceInvariant(db, walletId);
      expect(invariant.stored).toBe(25);
      expect(invariant.calculated).toBe(25);
      expect(invariant.consistent).toBe(true);
    } finally {
      await pool1.close();
      await pool2.close();
      await pool3.close();
    }
  });
});

describe("Concorrência 5: worker morto depois do commit e antes do ack", () => {
  test("mensagem processada (commit) mas não acked → redelivery é idempotente", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    const input = {
      providerId: "test-provider",
      externalTransactionId: "conc-crash-001",
      idempotencyKey: "conc-key-crash-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET" as const,
      amount: "20.00",
      currency: "BRL",
      consumerName: "test-consumer",
      messageId: "msg-crash-001",
    };

    // Primeira entrega: processa e "crasha" antes do ack
    const first = await applyWagerTransactionUseCase(db, input);
    expect(first.status).toBe("PROCESSED");
    expect(first.idempotentReplay).toBe(false);

    // Simula crash: não faz ack (DeleteMessage)
    // A mensagem fica visível novamente após VisibilityTimeout

    // Segunda entrega (redelivery): deve ser idempotente
    const second = await applyWagerTransactionUseCase(db, input);
    expect(second.status).toBe("PROCESSED");
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);

    // Saldo: 100 - 20 = 80 (um único débito)
    const invariant = await verifyBalanceInvariant(db, walletId);
    expect(invariant.stored).toBe(80);
    expect(invariant.calculated).toBe(80);
    expect(invariant.consistent).toBe(true);
  });
});

describe("Concorrência 6: dois publishers sobre a mesma outbox", () => {
  test("FOR UPDATE SKIP LOCKED garante que cada evento é publicado uma vez", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    // Gera 20 eventos
    for (let i = 0; i < 20; i++) {
      await applyWagerTransactionUseCase(db, {
        providerId: "test-provider",
        externalTransactionId: `conc-outbox-${i}`,
        idempotencyKey: `conc-key-outbox-${i}`,
        playerId,
        walletId,
        roundId: "round-1",
        gameId: "test-game",
        kind: "BET",
        amount: "1.00",
        currency: "BRL",
      });
    }

    // Publisher 1 e Publisher 2 em paralelo.
    // em.find com lockMode PESSIMISTIC_PARTIAL_WRITE → FOR UPDATE SKIP LOCKED.
    // Filtra por aggregateId para não pegar eventos de outras wallets
    // (outros testes podem ter criado eventos pendentes).
    const [pub1, pub2] = await Promise.all([
      db.em.transactional(async (em: SqlEntityManager) => {
        const pending = await em.find(OutboxMessage, { publishedAt: null, aggregateId: walletId }, {
          orderBy: { createdAt: "ASC" },
          limit: 10,
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        });
        for (const msg of pending) {
          await em.nativeUpdate(OutboxMessage, { id: msg.id }, { publishedAt: new Date() });
        }
        return pending.length;
      }),
      db.em.transactional(async (em: SqlEntityManager) => {
        const pending = await em.find(OutboxMessage, { publishedAt: null, aggregateId: walletId }, {
          orderBy: { createdAt: "ASC" },
          limit: 10,
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        });
        for (const msg of pending) {
          await em.nativeUpdate(OutboxMessage, { id: msg.id }, { publishedAt: new Date() });
        }
        return pending.length;
      }),
    ]);

    // Total publicado = pub1 + pub2 (sem duplicatas)
    // Nota: conta apenas os eventos desta wallet (outros testes podem ter
    // publicado eventos de outras wallets)
    const published = await dbQuery(db, async (em) =>
      em.count(OutboxMessage, { publishedAt: { $ne: null }, aggregateId: walletId }),
    );
    expect(published).toBe(pub1 + pub2);
  });
});

describe("Concorrência 7: ROLLBACK/REFUND antes da referência", () => {
  test("REFUND antes da BET → PENDING_REFERENCE, depois resolve", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    // REFUND antes da BET (fora de ordem)
    const refundResult = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "conc-ooo-refund",
      idempotencyKey: "conc-key-ooo-refund",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "REFUND",
      amount: "30.00",
      currency: "BRL",
      referenceExternalTransactionId: "conc-ooo-bet",
    });
    expect(refundResult.status).toBe("PENDING_REFERENCE");

    // BET chega depois
    const betResult = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "conc-ooo-bet",
      idempotencyKey: "conc-key-ooo-bet",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "30.00",
      currency: "BRL",
    });
    expect(betResult.status).toBe("PROCESSED");

    // A REFUND ainda está PENDING_REFERENCE (o worker resolveria)
    // Saldo: 100 - 30 = 70
    const invariant = await verifyBalanceInvariant(db, walletId);
    expect(invariant.stored).toBe(70);
    expect(invariant.consistent).toBe(true);
  });

  test("ROLLBACK antes da BET → PENDING_REFERENCE", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    const rollbackResult = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "conc-ooo-rollback",
      idempotencyKey: "conc-key-ooo-rollback",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "ROLLBACK",
      amount: "20.00",
      currency: "BRL",
      referenceExternalTransactionId: "conc-ooo-bet-rb",
    });
    expect(rollbackResult.status).toBe("PENDING_REFERENCE");

    // BET chega
    const betResult = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "conc-ooo-bet-rb",
      idempotencyKey: "conc-key-ooo-bet-rb",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "20.00",
      currency: "BRL",
    });
    expect(betResult.status).toBe("PROCESSED");
  });
});

describe("Concorrência 8: reinício do serviço com consistência final", () => {
  test("após 'restart', todas as wallets continuam consistentes", async () => {
    // Cria várias wallets com transações
    const walletIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { walletId, playerId } = await createTestWallet(db, 10000);
      walletIds.push(walletId);

      // Algumas transações
      await applyWagerTransactionUseCase(db, {
        providerId: "test-provider",
        externalTransactionId: `conc-restart-bet-${i}`,
        idempotencyKey: `conc-key-restart-bet-${i}`,
        playerId,
        walletId,
        roundId: "round-1",
        gameId: "test-game",
        kind: "BET",
        amount: "10.00",
        currency: "BRL",
      });

      await applyWagerTransactionUseCase(db, {
        providerId: "test-provider",
        externalTransactionId: `conc-restart-win-${i}`,
        idempotencyKey: `conc-key-restart-win-${i}`,
        playerId,
        walletId,
        roundId: "round-1",
        gameId: "test-game",
        kind: "WIN",
        amount: "5.00",
        currency: "BRL",
      });
    }

    // Simula "restart": cria um novo pool
    const newPool = await createTestDatabase();

    try {
      // Verifica consistência em todas as wallets
      for (const walletId of walletIds) {
        const invariant = await verifyBalanceInvariant(newPool, walletId);
        expect(invariant.consistent).toBe(true);
        expect(invariant.stored).toBe(95); // 100 - 10 + 5 = 95
      }

      // Verifica invariante global
      const negatives = await verifyNoNegativeBalance(newPool);
      expect(negatives).toBe(0);

      const duplicates = await verifyNoDuplicateLedgerEntries(newPool);
      expect(duplicates).toBe(0);
    } finally {
      await newPool.close();
    }
  });
});

describe("Invariante final de todos os testes", () => {
  test("wallet.balance == saldo reconstruído pelo ledger (todas as wallets)", async () => {
    const wallets = await dbQuery(db, async (em) =>
      em.find(Wallet, {}),
    );
    const walletIds = wallets.map((w: Wallet) => w.id);

    for (const walletId of walletIds) {
      const invariant = await verifyBalanceInvariant(db, walletId);
      expect(invariant.consistent).toBe(true);
    }
  });

  test("nenhum saldo negativo", async () => {
    const negatives = await verifyNoNegativeBalance(db);
    expect(negatives).toBe(0);
  });

  test("nenhum ledger entry duplicado", async () => {
    const duplicates = await verifyNoDuplicateLedgerEntries(db);
    expect(duplicates).toBe(0);
  });
});
