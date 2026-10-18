CREATE TABLE inventory_transaction_corrections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id BIGINT NOT NULL REFERENCES inventory_transactions(id),
  actor_account_snapshot TEXT NOT NULL,
  actor_display_name_snapshot TEXT NOT NULL,
  source_system TEXT NOT NULL CHECK (source_system IN ('admin', 'employee')),
  corrected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  before_content JSONB NOT NULL,
  after_content JSONB NOT NULL
);

CREATE INDEX inventory_transaction_corrections_transaction_id_id_idx
  ON inventory_transaction_corrections (transaction_id, id);
