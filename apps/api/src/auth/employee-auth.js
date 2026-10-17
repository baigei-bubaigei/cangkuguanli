import { createHash, randomBytes } from "node:crypto";
import { database } from "../db.js";
import { verifyPassword } from "./password.js";

export const employeeSessionCookie = "employee_session";

function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export async function loginEmployee(account, password) {
  const result = await database().query(
    `SELECT id, account, display_name, password_hash, status
       FROM employee_accounts
      WHERE account = $1`,
    [account],
  );
  const row = result.rows[0];
  if (!row || row.status !== "active" || !row.password_hash) return null;
  if (!(await verifyPassword(password, row.password_hash))) return null;

  const token = randomBytes(32).toString("base64url");
  await database().query(
    `INSERT INTO employee_sessions (token_hash, employee_account_id)
     VALUES ($1, $2)`,
    [hashSessionToken(token), row.id],
  );

  return {
    token,
    employee: { account: row.account, displayName: row.display_name },
  };
}

export async function currentEmployee(token) {
  const result = await database().query(
    `SELECT e.account, e.display_name AS "displayName"
       FROM employee_sessions s
       JOIN employee_accounts e ON e.id = s.employee_account_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND e.status = 'active'`,
    [hashSessionToken(token)],
  );
  return result.rows[0] ?? null;
}

export async function logoutEmployee(token) {
  await database().query(
    `UPDATE employee_sessions
        SET revoked_at = CURRENT_TIMESTAMP
      WHERE token_hash = $1
        AND revoked_at IS NULL`,
    [hashSessionToken(token)],
  );
}
