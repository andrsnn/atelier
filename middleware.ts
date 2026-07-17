import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, accessToken } from "@/app/lib/access";

/**
 * Optional whole-app password gate.
 *
 * ACCESS_PASSWORD UNSET (the default) → this is a pure pass-through; nothing
 * changes for local use. SET → every page and API requires a cookie proving the
 * visitor knows the password, so you can safely expose ONE shared Atelier instance
 * to your team (over the LAN, or a tunnel like `cloudflared`/`ngrok`) and everyone
 * reviews and comments on the SAME board.
 *
 * Exempt from the gate: the unlock page + its API, and `/api/internal/*` — the
 * agent's own tool bridge, which runs as a localhost subprocess and is guarded by
 * its own FACTORY_INTERNAL_SECRET (set that too when you expose the app).
 */
export async function middleware(req: NextRequest) {
  const pw = process.env.ACCESS_PASSWORD;
  if (!pw) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (pathname === "/access" || pathname === "/api/access" || pathname.startsWith("/api/internal")) {
    return NextResponse.next();
  }

  if (req.cookies.get(ACCESS_COOKIE)?.value === (await accessToken(pw))) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "locked" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/access";
  url.search = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpe?g|gif|svg|ico|mp4|webm|woff2?)).*)"],
};
