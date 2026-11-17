import { Migration } from '@mikro-orm/migrations';

// Frozen migration constants: changes to the domain must not rewrite schema history.
export class Migration202611170001 extends Migration {
  override up(): void {
    this.addSql(`
      CREATE FUNCTION valid_money(value numeric) RETURNS boolean
      LANGUAGE sql IMMUTABLE PARALLEL SAFE
      RETURN value >= 0 AND value <= 92233720368547758.07 AND scale(value) <= 2;

      CREATE TABLE wallets (
        id text PRIMARY KEY CHECK (btrim(id) <> ''),
        player_id text NOT NULL CHECK (btrim(player_id) <> ''),
        currency text NOT NULL CHECK (currency IN ('BRL', 'USD')),
        balance numeric NOT NULL CHECK (valid_money(balance)),
        version integer NOT NULL CHECK (version >= 1),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency),
        CONSTRAINT wallets_identity_unique UNIQUE (id, player_id),
        CONSTRAINT wallets_currency_unique UNIQUE (id, currency)
      );

      CREATE TABLE wager_transactions (
        id text PRIMARY KEY CHECK (btrim(id) <> ''),
        provider_id text NOT NULL CHECK (btrim(provider_id) <> ''),
        external_transaction_id text NOT NULL CHECK (btrim(external_transaction_id) <> ''),
        idempotency_key text NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
        payload_hash text NOT NULL CHECK (btrim(payload_hash) <> ''),
        wallet_id text NOT NULL,
        player_id text NOT NULL,
        round_id text NOT NULL CHECK (btrim(round_id) <> ''),
        game_id text NOT NULL CHECK (btrim(game_id) <> ''),
        kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric NOT NULL CHECK (valid_money(amount)),
        currency text NOT NULL CHECK (currency IN ('BRL','USD')),
        reference_external_transaction_id text CHECK (btrim(reference_external_transaction_id) <> ''),
        reference_transaction_id text,
        status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code text CHECK (failure_code IN (
          'INSUFFICIENT_FUNDS','REVERSAL_INSUFFICIENT_FUNDS','CURRENCY_MISMATCH','WALLET_MISMATCH',
          'AMOUNT_LIMIT_EXCEEDED','REFERENCE_CONTEXT_MISMATCH','REFERENCE_KIND_INVALID',
          'REFERENCE_AMOUNT_MISMATCH','REFERENCE_REJECTED','REFERENCE_FAILED','REFERENCE_NOT_FOUND',
          'SELF_REFERENCE','ALREADY_REVERSED','PERMANENT_INFRASTRUCTURE_FAILURE')),
        accepted_balance numeric CHECK (valid_money(accepted_balance)),
        accepted_currency text,
        balance numeric CHECK (valid_money(balance)),
        balance_currency text,
        created_at timestamptz NOT NULL,
        completed_at timestamptz,
        reference_attempts integer NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_reference_attempt_at timestamptz,
        reference_deadline_at timestamptz,
        CONSTRAINT transactions_provider_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT transactions_wallet_fk FOREIGN KEY (wallet_id, player_id) REFERENCES wallets (id, player_id),
        CONSTRAINT transactions_accepted_currency_fk FOREIGN KEY (wallet_id, accepted_currency) REFERENCES wallets (id, currency),
        CONSTRAINT transactions_balance_currency_fk FOREIGN KEY (wallet_id, balance_currency) REFERENCES wallets (id, currency),
        CONSTRAINT transactions_ledger_identity_unique UNIQUE (id, wallet_id, currency),
        CONSTRAINT transactions_reference_identity_unique UNIQUE
          (id, provider_id, external_transaction_id, wallet_id, player_id, currency, round_id),
        CONSTRAINT transactions_reference_fk FOREIGN KEY
          (reference_transaction_id, provider_id, reference_external_transaction_id, wallet_id, player_id, currency, round_id)
          REFERENCES wager_transactions (id, provider_id, external_transaction_id, wallet_id, player_id, currency, round_id)
          DEFERRABLE INITIALLY DEFERRED,
        CHECK (kind = 'LOSS' OR amount > 0),
        CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CHECK (reference_transaction_id IS NULL OR
          (reference_external_transaction_id IS NOT NULL AND reference_transaction_id <> id)),
        CHECK ((accepted_balance IS NULL) = (accepted_currency IS NULL)),
        CHECK ((balance IS NULL) = (balance_currency IS NULL)),
        CHECK ((status IN ('PROCESSED','REJECTED','FAILED')) = (completed_at IS NOT NULL)),
        CHECK ((status IN ('PROCESSED','REJECTED','FAILED')) = (balance IS NOT NULL)),
        CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CHECK (status <> 'PROCESSED' OR
          ((reference_external_transaction_id IS NULL) = (reference_transaction_id IS NULL))),
        CHECK (status <> 'PENDING_REFERENCE' OR
          (reference_external_transaction_id IS NOT NULL AND accepted_balance IS NOT NULL))
      );
      CREATE UNIQUE INDEX transactions_processed_reversal_unique
        ON wager_transactions (reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
      CREATE INDEX transactions_wallet_created_idx ON wager_transactions (wallet_id, created_at, id);
      CREATE INDEX transactions_reference_idx ON wager_transactions (reference_transaction_id)
        WHERE reference_transaction_id IS NOT NULL;
      CREATE INDEX transactions_pending_reference_idx
        ON wager_transactions (next_reference_attempt_at NULLS FIRST, created_at, id)
        WHERE status = 'PENDING_REFERENCE';

      CREATE FUNCTION protect_transaction_state() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Transactions are audit records' USING ERRCODE = '23514';
        END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'Terminal transaction is immutable' USING ERRCODE = '23514';
        END IF;
        IF ROW(NEW.id,NEW.provider_id,NEW.external_transaction_id,NEW.idempotency_key,NEW.payload_hash,
          NEW.wallet_id,NEW.player_id,NEW.round_id,NEW.game_id,NEW.kind,NEW.amount,NEW.currency,
          NEW.reference_external_transaction_id,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.provider_id,OLD.external_transaction_id,OLD.idempotency_key,OLD.payload_hash,
          OLD.wallet_id,OLD.player_id,OLD.round_id,OLD.game_id,OLD.kind,OLD.amount,OLD.currency,
          OLD.reference_external_transaction_id,OLD.created_at) THEN
          RAISE EXCEPTION 'Transaction identity is immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
          RAISE EXCEPTION 'Cannot reset pending reference' USING ERRCODE = '23514';
        END IF;
        IF OLD.accepted_balance IS NOT NULL AND
          ROW(NEW.accepted_balance,NEW.accepted_currency) IS DISTINCT FROM ROW(OLD.accepted_balance,OLD.accepted_currency) THEN
          RAISE EXCEPTION 'Acceptance snapshot is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER transactions_protect BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION protect_transaction_state();
    `);
  }

  override down(): void {
    this.addSql(`DROP TABLE wager_transactions; DROP FUNCTION protect_transaction_state();
      DROP TABLE wallets; DROP FUNCTION valid_money(numeric);`);
  }
}
