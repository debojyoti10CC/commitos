"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useApp } from "./app-provider";
import { Button, Field } from "./ui";

export function SettingsView() {
  const { state, mutate, mode } = useApp();
  const storedTimezone = state?.settings.timezone ?? "";
  const [timezone, setTimezone] = useState(storedTimezone);
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const router = useRouter();

  useEffect(() => setTimezone(storedTimezone), [storedTimezone]);

  async function save() {
    if (!state || saving) return;
    setSaving(true);
    try {
      const result = await mutate("/api/settings", {
        timezone,
      });
      if (result) toast.success("Settings saved");
    } finally {
      setSaving(false);
    }
  }

  if (!state) return null;

  return (
    <section
      className="retro-panel settings-panel"
      aria-labelledby="settings-title"
    >
      <header className="retro-titlebar">
        <h1 id="settings-title">Settings</h1>
      </header>
      <div className="retro-panel-body">
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field label="Timezone" hint="Dates use this timezone.">
            <input
              value={timezone}
              disabled={saving}
              list="settings-timezones"
              onChange={(event) => setTimezone(event.target.value)}
            />
            <datalist id="settings-timezones">
              {[
                "Asia/Kolkata",
                "America/New_York",
                "America/Los_Angeles",
                "Europe/London",
                "Europe/Berlin",
                "Asia/Singapore",
                "UTC",
              ].map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </Field>
          <div>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
        {mode === "supabase" && (
          <div className="settings-account">
            <Button
              type="button"
              disabled={signingOut}
              onClick={async () => {
                setSigningOut(true);
                const result = await mutate("/api/auth/logout");
                if (result) router.replace("/login");
                else setSigningOut(false);
              }}
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
