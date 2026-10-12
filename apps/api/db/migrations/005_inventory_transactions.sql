CREATE TABLE inventory_transactions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_type TEXT NOT NULL,
  product_spec_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  case_count INTEGER NOT NULL CHECK (case_count >= 0),
  loose_count INTEGER NOT NULL CHECK (loose_count >= 0),
  actual_occurred_at TIMESTAMPTZ NOT NULL,
  actor_account TEXT NOT NULL,
  source_system TEXT NOT NULL CHECK (source_system IN ('admin', 'employee')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (case_count > 0 OR loose_count > 0),
  FOREIGN KEY (product_spec_id, location_id)
    REFERENCES product_spec_locations (product_spec_id, location_id)
);
