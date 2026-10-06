import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import path from "node:path";
import {
  atomicWrite,
  dataDirectory,
  localUserIds,
  readJson,
  safeId,
  withFileLock,
} from "./local";
import { adminSupabase, isDemoMode } from "./supabase";
import { readState } from "./repository";

type DeviceRecord = {
  id: string;
  user_id: string;
  label: string;
  token_hash: string;
  created_at: string;
  revoked_at: string | null;
};
export type DeviceSummary = Pick<
  DeviceRecord,
  "id" | "label" | "created_at" | "revoked_at"
>;
const summary = ({
  id,
  label,
  created_at,
  revoked_at,
}: DeviceRecord): DeviceSummary => ({ id, label, created_at, revoked_at });
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const file = (userId: string) =>
  path.join(dataDirectory(), `devices-${safeId(userId)}.json`);
/** Public device metadata only; raw tokens are returned once by issueDeviceToken. */
export async function listDeviceTokens(
  userId: string,
): Promise<DeviceSummary[]> {
  safeId(userId);
  if (isDemoMode()) {
    const records = await readJson<DeviceRecord[]>(file(userId), () => []);
    return records
      .map(summary)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  const { data, error } = await adminSupabase()
    .from("device_tokens")
    .select("id,label,created_at,revoked_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error("Unable to list devices");
  return (data ?? []) as DeviceSummary[];
}
export async function issueDeviceToken(
  userId: string,
  label: string,
): Promise<{ token: string; id: string }> {
  safeId(userId);
  await readState(userId);
  const id = randomUUID(),
    token = `co_${id}.${randomBytes(32).toString("base64url")}`;
  const record: DeviceRecord = {
    id,
    user_id: userId,
    label: label.trim().slice(0, 100) || "Desk device",
    token_hash: digest(token),
    created_at: new Date().toISOString(),
    revoked_at: null,
  };
  if (isDemoMode())
    await withFileLock(`devices-${userId}`, async () => {
      const records = await readJson<DeviceRecord[]>(file(userId), () => []);
      if (records.filter((r) => !r.revoked_at).length >= 20)
        throw new Error("Revoke an existing device before adding another");
      records.push(record);
      await atomicWrite(file(userId), records);
    });
  else {
    const { error } = await adminSupabase()
      .from("device_tokens")
      .insert(record);
    if (error) throw new Error("Unable to issue device token");
  }
  return { token, id };
}
export async function verifyDeviceToken(token: string): Promise<string | null> {
  if (!/^co_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const hash = digest(token);
  if (isDemoMode()) {
    for (const userId of await localUserIds()) {
      const records = await readJson<DeviceRecord[]>(file(userId), () => []);
      const match = records.find(
        (record) =>
          !record.revoked_at &&
          record.token_hash.length === hash.length &&
          timingSafeEqual(Buffer.from(record.token_hash), Buffer.from(hash)),
      );
      if (match) return userId;
    }
    return null;
  }
  const { data, error } = await adminSupabase()
    .from("device_tokens")
    .select("user_id")
    .eq("token_hash", hash)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw new Error("Device verification unavailable");
  return data?.user_id || null;
}
export async function revokeDeviceToken(
  userId: string,
  id: string,
): Promise<void> {
  if (isDemoMode())
    await withFileLock(`devices-${safeId(userId)}`, async () => {
      const records = await readJson<DeviceRecord[]>(file(userId), () => []);
      const record = records.find((record) => record.id === id);
      if (record) record.revoked_at = new Date().toISOString();
      await atomicWrite(file(userId), records);
    });
  else {
    const { error } = await adminSupabase()
      .from("device_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("id", id);
    if (error) throw new Error("Unable to revoke device token");
  }
}
