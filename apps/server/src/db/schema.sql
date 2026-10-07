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
