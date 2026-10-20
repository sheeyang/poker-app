CREATE TABLE IF NOT EXISTS local_users (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS table_sessions (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES local_users(id),
  aggregate jsonb NOT NULL
);

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
CREATE TABLE IF NOT EXISTS analysis_evaluations (
  fingerprint text PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  table_session_id uuid NOT NULL REFERENCES table_sessions(id),
  owner_user_id uuid NOT NULL REFERENCES local_users(id),
  result jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS analysis_scores (
  fingerprint text PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  table_session_id uuid NOT NULL REFERENCES table_sessions(id),
  owner_user_id uuid NOT NULL REFERENCES local_users(id),
  result jsonb NOT NULL
);
