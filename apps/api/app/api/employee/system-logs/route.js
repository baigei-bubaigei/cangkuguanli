import { NextResponse } from "next/server";
import { currentEmployee, employeeSessionCookie } from "../../../../src/auth/employee-auth.js";
import { querySystemOperationLogs } from "../../../../src/system-operation-log-query.js";

export const runtime = "nodejs";

function unauthorized() {
  return NextResponse.json({ error: "需要员工登录后查询员工系统操作日志。" }, {
    status: 401,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request) {
  const token = request.cookies.get(employeeSessionCookie)?.value;
  if (!token || !await currentEmployee(token)) return unauthorized();

  const result = await querySystemOperationLogs(request, { employeeOnly: true });
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
