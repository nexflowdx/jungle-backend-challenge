// Run by the schema owner for an existing, separate runtime role; never by the application.
// No role creation, credentials or environment-specific provisioning belongs in migrations.
export function runtimePrivilegesSql(role: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(role)) throw new TypeError('Invalid runtime role');
  return `
    REVOKE ALL ON wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages FROM "${role}";
    GRANT USAGE ON SCHEMA public TO "${role}";
    GRANT SELECT, INSERT ON wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages TO "${role}";
    GRANT UPDATE (balance, version, updated_at) ON wallets TO "${role}";
    GRANT UPDATE (status, reference_transaction_id, failure_code, accepted_balance, accepted_currency,
      balance, balance_currency, completed_at, reference_attempts, next_reference_attempt_at, reference_deadline_at)
      ON wager_transactions TO "${role}";
    GRANT UPDATE (processed_at) ON inbox_messages TO "${role}";
    GRANT UPDATE (attempts, next_attempt_at, published_at, lease_token, lease_until) ON outbox_messages TO "${role}";
  `;
}
