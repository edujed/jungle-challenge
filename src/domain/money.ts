/**
 * Money — valor monetário imutável.
 *
 * Regras:
 *   - Nunca usar `number`/float para dinheiro (falha eliminatória, seção 14).
 *   - Internamente: string decimal com exatamente 2 casas ("25.00").
 *   - Na API: sempre serializado como { amount: "25.00", currency: "BRL" }.
 *   - No banco: NUMERIC(15,2) + CHAR(3).
 */

import { InvalidMoneyError } from "./errors/invalid-money-error.js";
import { NegativeMoneyError } from "./errors/negative-money-error.js";
import { CurrencyMismatchError } from "./errors/currency-mismatch-error.js";

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  readonly amount: string;
  readonly currency: string;

  private constructor(amount: string, currency: string) {
    this.amount = amount;
    this.currency = currency;
  }

  static from(amount: string, currency: string): Money {
    if (!/^\d+\.\d{2}$/.test(amount)) {
      throw new InvalidMoneyError(amount);
    }
    if (currency.length !== 3) {
      throw new InvalidMoneyError(currency);
    }
    return new Money(amount, currency);
  }

  static zero(currency: string): Money {
    return new Money("0.00", currency);
  }

  /** Converte para centavos (int64) — útil para comparações e aritmética. */
  toCents(): number {
    const parts = this.amount.split(".");
    const whole = parts[0] ?? "0";
    const frac = parts[1] ?? "00";
    return parseInt(whole, 10) * 100 + parseInt(frac, 10);
  }

  /** Converte centavos para Money. */
  static fromCents(cents: number, currency: string): Money {
    const whole = Math.floor(cents / 100);
    const frac = cents % 100;
    return new Money(`${whole}.${String(frac).padStart(2, "0")}`, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromCents(this.toCents() + other.toCents(), this.currency);
  }

  sub(other: Money): Money {
    this.assertSameCurrency(other);
    const result = this.toCents() - other.toCents();
    if (result < 0) {
      throw new NegativeMoneyError(this.amount, other.amount);
    }
    return Money.fromCents(result, this.currency);
  }

  isZero(): boolean {
    return this.amount === "0.00";
  }

  isPositive(): boolean {
    return this.toCents() > 0;
  }

  equals(other: Money): boolean {
    return this.amount === other.amount && this.currency === other.currency;
  }

  toProps(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toJSON(): MoneyProps {
    return this.toProps();
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
