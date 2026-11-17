import { Migration } from '@mikro-orm/migrations';

export class Migration202611170004 extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE inbox_messages (
        message_id text NOT NULL CHECK (btrim(message_id) <> ''),
        consumer_name text NOT NULL CHECK (btrim(consumer_name) <> ''),
        payload_hash text NOT NULL CHECK (btrim(payload_hash) <> ''),
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        PRIMARY KEY (message_id, consumer_name)
      );
      CREATE INDEX inbox_received_idx ON inbox_messages (received_at, message_id, consumer_name);
      CREATE TABLE outbox_messages (
        id text PRIMARY KEY CHECK (btrim(id) <> ''),
        aggregate_id text NOT NULL CHECK (btrim(aggregate_id) <> ''),
        event_type text NOT NULL CHECK (btrim(event_type) <> ''),
        event_version integer NOT NULL CHECK (event_version >= 1),
        payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz,
        published_at timestamptz,
        lease_token text CHECK (btrim(lease_token) <> ''),
        lease_until timestamptz,
        CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
        CHECK (published_at IS NULL OR (lease_token IS NULL AND lease_until IS NULL))
      );
      CREATE INDEX outbox_due_idx ON outbox_messages (next_attempt_at NULLS FIRST, occurred_at, id)
        WHERE published_at IS NULL;
      CREATE INDEX outbox_lease_idx ON outbox_messages (lease_until, id)
        WHERE published_at IS NULL AND lease_until IS NOT NULL;

      CREATE FUNCTION protect_message_identity() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME = 'inbox_messages' THEN
          IF ROW(NEW.message_id,NEW.consumer_name,NEW.payload_hash,NEW.received_at)
            IS DISTINCT FROM ROW(OLD.message_id,OLD.consumer_name,OLD.payload_hash,OLD.received_at) OR
            (OLD.processed_at IS NOT NULL AND NEW.processed_at IS DISTINCT FROM OLD.processed_at) THEN
            RAISE EXCEPTION 'Inbox identity and completion are immutable' USING ERRCODE = '23514';
          END IF;
        ELSE
          IF ROW(NEW.id,NEW.aggregate_id,NEW.event_type,NEW.event_version,NEW.payload,NEW.occurred_at)
            IS DISTINCT FROM ROW(OLD.id,OLD.aggregate_id,OLD.event_type,OLD.event_version,OLD.payload,OLD.occurred_at) OR
            OLD.published_at IS NOT NULL OR NEW.attempts < OLD.attempts THEN
            RAISE EXCEPTION 'Outbox event and publication are immutable' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER inbox_protect BEFORE UPDATE ON inbox_messages
        FOR EACH ROW EXECUTE FUNCTION protect_message_identity();
      CREATE TRIGGER outbox_protect BEFORE UPDATE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION protect_message_identity();
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE outbox_messages; DROP TABLE inbox_messages; DROP FUNCTION protect_message_identity();');
  }
}
