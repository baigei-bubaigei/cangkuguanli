CREATE TABLE product_specs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_name TEXT NOT NULL,
  spec TEXT NOT NULL,
  category TEXT,
  category_name TEXT,
  note TEXT,
  per_case_count INTEGER NOT NULL CHECK (per_case_count IN (2, 4, 6)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE warehouses (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE locations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);

CREATE TABLE product_spec_locations (
  product_spec_id BIGINT NOT NULL REFERENCES product_specs(id) ON DELETE CASCADE,
  location_id BIGINT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (product_spec_id, location_id)
);
