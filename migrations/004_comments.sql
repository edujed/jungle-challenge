-- 004_comments.sql
-- Distributed Wagering Processor — Comentários (documentação do schema)
--
-- Depende de: 001_tables.sql

COMMENT ON TABLE wallets IS 'Aggregate root: carteira do jogador com saldo materializado (cache derivado do ledger).';
COMMENT ON COLUMN wallets.balance IS 'Saldo materializado. Fonte de verdade auditável é o ledger. Validado pela reconciliação.';
COMMENT ON COLUMN wallets.version IS 'Incrementa a cada mudança de saldo. Usado para auditoria e defesa em profundidade.';

COMMENT ON TABLE wager_transactions IS 'Transações de aposta (BET, WIN, LOSS, REFUND, ROLLBACK, OPENING). Imutável após estado terminal.';
COMMENT ON COLUMN wager_transactions.idempotency_key IS 'Chave de idempotência. UNIQUE. Default: "{providerId}:{externalTransactionId}".';
COMMENT ON COLUMN wager_transactions.payload_hash IS 'SHA-256 do JSON canônico dos campos de negócio. Detecta conflito de idempotência.';
COMMENT ON COLUMN wager_transactions.status IS 'PENDING → PROCESSED | REJECTED | FAILED. PENDING_REFERENCE → PROCESSED | REJECTED. Terminais: PROCESSED, REJECTED, FAILED.';
COMMENT ON COLUMN wager_transactions.attempts IS 'Contagem de tentativas de reprocessamento (PENDING_REFERENCE).';
COMMENT ON COLUMN wager_transactions.next_attempt_at IS 'Próximo horário de reprocessamento (backoff exponencial).';

COMMENT ON TABLE wallet_ledger_entries IS 'Lançamentos contábeis imutáveis. Fonte de verdade auditável. Sem UPDATE/DELETE.';
COMMENT ON COLUMN wallet_ledger_entries.direction IS 'DEBIT: débito na wallet. CREDIT: crédito na wallet.';
COMMENT ON COLUMN wallet_ledger_entries.balance_before IS 'Saldo antes do lançamento. Derivado do RETURNING do UPDATE atômico.';
COMMENT ON COLUMN wallet_ledger_entries.balance_after IS 'Saldo depois do lançamento. Derivado do RETURNING do UPDATE atômico.';

COMMENT ON TABLE inbox_messages IS 'Dedup persistente de mensagens SQS. UNIQUE (consumer_name, message_id).';
COMMENT ON TABLE outbox_messages IS 'Transactional outbox: eventos de integração publicados após commit. Worker com backoff.';
