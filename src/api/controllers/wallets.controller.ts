/**
 * Wallets controller — criação e consulta de wallets.
 *
 * - POST /wallets → cria wallet (com OPENING se initialBalance > 0)
 * - GET /wallets/:walletId → consulta wallet
 * - GET /wallets/:walletId/ledger → ledger paginado (cursor)
 * - POST /wallets/:walletId/reconciliation → reconciliação
 */

import { randomUUID, createHash } from "node:crypto";
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Res,
  Inject,
} from "@nestjs/common";
import type { Response } from "express";
import { UniqueConstraintViolationException, raw } from "@mikro-orm/core";
import { DATABASE } from "../tokens.js";
import type { Database } from "../../infrastructure/database/db.js";
import { Wallet } from "../../infrastructure/database/entities/wallet.entity.js";
import { WagerTransaction } from "../../infrastructure/database/entities/wager-transaction.entity.js";
import { WalletLedgerEntry } from "../../infrastructure/database/entities/wallet-ledger-entry.entity.js";
import { Money } from "../../domain/money.js";
import { Wallet as WalletDomain } from "../../domain/wallet.js";
import { WagerTransaction as WagerTransactionDomain } from "../../domain/wager-transaction.js";
import { WalletLedgerEntry as WalletLedgerEntryDomain } from "../../domain/wallet-ledger-entry.js";
import { toWalletEntityData } from "../../infrastructure/database/mappers/wallet.mapper.js";
import { toWagerTransactionEntityData } from "../../infrastructure/database/mappers/wager-transaction.mapper.js";
import { toLedgerEntryEntityData } from "../../infrastructure/database/mappers/wallet-ledger-entry.mapper.js";
import { createWalletSchema, type CreateWalletInput } from "../schemas/create-wallet.schema.js";
import { toWalletResponse } from "../mappers/wallet.mapper.js";

