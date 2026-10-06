import { createClient } from "@supabase/supabase-js";
export function configuredSupabase(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
export function adminSupabase() {
  if (!configuredSupabase() || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    throw new Error(
      "Supabase is not configured. Set the URL, anon key and service role key, or enable DEMO_MODE.",
    );
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
export function isDemoMode(): boolean {
  return process.env.DEMO_MODE !== "false";
}
