/**
 * Unit tests — WalletLedgerEntry (domain)
 *
 * README §6.4: lançamento imutável; a factory `create` valida a
 * aritmética (balanceBefore ± money === balanceAfter).
 */

import { describe, test, expect } from "bun:test";
import { WalletLedgerEntry } from "../../src/domain/wallet-ledger-entry.js";
import { Money } from "../../src/domain/money.js";
import { LedgerArithmeticError } from "../../src/domain/errors/ledger-arithmetic-error.js";

describe("WalletLedgerEntry (domain)", () => {
  describe("create()", () => {
    test("DEBIT válido: before - money = after", () => {
      const entry = WalletLedgerEntry.create({
        id: "e1",
        walletId: "w1",
        transactionId: "t1",
        direction: "DEBIT",
        money: Money.from("30.00", "BRL"),
        balanceBefore: Money.from("100.00", "BRL"),
        balanceAfter: Money.from("70.00", "BRL"),
        createdAt: new Date("2026-01-01T00:00:00Z"),
      });
      expect(entry.isBalanced()).toBe(true);
      expect(entry.direction).toBe("DEBIT");
      expect(entry.money.amount).toBe("30.00");
    });

    test("CREDIT válido: before + money = after", () => {
      const entry = WalletLedgerEntry.create({
        id: "e2",
        walletId: "w1",
        transactionId: "t2",
        direction: "CREDIT",
        money: Money.from("25.00", "BRL"),
        balanceBefore: Money.from("70.00", "BRL"),
        balanceAfter: Money.from("95.00", "BRL"),
        createdAt: new Date("2026-01-01T00:00:00Z"),
      });
      expect(entry.isBalanced()).toBe(true);
    });

    test("DEBIT com aritmética errada lança LedgerArithmeticError", () => {
      expect(
        () =>
          WalletLedgerEntry.create({
            id: "e3",
            walletId: "w1",
            transactionId: "t3",
            direction: "DEBIT",
            money: Money.from("30.00", "BRL"),
            balanceBefore: Money.from("100.00", "BRL"),
            balanceAfter: Money.from("80.00", "BRL"),
            createdAt: new Date(),
          }),
      ).toThrow(LedgerArithmeticError);
    });

    test("CREDIT com aritmética errada lança LedgerArithmeticError", () => {
      expect(
        () =>
          WalletLedgerEntry.create({
            id: "e4",
            walletId: "w1",
            transactionId: "t4",
            direction: "CREDIT",
            money: Money.from("25.00", "BRL"),
            balanceBefore: Money.from("70.00", "BRL"),
            balanceAfter: Money.from("80.00", "BRL"),
            createdAt: new Date(),
          }),
      ).toThrow(LedgerArithmeticError);
    });
  });

  describe("rehydrate()", () => {
    test("reconstrói sem revalidar a aritmética", () => {
      const entry = WalletLedgerEntry.rehydrate({
        id: "e5",
        walletId: "w2",
        transactionId: "t5",
        direction: "DEBIT",
        amount: "30.00",
        currency: "BRL",
        balanceBefore: "100.00",
        balanceAfter: "70.00",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      });
      expect(entry.isBalanced()).toBe(true);
      expect(entry.walletId).toBe("w2");
      expect(entry.transactionId).toBe("t5");
    });
  });

  describe("imutabilidade", () => {
    test("campos são readonly (não há setters)", () => {
      const entry = WalletLedgerEntry.create({
        id: "e6",
        walletId: "w3",
        transactionId: "t6",
        direction: "CREDIT",
        money: Money.from("10.00", "BRL"),
        balanceBefore: Money.zero("BRL"),
        balanceAfter: Money.from("10.00", "BRL"),
        createdAt: new Date(),
      });
      expect(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(entry), "id")).toBeUndefined();
      expect(entry.id).toBe("e6");
    });
  });
});
