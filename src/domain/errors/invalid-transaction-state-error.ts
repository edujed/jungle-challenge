/**
 * Lançado quando uma transição de estado é inválida
 * (ex.: transicionar uma transação em estado terminal).
 *
 * É um erro de programação, não um caminho de negócio (README §6.3).
 */

export class InvalidTransactionStateError extends Error {
  constructor(
    current: string,
    target: string,
  ) {
    super(`Invalid transaction state transition: ${current} → ${target}`);
    this.name = "InvalidTransactionStateError";
  }
}
