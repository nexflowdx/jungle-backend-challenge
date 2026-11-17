import { Migration } from '@mikro-orm/migrations';

export class Migration202611170003 extends Migration {
  override up(): void {
    this.addSql(`
      CREATE FUNCTION protect_wallet_identity() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Wallet is an audit record' USING ERRCODE = '23514';
        END IF;
        IF ROW(NEW.id,NEW.player_id,NEW.currency,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.player_id,OLD.currency,OLD.created_at) THEN
          RAISE EXCEPTION 'Wallet identity is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER wallets_protect BEFORE UPDATE OR DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION protect_wallet_identity();
      CREATE TRIGGER wallets_no_truncate BEFORE TRUNCATE ON wallets
        FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_mutation();
      CREATE TRIGGER transactions_no_truncate BEFORE TRUNCATE ON wager_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_mutation();

      CREATE FUNCTION check_wallet_movement() RETURNS trigger LANGUAGE plpgsql
      SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE entry wallet_ledger_entries%ROWTYPE;
      BEGIN
        -- Check each captured transition, even if multiple movements share one SQL transaction.
        SELECT * INTO entry FROM wallet_ledger_entries
          WHERE wallet_id = NEW.id AND wallet_version = NEW.version;
        IF TG_OP = 'INSERT' THEN
          IF NEW.version <> 1 OR (NEW.balance = 0 AND entry.id IS NOT NULL) OR
            (NEW.balance > 0 AND (entry.id IS NULL OR entry.balance_before <> 0 OR
              entry.balance_after <> NEW.balance OR entry.direction <> 'CREDIT')) THEN
            RAISE EXCEPTION 'Opening balance requires matching version-one ledger' USING ERRCODE = '23514';
          END IF;
        ELSIF NEW.balance IS DISTINCT FROM OLD.balance THEN
          IF NEW.version <> OLD.version + 1 OR entry.id IS NULL OR
            entry.balance_before <> OLD.balance OR entry.balance_after <> NEW.balance THEN
            RAISE EXCEPTION 'Balance change requires matching ledger and next version' USING ERRCODE = '23514';
          END IF;
        ELSIF NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'Version changes only with balance' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER wallets_financial_integrity AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_movement();

      CREATE FUNCTION check_ledger_correspondence() RETURNS trigger LANGUAGE plpgsql
      SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE wallet wallets%ROWTYPE;
        previous_entry wallet_ledger_entries%ROWTYPE;
        following_entry wallet_ledger_entries%ROWTYPE;
        operation wager_transactions%ROWTYPE;
      BEGIN
        -- Also serialize SQL writers that bypass the future application wallet lock.
        SELECT * INTO wallet FROM wallets WHERE id = NEW.wallet_id FOR UPDATE;
        SELECT * INTO operation FROM wager_transactions WHERE id = NEW.transaction_id;
        IF operation.id IS NULL OR operation.status <> 'PROCESSED' OR operation.kind = 'LOSS' OR
          operation.amount <> NEW.amount OR operation.balance <> NEW.balance_after OR
          operation.balance_currency <> NEW.currency THEN
          RAISE EXCEPTION 'Ledger must match a processed financial transaction' USING ERRCODE = '23514';
        END IF;
        IF wallet.version < NEW.wallet_version OR
          (wallet.version = NEW.wallet_version AND wallet.balance <> NEW.balance_after) THEN
          RAISE EXCEPTION 'Ledger has no matching materialized wallet' USING ERRCODE = '23514';
        END IF;
        IF NEW.wallet_version = 1 THEN
          IF operation.kind <> 'OPENING' OR NEW.direction <> 'CREDIT' OR NEW.balance_before <> 0 THEN
            RAISE EXCEPTION 'Version one is reserved for positive opening' USING ERRCODE = '23514';
          END IF;
        ELSE
          IF operation.kind = 'OPENING' THEN
            RAISE EXCEPTION 'Opening must be version one' USING ERRCODE = '23514';
          END IF;
          SELECT * INTO previous_entry FROM wallet_ledger_entries
            WHERE wallet_id = NEW.wallet_id AND wallet_version = NEW.wallet_version - 1;
          IF previous_entry.id IS NULL THEN
            IF NEW.wallet_version <> 2 OR NEW.balance_before <> 0 THEN
              RAISE EXCEPTION 'Ledger sequence has a gap' USING ERRCODE = '23514';
            END IF;
          ELSIF previous_entry.balance_after <> NEW.balance_before THEN
            RAISE EXCEPTION 'Ledger predecessor balance differs' USING ERRCODE = '23514';
          END IF;
        END IF;
        IF wallet.version > NEW.wallet_version THEN
          SELECT * INTO following_entry FROM wallet_ledger_entries
            WHERE wallet_id = NEW.wallet_id AND wallet_version = NEW.wallet_version + 1;
          IF following_entry.id IS NULL OR following_entry.balance_before <> NEW.balance_after THEN
            RAISE EXCEPTION 'Ledger successor balance differs' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER ledger_financial_integrity AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ledger_correspondence();

      CREATE FUNCTION check_transaction_correspondence() RETURNS trigger LANGUAGE plpgsql
      SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE operation wager_transactions%ROWTYPE;
        entry wallet_ledger_entries%ROWTYPE;
        reference wager_transactions%ROWTYPE;
        reference_entry wallet_ledger_entries%ROWTYPE;
        expected_direction text;
      BEGIN
        -- Read final state: a PENDING insert may have concluded in the same transaction.
        SELECT * INTO operation FROM wager_transactions WHERE id = NEW.id;
        SELECT * INTO entry FROM wallet_ledger_entries
          WHERE transaction_id = operation.id AND wallet_id = operation.wallet_id;
        IF operation.status <> 'PROCESSED' OR operation.kind = 'LOSS' THEN
          IF entry.id IS NOT NULL THEN
            RAISE EXCEPTION 'Nonfinancial state cannot have ledger' USING ERRCODE = '23514';
          END IF;
          RETURN NULL;
        END IF;
        IF entry.id IS NULL OR entry.amount <> operation.amount OR entry.balance_after <> operation.balance THEN
          RAISE EXCEPTION 'Processed financial operation requires matching ledger' USING ERRCODE = '23514';
        END IF;
        IF operation.reference_transaction_id IS NOT NULL THEN
          SELECT * INTO reference FROM wager_transactions WHERE id = operation.reference_transaction_id;
          IF reference.id IS NULL OR reference.status <> 'PROCESSED' OR
            (operation.kind IN ('WIN','REFUND') AND reference.kind <> 'BET') OR
            (operation.kind = 'ROLLBACK' AND reference.kind NOT IN ('BET','WIN','REFUND')) OR
            (operation.kind IN ('REFUND','ROLLBACK') AND reference.amount <> operation.amount) THEN
            RAISE EXCEPTION 'Processed reference must match type, amount and status' USING ERRCODE = '23514';
          END IF;
        END IF;
        expected_direction := CASE WHEN operation.kind = 'BET' THEN 'DEBIT' ELSE 'CREDIT' END;
        IF operation.kind = 'ROLLBACK' THEN
          SELECT * INTO reference_entry FROM wallet_ledger_entries
            WHERE transaction_id = operation.reference_transaction_id AND wallet_id = operation.wallet_id;
          IF reference_entry.id IS NULL THEN
            RAISE EXCEPTION 'Rollback requires reference ledger' USING ERRCODE = '23514';
          END IF;
          expected_direction := CASE reference_entry.direction WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END;
        END IF;
        IF entry.direction <> expected_direction THEN
          RAISE EXCEPTION 'Ledger direction differs from processed operation' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER transactions_financial_integrity AFTER INSERT OR UPDATE ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transaction_correspondence();
    `);
  }

  override down(): void {
    this.addSql(`
      DROP TRIGGER transactions_financial_integrity ON wager_transactions;
      DROP TRIGGER ledger_financial_integrity ON wallet_ledger_entries;
      DROP TRIGGER wallets_financial_integrity ON wallets;
      DROP TRIGGER transactions_no_truncate ON wager_transactions;
      DROP TRIGGER wallets_no_truncate ON wallets;
      DROP TRIGGER wallets_protect ON wallets;
      DROP FUNCTION check_transaction_correspondence();
      DROP FUNCTION check_ledger_correspondence();
      DROP FUNCTION check_wallet_movement();
      DROP FUNCTION protect_wallet_identity();
    `);
  }
}
