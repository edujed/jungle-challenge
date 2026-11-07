/**
 * Helpers de teste — setup e teardown para testes de integração e concorrência.
 *
 * Requer PostgreSQL real (container Docker). O DATABASE_URL é lido da
 * variável de ambiente ou usa o default do docker-compose.
 *
 * A interface `Database` é a do MikroORM (`{ orm, em, close() }`) — ver
 * `src/infrastructure/database/db.ts`. Toda leitura/escrita passa pelo
 * EntityManager (regra do projeto: nenhuma chamada ao banco fora do MikroORM).
 */

import { createDatabase, type Database } from "../src/infrastructure/database/db.js";
import { randomUUID, createHash } from "node:crypto";
import { raw } from "@mikro-orm/core";
import { Wallet } from "../src/infrastructure/database/entities/wallet.entity.js";
import { WagerTransaction } from "../src/infrastructure/database/entities/wager-transaction.entity.js";
import { WalletLedgerEntry } from "../src/infrastructure/database/entities/wallet-ledger-entry.entity.js";
import { Money } from "../src/domain/money.js";
import { Wallet as WalletDomain } from "../src/domain/wallet.js";
import { WagerTransaction as WagerTransactionDomain } from "../src/domain/wager-transaction.js";
import { WalletLedgerEntry as WalletLedgerEntryDomain } from "../src/domain/wallet-ledger-entry.js";
import { toWalletEntityData } from "../src/infrastructure/database/mappers/wallet.mapper.js";
import { toWagerTransactionEntityData } from "../src/infrastructure/database/mappers/wager-transaction.mapper.js";
import { toLedgerEntryEntityData } from "../src/infrastructure/database/mappers/wallet-ledger-entry.mapper.js";

export type { Database };

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wagering:wagering@localhost:5432/wagering";

export async function createTestDatabase(): Promise<Database> {
  return createDatabase(TEST_DATABASE_URL);
}

/**
 * Helper para fazer queries de leitura em contexto transacional.
 * O MikroORM v7 exige que operações contextuais usem transactional() ou fork().
 */
export async function dbQuery<T>(
  db: Database,
  fn: (em: import("@mikro-orm/sql").SqlEntityManager) => Promise<T>,
): Promise<T> {
  return db.em.transactional(async (em) => fn(em));
}

/**
 * Cria uma wallet de teste com saldo inicial.
 * Retorna o walletId.
 */
export async function createTestWallet(
  db: Database,
  initialBalanceCents: number,
  currency: string = "BRL",
): Promise<{ walletId: string; playerId: string }> {
  const walletId = randomUUID();
  const playerId = randomUUID();
  const amount = (initialBalanceCents / 100).toFixed(2);

  await db.em.transactional(async (em) => {
    const initialBalance = Money.from(amount, currency);
    const walletDomain = WalletDomain.open({ id: walletId, playerId, initialBalance });
    const wallet = em.create(Wallet, toWalletEntityData(walletDomain));
    await em.persist(wallet);
    await em.flush();

    if (initialBalanceCents > 0) {
      const txId = randomUUID();
      const openingHash = createHash("sha256").update(`opening${walletId}`).digest("hex");

      const txDomain = WagerTransactionDomain.create({
        id: txId,
        providerId: "internal",
        externalTransactionId: `opening-${walletId}`,
        idempotencyKey: `internal:opening-${walletId}`,
        payloadHash: openingHash,
        walletId,
        playerId,
        roundId: "opening",
        gameId: "wallet",
        kind: "OPENING",
        money: initialBalance,
        referenceExternalTransactionId: null,
        createdAt: new Date(),
      });
      txDomain.markProcessed(null, new Date());
      const tx = em.create(WagerTransaction, toWagerTransactionEntityData(txDomain));
      await em.persist(tx);

      const entryDomain = WalletLedgerEntryDomain.create({
        id: randomUUID(),
        walletId,
        transactionId: txId,
        direction: "CREDIT",
        money: initialBalance,
        balanceBefore: Money.zero(currency),
        balanceAfter: initialBalance,
        createdAt: new Date(),
      });
      const entry = em.create(WalletLedgerEntry, toLedgerEntryEntityData(entryDomain));
      await em.persist(entry);
      await em.flush();
    }
  });

  return { walletId, playerId };
}

/**
 * Limpa todas as tabelas.
 * Usa TRUNCATE CASCADE porque o trigger de imutabilidade da
 * wallet_ledger_entries bloqueia DELETE (e TRUNCATE ignora triggers).
 */
export async function cleanDatabase(db: Database): Promise<void> {
  await db.em.getConnection().execute(`
    TRUNCATE TABLE
      outbox_messages,
      inbox_messages,
      wallet_ledger_entries,
      wager_transactions,
      wallets
    CASCADE;
  `);
}

/**
 * Verifica a invariante fundamental:
 * wallet.balance == saldo reconstruído pelo ledger
 */
export async function verifyBalanceInvariant(
  db: Database,
  walletId: string,
): Promise<{ stored: number; calculated: number; consistent: boolean; entries: number }> {
  const qb = db.em
    .createQueryBuilder(Wallet, "w")
    .select([
      "w.balance as stored_balance",
      raw("COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0) as calculated_balance"),
      raw("COUNT(l.id) as checked_entries"),
    ])
    .leftJoin("w.ledgerEntries", "l")
    .where({ id: walletId })
    .groupBy(["w.balance"]);

  const row = (await qb.execute("get")) as
    | { stored_balance: string; calculated_balance: string; checked_entries: string | number }
    | undefined;

  const stored = Number(row?.stored_balance);
  const calculated = Number(row?.calculated_balance);
  const consistent = Math.abs(stored - calculated) < 0.005;

  return {
    stored,
    calculated,
    consistent,
    entries: Number(row?.checked_entries),
  };
}

/**
 * Verifica que não há saldo negativo em nenhuma wallet.
 */
export async function verifyNoNegativeBalance(db: Database): Promise<number> {
  const row = (await db.em
    .createQueryBuilder(Wallet, "w")
    .select([raw("COUNT(w.id) as count")])
    .where("w.balance < 0")
    .execute("get")) as { count: string | number } | undefined;
  return Number(row?.count);
}

/**
 * Verifica que não há débito/crédito duplicado no ledger.
 */
export async function verifyNoDuplicateLedgerEntries(db: Database): Promise<number> {
  const row = (await db.em
    .createQueryBuilder(WalletLedgerEntry, "l")
    .select([raw("COUNT(*) as count")])
    .groupBy([raw("l.transaction_id")])
    .having("COUNT(*) > 1")
    .execute("all")) as { count: string | number }[];
  return row.length;
}

/**
 * Sleep helper.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
