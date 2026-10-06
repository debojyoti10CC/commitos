import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  assertSameOrigin,
  createDemoSession,
  DEMO_COOKIE,
  demoCookieOptions,
  validateDemoSession,
} from "@/lib/auth";
import { configuredSupabase, isDemoMode } from "@/lib/db/supabase";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    !path.startsWith("/api/telegram/webhook") &&
    !path.startsWith("/api/cron/") &&
    !path.startsWith("/api/device/")
  ) {
    try {
      assertSameOrigin(request);
    } catch {
      return NextResponse.json(
        { error: "Cross-origin requests are not allowed" },
        { status: 403 },
      );
    }
  }
  if (isDemoMode()) {
    let token = request.cookies.get(DEMO_COOKIE)?.value;
    const id = await validateDemoSession(token);
    if (id) return NextResponse.next();
    const session = await createDemoSession();
    token = session.token;
    request.cookies.set(DEMO_COOKIE, token);
    const response = NextResponse.next({
      request: { headers: request.headers },
    });
    response.cookies.set(DEMO_COOKIE, token, demoCookieOptions);
    return response;
  }
  const publiclyAccessible =
    path === "/login" ||
    path === "/register" ||
    path.startsWith("/api/auth/") ||
    path.startsWith("/api/cron/") ||
    path.startsWith("/api/telegram/webhook") ||
    path.startsWith("/api/device/");
  if (!configuredSupabase()) {
    if (publiclyAccessible) return NextResponse.next();
    return NextResponse.json(
      {
        error:
          "Production authentication is not configured. Configure Supabase or enable DEMO_MODE.",
      },
      { status: 503 },
    );
  }
  let response = NextResponse.next({ request });
  const client = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (items) => {
          for (const item of items) request.cookies.set(item.name, item.value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of items)
            response.cookies.set(name, value, {
              ...options,
              httpOnly: true,
              sameSite: "lax",
              secure: process.env.APP_URL?.startsWith("https://") === true,
            });
        },
      },
    },
  );
  const { data, error } = await client.auth.getUser();
  if (!publiclyAccessible && (error || !data.user)) {
    if (path.startsWith("/api/"))
      return NextResponse.json(
        { error: "Sign in to continue" },
        { status: 401 },
      );
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/login";
    redirect.search = "";
    return NextResponse.redirect(redirect);
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icons/|icon.svg|icon-192.png|icon-512.png).*)",
  ],
};
