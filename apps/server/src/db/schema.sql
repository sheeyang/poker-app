CREATE TABLE IF NOT EXISTS local_users (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE
);
-- Check first: even a no-op ALTER takes an exclusive lock that would block startup behind in-flight transactions.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'local_users' AND column_name = 'display_name') THEN
    ALTER TABLE local_users ADD COLUMN display_name text;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS table_sessions (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES local_users(id),
  aggregate jsonb NOT NULL,
  -- True exactly while the table has scheduled work, written in the same commit that creates or ends it.
  load_at_startup boolean NOT NULL DEFAULT false,
  -- Server time (epoch ms) of the last committed change; an Online Table closes 24 hours after it.
  last_committed_at bigint NOT NULL DEFAULT 0,
  -- A Closed Table, mirroring the aggregate's `closed`, written in the commit that closes it.
  closed boolean NOT NULL DEFAULT false
);
-- The idle-table sweep reads only the open Online Tables, oldest change first.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'table_sessions' AND indexname = 'table_sessions_open_online') THEN
    CREATE INDEX table_sessions_open_online ON table_sessions (last_committed_at) WHERE NOT closed AND aggregate->>'mode' = 'online';
  END IF;
END $$;
-- Startup loads only the tables with scheduled work. Guarded: even a no-op CREATE INDEX IF NOT EXISTS takes a SHARE lock.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'table_sessions' AND indexname = 'table_sessions_load_at_startup') THEN
    CREATE INDEX table_sessions_load_at_startup ON table_sessions (id) WHERE load_at_startup;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS creation_requests (
  user_id uuid NOT NULL REFERENCES local_users(id),
  request_id text NOT NULL,
  fingerprint text NOT NULL,
  outcome jsonb NOT NULL,
  PRIMARY KEY(user_id, request_id)
);
CREATE TABLE IF NOT EXISTS processed_requests (
  table_session_id uuid NOT NULL REFERENCES table_sessions(id),
  request_id text NOT NULL,
  fingerprint text NOT NULL,
  outcome jsonb NOT NULL,
  PRIMARY KEY(table_session_id, request_id)
);
-- Deliberately no FK to a target's still-uncommitted table_sessions row.
CREATE TABLE IF NOT EXISTS acceptance_attempts (
  scope_kind text NOT NULL,
  scope_id text NOT NULL,
  request_id text NOT NULL,
  fingerprint text NOT NULL,
  transaction_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'noncommit')),
  table_session_id uuid,
  PRIMARY KEY(scope_kind, scope_id, request_id)
);
-- Mirrors each human binding of a table's aggregate, written in the same transaction as every commit.
-- The primary key serves a Guest's lookups; the unique key serves a Participant's.
CREATE TABLE IF NOT EXISTS table_memberships (
  user_id uuid NOT NULL REFERENCES local_users(id),
  table_session_id uuid NOT NULL REFERENCES table_sessions(id),
  participant_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('joined', 'left')),
  PRIMARY KEY(user_id, table_session_id),
  UNIQUE(table_session_id, participant_id)
);
-- Version-1 aggregates predate the index. They are Practice Tables whose one human is joined.
INSERT INTO table_memberships (user_id, table_session_id, participant_id, status)
SELECT (binding->>'userId')::uuid, sessions.id, binding->>'participantId', 'joined'
FROM table_sessions AS sessions, jsonb_array_elements(sessions.aggregate->'bindings') AS binding
WHERE sessions.aggregate->>'schemaVersion' = '1' AND binding->'controller'->>'kind' = 'human' AND binding ? 'userId'
ON CONFLICT DO NOTHING;
-- Analysis Results and scores belong to the Participant, authorized through its Human Controller.
CREATE TABLE IF NOT EXISTS analysis_evaluations (
  fingerprint text PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  table_session_id uuid NOT NULL REFERENCES table_sessions(id),
  participant_id text NOT NULL,
  result jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS analysis_scores (
  fingerprint text PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  table_session_id uuid NOT NULL REFERENCES table_sessions(id),
  participant_id text NOT NULL,
  result jsonb NOT NULL
);
-- Before M4 these were keyed to the Table Owner. Guarded so that later startups take no lock.
DO $$
DECLARE analysis_table text;
BEGIN
  FOREACH analysis_table IN ARRAY ARRAY['analysis_evaluations', 'analysis_scores'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = analysis_table AND column_name = 'owner_user_id') THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS participant_id text', analysis_table);
      EXECUTE format('UPDATE %I SET participant_id = result->>''participantId''', analysis_table);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN participant_id SET NOT NULL, DROP COLUMN owner_user_id', analysis_table);
    END IF;
  END LOOP;
END $$;
