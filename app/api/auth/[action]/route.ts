import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import {
  assertSameOrigin,
  createDemoSession,
  DEMO_COOKIE,
  demoCookieOptions,
  serverAuthClient,
} from "@/lib/auth";
import { isDemoMode } from "@/lib/db/supabase";

const credentials = z.object({
  email: z.email(),
  password: z.string().min(8).max(200),
  name: z.string().max(100).optional(),
});
export async function POST(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
) {
  try {
    assertSameOrigin(request);
    const { action } = await params;
    if (!["login", "register", "logout", "demo"].includes(action))
      return NextResponse.json(
        { error: "Unknown authentication action" },
        { status: 404 },
      );
    const store = await cookies();
    if (action === "logout") {
      if (!isDemoMode()) {
        const client = await serverAuthClient();
        await client.auth.signOut();
      }
      store.set(DEMO_COOKIE, "", { ...demoCookieOptions, maxAge: 0 });
      return NextResponse.json({ ok: true });
    }
    if (isDemoMode()) {
      const session = await createDemoSession();
      store.set(DEMO_COOKIE, session.token, demoCookieOptions);
      return NextResponse.json({
        ok: true,
        demo: true,
        message:
          "Opened a new isolated local demo. No account credentials were stored.",
      });
    }
    if (action === "demo")
      return NextResponse.json(
        { error: "Demo mode is disabled" },
        { status: 403 },
      );
    const body = credentials.parse(await request.json());
    const supabase = await serverAuthClient();
    const result =
      action === "register"
        ? await supabase.auth.signUp({
            email: body.email,
            password: body.password,
            options: {
              emailRedirectTo: new URL(
                "/api/auth/callback",
                process.env.APP_URL || request.url,
              ).toString(),
              data: { name: body.name || "" },
            },
          })
        : await supabase.auth.signInWithPassword({
            email: body.email,
            password: body.password,
          });
    if (result.error)
      return NextResponse.json(
        { error: result.error.message },
        { status: 400 },
      );
    return NextResponse.json({
      ok: true,
      confirmationRequired: action === "register" && !result.data.session,
      message:
        action === "register" && !result.data.session
          ? "Check your email to confirm your account."
          : undefined,
    });
  } catch (error) {
    const e = error as Error & { status?: number };
    return NextResponse.json(
      {
        error:
          error instanceof z.ZodError
            ? "Enter a valid email and a password of at least 8 characters."
            : e.message,
      },
      { status: e.status || 400 },
    );
  }
}
export async function GET(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
) {
  const { action } = await params;
  if (action !== "callback")
    return NextResponse.json(
      { error: "Unknown authentication action" },
      { status: 404 },
    );
  const code = new URL(request.url).searchParams.get("code");
  if (!code)
    return NextResponse.json(
      { error: "Missing verification code. Request a new confirmation email." },
      { status: 400 },
    );
  try {
    const client = await serverAuthClient();
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (error)
      return NextResponse.json(
        {
          error:
            "Confirmation link is invalid or expired. Request a new email.",
        },
        { status: 400 },
      );
    return NextResponse.redirect(
      new URL("/today", process.env.APP_URL || request.url),
    );
  } catch {
    return NextResponse.json(
      { error: "Authentication is unavailable. Check server configuration." },
      { status: 503 },
    );
  }
}
