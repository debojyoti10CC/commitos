"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Copy, Monitor, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { DeviceSummary } from "@/lib/db/device";
import { useApp } from "./app-provider";
import { Button, Field, Modal } from "./ui";
import styles from "./device-settings.module.css";

export function DeviceSettings() {
  const { mutate } = useApp();
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [label, setLabel] = useState("Desk Hub");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ id: string; token: string } | null>(
    null,
  );
  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/devices", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Could not load devices.");
      setDevices(data.devices);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load devices.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function create() {
    if (busy || !label.trim()) return;
    setBusy(true);
    const result = await mutate<{ id: string; token: string }>("/api/devices", {
      label: label.trim(),
    });
    if (result) {
      setIssued(result);
      await load();
    }
    setBusy(false);
  }
  async function revoke(id: string) {
    if (busy) return;
    setBusy(true);
    const result = await mutate(`/api/devices/${id}`, undefined, "DELETE");
    if (result) {
      toast.success("Device access revoked");
      await load();
    }
    setBusy(false);
  }
  async function copy() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.token);
      toast.success("Token copied");
    } catch {
      toast.error(
        "Copy is unavailable. Select the token and copy it manually.",
      );
    }
  }
  return (
    <section className="settings-section" id="devices">
      <div className="settings-title">
        <h2>Desk Hub & devices</h2>
        <p>
          A focused screen beside your work. Device tokens grant access to your
          commitments.
        </p>
      </div>
      <div className={styles.intro}>
        <Monitor size={22} />
        <p>
          Use Desk mode on a second monitor or a Raspberry Pi browser. An ESP32
          client can use the authenticated snapshot and action API.
        </p>
        <Button asChild>
          <Link href="/desk">Open Desk mode</Link>
        </Button>
      </div>
      <form
        className={styles.create}
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Field label="Device name">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={100}
            required
            autoComplete="off"
          />
        </Field>
        <Button type="submit" disabled={busy || !label.trim()}>
          <ShieldCheck size={16} />
          Create device token
        </Button>
      </form>
      {loading && <p>Loading devices…</p>}
      {error && (
        <div role="alert" className={styles.error}>
          {error}{" "}
          <Button onClick={() => void load()} variant="ghost">
            <RefreshCw size={15} />
            Retry
          </Button>
        </div>
      )}
      {!loading && !error && !devices.length && (
        <p className={styles.empty}>
          No device tokens yet. Browser Desk mode uses your signed-in session.
        </p>
      )}
      <ul className={styles.list}>
        {devices.map((device) => (
          <li key={device.id}>
            <div>
              <strong>{device.label}</strong>
              <small>
                {device.revoked_at ? "Revoked" : "Active"} · created{" "}
                {new Date(device.created_at).toLocaleDateString()}
              </small>
            </div>
            <Button
              variant="ghost"
              disabled={busy || !!device.revoked_at}
              onClick={() => void revoke(device.id)}
            >
              {device.revoked_at ? "Revoked" : "Revoke"}
            </Button>
          </li>
        ))}
      </ul>
      <Modal
        open={!!issued}
        onOpenChange={(open) => {
          if (!open) setIssued(null);
        }}
        title="Save your device token"
        description="This token is shown once. Keep it private; anyone with it can read, capture and act on your commitments. Revoke it here if it is lost."
      >
        <code className={styles.token}>{issued?.token}</code>
        <p>
          Send it as an Authorization: Bearer header from your device. Never put
          it in a URL or a public firmware repository.
        </p>
        <div className={styles.actions}>
          <Button onClick={() => void copy()}>
            <Copy size={16} />
            Copy token
          </Button>
          <Button onClick={() => setIssued(null)}>I saved it</Button>
        </div>
      </Modal>
    </section>
  );
}
