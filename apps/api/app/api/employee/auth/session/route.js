import { NextResponse } from "next/server";
import {
  currentEmployeeSession,
  employeeSessionCookie,
  logoutEmployee,
} from "../../../../../src/auth/employee-auth.js";

export const runtime = "nodejs";

function expiredCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(0),
  };
}

export async function GET(request) {
  const token = request.cookies.get(employeeSessionCookie)?.value;
  if (!token) {
    return NextResponse.json({ error: "需要重新登录。" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const employee = await currentEmployeeSession(token);
  if (!employee) {
    const response = NextResponse.json({ error: "需要重新登录。" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
    response.cookies.set(employeeSessionCookie, "", expiredCookieOptions());
    return response;
  }

  return NextResponse.json(employee, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function DELETE(request) {
  const token = request.cookies.get(employeeSessionCookie)?.value;
  if (token) await logoutEmployee(token);

  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(employeeSessionCookie, "", expiredCookieOptions());
  return response;
}
