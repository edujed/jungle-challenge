-- 001_tables.sql
-- Distributed Wagering Processor — Tabelas
--
-- Convenções:
--   - UUID v4 para todos os IDs (gerados pela aplicação)
--   - NUMERIC(15,2) para valores monetários (nunca FLOAT/DOUBLE)
--   - CHAR(3) para moeda (ISO-4217)
--   - TIMESTAMPTZ para todos os timestamps (UTC)
--   - BIGINT para version
--   - CHAR(64) para hashes SHA-256 (hex)
--   - VARCHAR com tamanho explícito para strings de negócio
--   - JSONB para payloads de eventos (outbox)
--
-- Invariantes aplicadas no schema (restrição 9 do README):
--   1. No máximo uma wallet por (player_id, currency)
--   2. Saldo nunca negativo
--   3. Ledger imutável (sem UPDATE/DELETE)
--   4. Uma transação por idempotency_key
--   5. Inbox dedup por (consumer_name, message_id)
--   6. Aritmética do ledger: balanceBefore ± amount = balanceAfter
--   7. REFUND/ROLLBACK exigem referência
--
-- Ordem de criação (respeita dependências de FK):
--   1. wallets
--   2. wager_transactions (FK → wallets, FK auto-referente)
--   3. wallet_ledger_entries (FK → wallets, wager_transactions)
--   4. inbox_messages
--   5. outbox_messages
--
-- Constraints e triggers ficam em 002_constraints.sql e 003_triggers.sql.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. WALLET
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS wallets (
    id          UUID            PRIMARY KEY,
    player_id   UUID            NOT NULL,
    currency    CHAR(3)         NOT NULL,
    balance     NUMERIC(15,2)   NOT NULL DEFAULT 0,
    version     BIGINT          NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ     NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════════════
-- 2. WAGER_TRANSACTIONS
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS wager_transactions (
    id                                  UUID            PRIMARY KEY,
    provider_id                         VARCHAR(128)    NOT NULL,
    external_transaction_id             VARCHAR(256)    NOT NULL,
    idempotency_key                     VARCHAR(256)    NOT NULL,
    payload_hash                        CHAR(64)        NOT NULL,
    wallet_id                           UUID            NULL REFERENCES wallets(id),
    player_id                           UUID            NOT NULL,
    round_id                            VARCHAR(256)    NOT NULL,
    game_id                             VARCHAR(128)    NOT NULL,
    kind                                VARCHAR(10)     NOT NULL,
    amount                              NUMERIC(15,2)   NOT NULL,
    currency                            CHAR(3)         NOT NULL,
    reference_external_transaction_id   VARCHAR(256)    NULL,
    reference_transaction_id            UUID            NULL REFERENCES wager_transactions(id),
    status                              VARCHAR(20)     NOT NULL,
    failure_code                        VARCHAR(50)     NULL,
    attempts                            INT             NOT NULL DEFAULT 0,
    next_attempt_at                     TIMESTAMPTZ     NULL,
    created_at                          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    processed_at                        TIMESTAMPTZ     NULL
);

-- ═══════════════════════════════════════════════════════════════════════
-- 3. WALLET_LEDGER_ENTRIES (imutável)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
    id              UUID            PRIMARY KEY,
    wallet_id       UUID            NOT NULL REFERENCES wallets(id),
    transaction_id  UUID            NOT NULL REFERENCES wager_transactions(id),
    direction       VARCHAR(6)      NOT NULL,
    amount          NUMERIC(15,2)   NOT NULL,
    currency        CHAR(3)         NOT NULL,
    balance_before  NUMERIC(15,2)   NOT NULL,
    balance_after   NUMERIC(15,2)   NOT NULL,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════════════
-- 4. INBOX_MESSAGES (dedup de mensagens SQS)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS inbox_messages (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    consumer_name   VARCHAR(128)    NOT NULL,
    message_id      VARCHAR(256)    NOT NULL,
    payload_hash    CHAR(64)        NOT NULL,
    received_at     TIMESTAMPTZ     NOT NULL DEFAULT now(),
    processed_at    TIMESTAMPTZ     NULL
);

-- ═══════════════════════════════════════════════════════════════════════
-- 5. OUTBOX_MESSAGES (transactional outbox)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS outbox_messages (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_id    UUID            NOT NULL,
    event_type      VARCHAR(64)     NOT NULL,
    payload         JSONB           NOT NULL,
    occurred_at     TIMESTAMPTZ     NOT NULL,
    attempts        INT             NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ     NULL,
    published_at    TIMESTAMPTZ     NULL,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);
