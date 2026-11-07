/**
 * WalletLedgerEntry — lançamento imutável do ledger (README §6.4).
 *
 * Sem campos mutáveis e sem métodos de transição — a imutabilidade é
 * estrutural, não uma convenção. A factory `create` valida a aritmética
 * do lançamento (balanceBefore ± money === balanceAfter).
 *
 * A reidratação (`rehydrate`) não revalida a aritmética — apenas
 * reconstrói estado já persistido (README §6.0).
 */

import { Money } from "./money.js";
import type { LedgerDirection } from "./enums/ledger-direction.js";
import { LedgerArithmeticError } from "./errors/ledger-arithmetic-error.js";

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;

  private constructor(
    id: string,
    walletId: string,
    transactionId: string,
    direction: LedgerDirection,
    money: Money,
    balanceBefore: Money,
    balanceAfter: Money,
    createdAt: Date,
  ) {
    this.id = id;
    this.walletId = walletId;
    this.transactionId = transactionId;
    this.direction = direction;
    this.money = money;
    this.balanceBefore = balanceBefore;
    this.balanceAfter = balanceAfter;
    this.createdAt = createdAt;
  }

  /** Cria um lançamento validando a aritmética (README §6.4). */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const expected =
      props.direction === "DEBIT"
        ? props.balanceBefore.sub(props.money)
        : props.balanceBefore.add(props.money);
    if (!expected.equals(props.balanceAfter)) {
      throw new LedgerArithmeticError(
        props.direction,
        props.balanceBefore.amount,
        props.money.amount,
        props.balanceAfter.amount,
      );
    }
    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );
  }

  /** Reconstrução a partir da persistência — não revalida a aritmética. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      Money.from(state.amount, state.currency),
      Money.from(state.balanceBefore, state.currency),
      Money.from(state.balanceAfter, state.currency),
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter. */
  isBalanced(): boolean {
    const expected =
      this.direction === "DEBIT"
        ? this.balanceBefore.sub(this.money)
        : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}
