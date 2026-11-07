/**
 * Unit tests — Money
 *
 * Seção 13.1 do README: operações e validações de Money
 * (escala, arredondamento, entradas inválidas).
 */

import { describe, test, expect } from "bun:test";
import { Money } from "../../src/domain/money.js";
import { InvalidMoneyError } from "../../src/domain/errors/invalid-money-error.js";
import { NegativeMoneyError } from "../../src/domain/errors/negative-money-error.js";
import { CurrencyMismatchError } from "../../src/domain/errors/currency-mismatch-error.js";

describe("Money", () => {
  describe("constructor / from()", () => {
    test("cria Money válido com 2 casas decimais", () => {
      const m = Money.from("25.00", "BRL");
      expect(m.amount).toBe("25.00");
      expect(m.currency).toBe("BRL");
    });

    test("aceita zero", () => {
      const m = Money.from("0.00", "BRL");
      expect(m.amount).toBe("0.00");
      expect(m.isZero()).toBe(true);
    });

    test("aceita valores grandes", () => {
      const m = Money.from("999999999999.99", "BRL");
      expect(m.amount).toBe("999999999999.99");
    });

    test("rejeita valor sem casas decimais", () => {
      expect(() => Money.from("25", "BRL")).toThrow(InvalidMoneyError);
    });

    test("rejeita valor com 1 casa decimal", () => {
      expect(() => Money.from("25.5", "BRL")).toThrow(InvalidMoneyError);
    });

    test("rejeita valor com 3 casas decimais", () => {
      expect(() => Money.from("25.005", "BRL")).toThrow(InvalidMoneyError);
    });

    test("rejeita valor negativo", () => {
      expect(() => Money.from("-25.00", "BRL")).toThrow(InvalidMoneyError);
    });

    test("rejeita valor com ponto flutuante", () => {
      expect(() => Money.from("25.0", "BRL")).toThrow(InvalidMoneyError);
    });

    test("rejeita string vazia", () => {
      expect(() => Money.from("", "BRL")).toThrow(InvalidMoneyError);
    });

    test("rejeita moeda com menos de 3 caracteres", () => {
      expect(() => Money.from("25.00", "BR")).toThrow(InvalidMoneyError);
    });

    test("rejeita moeda com mais de 3 caracteres", () => {
      expect(() => Money.from("25.00", "BRLX")).toThrow(InvalidMoneyError);
    });

    test("rejeita moeda vazia", () => {
      expect(() => Money.from("25.00", "")).toThrow(InvalidMoneyError);
    });
  });

  describe("zero()", () => {
    test("cria Money zero", () => {
      const m = Money.zero("BRL");
      expect(m.amount).toBe("0.00");
      expect(m.isZero()).toBe(true);
      expect(m.isPositive()).toBe(false);
    });
  });

  describe("toCents() / fromCents()", () => {
    test("converte para centavos", () => {
      expect(Money.from("25.00", "BRL").toCents()).toBe(2500);
      expect(Money.from("0.01", "BRL").toCents()).toBe(1);
      expect(Money.from("0.00", "BRL").toCents()).toBe(0);
      expect(Money.from("100.99", "BRL").toCents()).toBe(10099);
    });

    test("converte de centavos", () => {
      expect(Money.fromCents(2500, "BRL").amount).toBe("25.00");
      expect(Money.fromCents(1, "BRL").amount).toBe("0.01");
      expect(Money.fromCents(0, "BRL").amount).toBe("0.00");
      expect(Money.fromCents(10099, "BRL").amount).toBe("100.99");
    });

    test("round-trip: from → toCents → fromCents", () => {
      const original = Money.from("123.45", "BRL");
      const roundTripped = Money.fromCents(original.toCents(), "BRL");
      expect(roundTripped.amount).toBe(original.amount);
    });
  });

  describe("add()", () => {
    test("soma dois valores", () => {
      const a = Money.from("25.00", "BRL");
      const b = Money.from("10.50", "BRL");
      const result = a.add(b);
      expect(result.amount).toBe("35.50");
    });

    test("soma com zero", () => {
      const a = Money.from("25.00", "BRL");
      const zero = Money.zero("BRL");
      expect(a.add(zero).amount).toBe("25.00");
    });

    test("soma valores grandes", () => {
      const a = Money.from("999999999999.99", "BRL");
      const b = Money.from("0.01", "BRL");
      expect(a.add(b).amount).toBe("1000000000000.00");
    });

    test("rejeita soma com moeda diferente", () => {
      const a = Money.from("25.00", "BRL");
      const b = Money.from("10.00", "USD");
      expect(() => a.add(b)).toThrow(CurrencyMismatchError);
    });
  });

  describe("sub()", () => {
    test("subtrai dois valores", () => {
      const a = Money.from("25.00", "BRL");
      const b = Money.from("10.50", "BRL");
      const result = a.sub(b);
      expect(result.amount).toBe("14.50");
    });

    test("subtrai até zero", () => {
      const a = Money.from("25.00", "BRL");
      const b = Money.from("25.00", "BRL");
      expect(a.sub(b).amount).toBe("0.00");
    });

    test("rejeita subtração que resulta em negativo", () => {
      const a = Money.from("10.00", "BRL");
      const b = Money.from("25.00", "BRL");
      expect(() => a.sub(b)).toThrow(NegativeMoneyError);
    });

    test("rejeita subtração com moeda diferente", () => {
      const a = Money.from("25.00", "BRL");
      const b = Money.from("10.00", "USD");
      expect(() => a.sub(b)).toThrow(CurrencyMismatchError);
    });
  });

  describe("isZero() / isPositive()", () => {
    test("isZero para zero", () => {
      expect(Money.zero("BRL").isZero()).toBe(true);
    });

    test("isZero para valor positivo", () => {
      expect(Money.from("0.01", "BRL").isZero()).toBe(false);
    });

    test("isPositive para valor positivo", () => {
      expect(Money.from("0.01", "BRL").isPositive()).toBe(true);
    });

    test("isPositive para zero", () => {
      expect(Money.zero("BRL").isPositive()).toBe(false);
    });
  });

  describe("equals()", () => {
    test("valores iguais", () => {
      const a = Money.from("25.00", "BRL");
      const b = Money.from("25.00", "BRL");
      expect(a.equals(b)).toBe(true);
    });

    test("valores diferentes", () => {
      const a = Money.from("25.00", "BRL");
      const b = Money.from("25.01", "BRL");
      expect(a.equals(b)).toBe(false);
    });

    test("moedas diferentes", () => {
      const a = Money.from("25.00", "BRL");
      const b = Money.from("25.00", "USD");
      expect(a.equals(b)).toBe(false);
    });
  });

  describe("toProps() / toJSON()", () => {
    test("serializa para MoneyProps", () => {
      const m = Money.from("25.00", "BRL");
      expect(m.toProps()).toEqual({ amount: "25.00", currency: "BRL" });
      expect(m.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    });
  });

  describe("imutabilidade", () => {
    test("add não modifica o original", () => {
      const a = Money.from("25.00", "BRL");
      const b = Money.from("10.00", "BRL");
      a.add(b);
      expect(a.amount).toBe("25.00");
    });

    test("sub não modifica o original", () => {
      const a = Money.from("25.00", "BRL");
      const b = Money.from("10.00", "BRL");
      a.sub(b);
      expect(a.amount).toBe("25.00");
    });
  });
});
