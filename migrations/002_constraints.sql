-- 002_constraints.sql
-- Distributed Wagering Processor — Constraints e índices
--
-- Depende de: 001_tables.sql
--
-- Invariantes aplicadas (restrição 9 do README):
--   1. No máximo uma wallet por (player_id, currency)
--   2. Saldo nunca negativo
--   3. Ledger imutável (sem UPDATE/DELETE) — triggers em 003_triggers.sql
--   4. Uma transação por idempotency_key
--   5. Inbox dedup por (consumer_name, message_id)
--   6. Aritmética do ledger: balanceBefore ± amount = balanceAfter
--   7. REFUND/ROLLBACK exigem referência
--
-- Todos os nomes de constraint são explícitos (naming convention):
--   - PK:  (implícito na definição da coluna)
--   - UNIQUE:  uq_<tabela>_<colunas>
--   - CHECK:   chk_<tabela>_<descrição>
--   - FK:      fk_<tabela>_<coluna>
--   - Índice:  idx_<tabela>_<colunas>  (ou uq_ para índices únicos)

-- ═══════════════════════════════════════════════════════════════════════
-- 1. WALLET
-- ═══════════════════════════════════════════════════════════════════════

-- Invariante: no máximo uma wallet por player + moeda
ALTER TABLE wallets
    ADD CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency);

-- Invariante: saldo nunca negativo
ALTER TABLE wallets
    ADD CONSTRAINT chk_wallets_balance_non_negative CHECK (balance >= 0);

-- Invariante: version sempre >= 1
ALTER TABLE wallets
    ADD CONSTRAINT chk_wallets_version_positive CHECK (version >= 1);

-- Índice para lookup por player (consultas de admin/suporte)
CREATE INDEX IF NOT EXISTS idx_wallets_player_id ON wallets (player_id);

-- ═══════════════════════════════════════════════════════════════════════
-- 2. WAGER_TRANSACTIONS
-- ═══════════════════════════════════════════════════════════════════════

-- Invariante: uma transação por idempotency_key
ALTER TABLE wager_transactions
    ADD CONSTRAINT uq_wager_transactions_idempotency_key UNIQUE (idempotency_key);

-- Invariante: kind válido
ALTER TABLE wager_transactions
    ADD CONSTRAINT chk_wager_transactions_kind
        CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));

-- Invariante: amount nunca negativo
ALTER TABLE wager_transactions
    ADD CONSTRAINT chk_wager_transactions_amount_non_negative CHECK (amount >= 0);

-- Invariante: moeda ISO-4217 (3 letras maiúsculas)
ALTER TABLE wager_transactions
    ADD CONSTRAINT chk_wager_transactions_currency
        CHECK (currency ~ '^[A-Z]{3}$');

-- Invariante: status válido
ALTER TABLE wager_transactions
    ADD CONSTRAINT chk_wager_transactions_status
        CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));

-- Invariante: REFUND e ROLLBACK exigem referência
ALTER TABLE wager_transactions
    ADD CONSTRAINT chk_wager_transactions_reference
        CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL);

-- Índice: lookup por provider + external_transaction_id (endpoint GET /providers/:id/...)
CREATE UNIQUE INDEX IF NOT EXISTS uq_wager_transactions_provider_ext
    ON wager_transactions (provider_id, external_transaction_id);

-- Índice: worker de PENDING_REFERENCE (varredura por status + next_attempt_at)
CREATE INDEX IF NOT EXISTS idx_wager_transactions_pending_ref
    ON wager_transactions (next_attempt_at)
    WHERE status = 'PENDING_REFERENCE';

-- Índice: consultas por wallet (ledger, histórico)
CREATE INDEX IF NOT EXISTS idx_wager_transactions_wallet ON wager_transactions (wallet_id, created_at);

-- Índice: consultas por round (correlação de eventos)
CREATE INDEX IF NOT EXISTS idx_wager_transactions_round ON wager_transactions (round_id);

-- ═══════════════════════════════════════════════════════════════════════
-- 3. WALLET_LEDGER_ENTRIES
-- ═══════════════════════════════════════════════════════════════════════

-- Invariante: direction válido
ALTER TABLE wallet_ledger_entries
    ADD CONSTRAINT chk_ledger_direction
        CHECK (direction IN ('DEBIT', 'CREDIT'));

-- Invariante: amount sempre positivo
ALTER TABLE wallet_ledger_entries
    ADD CONSTRAINT chk_ledger_amount_positive CHECK (amount > 0);

-- Invariante: balance_before nunca negativo
ALTER TABLE wallet_ledger_entries
    ADD CONSTRAINT chk_ledger_balance_before_non_negative CHECK (balance_before >= 0);

-- Invariante: balance_after nunca negativo
ALTER TABLE wallet_ledger_entries
    ADD CONSTRAINT chk_ledger_balance_after_non_negative CHECK (balance_after >= 0);

-- Invariante: aritmética do lançamento
-- DEBIT:  balance_before - amount = balance_after
-- CREDIT: balance_before + amount = balance_after
ALTER TABLE wallet_ledger_entries
    ADD CONSTRAINT chk_ledger_arithmetic
        CHECK (
            (direction = 'DEBIT'  AND balance_before - amount = balance_after)
            OR
            (direction = 'CREDIT' AND balance_before + amount = balance_after)
        );

-- Invariante: uma transação financeira produz no máximo um lançamento
ALTER TABLE wallet_ledger_entries
    ADD CONSTRAINT uq_ledger_transaction UNIQUE (transaction_id);

-- Índice: consulta de ledger por wallet (paginado por cursor)
CREATE INDEX IF NOT EXISTS idx_ledger_wallet_created ON wallet_ledger_entries (wallet_id, created_at, id);

-- Índice: reconciliação (SUM por wallet)
CREATE INDEX IF NOT EXISTS idx_ledger_wallet_direction ON wallet_ledger_entries (wallet_id, direction);

-- ═══════════════════════════════════════════════════════════════════════
-- 4. INBOX_MESSAGES
-- ═══════════════════════════════════════════════════════════════════════

-- Invariante: dedup por (consumer, message)
ALTER TABLE inbox_messages
    ADD CONSTRAINT uq_inbox_consumer_message UNIQUE (consumer_name, message_id);

-- Índice: limpeza de mensagens antigas (GC)
CREATE INDEX IF NOT EXISTS idx_inbox_received ON inbox_messages (received_at);

-- ═══════════════════════════════════════════════════════════════════════
-- 5. OUTBOX_MESSAGES
-- ═══════════════════════════════════════════════════════════════════════

-- Índice: worker de publicação (eventos pendentes, em ordem de criação)
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_messages (created_at)
    WHERE published_at IS NULL;

-- Índice: eventos por aggregate (auditoria)
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate ON outbox_messages (aggregate_id, created_at);

-- Índice: eventos por tipo (métricas, debugging)
CREATE INDEX IF NOT EXISTS idx_outbox_event_type ON outbox_messages (event_type, created_at);
