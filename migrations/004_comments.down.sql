-- 004_comments.down.sql
-- Distributed Wagering Processor — Down migration: comentários
--
-- Remove os comentários adicionados em 004_comments.sql.

COMMENT ON TABLE wallets IS NULL;
COMMENT ON COLUMN wallets.balance IS NULL;
COMMENT ON COLUMN wallets.version IS NULL;

COMMENT ON TABLE wager_transactions IS NULL;
COMMENT ON COLUMN wager_transactions.idempotency_key IS NULL;
COMMENT ON COLUMN wager_transactions.payload_hash IS NULL;
COMMENT ON COLUMN wager_transactions.status IS NULL;
COMMENT ON COLUMN wager_transactions.attempts IS NULL;
COMMENT ON COLUMN wager_transactions.next_attempt_at IS NULL;

COMMENT ON TABLE wallet_ledger_entries IS NULL;
COMMENT ON COLUMN wallet_ledger_entries.direction IS NULL;
COMMENT ON COLUMN wallet_ledger_entries.balance_before IS NULL;
COMMENT ON COLUMN wallet_ledger_entries.balance_after IS NULL;

COMMENT ON TABLE inbox_messages IS NULL;
COMMENT ON TABLE outbox_messages IS NULL;
