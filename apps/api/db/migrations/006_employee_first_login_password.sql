ALTER TABLE employee_accounts
  ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX employee_accounts_account_case_insensitive
  ON employee_accounts (LOWER(account));
