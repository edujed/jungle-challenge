# Decisões — Migração para MikroORM

Documento de referência das decisões tomadas durante a migração da v1
(`pg`/`pg_pool` com SQL bruto) para MikroORM v7 com entities decoradas.

Última atualização: 2026-11-06 (domínio com construtor privado + factories).

## 1. Stack e bootstrap

| Item | Decisão |
|---|---|
| Versão | MikroORM **v7** (`@mikro-orm/postgresql`, `@mikro-orm/core`, `@mikro-orm/reflection`) |
| Metadata | `ReflectMetadataProvider` de `@mikro-orm/decorators/legacy` (decorators legacy + `reflect-metadata`). Requer `experimentalDecorators` + `emitDecoratorMetadata` no tsconfig (já configurados). |
| Conexão | `clientUrl` com a URL do PostgreSQL. Pool: `min: 1, max: 20, idleTimeoutMillis: 30_000`. |
| Schema | **Migrations manuais** (`migrations/*.sql`) são a fonte de verdade. O schema generator do MikroORM **não** é usado. O bloco `migrations: { path, tableName }` em `db.ts` é inofensivo (apenas configura o caminho para o CLI do MikroORM, que não é usado). |
| Interface `Database` | `{ orm, em, close() }` — exposta por `createDatabase()` em `src/infrastructure/database/db.ts`. Todos os consumidores usam `db.em`. |
| `main.ts` | `createDatabase()` é **async** → deve ser `await`ado no bootstrap. |

## 2. Entities

Local: `src/infrastructure/database/entities/`.

| Entity | Tabela | Observações |
|---|---|---|
| `Wallet` | `wallets` | Aggregate root. `balance` é `decimal(15,2)` mapeado como **string** (`"25.00"`). `@Unique(playerId, currency)`. |
| `WagerTransaction` | `wager_transactions` | `@Unique(idempotencyKey)`, `@Unique(providerId, externalTransactionId)`. `referenceTransactionId` é coluna plain (uuid nullable), **não** é relação. |
| `WalletLedgerEntry` | `wallet_ledger_entries` | **Imutável** (triggers no banco bloqueiam UPDATE/DELETE). Só INSERT. `@ManyToOne` para `Wallet` e `WagerTransaction`. |
| `InboxMessage` | `inbox_messages` | Dedup SQS. `@Unique(consumerName, messageId)`. |
| `OutboxMessage` | `outbox_messages` | Transactional outbox. `payload` é `json`. |

Regras:

- Money sempre como **string decimal** (nunca `number`/`float`).
- IDs UUID gerados na aplicação (`crypto.randomUUID()`), nunca no banco.
- `createdAt`/`updatedAt` com `onCreate`/`onUpdate` nos decorators.

## 3. Padrão de transação (hot-path)

Padrão **obrigatório** para o hot-path (update de saldo e demais escritas):

```typescript
return await em.transactional(async (forkedEm) => {
  // SEMPRE usar 'forkedEm' — nunca 'this.em'/'db.em' dentro do bloco
  const affected = await forkedEm.nativeUpdate(Wallet, { id }, { ... });
  return ...;
});
```

Regras de ouro:

1. **Usar o `forkedEm`** (em do callback) dentro do `transactional`. Usar o `em` global faz a query rodar **fora** da transação.
2. **Rollback automático**: qualquer `Error`/`Exception` dentro do escopo → rollback. Não chamar rollback manualmente.
3. **Commit automático**: bloco termina sem erro → commit transparente.
4. **Exceção permitida:** uma única statement atômica (ex.: `nativeUpdate` de backoff no `pending-reference-worker`) pode rodar fora de `transactional` — não há risco de inconsistência pois é uma operação única.

## 4. Decisões aprovadas pelo usuário (2026-11-06)

