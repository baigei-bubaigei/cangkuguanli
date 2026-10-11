CREATE TABLE employee_accounts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE employee_sessions (
  token_hash TEXT PRIMARY KEY,
  employee_account_id BIGINT NOT NULL REFERENCES employee_accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ
);
