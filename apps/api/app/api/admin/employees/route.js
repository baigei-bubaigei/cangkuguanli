import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import {
  adminSessionCookie,
  currentAdmin,
} from "../../../../src/auth/admin-auth.js";
import { hashPassword } from "../../../../src/auth/password.js";
import { database } from "../../../../src/db.js";

export const runtime = "nodejs";

async function administrator(request) {
  const token = request.cookies.get(adminSessionCookie)?.value;
  return token ? currentAdmin(token) : null;
}

function unauthorized() {
  return NextResponse.json({ error: "需要管理员登录后管理员工账号。" }, {
    status: 401,
    headers: { "Cache-Control": "no-store" },
  });
}

function employeeFields(row) {
  return {
    id: String(row.id),
    account: row.account,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function GET(request) {
  if (!await administrator(request)) return unauthorized();

  const result = await database().query(
    `SELECT id, account, display_name, status, created_at
       FROM employee_accounts
      ORDER BY created_at DESC, id DESC`,
  );
  return NextResponse.json(result.rows.map(employeeFields), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request) {
  if (!await administrator(request)) return unauthorized();

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请填写员工姓名和登录账号。" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "请填写员工姓名和登录账号。" }, { status: 400 });
  }

  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const account = typeof body.account === "string" ? body.account.trim() : "";
  if (!displayName || !account) {
    return NextResponse.json({ error: "请填写员工姓名和登录账号。" }, { status: 400 });
  }

  const temporaryPassword = randomBytes(9).toString("base64url");
  const passwordHash = await hashPassword(temporaryPassword);
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT 1 FROM employee_accounts WHERE LOWER(account) = LOWER($1)
       UNION ALL
       SELECT 1 FROM admin_accounts WHERE LOWER(account) = LOWER($1)
       LIMIT 1`,
      [account],
    );
    if (existing.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "该账号已存在或属于管理员。" }, { status: 409 });
    }

    const inserted = await client.query(
      `INSERT INTO employee_accounts
         (account, display_name, password_hash, must_change_password)
       VALUES ($1, $2, $3, TRUE)
       RETURNING id, account, display_name, status, created_at`,
      [account, displayName, passwordHash],
    );
    await client.query("COMMIT");

    return NextResponse.json({
      employee: employeeFields(inserted.rows[0]),
      temporaryPassword,
    }, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      return NextResponse.json({ error: "该账号已存在或属于管理员。" }, { status: 409 });
    }
    throw error;
  } finally {
    client.release();
  }
}
