"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { PRODUCT } from "@/lib/config";
import { Button, Field } from "./ui";
import styles from "./auth-view.module.css";

export function AuthView({
  register = false,
  mode,
}: {
  register?: boolean;
  mode: "demo" | "supabase" | "unconfigured";
}) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const router = useRouter();
  async function submit() {
    if (busy || mode !== "supabase") return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/auth/${register ? "register" : "login"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Authentication failed");
      if (data.confirmationRequired || (data.message && !data.demo))
        setMessage(data.message || "Check your email to confirm your account.");
      else {
        router.push("/dashboard");
        router.refresh();
      }
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Unable to connect",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className={styles.desktop}>
      <section className={`${styles.window} retro-app`} aria-labelledby="auth-title">
        <header className={styles.titlebar}>
          <h1 id="auth-title">
            {PRODUCT.name}
            {mode === "supabase"
              ? ` · ${register ? "Create account" : "Sign in"}`
              : ""}
          </h1>
        </header>
        <div className={styles.body}>
          {mode === "demo" ? (
            <>
            <p>Local demo. No account needed.</p>
              <Button asChild variant="primary">
                <Link href="/dashboard">Open records</Link>
              </Button>
            </>
          ) : mode === "unconfigured" ? (
            <p role="status">
              Account sign-in is unavailable for this workspace.
            </p>
          ) : message ? (
            <>
              <p className={styles.notice} role="status">
                {message}
              </p>
              <Link className={styles.link} href="/login">
                Return to sign in
              </Link>
            </>
          ) : (
            <>
              <form
                className="form-stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <Field label="Email">
                  <input
                    required
                    type="email"
                    value={email}
                    disabled={busy}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                  />
                </Field>
                <Field
                  label="Password"
                  hint={register ? "At least 8 characters." : undefined}
                >
                  <input
                    required
                    type="password"
                    minLength={8}
                    maxLength={200}
                    value={password}
                    disabled={busy}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete={
                      register ? "new-password" : "current-password"
                    }
                  />
                </Field>
                {error && (
                  <p role="alert" className={styles.notice}>
                    {error}
                  </p>
                )}
                <div className={styles.actions}>
                  <Button type="submit" variant="primary" disabled={busy}>
                    {busy && <Loader2 size={15} className="spin" />}
                    {busy
                      ? "Please wait…"
                      : register
                        ? "Create account"
                        : "Sign in"}
                  </Button>
                </div>
              </form>
              <Link
                className={styles.link}
                href={register ? "/login" : "/register"}
              >
                {register
                  ? "Sign in to an existing account"
                  : "Create an account"}
              </Link>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
