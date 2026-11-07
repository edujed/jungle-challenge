/**
 * Lançado quando a aritmética de um lançamento do ledger é inconsistente
 * (balanceBefore ± money !== balanceAfter).
 *
 * Verificada na factory `WalletLedgerEntry.create` (README §6.4).
 */

export class LedgerArithmeticError extends Error {
  constructor(
    direction: string,
    balanceBefore: string,
    amount: string,
    balanceAfter: string,
  ) {
    super(
      `Ledger arithmetic mismatch: ${direction} ${balanceBefore} ± ${amount} !== ${balanceAfter}`,
    );
    this.name = "LedgerArithmeticError";
  }
}
