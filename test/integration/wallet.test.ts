/**
 * Integration tests — Wallet
 *
 * Seção 13.2 do README: migrations e constraints, atomicidade.
 * Requer PostgreSQL real (container Docker).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createTestDatabase,
  createTestWallet,
  cleanDatabase,
  verifyBalanceInvariant,
  dbQuery,
  type Database,
} from "../helpers.js";
import { Wallet } from "../../src/infrastructure/database/entities/wallet.entity.js";
import { WagerTransaction } from "../../src/infrastructure/database/entities/wager-transaction.entity.js";
import { WalletLedgerEntry } from "../../src/infrastructure/database/entities/wallet-ledger-entry.entity.js";
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

describe("Wallet — criação e consulta", () => {
  test("cria wallet com saldo inicial (OPENING)", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000); // R$ 100.00

    const wallet = await dbQuery(db, async (em) =>
      em.findOne(Wallet, { id: walletId }),
    );
    expect(wallet).not.toBeNull();
    expect(wallet!.playerId).toBe(playerId);
    expect(wallet!.currency).toBe("BRL");
    expect(Number(wallet!.balance)).toBe(100);
    expect(Number(wallet!.version)).toBe(1);
  });

  test("cria wallet com saldo zero (sem OPENING)", async () => {
    const { walletId } = await createTestWallet(db, 0);

    const wallet = await dbQuery(db, async (em) =>
      em.findOne(Wallet, { id: walletId }),
    );
    expect(Number(wallet!.balance)).toBe(0);

    // Não deve ter transação OPENING
    const openingCount = await dbQuery(db, async (em) =>
      em.count(WagerTransaction, { walletId, kind: "OPENING" }),
    );
    expect(openingCount).toBe(0);
  });

  test("unique constraint: player_id + currency", async () => {
    const { playerId } = await createTestWallet(db, 5000);

    // Tentar criar outra wallet para o mesmo player + currency deve falhar
    await expect(
      db.em.transactional(async (em: SqlEntityManager) => {
        const w = em.create(Wallet, {
          id: randomUUID(),
          playerId,
          currency: "BRL",
          balance: "0.00",
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        await em.persist(w);
        await em.flush();
      }),
    ).rejects.toThrow();
  });

  test("unique constraint: id", async () => {
    const { walletId } = await createTestWallet(db, 5000);

    // Tentar inserir com o mesmo ID deve falhar
    await expect(
      db.em.transactional(async (em: SqlEntityManager) => {
        const w = em.create(Wallet, {
          id: walletId,
          playerId: randomUUID(),
          currency: "BRL",
          balance: "0.00",
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        await em.persist(w);
        await em.flush();
      }),
    ).rejects.toThrow();
  });

  test("CHECK constraint: balance >= 0", async () => {
    const { walletId } = await createTestWallet(db, 1000);

    // Tentar setar saldo negativo deve falhar
    await expect(
      db.em.transactional(async (em: SqlEntityManager) => {
        await em.nativeUpdate(Wallet, { id: walletId }, { balance: "-100.00" });
      }),
    ).rejects.toThrow();
  });

  test("CHECK constraint: version >= 1", async () => {
    const { walletId } = await createTestWallet(db, 1000);

    await expect(
      db.em.transactional(async (em: SqlEntityManager) => {
        await em.nativeUpdate(Wallet, { id: walletId }, { version: 0 });
      }),
    ).rejects.toThrow();
  });
});

describe("Wallet — ledger imutabilidade", () => {
  test("ledger entry não pode ser UPDATE", async () => {
    const { walletId } = await createTestWallet(db, 10000);

    // Obtém o ID do ledger entry
    const entry = await dbQuery(db, async (em) =>
      em.findOne(WalletLedgerEntry, { wallet: walletId }),
    );
    expect(entry).not.toBeNull();

    // Tentar atualizar deve falhar (trigger)
    await expect(
      db.em.transactional(async (em: SqlEntityManager) => {
        await em.nativeUpdate(WalletLedgerEntry, { id: entry!.id }, { amount: "999.00" });
      }),
    ).rejects.toThrow();
  });

  test("ledger entry não pode ser DELETE", async () => {
    const { walletId } = await createTestWallet(db, 10000);

    const entry = await dbQuery(db, async (em) =>
      em.findOne(WalletLedgerEntry, { wallet: walletId }),
    );
    expect(entry).not.toBeNull();

    await expect(
      db.em.transactional(async (em: SqlEntityManager) => {
        await em.nativeDelete(WalletLedgerEntry, { id: entry!.id });
      }),
    ).rejects.toThrow();
  });

  test("unique constraint: transaction_id no ledger", async () => {
    const { walletId } = await createTestWallet(db, 10000);

    const entry = await dbQuery(db, async (em) =>
      em.findOne(WalletLedgerEntry, { wallet: walletId }),
    );
    expect(entry).not.toBeNull();

    // Tentar inserir outro entry com o mesmo transaction_id deve falhar
    await expect(
      db.em.transactional(async (em: SqlEntityManager) => {
        const dup = em.create(WalletLedgerEntry, {
          id: randomUUID(),
          wallet: walletId,
          transaction: entry!.transaction,
          direction: "DEBIT",
          amount: "10.00",
          currency: "BRL",
          balanceBefore: "0.00",
          balanceAfter: "10.00",
          createdAt: new Date(),
        });
        await em.persist(dup);
        await em.flush();
      }),
    ).rejects.toThrow();
  });
});

describe("Wallet — reconciliação", () => {
  test("saldo materializado == saldo calculado pelo ledger", async () => {
    const { walletId } = await createTestWallet(db, 10000); // R$ 100.00

    const invariant = await verifyBalanceInvariant(db, walletId);
    expect(invariant.consistent).toBe(true);
    expect(invariant.stored).toBe(100);
    expect(invariant.calculated).toBe(100);
  });

  test("após transações, saldo continua consistente", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    // Simula uma BET de R$ 25.00
    const { applyWagerTransactionUseCase } = await import(
      "../../src/usecases/apply-wager-transaction.js"
    );

    await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "test-bet-001",
      idempotencyKey: "test-key-bet-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "25.00",
      currency: "BRL",
    });

    const invariant = await verifyBalanceInvariant(db, walletId);
    expect(invariant.consistent).toBe(true);
    expect(invariant.stored).toBe(75);
    expect(invariant.calculated).toBe(75);
  });
});