| # | Decisão | Status |
|---|---|---|
| 1 | Usar `raw()` dentro de QueryBuilder para expressões como `balance - ?::NUMERIC` (parâmetros posicionais) | ✅ Aprovado |
| 2 | Reconciliação (`reconcileWallet`) — agregação `SUM(CASE...)` com `LEFT JOIN` no banco via QueryBuilder + `raw()` | ✅ Aprovado e implementado (2026-11-06) |
| 3 | UPDATE atômico do saldo via QueryBuilder (`.update()` + `raw()` + `.returning()`) — migrado de `getConnection().execute()` | ✅ Aprovado e implementado (2026-11-06) |
| 4 | Domínio com **construtor privado + factories** (`create`/`open`/`receive`/`enqueue`/`rehydrate`) — entidades MikroORM viram shells de persistência; mappers `toXDomain`/`toXEntityData` em `src/infrastructure/database/mappers/` | ✅ Aprovado e implementado (2026-11-06) |

## 5. APIs do MikroORM v7 validadas

- `em.transactional(cb)` — cb recebe o forked em; commit/rollback automáticos.
- `em.nativeUpdate(Entity, where, data)` — retorna **apenas** `affectedRows` (number). **Não** retorna linhas.
- `em.upsert(Entity, data, { onConflictFields, onConflictAction: 'ignore' })` — `INSERT ... ON CONFLICT DO NOTHING`.
- `em.createQueryBuilder(Entity)` — suporta `.setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE)` → `FOR UPDATE SKIP LOCKED`.
- `em.fork().execute(sql, params, 'all' | 'get' | 'run')` — escape hatch para SQL raw (usado no health check: `SELECT 1`). Equivalentemente, `em.getConnection().execute(...)` também funciona, mas o padrão do projeto é `em.fork().execute()`.
- `em.find(Entity, where, { orderBy, limit, fields })`.
- `LockMode` em `@mikro-orm/core/enums`.
- `UniqueConstraintViolationException` em `@mikro-orm/core/exceptions` — para tratar violações de unique (ex.: 409 no createWallet).

### Atenção: `nativeUpdate` não retorna linhas

O exemplo do usuário usava `nativeUpdate(..., { returning: true })`, mas essa opção
**não existe** no `UpdateOptions` do v7.2.7. Para obter `RETURNING balance` do
UPDATE atômico do saldo, usar QueryBuilder com parâmetros **posicionais** (`?`):

```typescript
const qb = forkedEm
  .createQueryBuilder(Wallet, 'w')
  .update({
    balance: raw('balance - ?::NUMERIC', [amount]),
    version: raw('version + 1'),
  })
  .where({ id: walletId })
  .andWhere('w.balance >= ?::NUMERIC', [amount])
  .returning('balance');
const result = await qb.execute('run');
const row = result.row as { balance: string } | undefined;
```

> **Nota:** `setParameters`/`getParameters` **não existem** no v7. Parâmetros em
> `raw()` e `andWhere(string, params)` são sempre posicionais (`?`). Ver §7.

## 6. Escopo da migração

Eliminar **todas** as chamadas ao banco que não usam o MikroORM:

- [x] `apply-wager-transaction.ts` — reescrito com `em.transactional` + `forkedEm` (UPDATE atômico via QueryBuilder + `raw()`, upserts, ledger/outbox via `create`/`persist`/`flush`)
- [x] `wallets.controller.ts` — `createWallet` (tx), `getWallet`, `getWalletLedger` (cursor), `reconcileWallet` (QueryBuilder + `LEFT JOIN` + `raw()`)
- [x] `transactions.controller.ts` — `getTransaction`, `getTransactionByProvider` via `em.findOne`
- [x] `health.controller.ts` — readiness via `em.fork().execute("SELECT 1", [], "get")`
- [x] `pending-reference-worker.ts` — claim com `PESSIMISTIC_PARTIAL_WRITE` + `nativeUpdate` de backoff
- [x] `outbox-publisher.ts` — claim com `PESSIMISTIC_PARTIAL_WRITE` + `nativeUpdate` de `publishedAt`
- [x] `main.ts` — `await createDatabase(...)` (via DI factory no `AppModule`)
- [x] `package.json` — `@mikro-orm/decorators` presente; `pg`/`@types/pg` removidos

