import { createHash, randomBytes } from "node:crypto";
import { database } from "../db.js";
import { writeOperationLog } from "../operation-logs.js";
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
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO admin_sessions (token_hash, admin_account_id)
       VALUES ($1, $2)`,
      [hashSessionToken(token), row.id],
    );
    await writeOperationLog(client, {
      actor: { account: row.account, sourceSystem: "admin" },
      operationType: "login",
      targetType: "admin_account",
      targetId: row.id,
      content: { action: "登录" },
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

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
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE admin_sessions AS session
          SET revoked_at = CURRENT_TIMESTAMP
         FROM admin_accounts AS account
        WHERE session.token_hash = $1
          AND session.revoked_at IS NULL
          AND account.id = session.admin_account_id
        RETURNING account.id AS account_id, account.account`,
      [hashSessionToken(token)],
    );
    if (result.rowCount) {
      const account = result.rows[0];
      await writeOperationLog(client, {
        actor: { account: account.account, sourceSystem: "admin" },
        operationType: "logout",
        targetType: "admin_account",
        targetId: account.account_id,
        content: { action: "退出" },
      });
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
