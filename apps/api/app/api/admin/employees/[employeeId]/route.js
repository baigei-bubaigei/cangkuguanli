import { NextResponse } from "next/server";
import {
  adminSessionCookie,
  currentAdmin,
} from "../../../../../src/auth/admin-auth.js";
import { database } from "../../../../../src/db.js";

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
  if (!await administrator(request)) return unauthorized();

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

  const result = await database().query(
    `UPDATE employee_accounts
        SET status = $1
      WHERE id = $2
      RETURNING id, status`,
    [body.status, employeeId],
  );
  if (!result.rowCount) {
    return NextResponse.json({ error: "找不到该员工账号。" }, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }

  return NextResponse.json({
    id: String(result.rows[0].id),
    status: result.rows[0].status,
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}
