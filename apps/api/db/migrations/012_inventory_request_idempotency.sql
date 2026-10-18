CREATE TABLE inventory_request_idempotency (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_system TEXT NOT NULL CHECK (source_system IN ('admin', 'employee')),
  actor_account TEXT NOT NULL,
  request_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_system, actor_account, request_scope, idempotency_key),
  CHECK ((response_status IS NULL) = (response_body IS NULL))
);
