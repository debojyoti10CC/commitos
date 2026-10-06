import { connection } from "next/server";
import { AuthView } from "@/components/auth-view";
import { configuredSupabase, isDemoMode } from "@/lib/db/supabase";

export default async function Register() {
  await connection();
  const mode = isDemoMode()
    ? "demo"
    : configuredSupabase()
      ? "supabase"
      : "unconfigured";
  return <AuthView register mode={mode} />;
}
