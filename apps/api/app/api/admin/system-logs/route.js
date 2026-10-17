import { NextResponse } from "next/server";
import { adminSessionCookie, currentAdmin } from "../../../../src/auth/admin-auth.js";
import { querySystemOperationLogs } from "../../../../src/system-operation-log-query.js";

export const runtime = "nodejs";

function unauthorized() {
  return NextResponse.json({ error: "需要管理员登录后查询系统操作日志。" }, {
    status: 401,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request) {
  const token = request.cookies.get(adminSessionCookie)?.value;
  if (!token || !await currentAdmin(token)) return unauthorized();

  const result = await querySystemOperationLogs(request);
  if (result.error) {
    return NextResponse.json({ error: result.error }, {
      status: result.status,
      headers: { "Cache-Control": "no-store" },
    });
  }

  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
