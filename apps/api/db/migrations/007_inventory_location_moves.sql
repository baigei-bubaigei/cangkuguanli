ALTER TABLE inventory_transactions
  ADD COLUMN target_location_id BIGINT,
  ADD COLUMN note TEXT NOT NULL DEFAULT '',
  ADD CONSTRAINT inventory_transactions_target_location_fk
    FOREIGN KEY (product_spec_id, target_location_id)
    REFERENCES product_spec_locations (product_spec_id, location_id);
