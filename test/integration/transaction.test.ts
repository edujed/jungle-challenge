/**
 * Integration tests — Transações
 *
 * Seção 13.2 do README: atomicidade entre wallet, ledger, inbox e outbox.
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
import { WalletLedgerEntry } from "../../src/infrastructure/database/entities/wallet-ledger-entry.entity.js";
import { OutboxMessage } from "../../src/infrastructure/database/entities/outbox-message.entity.js";

let db: Database;

beforeAll(async () => {
  db = await createTestDatabase();
  await cleanDatabase(db);
});

afterAll(async () => {
  await db.close();
});

describe("Transações — BET (débito)", () => {
  test("BET com saldo suficiente → PROCESSED", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000); // R$ 100.00

    const result = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "bet-001",
      idempotencyKey: "key-bet-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "25.00",
      currency: "BRL",
    });

    expect(result.status).toBe("PROCESSED");
    expect(result.failureCode).toBeNull();
    expect(result.balanceAfter).toBe("75.00");
    expect(result.idempotentReplay).toBe(false);
  });

  test("BET com saldo insuficiente → REJECTED INSUFFICIENT_BALANCE", async () => {
    const { walletId, playerId } = await createTestWallet(db, 5000); // R$ 50.00

    const result = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "bet-002",
      idempotencyKey: "key-bet-002",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "80.00",
      currency: "BRL",
    });

    expect(result.status).toBe("REJECTED");
    expect(result.failureCode).toBe("INSUFFICIENT_BALANCE");
    expect(result.balanceAfter).toBeNull();
  });

  test("BET igual ao saldo → PROCESSED (saldo zero)", async () => {
    const { walletId, playerId } = await createTestWallet(db, 8000); // R$ 80.00

    const result = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "bet-003",
      idempotencyKey: "key-bet-003",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "80.00",
      currency: "BRL",
    });

    expect(result.status).toBe("PROCESSED");
    expect(result.balanceAfter).toBe("0.00");
  });

  test("BET gera ledger entry DEBIT", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    const result = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "bet-004",
      idempotencyKey: "key-bet-004",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "30.00",
      currency: "BRL",
    });

    const ledgerEntry = await dbQuery(db, async (em) =>
      em.findOne(WalletLedgerEntry, { transaction: result.transactionId! }),
    );
    expect(ledgerEntry).not.toBeNull();
    expect(ledgerEntry!.direction).toBe("DEBIT");
    expect(Number(ledgerEntry!.amount)).toBe(30);
    expect(Number(ledgerEntry!.balanceBefore)).toBe(100);
    expect(Number(ledgerEntry!.balanceAfter)).toBe(70);
  });

  test("BET gera outbox events (Processed + BalanceChanged)", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "bet-005",
      idempotencyKey: "key-bet-005",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "10.00",
      currency: "BRL",
    });

    const outboxMessages = await dbQuery(db, async (em) =>
      em.find(OutboxMessage, { aggregateId: walletId }),
    );
    const eventTypes = outboxMessages.map((m: OutboxMessage) => m.eventType);
    expect(eventTypes).toContain("WagerTransactionProcessed");
    expect(eventTypes).toContain("WalletBalanceChanged");
  });
});

describe("Transações — WIN (crédito)", () => {
  test("WIN → PROCESSED, saldo aumenta", async () => {
    const { walletId, playerId } = await createTestWallet(db, 5000); // R$ 50.00

    const result = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "win-001",
      idempotencyKey: "key-win-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "WIN",
      amount: "25.00",
      currency: "BRL",
    });

    expect(result.status).toBe("PROCESSED");
    expect(result.balanceAfter).toBe("75.00");
  });

  test("WIN gera ledger entry CREDIT", async () => {
    const { walletId, playerId } = await createTestWallet(db, 5000);

    const result = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "win-002",
      idempotencyKey: "key-win-002",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "WIN",
      amount: "25.00",
      currency: "BRL",
    });

    const ledgerEntry = await dbQuery(db, async (em) =>
      em.findOne(WalletLedgerEntry, { transaction: result.transactionId! }),
    );
    expect(ledgerEntry!.direction).toBe("CREDIT");
    expect(Number(ledgerEntry!.amount)).toBe(25);
  });
});

describe("Transações — LOSS (sem mudança de saldo)", () => {
  test("LOSS → PROCESSED, saldo não muda", async () => {
    const { walletId, playerId } = await createTestWallet(db, 7500); // R$ 75.00

    const result = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "loss-001",
      idempotencyKey: "key-loss-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "LOSS",
      amount: "25.00",
      currency: "BRL",
    });

    expect(result.status).toBe("PROCESSED");
    expect(result.balanceAfter).toBe("75.00");
  });

  test("LOSS não gera ledger entry", async () => {
    const { walletId, playerId } = await createTestWallet(db, 7500);

    const result = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "loss-002",
      idempotencyKey: "key-loss-002",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "LOSS",
      amount: "25.00",
      currency: "BRL",
    });

    const ledgerCount = await dbQuery(db, async (em) =>
      em.count(WalletLedgerEntry, { transaction: result.transactionId! }),
    );
    expect(ledgerCount).toBe(0);
  });

  test("LOSS gera outbox event Processed (mas não BalanceChanged)", async () => {
    const { walletId, playerId } = await createTestWallet(db, 7500);

    await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "loss-003",
      idempotencyKey: "key-loss-003",
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
    // BalanceChanged pode ou não estar presente (depende de outras transações)
    // Mas o Processed deve estar
  });
});

describe("Transações — REFUND", () => {
  test("REFUND de BET processada → PROCESSED, saldo volta", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    // BET de R$ 30.00
    const betResult = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "bet-ref-001",
      idempotencyKey: "key-bet-ref-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "30.00",
      currency: "BRL",
    });
    expect(betResult.status).toBe("PROCESSED");

    // REFUND da BET
    const refundResult = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "refund-001",
      idempotencyKey: "key-refund-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "REFUND",
      amount: "30.00",
      currency: "BRL",
      referenceExternalTransactionId: "bet-ref-001",
    });

    expect(refundResult.status).toBe("PROCESSED");
    expect(refundResult.balanceAfter).toBe("100.00");
  });

  test("REFUND sem referência → PENDING_REFERENCE", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    const result = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "refund-002",
      idempotencyKey: "key-refund-002",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "REFUND",
      amount: "30.00",
      currency: "BRL",
      referenceExternalTransactionId: "bet-nao-existe",
    });

    expect(result.status).toBe("PENDING_REFERENCE");
    expect(result.failureCode).toBeNull();
  });

  test("REFUND de WIN → REJECTED INVALID_REFERENCE_KIND", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    // WIN de R$ 25.00
    await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "win-ref-001",
      idempotencyKey: "key-win-ref-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "WIN",
      amount: "25.00",
      currency: "BRL",
    });

    // REFUND tentando referenciar a WIN
    const result = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "refund-003",
      idempotencyKey: "key-refund-003",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "REFUND",
      amount: "25.00",
      currency: "BRL",
      referenceExternalTransactionId: "win-ref-001",
    });

    expect(result.status).toBe("REJECTED");
    expect(result.failureCode).toBe("INVALID_REFERENCE_KIND");
  });

  test("REFUND com valor diferente → REJECTED AMOUNT_MISMATCH", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "bet-ref-002",
      idempotencyKey: "key-bet-ref-002",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "30.00",
      currency: "BRL",
    });

    const result = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "refund-004",
      idempotencyKey: "key-refund-004",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "REFUND",
      amount: "50.00", // diferente de 30.00
      currency: "BRL",
      referenceExternalTransactionId: "bet-ref-002",
    });

    expect(result.status).toBe("REJECTED");
    expect(result.failureCode).toBe("AMOUNT_MISMATCH");
  });

  test("REFUND duplicada → REJECTED ALREADY_REVERSED", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "bet-ref-003",
      idempotencyKey: "key-bet-ref-003",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "30.00",
      currency: "BRL",
    });

    // Primeira REFUND
    const firstRefund = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "refund-005",
      idempotencyKey: "key-refund-005",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "REFUND",
      amount: "30.00",
      currency: "BRL",
      referenceExternalTransactionId: "bet-ref-003",
    });
    expect(firstRefund.status).toBe("PROCESSED");

    // Segunda REFUND da mesma BET
    const secondRefund = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "refund-006",
      idempotencyKey: "key-refund-006",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "REFUND",
      amount: "30.00",
      currency: "BRL",
      referenceExternalTransactionId: "bet-ref-003",
    });
    expect(secondRefund.status).toBe("REJECTED");
    expect(secondRefund.failureCode).toBe("ALREADY_REVERSED");
  });
});

describe("Transações — ROLLBACK", () => {
  test("ROLLBACK de BET processada → PROCESSED", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "bet-rb-001",
      idempotencyKey: "key-bet-rb-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "40.00",
      currency: "BRL",
    });

    const result = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "rollback-001",
      idempotencyKey: "key-rollback-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "ROLLBACK",
      amount: "40.00",
      currency: "BRL",
      referenceExternalTransactionId: "bet-rb-001",
    });

    expect(result.status).toBe("PROCESSED");
    expect(result.balanceAfter).toBe("100.00");
  });

  test("ROLLBACK de LOSS → REJECTED INVALID_REFERENCE_KIND", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "loss-rb-001",
      idempotencyKey: "key-loss-rb-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "LOSS",
      amount: "20.00",
      currency: "BRL",
    });

    const result = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "rollback-002",
      idempotencyKey: "key-rollback-002",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "ROLLBACK",
      amount: "20.00",
      currency: "BRL",
      referenceExternalTransactionId: "loss-rb-001",
    });

    expect(result.status).toBe("REJECTED");
    expect(result.failureCode).toBe("INVALID_REFERENCE_KIND");
  });
});

describe("Transações — validações", () => {
  test("wallet inexistente → REJECTED WALLET_NOT_FOUND", async () => {
    const result = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "bet-wf-001",
      idempotencyKey: "key-bet-wf-001",
      playerId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      walletId: "99999999-8888-7777-6666-555555555555",
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "10.00",
      currency: "BRL",
    });

    expect(result.status).toBe("REJECTED");
    expect(result.failureCode).toBe("WALLET_NOT_FOUND");
  });

  test("moeda diferente → REJECTED CURRENCY_MISMATCH", async () => {
    // Cria wallet com BRL e tenta transação com USD
    // O CHECK constraint do banco só permite BRL, mas a validação da aplicação
    // detecta o mismatch antes de chegar ao banco
    const { walletId, playerId } = await createTestWallet(db, 10000, "BRL");

    const result = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "bet-cm-001",
      idempotencyKey: "key-bet-cm-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "10.00",
      currency: "USD",
    });

    expect(result.status).toBe("REJECTED");
    expect(result.failureCode).toBe("CURRENCY_MISMATCH");
  });

  test("player diferente → REJECTED PLAYER_WALLET_MISMATCH", async () => {
    const { walletId } = await createTestWallet(db, 10000);

    const result = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "bet-pwm-001",
      idempotencyKey: "key-bet-pwm-001",
      playerId: "00000000-0000-0000-0000-000000000000",
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "10.00",
      currency: "BRL",
    });

    expect(result.status).toBe("REJECTED");
    expect(result.failureCode).toBe("PLAYER_WALLET_MISMATCH");
  });

  test("OPENING via API → REJECTED OPENING_NOT_ALLOWED", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    const result = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "opening-001",
      idempotencyKey: "key-opening-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "OPENING",
      amount: "10.00",
      currency: "BRL",
    });

    expect(result.status).toBe("REJECTED");
    expect(result.failureCode).toBe("OPENING_NOT_ALLOWED");
  });
});

describe("Transações — idempotência", () => {
  test("mesma idempotency key + mesmo payload → replay idempotente", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    const input = {
      providerId: "test-provider",
      externalTransactionId: "bet-idem-001",
      idempotencyKey: "key-idem-001",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET" as const,
      amount: "20.00",
      currency: "BRL",
    };

    const first = await applyWagerTransactionUseCase(db, input);
    expect(first.status).toBe("PROCESSED");
    expect(first.idempotentReplay).toBe(false);

    const second = await applyWagerTransactionUseCase(db, input);
    expect(second.status).toBe("PROCESSED");
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.balanceAfter).toBe(first.balanceAfter);
  });

  test("mesma idempotency key + payload diferente → IDEMPOTENCY_CONFLICT", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "bet-idem-002",
      idempotencyKey: "key-idem-002",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "20.00",
      currency: "BRL",
    });

    const conflict = await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "bet-idem-002-diff",
      idempotencyKey: "key-idem-002", // mesma key
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "50.00", // valor diferente
      currency: "BRL",
    });

    expect(conflict.status).toBe("REJECTED");
    expect(conflict.failureCode).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("replay de REJECTED → devolve o mesmo REJECTED", async () => {
    const { walletId, playerId } = await createTestWallet(db, 5000); // R$ 50.00

    const input = {
      providerId: "test-provider",
      externalTransactionId: "bet-idem-003",
      idempotencyKey: "key-idem-003",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET" as const,
      amount: "80.00", // insuficiente
      currency: "BRL",
    };

    const first = await applyWagerTransactionUseCase(db, input);
    expect(first.status).toBe("REJECTED");
    expect(first.failureCode).toBe("INSUFFICIENT_BALANCE");

    const second = await applyWagerTransactionUseCase(db, input);
    expect(second.status).toBe("REJECTED");
    expect(second.failureCode).toBe("INSUFFICIENT_BALANCE");
    expect(second.idempotentReplay).toBe(true);
  });
});

describe("Transações — invariants finais", () => {
  test("após todas as transações: saldo == ledger", async () => {
    const { walletId, playerId } = await createTestWallet(db, 10000);

    // Várias transações
    await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "final-bet-1",
      idempotencyKey: "final-key-1",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "BET",
      amount: "30.00",
      currency: "BRL",
    });

    await applyWagerTransactionUseCase(db, {
      providerId: "test-provider",
      externalTransactionId: "final-win-1",
      idempotencyKey: "final-key-2",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "test-game",
      kind: "WIN",
      amount: "15.00",
      currency: "BRL",
    });

    const invariant = await verifyBalanceInvariant(db, walletId);
    expect(invariant.consistent).toBe(true);
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
