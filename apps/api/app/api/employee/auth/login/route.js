import { NextResponse } from "next/server";
import { employeeSessionCookie, loginEmployee } from "../../../../../src/auth/employee-auth.js";

export const runtime = "nodejs";

function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

export async function POST(request) {
  let credentials;
  try {
    credentials = await request.json();
  } catch {
    return NextResponse.json({ error: "请输入账号和密码。" }, { status: 400 });
  }

  if (
    !credentials ||
    typeof credentials !== "object" ||
    typeof credentials.account !== "string" ||
    typeof credentials.password !== "string" ||
    !credentials.account ||
    !credentials.password
  ) {
    return NextResponse.json({ error: "请输入账号和密码。" }, { status: 400 });
  }

  const result = await loginEmployee(credentials.account, credentials.password);
  if (!result) {
    return NextResponse.json(
      { error: "账号或密码不正确，或员工账号已停用。" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const response = NextResponse.json(result.employee, {
    headers: { "Cache-Control": "no-store" },
  });
  response.cookies.set(employeeSessionCookie, result.token, sessionCookieOptions());
  return response;
}
