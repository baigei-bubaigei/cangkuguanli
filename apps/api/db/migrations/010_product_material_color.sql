ALTER TABLE product_specs
  ADD COLUMN material TEXT NOT NULL DEFAULT '',
  ADD COLUMN color TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX product_specs_identity_package_unique ON product_specs (product_name, spec, material, color, per_case_count);
