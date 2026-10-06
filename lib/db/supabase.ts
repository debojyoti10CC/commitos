import { createClient } from "@supabase/supabase-js";

export const SUPABASE_CONFIGURATION_MESSAGE =
  "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY for this deployment. Hosted functions require durable database storage.";
export class SupabaseConfigurationError extends Error {
  readonly status = 503;
  constructor(message = SUPABASE_CONFIGURATION_MESSAGE) {
    super(message);
    this.name = "SupabaseConfigurationError";
  }
}
/** System variables may be disabled in Vercel; Lambda's runtime path is a fallback. */
export function isHostedRuntime(): boolean {
  return process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV) ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) || /^\/var\/task(?:\/|$)/.test(process.cwd());
}
export function configuredSupabase(): boolean {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "");
    return ["https:", "http:"].includes(url.protocol) && Boolean(url.hostname) &&
      !url.username && !url.password && Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()) &&
      (!isHostedRuntime() || Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()));
  } catch { return false; }
}
export function adminSupabase() {
  if (!configuredSupabase() || !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim())
    throw new SupabaseConfigurationError();
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
export function isDemoMode(): boolean {
  // File-backed sessions and records are local only, even if DEMO_MODE=true was deployed.
  return !isHostedRuntime() && process.env.DEMO_MODE !== "false";
}
