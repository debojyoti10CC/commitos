import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { localSigningKey } from "@/lib/db/local";
import { configuredSupabase, isDemoMode, isHostedRuntime, SupabaseConfigurationError } from "@/lib/db/supabase";
import { assertRequestOrigin } from "@/lib/origin";

export const DEMO_COOKIE = "commitos_demo";
export const demoCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.APP_URL?.startsWith("https://") === true,
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
};
export class AuthenticationError extends Error {
  readonly status = 401;
  constructor(message = "Sign in to continue") {
    super(message);
  }
}
export type AuthUser = { id: string; email: string; demo: boolean };
export async function createDemoSession(): Promise<{
  id: string;
  token: string;
}> {
  if (isHostedRuntime()) throw new SupabaseConfigurationError();
  const id = randomUUID();
  const payload = Buffer.from(
    JSON.stringify({ id, expires: Date.now() + 30 * 86400000 }),
  ).toString("base64url");
  const signature = createHmac("sha256", await localSigningKey())
    .update(payload)
    .digest("base64url");
  return { id, token: `${payload}.${signature}` };
}
export async function validateDemoSession(
  token: string | undefined,
): Promise<string | null> {
  if (isHostedRuntime()) return null;
  if (!token || token.length > 500) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = createHmac("sha256", await localSigningKey())
    .update(payload)
    .digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(expected, supplied)
  )
    return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      id: unknown;
      expires: unknown;
    };
    return typeof data.id === "string" &&
      /^[a-f0-9-]{36}$/.test(data.id) &&
      typeof data.expires === "number" &&
      data.expires > Date.now()
      ? data.id
      : null;
  } catch {
    return null;
  }
}
export function requestCookie(
  request: Request,
  name: string,
): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
export async function serverAuthClient() {
  if (!configuredSupabase())
    throw new SupabaseConfigurationError();
  const store = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (items) => {
          try {
            for (const { name, value, options } of items)
              store.set(name, value, {
                ...options,
                httpOnly: true,
                secure: process.env.APP_URL?.startsWith("https://") === true,
                sameSite: "lax",
              });
          } catch {
            /* Read-only Server Components rely on proxy session refresh. */
          }
        },
      },
    },
  );
}
export async function requireUser(request?: Request): Promise<AuthUser> {
  if (isDemoMode()) {
    const token = request
      ? requestCookie(request, DEMO_COOKIE)
      : (await cookies()).get(DEMO_COOKIE)?.value;
    const id = await validateDemoSession(token);
    if (!id)
      throw new AuthenticationError(
        "Local demo session is missing. Reload the application.",
      );
    return { id, email: "Local demo", demo: true };
  }
  // getUser verifies with the Auth server; cookie content alone is never trusted.
  const supabase = await serverAuthClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new AuthenticationError();
  return { id: data.user.id, email: data.user.email || "", demo: false };
}
export function assertSameOrigin(request: Request): void {
  assertRequestOrigin(request);
}