@Controller("wallets")
export class WalletsController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * POST /wallets
   *
   * Cria uma wallet. Se initialBalance > 0, gera uma transação OPENING
   * interna na mesma transação SQL, com lançamento CREDIT no ledger.
   */
  @Post()
  async createWallet(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const parsed = createWalletSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400);
      return {
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        details: parsed.error.flatten(),
      };
    }

    const input: CreateWalletInput = parsed.data;
    const walletId = randomUUID();
    const isPositive = input.initialBalance.amount !== "0.00";

    try {
      const wallet = await this.db.em.transactional(async (forkedEm) => {
        // 1. Wallet (domain) → INSERT
        const initialBalance = Money.from(input.initialBalance.amount, input.initialBalance.currency);
        const walletDomain = WalletDomain.open({
          id: walletId,
          playerId: input.playerId,
          initialBalance,
        });
        const w = forkedEm.create(Wallet, toWalletEntityData(walletDomain));
        await forkedEm.persist(w);
        await forkedEm.flush();

        // 2. Se initialBalance > 0: INSERT OPENING + ledger CREDIT
        if (isPositive) {
          const txId = randomUUID();
          const currency = input.initialBalance.currency;

          const openingHash = createHash("sha256").update(`opening${walletId}`).digest("hex");

          // Domain: transação OPENING (nasce PENDING) → markProcessed
          const openingTxDomain = WagerTransactionDomain.create({
            id: txId,
            providerId: "internal",
            externalTransactionId: `opening-${walletId}`,
            idempotencyKey: `internal:opening-${walletId}`,
            payloadHash: openingHash,
            walletId,
            playerId: input.playerId,
            roundId: "opening",
            gameId: "wallet",
            kind: "OPENING",
            money: initialBalance,
            referenceExternalTransactionId: null,
            createdAt: new Date(),
          });
          openingTxDomain.markProcessed(null, new Date());
          const openingTx = forkedEm.create(WagerTransaction, toWagerTransactionEntityData(openingTxDomain));
          await forkedEm.persist(openingTx);
          await forkedEm.flush();

          // Domain: lançamento CREDIT (valida aritmética 0.00 + amount = amount)
          const ledgerEntryDomain = WalletLedgerEntryDomain.create({
            id: randomUUID(),
            walletId,
            transactionId: txId,
            direction: "CREDIT",
            money: initialBalance,
            balanceBefore: Money.zero(currency),
            balanceAfter: initialBalance,
            createdAt: new Date(),
          });
          const ledgerEntry = forkedEm.create(WalletLedgerEntry, toLedgerEntryEntityData(ledgerEntryDomain));
          await forkedEm.persist(ledgerEntry);
          await forkedEm.flush();
        }

        // 3. Retorna a wallet
        return w;
      });

      res.status(201);
      return toWalletResponse(wallet);
    } catch (error: unknown) {
      if (error instanceof UniqueConstraintViolationException) {
        // Unique violation: wallet já existe para este player + currency
        const existing = await this.db.em.fork().findOne(Wallet, {
          playerId: input.playerId,
          currency: input.initialBalance.currency,
        });
        if (existing) {
          res.status(409);
          return toWalletResponse(existing);
        }
        res.status(409);
        return { code: "CONFLICT", message: "Wallet already exists for this playerId + currency" };
      }
      throw error;
    }
  }

  /**
   * GET /wallets/:walletId
   */
  @Get(":walletId")
  async getWallet(@Param("walletId") walletId: string, @Res({ passthrough: true }) res: Response) {
    const wallet = await this.db.em.fork().findOne(Wallet, { id: walletId });

    if (!wallet) {
      res.status(404);
      return { code: "WALLET_NOT_FOUND", message: "Wallet not found" };
    }

    return toWalletResponse(wallet);
  }

  /**
   * GET /wallets/:walletId/ledger?cursor=...&limit=50
   *
   * Cursor opaco: base64 de "created_at|id" para paginação estável.
   */
  @Get(":walletId/ledger")
  async getWalletLedger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Verifica se a wallet existe
    const walletCheck = await this.db.em.fork().findOne(Wallet, { id: walletId });
    if (!walletCheck) {
      res.status(404);
      return { code: "WALLET_NOT_FOUND", message: "Wallet not found" };
    }

    const effectiveLimit = Math.min(Math.max(parseInt(limit ?? "50", 10), 1), 100);

    let where: Record<string, unknown>;
    if (cursor) {
      const decoded = Buffer.from(cursor, "base64").toString("utf-8");
      const [cursorCreatedAt, cursorId] = decoded.split("|");
      where = {
        wallet: walletId,
        $or: [
          { createdAt: { $lt: cursorCreatedAt } },
          { createdAt: cursorCreatedAt, id: { $lt: cursorId } },
        ],
      };
    } else {
      where = { wallet: walletId };
    }

    const entries = await this.db.em.fork().find(
      WalletLedgerEntry,
      where,
      {
        orderBy: { createdAt: "DESC", id: "DESC" },
        limit: effectiveLimit,
      },
    );

    let nextCursor: string | null = null;
    if (entries.length === effectiveLimit && entries.length > 0) {
      const last = entries[entries.length - 1]!;
      nextCursor = Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString("base64");
    }

    return {
      entries: entries.map((e) => ({
        id: e.id,
        walletId: e.wallet,
        transactionId: e.transaction,
        direction: e.direction,
        money: { amount: String(e.amount), currency: e.currency },
        balanceBefore: { amount: String(e.balanceBefore), currency: e.currency },
        balanceAfter: { amount: String(e.balanceAfter), currency: e.currency },
        createdAt: e.createdAt,
      })),
      nextCursor,
    };
  }

  /**
   * POST /wallets/:walletId/reconciliation
   *
   * Compara wallets.balance (materializado) com SUM(ledger) (calculado).
   * Divergência é sinalizada, nunca corrigida.
   *
   * Agregação no banco via QueryBuilder + LEFT JOIN + raw() (decisão #2).
   */
  @Post(":walletId/reconciliation")
  async reconcileWallet(@Param("walletId") walletId: string, @Res({ passthrough: true }) res: Response) {
    const qb = this.db.em.fork()
      .createQueryBuilder(Wallet, "w")
      .select([
        "w.balance as stored_balance",
        "w.currency",
        raw(
          "COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0) as calculated_balance",
        ),
        raw("COUNT(l.id) as checked_entries"),
      ])
      .leftJoin("w.ledgerEntries", "l")
      .where({ id: walletId })
      .groupBy(["w.balance", "w.currency"]);

    const row = (await qb.execute("get")) as
      | { stored_balance: string; currency: string; calculated_balance: string; checked_entries: string | number }
      | undefined;

    if (!row) {
      res.status(404);
      return { code: "WALLET_NOT_FOUND", message: "Wallet not found" };
    }

    const stored = Number(row.stored_balance);
    const calculated = Number(row.calculated_balance);
    const difference = stored - calculated;
    const consistent = Math.abs(difference) < 0.005; // tolerância de arredondamento

    return {
      walletId,
      storedBalance: { amount: row.stored_balance, currency: row.currency },
      calculatedBalance: { amount: row.calculated_balance, currency: row.currency },
      difference: { amount: difference.toFixed(2), currency: row.currency },
      consistent,
      checkedEntries: Number(row.checked_entries),
    };
  }
}
