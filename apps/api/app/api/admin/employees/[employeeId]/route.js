import { NextResponse } from "next/server";
import {
  adminSessionCookie,
  currentAdmin,
} from "../../../../../src/auth/admin-auth.js";
import { database } from "../../../../../src/db.js";
import { writeOperationLog } from "../../../../../src/operation-logs.js";

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

function invalidRequest() {
  return NextResponse.json({ error: "请选择启用或停用员工账号。" }, {
    status: 400,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function PATCH(request, { params }) {
  const actor = await administrator(request);
  if (!actor) return unauthorized();

  const { employeeId } = await params;
  if (!/^\d+$/.test(employeeId)) return invalidRequest();

  let body;
  try {
    body = await request.json();
  } catch {
    return invalidRequest();
  }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || !["active", "disabled"].includes(body.status)) {
    return invalidRequest();
  }

  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT id, account, display_name, status
         FROM employee_accounts
        WHERE id = $1
        FOR UPDATE`,
      [employeeId],
    );
    if (!existing.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "找不到该员工账号。" }, {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      });
    }

    const employee = existing.rows[0];
    if (employee.status !== body.status) {
      await client.query(
        `UPDATE employee_accounts
            SET status = $1
          WHERE id = $2`,
        [body.status, employeeId],
      );
      await writeOperationLog(client, {
        actor: { ...actor, sourceSystem: "admin" },
        operationType: "employee_account_status_changed",
        targetType: "employee_account",
        targetId: employee.id,
        content: {
          account: employee.account,
          displayName: employee.display_name,
          beforeStatus: employee.status,
          afterStatus: body.status,
        },
      });
    }

    await client.query("COMMIT");
    return NextResponse.json({
      id: String(employee.id),
      status: body.status,
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