### Status (2026-11-06)

- `npx tsc --noEmit` → **limpo**
- `bun build src/main.ts --outdir dist --target bun --packages external` → **OK**
  (o flag `--packages external` é necessário porque o `@nestjs/core` importa
  estaticamente `@nestjs/microservices`, `@nestjs/websockets`, `class-transformer`
  e `class-validator` — deps opcionais que não estão instaladas)
- Migração completa — **nenhuma** chamada ao banco fora do MikroORM (todas via `em.*` / QueryBuilder)

### UPDATE atômico do saldo (implementação final)

```typescript
async function atomicBalanceUpdate(
  em: SqlEntityManager,
  walletId: string,
  amount: string,
  direction: "DEBIT" | "CREDIT" | "REVERT_DEBIT" | "REVERT_CREDIT",
): Promise<string | null> {
  const op = direction === "DEBIT" || direction === "REVERT_CREDIT" ? "-" : "+";
  const qb = em
    .createQueryBuilder(Wallet, "w")
    .update({
      balance: raw(`balance ${op} ?::NUMERIC`, [amount]),
      version: raw("version + 1"),
    })
    .where({ id: walletId });
  if (direction === "DEBIT") {
    qb.andWhere("w.balance >= ?::NUMERIC", [amount]);
  }
  const result = await qb.returning("balance").execute("run");
  const row = result.row as { balance: string } | undefined;
  return row ? String(row.balance) : null;
}
```

- `raw()` no `update()` aceita parâmetros posicionais: `raw("balance - ?::NUMERIC", [amount])`.
- `.returning("balance")` + `.execute("run")` → `QueryResult` com `row` (primeira linha) e `affectedRows`.
- `affectedRows === 0` (ou `row === undefined`) → saldo insuficiente / wallet não encontrada.
- O `forkedEm` do `transactional` é um `SqlEntityManager` (tem `createQueryBuilder`) — o `EntityManager` base não.

### `reconcileWallet` (implementação final)

```typescript
const qb = em.createQueryBuilder(Wallet, "w")
  .select([
    "w.balance as stored_balance",
    "w.currency",
    raw("COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0) as calculated_balance"),
    raw("COUNT(l.id) as checked_entries"),
  ])
  .leftJoin("w.ledgerEntries", "l")
  .where({ id: walletId })
  .groupBy(["w.balance", "w.currency"]);
const row = await qb.execute("get");
```

- `groupBy` no v7 aceita **array** (não variadic).
- `leftJoin` usa o nome da propriedade da relação (`ledgerEntries`), não o campo FK.

## 7. Notas de API aprendidas durante a migração

- `em.create(Entity, data)` no v7 exige **todos** os campos não-nulos no tipo, inclusive os com `onCreate`/`onUpdate` — passar `createdAt`/`updatedAt` explicitamente (o valor é apenas um default; o hook ainda roda no flush).
- `em.create` **não** gera PK — passar `id: crypto.randomUUID()` explicitamente (regra do projeto: UUID na aplicação).
- `SelectQueryBuilder.select()` exige argumento no v7 → `.select("*")`.
- Parâmetros em `andWhere(string, params)` são **posicionais** (`?`), não nominais (`:name`) — `setParameters`/`getParameters` não existem no v7.
- `em.upsert(EntityName, data, { onConflictFields, onConflictAction: "ignore" })` gera `INSERT ... ON CONFLICT DO NOTHING` (validado no driver: `qb.ignore()`). O `onCreate` do `createdAt` é automaticamente excluído da cláusula `DO UPDATE` pelo próprio EM.
- `em.upsert` retorna a entidade (re-hidrata via `findOne` quando `onConflictAction: "ignore"` e não há row retornada) — para detectar race, comparar `id` do resultado com o `txId` esperado.
- `Connection.execute(sql, params, "all" | "get" | "run")` retorna: `"all"` → `rows[]`, `"get"` → `rows[0]`, `"run"` → `{ affectedRows, insertId, row, rows }`.

