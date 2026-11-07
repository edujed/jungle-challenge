/**
 * Bootstrap do MikroORM (PostgreSQL) — v7.
 *
 * Substitui o pool nativo (pg) da v1. Toda a persistência passa pelo
 * EntityManager: `em.transactional()`, `em.persist()`, `em.find()`,
 * `em.upsert()`, `LockMode` — ver ARCHITECTURE.md.
 *
 * Metadata: ReflectMetadataProvider (decorators legacy +
 * reflect-metadata) — padrão recomendado para projetos com
 * experimentalDecorators/emitDecoratorMetadata.
 */

import "reflect-metadata";
import { MikroORM, defineConfig } from "@mikro-orm/postgresql";
import { ReflectMetadataProvider } from "@mikro-orm/decorators/legacy";
import { Wallet } from "./entities/wallet.entity.js";
import { WagerTransaction } from "./entities/wager-transaction.entity.js";
import { WalletLedgerEntry } from "./entities/wallet-ledger-entry.entity.js";
import { InboxMessage } from "./entities/inbox-message.entity.js";
import { OutboxMessage } from "./entities/outbox-message.entity.js";

export interface Database {
  orm: MikroORM;
  em: MikroORM["em"];
  close(): Promise<void>;
}

export async function createDatabase(databaseUrl: string): Promise<Database> {
  const orm = await MikroORM.init(
    defineConfig({
      clientUrl: databaseUrl,
      metadataProvider: ReflectMetadataProvider,
      entities: [
        Wallet,
        WagerTransaction,
        WalletLedgerEntry,
        InboxMessage,
        OutboxMessage,
      ],
      pool: {
        min: 1,
        max: 20,
        idleTimeoutMillis: 30_000,
      },
      // Migrations são aplicadas manualmente (migrations/*.sql) — o schema é
      // a fonte de verdade, não o schema generator.
      migrations: {
        path: "./migrations",
        tableName: "migrations",
      },
    }),
  );

  return {
    orm,
    em: orm.em,
    close: () => orm.close(),
  };
}
