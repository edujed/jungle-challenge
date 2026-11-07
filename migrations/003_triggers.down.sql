-- 003_triggers.down.sql
-- Distributed Wagering Processor — Down migration: triggers
--
-- Remove os triggers e funções criados em 003_triggers.sql.

-- 4. WALLET_LEDGER_ENTRIES — imutabilidade (bloquear DELETE)
DROP TRIGGER IF EXISTS ledger_block_delete ON wallet_ledger_entries;
DROP FUNCTION IF EXISTS trg_ledger_no_delete();

-- 3. WALLET_LEDGER_ENTRIES — imutabilidade (bloquear UPDATE)
DROP TRIGGER IF EXISTS ledger_block_update ON wallet_ledger_entries;
DROP FUNCTION IF EXISTS trg_ledger_no_update();

-- 2. WAGER_TRANSACTIONS — proteção de estado terminal
DROP TRIGGER IF EXISTS wager_transactions_protect_terminal ON wager_transactions;
DROP FUNCTION IF EXISTS trg_wager_transactions_no_terminal_transition();

-- 1. WALLET — updated_at automático
DROP TRIGGER IF EXISTS wallets_set_updated_at ON wallets;
DROP FUNCTION IF EXISTS trg_wallets_updated_at();
