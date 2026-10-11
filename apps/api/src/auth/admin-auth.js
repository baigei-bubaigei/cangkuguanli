import { createHash, randomBytes } from "node:crypto";
import { database } from "../db.js";
import { verifyPassword } from "./password.js";

export const adminSessionCookie = "admin_session";

function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export async function loginAdmin(account, password) {
  const result = await database().query(
    `SELECT id, account, display_name, password_hash, status
       FROM admin_accounts
      WHERE account = $1`,
    [account],
  );
  const row = result.rows[0];
  if (!row || row.status !== "active") return null;
  if (!(await verifyPassword(password, row.password_hash))) return null;

  const token = randomBytes(32).toString("base64url");
  await database().query(
    `INSERT INTO admin_sessions (token_hash, admin_account_id)
     VALUES ($1, $2)`,
    [hashSessionToken(token), row.id],
  );

  return {
    token,
    admin: { account: row.account, displayName: row.display_name },
  };
}

export async function currentAdmin(token) {
  const result = await database().query(
    `SELECT a.account, a.display_name AS "displayName"
       FROM admin_sessions s
       JOIN admin_accounts a ON a.id = s.admin_account_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND a.status = 'active'`,
    [hashSessionToken(token)],
  );
  return result.rows[0] ?? null;
}

export async function logoutAdmin(token) {
  await database().query(
    `UPDATE admin_sessions
        SET revoked_at = CURRENT_TIMESTAMP
      WHERE token_hash = $1
        AND revoked_at IS NULL`,
    [hashSessionToken(token)],
  );
}
