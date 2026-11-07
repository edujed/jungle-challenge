/**
 * Unit tests — WagerTransaction (domain)
 *
 * README §6.3: construtor privado + factories (`create`, `rehydrate`),
 * transições de estado e consultas de domínio.
 */

import { describe, test, expect } from "bun:test";
import { WagerTransaction } from "../../src/domain/wager-transaction.js";
import { Money } from "../../src/domain/money.js";
import { InvalidTransactionStateError } from "../../src/domain/errors/invalid-transaction-state-error.js";

function makeTx(overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) {
  return WagerTransaction.create({
    id: "t1",
    providerId: "prov",
    externalTransactionId: "ext1",
    idempotencyKey: "key1",
    payloadHash: "hash1",
    walletId: "w1",
    playerId: "p1",
    roundId: "r1",
    gameId: "g1",
    kind: "BET",
    money: Money.from("50.00", "BRL"),
    referenceExternalTransactionId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  });
}

describe("WagerTransaction (domain)", () => {
  describe("create()", () => {
    test("nasce em PENDING", () => {
      const tx = makeTx();
      expect(tx.status).toBe("PENDING");
      expect(tx.processedAt).toBeNull();
      expect(tx.attempts).toBe(0);
    });

    test("REFUND sem referência lança erro", () => {
      expect(() => makeTx({ kind: "REFUND", referenceExternalTransactionId: null })).toThrow(
        /requires referenceExternalTransactionId/,
      );
    });

    test("ROLLBACK sem referência lança erro", () => {
      expect(() => makeTx({ kind: "ROLLBACK", referenceExternalTransactionId: null })).toThrow(
        /requires referenceExternalTransactionId/,
      );
    });

    test("REFUND com referência é aceito", () => {
      const tx = makeTx({ kind: "REFUND", referenceExternalTransactionId: "ext-bet" });
      expect(tx.status).toBe("PENDING");
      expect(tx.referenceExternalTransactionId).toBe("ext-bet");
    });
  });

  describe("rehydrate()", () => {
    test("reconstrói estado persistido sem revalidar", () => {
      const tx = WagerTransaction.rehydrate({
        id: "t2",
        providerId: "prov",
        externalTransactionId: "ext2",
        idempotencyKey: "key2",
        payloadHash: "hash2",
        walletId: "w2",
        playerId: "p2",
        roundId: "r2",
        gameId: "g2",
        kind: "WIN",
        amount: "25.00",
        currency: "BRL",
        referenceExternalTransactionId: null,
        referenceTransactionId: "t1",
        status: "PROCESSED",
        failureCode: null,
        attempts: 3,
        nextAttemptAt: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        processedAt: new Date("2026-01-01T01:00:00Z"),
      });
      expect(tx.status).toBe("PROCESSED");
      expect(tx.attempts).toBe(3);
      expect(tx.referenceTransactionId).toBe("t1");
      expect(tx.processedAt?.toISOString()).toBe("2026-01-01T01:00:00.000Z");
    });
  });

  describe("transições", () => {
    test("markProcessed: PENDING → PROCESSED", () => {
      const tx = makeTx();
      tx.markProcessed("ref1", new Date("2026-01-01T02:00:00Z"));
      expect(tx.status).toBe("PROCESSED");
      expect(tx.referenceTransactionId).toBe("ref1");
      expect(tx.processedAt?.toISOString()).toBe("2026-01-01T02:00:00.000Z");
    });

    test("markPendingReference: PENDING → PENDING_REFERENCE", () => {
      const tx = makeTx({ kind: "REFUND", referenceExternalTransactionId: "ext-bet" });
      tx.markPendingReference();
      expect(tx.status).toBe("PENDING_REFERENCE");
    });

    test("reject: PENDING → REJECTED", () => {
      const tx = makeTx();
      tx.reject("INSUFFICIENT_BALANCE");
      expect(tx.status).toBe("REJECTED");
      expect(tx.failureCode).toBe("INSUFFICIENT_BALANCE");
    });

    test("fail: PENDING → FAILED", () => {
      const tx = makeTx();
      tx.fail("INFRASTRUCTURE_ERROR");
      expect(tx.status).toBe("FAILED");
      expect(tx.failureCode).toBe("INFRASTRUCTURE_ERROR");
    });

    test("transicionar de estado terminal lança InvalidTransactionStateError", () => {
      const tx = makeTx();
      tx.markProcessed(null, new Date());
      expect(() => tx.reject("INSUFFICIENT_BALANCE")).toThrow(InvalidTransactionStateError);
      expect(() => tx.fail("INFRASTRUCTURE_ERROR")).toThrow(InvalidTransactionStateError);
      expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
      expect(() => tx.markProcessed(null, new Date())).toThrow(InvalidTransactionStateError);
    });

    test("scheduleRetry incrementa attempts e agenda nextAttemptAt", () => {
      const tx = makeTx({ kind: "REFUND", referenceExternalTransactionId: "ext-bet" });
      tx.markPendingReference();
      const next = new Date("2026-01-01T03:00:00Z");
      tx.scheduleRetry(2, next);
      expect(tx.attempts).toBe(2);
      expect(tx.nextAttemptAt?.toISOString()).toBe("2026-01-01T03:00:00.000Z");
    });
  });

  describe("consultas de domínio", () => {
    test("isTerminal()", () => {
      const processed = makeTx();
      processed.markProcessed(null, new Date());
      expect(processed.isTerminal()).toBe(true);

      const rejected = makeTx();
      rejected.reject("INSUFFICIENT_BALANCE");
      expect(rejected.isTerminal()).toBe(true);

      const pending = makeTx();
      expect(pending.isTerminal()).toBe(false);
    });

    test("affectsBalance() é false apenas para LOSS", () => {
      expect(makeTx({ kind: "BET" }).affectsBalance()).toBe(true);
      expect(makeTx({ kind: "WIN" }).affectsBalance()).toBe(true);
      expect(makeTx({ kind: "LOSS" }).affectsBalance()).toBe(false);
      expect(makeTx({ kind: "REFUND", referenceExternalTransactionId: "x" }).affectsBalance()).toBe(true);
      expect(makeTx({ kind: "ROLLBACK", referenceExternalTransactionId: "x" }).affectsBalance()).toBe(true);
    });

    test("requiresReference() é true para REFUND e ROLLBACK", () => {
      expect(makeTx({ kind: "BET" }).requiresReference()).toBe(false);
      expect(makeTx({ kind: "REFUND", referenceExternalTransactionId: "x" }).requiresReference()).toBe(true);
      expect(makeTx({ kind: "ROLLBACK", referenceExternalTransactionId: "x" }).requiresReference()).toBe(true);
    });

    test("matchesPayload() compara payloadHash", () => {
      const tx = makeTx();
      expect(tx.matchesPayload("hash1")).toBe(true);
      expect(tx.matchesPayload("other")).toBe(false);
    });

    test("ledgerDirectionFor() por kind", () => {
      expect(makeTx({ kind: "BET" }).ledgerDirectionFor()).toBe("DEBIT");
      expect(makeTx({ kind: "WIN" }).ledgerDirectionFor()).toBe("CREDIT");
      expect(makeTx({ kind: "REFUND", referenceExternalTransactionId: "x" }).ledgerDirectionFor()).toBe("CREDIT");
      expect(makeTx({ kind: "LOSS" }).ledgerDirectionFor()).toBeNull();
      expect(makeTx({ kind: "OPENING" }).ledgerDirectionFor()).toBeNull();
    });

    test("ledgerDirectionFor() ROLLBACK inverte a referência", () => {
      const bet = makeTx({ kind: "BET" });
      const win = makeTx({ kind: "WIN" });
      const rollback = makeTx({ kind: "ROLLBACK", referenceExternalTransactionId: "x" });
      expect(rollback.ledgerDirectionFor(bet)).toBe("CREDIT");
      expect(rollback.ledgerDirectionFor(win)).toBe("DEBIT");
      expect(rollback.ledgerDirectionFor(null)).toBeNull();
    });
  });
});
