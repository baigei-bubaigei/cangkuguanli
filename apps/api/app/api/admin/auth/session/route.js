import { NextResponse } from "next/server";
import {
  adminSessionCookie,
  currentAdmin,
  logoutAdmin,
} from "../../../../../src/auth/admin-auth.js";

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
  const token = request.cookies.get(adminSessionCookie)?.value;
  if (!token) {
    return NextResponse.json({ error: "需要重新登录。" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const admin = await currentAdmin(token);
  if (!admin) {
    const response = NextResponse.json({ error: "需要重新登录。" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
    response.cookies.set(adminSessionCookie, "", expiredCookieOptions());
    return response;
  }

  return NextResponse.json(admin, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function DELETE(request) {
  const token = request.cookies.get(adminSessionCookie)?.value;
  if (token) await logoutAdmin(token);

  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(adminSessionCookie, "", expiredCookieOptions());
  return response;
}
