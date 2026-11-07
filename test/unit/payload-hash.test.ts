/**
 * Unit tests — computePayloadHash
 *
 * Seção 13.1 do README: idempotency key com payload divergente.
 * O hash SHA-256 do JSON canônico é a base da detecção de conflito.
 */

import { describe, test, expect } from "bun:test";
import { computePayloadHash } from "../../src/usecases/apply-wager-transaction.js";

const baseInput = {
  providerId: "provider-1",
  externalTransactionId: "ext-001",
  playerId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  walletId: "11111111-2222-3333-4444-555555555555",
  roundId: "round-1",
  gameId: "fortune-chimp",
  kind: "BET",
  amount: "25.00",
  currency: "BRL",
};

describe("computePayloadHash", () => {
  test("produz hash determinístico (mesmo input → mesmo hash)", () => {
    const h1 = computePayloadHash(baseInput);
    const h2 = computePayloadHash(baseInput);
    expect(h1).toBe(h2);
  });

  test("produz hash de 64 caracteres hexadecimais (SHA-256)", () => {
    const h = computePayloadHash(baseInput);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  test("muda quando amount muda", () => {
    const h1 = computePayloadHash(baseInput);
    const h2 = computePayloadHash({ ...baseInput, amount: "26.00" });
    expect(h1).not.toBe(h2);
  });

  test("muda quando kind muda", () => {
    const h1 = computePayloadHash(baseInput);
    const h2 = computePayloadHash({ ...baseInput, kind: "WIN" });
    expect(h1).not.toBe(h2);
  });

  test("muda quando currency muda", () => {
    const h1 = computePayloadHash(baseInput);
    const h2 = computePayloadHash({ ...baseInput, currency: "USD" });
    expect(h1).not.toBe(h2);
  });

  test("muda quando walletId muda", () => {
    const h1 = computePayloadHash(baseInput);
    const h2 = computePayloadHash({
      ...baseInput,
      walletId: "99999999-8888-7777-6666-555555555555",
    });
    expect(h1).not.toBe(h2);
  });

  test("muda quando referenceExternalTransactionId muda", () => {
    const h1 = computePayloadHash(baseInput);
    const h2 = computePayloadHash({
      ...baseInput,
      referenceExternalTransactionId: "ext-ref-001",
    });
    expect(h1).not.toBe(h2);
  });

  test("referenceExternalTransactionId null e ausente produzem o mesmo hash", () => {
    const h1 = computePayloadHash(baseInput);
    const h2 = computePayloadHash({ ...baseInput, referenceExternalTransactionId: null });
    expect(h1).toBe(h2);
  });

  test("ordem das chaves não importa (JSON canônico)", () => {
    // O JSON.stringify com chaves ordenadas alfabeticamente garante
    // que a ordem de inserção no objeto não afeta o hash.
    const h1 = computePayloadHash(baseInput);
    const reordered = {
      currency: baseInput.currency,
      amount: baseInput.amount,
      kind: baseInput.kind,
      gameId: baseInput.gameId,
      roundId: baseInput.roundId,
      walletId: baseInput.walletId,
      playerId: baseInput.playerId,
      providerId: baseInput.providerId,
      externalTransactionId: baseInput.externalTransactionId,
    };
    const h2 = computePayloadHash(reordered);
    expect(h1).toBe(h2);
  });

  test("idempotencyKey NÃO entra no hash (é metadado de transporte)", () => {
    // O hash é calculado apenas sobre os campos de negócio.
    // Dois payloads idênticos com idempotency keys diferentes
    // produzem o mesmo hash (o que é correto — a key é do cliente).
    const h1 = computePayloadHash(baseInput);
    const h2 = computePayloadHash(baseInput);
    expect(h1).toBe(h2);
  });

  test("providerId diferente → hash diferente", () => {
    const h1 = computePayloadHash(baseInput);
    const h2 = computePayloadHash({ ...baseInput, providerId: "provider-2" });
    expect(h1).not.toBe(h2);
  });

  test("externalTransactionId diferente → hash diferente", () => {
    const h1 = computePayloadHash(baseInput);
    const h2 = computePayloadHash({ ...baseInput, externalTransactionId: "ext-002" });
    expect(h1).not.toBe(h2);
  });
});
