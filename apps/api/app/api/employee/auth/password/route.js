import { NextResponse } from "next/server";
import {
  changeEmployeePassword,
  employeeSessionCookie,
  currentEmployeeSession,
} from "../../../../../src/auth/employee-auth.js";

export const runtime = "nodejs";

export async function POST(request) {
  const token = request.cookies.get(employeeSessionCookie)?.value;
  if (!token) {
    return NextResponse.json({ error: "需要先登录员工系统。" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请输入新密码。" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.password !== "string" || !body.password) {
    return NextResponse.json({ error: "请输入新密码。" }, { status: 400 });
  }

  const employee = await currentEmployeeSession(token);
  if (!employee) {
    return NextResponse.json({ error: "员工会话已失效，请重新登录。" }, { status: 401 });
  }
  if (!employee.mustChangePassword) {
    return NextResponse.json({ error: "当前账号不需要修改初始密码。" }, { status: 409 });
  }

  const result = await changeEmployeePassword(token, body.password);
  if (result === "same-password") {
    return NextResponse.json({ error: "新密码不能与一次性临时密码相同。" }, { status: 400 });
  }
  if (result !== "changed") {
    return NextResponse.json({ error: "员工会话已失效，请重新登录。" }, { status: 401 });
  }

  return new NextResponse(null, { status: 204 });
}
