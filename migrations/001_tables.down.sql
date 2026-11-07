-- 001_tables.down.sql
-- Distributed Wagering Processor — Down migration: tabelas
--
-- Remove as tabelas criadas em 001_tables.sql.
-- Ordem: inversa da criação (respeita dependências de FK).

-- 5. OUTBOX_MESSAGES
DROP TABLE IF EXISTS outbox_messages;

-- 4. INBOX_MESSAGES
DROP TABLE IF EXISTS inbox_messages;

-- 3. WALLET_LEDGER_ENTRIES (FK → wallets, wager_transactions)
DROP TABLE IF EXISTS wallet_ledger_entries;

-- 2. WAGER_TRANSACTIONS (FK → wallets, FK auto-referente)
DROP TABLE IF EXISTS wager_transactions;

-- 1. WALLET
DROP TABLE IF EXISTS wallets;
