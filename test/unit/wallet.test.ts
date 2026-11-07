/**
 * Unit tests — Wallet (domain)
 *
 * README §6.2: construtor privado + factories (`open`, `rehydrate`),
 * invariantes de saldo/moeda/versionamento.
 */

import { describe, test, expect } from "bun:test";
import { Wallet } from "../../src/domain/wallet.js";
import { Money } from "../../src/domain/money.js";
import { CurrencyMismatchError } from "../../src/domain/errors/currency-mismatch-error.js";
import { NegativeMoneyError } from "../../src/domain/errors/negative-money-error.js";

describe("Wallet (domain)", () => {
  describe("open()", () => {
    test("abre wallet com version = 1", () => {
      const w = Wallet.open({
        id: "w1",
        playerId: "p1",
        initialBalance: Money.from("100.00", "BRL"),
      });
      expect(w.version).toBe(1);
      expect(w.balance.amount).toBe("100.00");
      expect(w.currency).toBe("BRL");
      expect(w.playerId).toBe("p1");
    });

    test("aceita saldo inicial zero", () => {
      const w = Wallet.open({
        id: "w2",
        playerId: "p2",
        initialBalance: Money.zero("USD"),
      });
      expect(w.balance.isZero()).toBe(true);
      expect(w.version).toBe(1);
    });
  });

  describe("rehydrate()", () => {
    test("reconstrói estado persistido sem revalidar", () => {
      const w = Wallet.rehydrate({
        id: "w3",
        playerId: "p3",
        currency: "BRL",
        balance: "42.50",
        version: 7,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-02T00:00:00Z"),
      });
      expect(w.version).toBe(7);
      expect(w.balance.amount).toBe("42.50");
      expect(w.updatedAt.getTime()).toBe(new Date("2026-01-02T00:00:00Z").getTime());
    });
  });

  describe("debit()", () => {
    test("debita e incrementa version", () => {
      const w = Wallet.open({ id: "w4", playerId: "p4", initialBalance: Money.from("100.00", "BRL") });
      w.debit(Money.from("30.00", "BRL"));
      expect(w.balance.amount).toBe("70.00");
      expect(w.version).toBe(2);
    });

    test("lança NegativeMoneyError se saldo insuficiente", () => {
      const w = Wallet.open({ id: "w5", playerId: "p5", initialBalance: Money.from("10.00", "BRL") });
      expect(() => w.debit(Money.from("20.00", "BRL"))).toThrow(NegativeMoneyError);
      expect(w.balance.amount).toBe("10.00");
      expect(w.version).toBe(1);
    });

    test("lança CurrencyMismatchError se moeda diferente", () => {
      const w = Wallet.open({ id: "w6", playerId: "p6", initialBalance: Money.from("10.00", "BRL") });
      expect(() => w.debit(Money.from("1.00", "USD"))).toThrow(CurrencyMismatchError);
    });
  });

  describe("credit()", () => {
    test("credita e incrementa version", () => {
      const w = Wallet.open({ id: "w7", playerId: "p7", initialBalance: Money.from("10.00", "BRL") });
      w.credit(Money.from("25.00", "BRL"));
      expect(w.balance.amount).toBe("35.00");
      expect(w.version).toBe(2);
    });
  });

  describe("revertDebit() / revertCredit()", () => {
    test("revertDebit devolve o débito", () => {
      const w = Wallet.open({ id: "w8", playerId: "p8", initialBalance: Money.from("100.00", "BRL") });
      w.debit(Money.from("40.00", "BRL"));
      w.revertDebit(Money.from("40.00", "BRL"));
      expect(w.balance.amount).toBe("100.00");
      expect(w.version).toBe(3);
    });

    test("revertCredit lança NegativeMoneyError se saldo insuficiente", () => {
      const w = Wallet.open({ id: "w9", playerId: "p9", initialBalance: Money.from("5.00", "BRL") });
      expect(() => w.revertCredit(Money.from("10.00", "BRL"))).toThrow(NegativeMoneyError);
    });
  });

  describe("applyAtomicUpdate()", () => {
    test("sincroniza saldo e version vindos do UPDATE atômico", () => {
      const w = Wallet.open({ id: "w10", playerId: "p10", initialBalance: Money.from("100.00", "BRL") });
      w.applyAtomicUpdate(Money.from("60.00", "BRL"), 5);
      expect(w.balance.amount).toBe("60.00");
      expect(w.version).toBe(5);
    });

    test("lança CurrencyMismatchError se moeda divergente", () => {
      const w = Wallet.open({ id: "w11", playerId: "p11", initialBalance: Money.from("100.00", "BRL") });
      expect(() => w.applyAtomicUpdate(Money.from("60.00", "USD"), 2)).toThrow(CurrencyMismatchError);
    });
  });
});
