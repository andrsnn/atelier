import { NextRequest, NextResponse } from "next/server";
import { ACCESS_COOKIE, accessToken } from "@/app/lib/access";

export const dynamic = "force-dynamic";

// Submit the access password (see middleware.ts). On a match, set an httpOnly
// cookie that proves it for ~30 days. When ACCESS_PASSWORD is unset the gate is
// off and this is a no-op.
export async function POST(req: NextRequest) {
  const pw = process.env.ACCESS_PASSWORD;
  if (!pw) return NextResponse.json({ ok: true });
  const { password } = await req.json().catch(() => ({ password: "" }));
  if (typeof password !== "string" || password !== pw) {
    return NextResponse.json({ error: "wrong password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACCESS_COOKIE, await accessToken(pw), {
    httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}

// Log out — clear the access cookie.
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACCESS_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
