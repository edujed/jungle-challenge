/**
 * Lançado quando uma subtração produziria valor negativo.
 */

export class NegativeMoneyError extends Error {
  constructor(a: string, b: string) {
    super(`Subtraction would produce negative amount: ${a} - ${b}`);
    this.name = "NegativeMoneyError";
  }
}
