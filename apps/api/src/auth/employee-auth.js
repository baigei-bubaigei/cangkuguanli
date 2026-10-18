import { createHash, randomBytes } from "node:crypto";
import { database } from "../db.js";
import { writeOperationLog } from "../operation-logs.js";
import { hashPassword, verifyPassword } from "./password.js";

export const employeeSessionCookie = "employee_session";

function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export async function loginEmployee(account, password) {
  const result = await database().query(
    `SELECT id, account, display_name, password_hash, status, must_change_password
       FROM employee_accounts
      WHERE account = $1`,
    [account],
  );
  const row = result.rows[0];
  if (!row || row.status !== "active" || !row.password_hash) return null;
  if (!(await verifyPassword(password, row.password_hash))) return null;

  const token = randomBytes(32).toString("base64url");
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO employee_sessions (token_hash, employee_account_id)
       VALUES ($1, $2)`,
      [hashSessionToken(token), row.id],
    );
    await writeOperationLog(client, {
      actor: { account: row.account, sourceSystem: "employee" },
      operationType: "login",
      targetType: "employee_account",
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

  const employee = {
    account: row.account,
    displayName: row.display_name,
  };
  if (row.must_change_password) employee.mustChangePassword = true;

  return { token, employee };
}

export async function currentEmployee(token) {
  const result = await database().query(
    `SELECT e.account, e.display_name AS "displayName"
       FROM employee_sessions s
       JOIN employee_accounts e ON e.id = s.employee_account_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND e.status = 'active'
        AND e.must_change_password = FALSE`,
    [hashSessionToken(token)],
  );
  return result.rows[0] ?? null;
}

export async function currentEmployeeSession(token) {
  const result = await database().query(
    `SELECT e.account, e.display_name AS "displayName",
            e.must_change_password AS "mustChangePassword"
       FROM employee_sessions s
       JOIN employee_accounts e ON e.id = s.employee_account_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND e.status = 'active'`,
    [hashSessionToken(token)],
  );
  const employee = result.rows[0];
  if (!employee) return null;
  if (employee.mustChangePassword) return employee;
  return { account: employee.account, displayName: employee.displayName };
}

export async function changeEmployeePassword(token, password) {
  const tokenHash = hashSessionToken(token);
  const result = await database().query(
    `SELECT e.id, e.password_hash
       FROM employee_sessions s
       JOIN employee_accounts e ON e.id = s.employee_account_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND e.status = 'active'
        AND e.must_change_password = TRUE`,
    [tokenHash],
  );
  const employee = result.rows[0];
  if (!employee) return "not-required";
  if (await verifyPassword(password, employee.password_hash)) return "same-password";

  const passwordHash = await hashPassword(password);
  const updated = await database().query(
    `UPDATE employee_accounts
        SET password_hash = $1,
            must_change_password = FALSE
      WHERE id = $2
        AND status = 'active'
        AND must_change_password = TRUE`,
    [passwordHash, employee.id],
  );
  return updated.rowCount ? "changed" : "not-required";
}

export async function logoutEmployee(token) {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE employee_sessions AS session
          SET revoked_at = CURRENT_TIMESTAMP
         FROM employee_accounts AS account
        WHERE session.token_hash = $1
          AND session.revoked_at IS NULL
          AND account.id = session.employee_account_id
        RETURNING account.id AS account_id, account.account`,
      [hashSessionToken(token)],
    );
    if (result.rowCount) {
      const account = result.rows[0];
      await writeOperationLog(client, {
        actor: { account: account.account, sourceSystem: "employee" },
        operationType: "logout",
        targetType: "employee_account",
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
