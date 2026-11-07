-- 002_constraints.down.sql
-- Distributed Wagering Processor — Down migration: constraints e índices
--
-- Remove os índices e constraints criados em 002_constraints.sql.
-- Ordem: índices primeiro, depois constraints (UNIQUE e CHECK).

-- ═══════════════════════════════════════════════════════════════════════
-- 5. OUTBOX_MESSAGES — índices
-- ═══════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS idx_outbox_event_type;
DROP INDEX IF EXISTS idx_outbox_aggregate;
DROP INDEX IF EXISTS idx_outbox_pending;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. INBOX_MESSAGES — índices e constraints
-- ═══════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS idx_inbox_received;
ALTER TABLE inbox_messages
    DROP CONSTRAINT IF EXISTS uq_inbox_consumer_message;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. WALLET_LEDGER_ENTRIES — índices e constraints
-- ═══════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS idx_ledger_wallet_direction;
DROP INDEX IF EXISTS idx_ledger_wallet_created;
ALTER TABLE wallet_ledger_entries
    DROP CONSTRAINT IF EXISTS uq_ledger_transaction,
    DROP CONSTRAINT IF EXISTS chk_ledger_arithmetic,
    DROP CONSTRAINT IF EXISTS chk_ledger_balance_after_non_negative,
    DROP CONSTRAINT IF EXISTS chk_ledger_balance_before_non_negative,
    DROP CONSTRAINT IF EXISTS chk_ledger_amount_positive,
    DROP CONSTRAINT IF EXISTS chk_ledger_direction;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. WAGER_TRANSACTIONS — índices e constraints
-- ═══════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS idx_wager_transactions_round;
DROP INDEX IF EXISTS idx_wager_transactions_wallet;
DROP INDEX IF EXISTS idx_wager_transactions_pending_ref;
DROP INDEX IF EXISTS uq_wager_transactions_provider_ext;
ALTER TABLE wager_transactions
    DROP CONSTRAINT IF EXISTS chk_wager_transactions_reference,
    DROP CONSTRAINT IF EXISTS chk_wager_transactions_status,
    DROP CONSTRAINT IF EXISTS chk_wager_transactions_currency,
    DROP CONSTRAINT IF EXISTS chk_wager_transactions_amount_non_negative,
    DROP CONSTRAINT IF EXISTS chk_wager_transactions_kind,
    DROP CONSTRAINT IF EXISTS uq_wager_transactions_idempotency_key;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. WALLET — índices e constraints
-- ═══════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS idx_wallets_player_id;
ALTER TABLE wallets
    DROP CONSTRAINT IF EXISTS chk_wallets_version_positive,
    DROP CONSTRAINT IF EXISTS chk_wallets_balance_non_negative,
    DROP CONSTRAINT IF EXISTS uq_wallets_player_currency;
