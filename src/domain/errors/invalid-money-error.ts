/**
 * Lançado quando um valor monetário não está no formato esperado.
 */

export class InvalidMoneyError extends Error {
  constructor(value: string) {
    super(`Invalid money value: "${value}" (expected format: "123.45")`);
    this.name = "InvalidMoneyError";
  }
}
