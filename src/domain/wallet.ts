/**
 * Wallet — Aggregate Root (README §6.2).
 *
 * Construtor privado + factories estáticas (`open`, `rehydrate`).
 * Invariantes:
 *   - saldo nunca negativo;
 *   - moeda da operação deve ser igual à moeda da wallet;
 *   - `version` inicia em 1 e incrementa somente quando o saldo muda.
 *
 * A reidratação (`rehydrate`) não revalida transições — apenas reconstrói
 * estado já persistido (README §6.0).
 *
 * Nota: a primitiva de concorrência (UPDATE atômico condicionado) continua
 * no banco — ver ARCHITECTURE.md §4. As mutações aqui (`debit`/`credit`)
 * são usadas nos caminhos onde o row lock já foi adquirido (hot-path) ou
 * onde a operação é única (abertura de wallet).
 */

import { Money } from "./money.js";
import { CurrencyMismatchError } from "./errors/currency-mismatch-error.js";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly createdAt: Date;

  private _balance: Money;
  private _version: number;
  private _updatedAt: Date;

  private constructor(
    id: string,
    playerId: string,
    currency: string,
    balance: Money,
    version: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this.id = id;
    this.playerId = playerId;
    this.currency = currency;
    this._balance = balance;
    this._version = version;
    this.createdAt = createdAt;
    this._updatedAt = updatedAt;
  }

  /** Abre uma nova wallet. `version` inicia em 1 (README §6.2). */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
  }): Wallet {
    const now = new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from(state.balance, state.currency),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Débito (BET). Lança `NegativeMoneyError` se o saldo for insuficiente.
   * Incrementa `version` e atualiza `updatedAt`.
   */
  debit(money: Money): void {
    this.assertSameCurrency(money);
    this._balance = this._balance.sub(money);
    this._version += 1;
    this._updatedAt = new Date();
  }

  /** Crédito (WIN/REFUND/ROLLBACK/OPENING). Incrementa `version`. */
  credit(money: Money): void {
    this.assertSameCurrency(money);
    this._balance = this._balance.add(money);
    this._version += 1;
    this._updatedAt = new Date();
  }

  /**
   * Reverte um débito (caminho de race na idempotency key — hot-path).
   * Incrementa `version` (o UPDATE atômico correspondente também incrementa).
   */
  revertDebit(money: Money): void {
    this.assertSameCurrency(money);
    this._balance = this._balance.add(money);
    this._version += 1;
    this._updatedAt = new Date();
  }

  /**
   * Reverte um crédito (caminho de race na idempotency key — hot-path).
   * Lança `NegativeMoneyError` se o saldo for insuficiente.
   */
  revertCredit(money: Money): void {
    this.assertSameCurrency(money);
    this._balance = this._balance.sub(money);
    this._version += 1;
    this._updatedAt = new Date();
  }

  /**
   * Reconstrói a wallet a partir do saldo retornado pelo UPDATE atômico
   * (hot-path). O `newVersion` é o version resultante do UPDATE
   * (o valor em memória pode estar stale — por isso o parâmetro explícito).
   */
  applyAtomicUpdate(newBalance: Money, newVersion: number): void {
    this.assertSameCurrency(newBalance);
    this._balance = newBalance;
    this._version = newVersion;
    this._updatedAt = new Date();
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
