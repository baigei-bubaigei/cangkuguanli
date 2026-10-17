CREATE TABLE system_operation_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_admin_account_id BIGINT REFERENCES admin_accounts(id),
  actor_employee_account_id BIGINT REFERENCES employee_accounts(id),
  actor_account_snapshot TEXT NOT NULL,
  actor_display_name_snapshot TEXT NOT NULL,
  source_system TEXT NOT NULL CHECK (source_system IN ('admin', 'employee')),
  operation_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id BIGINT NOT NULL,
  operation_content JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (source_system = 'admin'
      AND actor_admin_account_id IS NOT NULL
      AND actor_employee_account_id IS NULL)
    OR
    (source_system = 'employee'
      AND actor_admin_account_id IS NULL
      AND actor_employee_account_id IS NOT NULL)
  )
);