## 8. Invariantes do schema (fonte de verdade: `migrations/001_tables.sql` + `002_constraints.sql` + `003_triggers.sql`)

- `UNIQUE(player_id, currency)` em `wallets`
- `UNIQUE(idempotency_key)` e `UNIQUE(provider_id, external_transaction_id)` em `wager_transactions`
- Ledger imutável (triggers bloqueiam UPDATE/DELETE)
- CHECK de aritmética do ledger: `DEBIT → before - amount = after`; `CREDIT → before + amount = after`
- Trigger de estado terminal em `wager_transactions` (PROCESSED/REJECTED/FAILED não transicionam)
- `CHECK (balance >= 0)` em `wallets`

## 9. Primitiva de concorrência (hot-path)

O UPDATE atômico é a primitiva de concorrência — **sem lock pessimista**:

```sql
UPDATE wallets
SET balance = balance - :amount, version = version + 1
WHERE id = :walletId AND balance >= :amount
RETURNING balance
```

Duas apostas de 80 com saldo 100 → uma PROCESSED, uma REJECTED
(`INSUFFICIENT_BALANCE`). O `rowCount === 0` detecta o saldo insuficiente.

## 10. Domínio com construtor privado + factories (2026-11-06)

Decisão do usuário: adotar a modelagem do README §6.0 — **a forma mais
segura** (construtor privado + factories estáticas), em vez de usar as
entities MikroORM diretamente como objetos de domínio.

### Estrutura

- **`src/domain/`** — classes de domínio framework-agnostic:
  - `Wallet` (`open`, `rehydrate`; `debit`/`credit`/`revertDebit`/`revertCredit`/`applyAtomicUpdate`)
  - `WagerTransaction` (`create`, `rehydrate`; transições `markProcessed`/`markPendingReference`/`reject`/`fail`/`scheduleRetry`)
  - `WalletLedgerEntry` (imutável; `create` valida a aritmética, `rehydrate` não revalida)
  - `InboxMessage` (`receive`, `rehydrate`, `markProcessed`)
  - `OutboxMessage` (`enqueue`, `rehydrate`, `markPublished`, `scheduleRetry`)
- **`src/infrastructure/database/entities/`** — shells de persistência (MikroORM).
- **`src/infrastructure/database/mappers/`** — `toXState`/`toXDomain` (entity → domain) e `toXEntityData` (domain → dados para `em.create`).

### Regras

1. **Construtor privado** — instâncias só existem via factories (`create`/`open`/`receive`/`enqueue`/`rehydrate`).
2. **`rehydrate` não revalida** transições/aritmética — apenas reconstrói estado já persistido (README §6.0).
3. **`create` valida** invariantes (ex.: `WalletLedgerEntry.create` checa `balanceBefore ± money === balanceAfter`; `WagerTransaction.create` exige referência para REFUND/ROLLBACK).
4. **A primitiva de concorrência continua no banco** — o UPDATE atômico condicionado (`WHERE balance >= amount`) não é substituído; o domain o envolve (`Wallet.applyAtomicUpdate` sincroniza o estado após o UPDATE).
5. **Transições no domain + persistência via `nativeUpdate`/mapper** — nos workers (pending-reference, outbox-publisher), a transição é exercida no domain (documenta a intenção e garante o invariante de estado terminal) e persistida via `nativeUpdate`.
6. **Interfaces/types usados por uma única classe** ficam no mesmo arquivo `.ts` da classe (regra de layout do usuário).
