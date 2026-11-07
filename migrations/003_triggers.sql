-- 003_triggers.sql
-- Distributed Wagering Processor — Triggers
--
-- Depende de: 001_tables.sql
--
-- Triggers:
--   1. wallets_set_updated_at — atualiza updated_at automaticamente
--   2. wager_transactions_protect_terminal — bloqueia transição a partir de estado terminal
--   3. ledger_block_update — bloqueia UPDATE no ledger (imutabilidade)
--   4. ledger_block_delete — bloqueia DELETE no ledger (imutabilidade)

-- ═══════════════════════════════════════════════════════════════════════
-- 1. WALLET — updated_at automático
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION trg_wallets_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wallets_set_updated_at ON wallets;
CREATE TRIGGER wallets_set_updated_at
    BEFORE UPDATE ON wallets
    FOR EACH ROW
    EXECUTE FUNCTION trg_wallets_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- 2. WAGER_TRANSACTIONS — proteção de estado terminal
-- ═══════════════════════════════════════════════════════════════════════

-- Impede transição a partir de estado terminal (defesa em profundidade —
-- a stored procedure já valida, mas o DB garante).
CREATE OR REPLACE FUNCTION trg_wager_transactions_no_terminal_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED')
       AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'Terminal state % cannot transition to %', OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wager_transactions_protect_terminal ON wager_transactions;
CREATE TRIGGER wager_transactions_protect_terminal
    BEFORE UPDATE ON wager_transactions
    FOR EACH ROW
    EXECUTE FUNCTION trg_wager_transactions_no_terminal_transition();

-- ═══════════════════════════════════════════════════════════════════════
-- 3. WALLET_LEDGER_ENTRIES — imutabilidade (bloquear UPDATE)
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION trg_ledger_no_update()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'wallet_ledger_entries is immutable: UPDATE blocked (id=%)', NEW.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_block_update ON wallet_ledger_entries;
CREATE TRIGGER ledger_block_update
    BEFORE UPDATE ON wallet_ledger_entries
    FOR EACH ROW
    EXECUTE FUNCTION trg_ledger_no_update();

-- ═══════════════════════════════════════════════════════════════════════
-- 4. WALLET_LEDGER_ENTRIES — imutabilidade (bloquear DELETE)
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION trg_ledger_no_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'wallet_ledger_entries is immutable: DELETE blocked (id=%)', OLD.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_block_delete ON wallet_ledger_entries;
CREATE TRIGGER ledger_block_delete
    BEFORE DELETE ON wallet_ledger_entries
    FOR EACH ROW
    EXECUTE FUNCTION trg_ledger_no_delete();
