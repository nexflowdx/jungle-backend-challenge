import { Migration } from '@mikro-orm/migrations';

export class Migration202611170002 extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id text PRIMARY KEY CHECK (btrim(id) <> ''),
        wallet_id text NOT NULL,
        transaction_id text NOT NULL,
        direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount numeric NOT NULL CHECK (valid_money(amount) AND amount > 0),
        currency text NOT NULL CHECK (currency IN ('BRL','USD')),
        balance_before numeric NOT NULL CHECK (valid_money(balance_before)),
        balance_after numeric NOT NULL CHECK (valid_money(balance_after)),
        wallet_version integer NOT NULL CHECK (wallet_version >= 1),
        created_at timestamptz NOT NULL,
        CONSTRAINT ledger_wallet_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT ledger_transaction_fk FOREIGN KEY (transaction_id, wallet_id, currency)
          REFERENCES wager_transactions (id, wallet_id, currency) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT ledger_transaction_wallet_unique UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ledger_wallet_version_unique UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ledger_arithmetic CHECK (balance_after = CASE direction
          WHEN 'CREDIT' THEN balance_before + amount ELSE balance_before - amount END)
      );
      CREATE INDEX ledger_wallet_cursor_idx ON wallet_ledger_entries (wallet_id, created_at, id);
      CREATE FUNCTION reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Ledger is append-only' USING ERRCODE = '23514';
      END $$;
      CREATE TRIGGER ledger_no_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
      CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_mutation();
      REVOKE UPDATE, DELETE, TRUNCATE ON wallet_ledger_entries FROM PUBLIC;
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE wallet_ledger_entries; DROP FUNCTION reject_ledger_mutation();');
  }
}
