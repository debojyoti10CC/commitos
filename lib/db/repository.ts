import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type { AppState } from "@/lib/types";
import { createSeedState } from "@/lib/seed";
import {
  atomicWrite,
  dataDirectory,
  localUserIds,
  readJson,
  safeId,
  withFileLock,
} from "./local";
import { adminSupabase, isDemoMode } from "./supabase";
import { decryptSecret, encryptSecret } from "./secrets";

const tables: (keyof AppState)[] = [
  "records",
  "commitments",
  "projects",
  "contacts",
  "sessions",
  "reminders",
  "integrations",
  "reviews",
  "activity",
  "calendar_events",
  "candidates",
];
/** Expand legacy snapshots without replacing any existing domain rows. */
function normalizeState(state: AppState): AppState {
  if (state.records === undefined) state.records = [];
  if (!Array.isArray(state.records)) throw new Error("Invalid records state");
  return state;
}
function validateOwner(state: AppState, userId: string): void {
  if (state.user_id !== userId)
    throw new Error("State belongs to another user");
  for (const key of tables)
    for (const row of state[key] as { user_id: string }[])
      if (row.user_id !== userId)
        throw new Error("Cannot persist another user’s record");
}
const stateFile = (userId: string) =>
  path.join(dataDirectory(), `state-${safeId(userId)}.json`);
async function readLocal(userId: string): Promise<AppState> {
  const state = await readJson(stateFile(userId), () =>
    createSeedState(userId),
  );
  normalizeState(state);
  validateOwner(state, userId);
  return state;
}
export async function readState(userId: string): Promise<AppState> {
  safeId(userId);
  if (isDemoMode())
    return withFileLock(`state-${userId}`, async () => {
      const state = await readLocal(userId);
      await atomicWrite(stateFile(userId), state);
      return state;
    });
  const { data, error } = await adminSupabase().rpc("load_commitos_state", {
    p_user_id: userId,
  });
  if (error) throw new Error(`Database read failed: ${error.message}`);
  if (data) {
    const state = normalizeState(data as AppState);
    validateOwner(state, userId);
    return state;
  }
  // Real users begin empty; demo samples must never become production records.
  const fresh = createSeedState(userId);
  for (const key of tables) (fresh[key] as unknown[]).splice(0);
  fresh.version = 0;
  const result = await adminSupabase().rpc("save_commitos_state", {
    p_user_id: userId,
    p_expected_version: 0,
    p_state: fresh,
  });
  if (result.error) {
    if (result.error.message.includes("VERSION_CONFLICT"))
      return readState(userId);
    throw new Error(`Database initialization failed: ${result.error.message}`);
  }
  return { ...fresh, version: Number(result.data) };
}
export async function mutateState(
  userId: string,
  fn: (state: AppState) => void | Promise<void>,
): Promise<AppState> {
  safeId(userId);
  if (isDemoMode())
    return withFileLock(`state-${userId}`, async () => {
      const state = await readLocal(userId);
      await fn(state);
      validateOwner(state, userId);
      state.version++;
      await atomicWrite(stateFile(userId), state);
      return state;
    });
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = await readState(userId),
      version = state.version;
    await fn(state);
    validateOwner(state, userId);
    const { data, error } = await adminSupabase().rpc("save_commitos_state", {
      p_user_id: userId,
      p_expected_version: version,
      p_state: state,
    });
    if (!error) return { ...state, version: Number(data) };
    if (!error.message.includes("VERSION_CONFLICT"))
      throw new Error(`Database write failed: ${error.message}`);
  }
  throw new Error("State changed concurrently. Please retry.");
}
export async function listUserIds(): Promise<string[]> {
  if (isDemoMode()) return localUserIds();
  const { data, error } = await adminSupabase()
    .from("user_settings")
    .select("user_id");
  if (error) throw new Error("Cannot enumerate reminder accounts");
  return (data || []).map((row) => String(row.user_id));
}
const secretFile = (userId: string) =>
  path.join(dataDirectory(), `secrets-${safeId(userId)}.json`);
export async function getIntegrationSecret(
  userId: string,
  provider: string,
): Promise<Record<string, unknown> | null> {
  safeId(userId);
  safeId(provider);
  let encrypted: string | undefined;
  if (isDemoMode()) {
    const secrets = await readJson<Record<string, string>>(
      secretFile(userId),
      () => ({}),
    );
    encrypted = secrets[provider];
  } else {
    const { data, error } = await adminSupabase()
      .from("integration_secrets")
      .select("encrypted_value")
      .eq("user_id", userId)
      .eq("provider", provider)
      .maybeSingle();
    if (error) throw new Error("Unable to read integration credentials");
    encrypted = data?.encrypted_value;
  }
  return encrypted ? decryptSecret(encrypted, `${userId}:${provider}`) : null;
}
export async function setIntegrationSecret(
  userId: string,
  provider: string,
  value: Record<string, unknown>,
): Promise<void> {
  safeId(userId);
  safeId(provider);
  const encrypted = encryptSecret(value, `${userId}:${provider}`);
  if (isDemoMode()) {
    await withFileLock(`secrets-${userId}`, async () => {
      const secrets = await readJson<Record<string, string>>(
        secretFile(userId),
        () => ({}),
      );
      secrets[provider] = encrypted;
      await atomicWrite(secretFile(userId), secrets);
    });
    return;
  }
  const { error } = await adminSupabase()
    .from("integration_secrets")
    .upsert(
      { user_id: userId, provider, encrypted_value: encrypted },
      { onConflict: "user_id,provider" },
    );
  if (error) throw new Error("Unable to save integration credentials");
}
/** Atomically consume a matching nonce; concurrent callbacks cannot replay the same OAuth state. */
export async function consumeIntegrationSecret(
  userId: string,
  provider: string,
  field: string,
  value: string,
): Promise<boolean> {
  safeId(userId);
  safeId(provider);
  if (isDemoMode())
    return withFileLock(`secrets-${userId}`, async () => {
      const secrets = await readJson<Record<string, string>>(
        secretFile(userId),
        () => ({}),
      );
      const encrypted = secrets[provider];
      if (
        !encrypted ||
        decryptSecret(encrypted, `${userId}:${provider}`)[field] !== value
      )
        return false;
      delete secrets[provider];
      await atomicWrite(secretFile(userId), secrets);
      return true;
    });
  const client = adminSupabase();
  const { data, error } = await client
    .from("integration_secrets")
    .select("encrypted_value")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw new Error("Unable to verify OAuth state");
  if (
    !data ||
    decryptSecret(data.encrypted_value, `${userId}:${provider}`)[field] !==
      value
  )
    return false;
  const removed = await client
    .from("integration_secrets")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider)
    .eq("encrypted_value", data.encrypted_value)
    .select("user_id");
  if (removed.error) throw new Error("Unable to consume OAuth state");
  return Boolean(removed.data?.length);
}
type Pairing = { user_id: string; hash: string; expires_at: number };
type TelegramLinks = { pairings: Pairing[]; links: Record<string, string> };
const telegramFile = () => path.join(dataDirectory(), "telegram-links.json");
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function createTelegramPairing(userId: string): Promise<string> {
  safeId(userId);
  const token = randomBytes(24).toString("base64url");
  const expires = new Date(Date.now() + 10 * 60000);
  if (isDemoMode())
    await withFileLock("telegram-links", async () => {
      const store = await readJson<TelegramLinks>(telegramFile(), () => ({
        pairings: [],
        links: {},
      }));
      store.pairings = store.pairings.filter(
        (p) => p.expires_at > Date.now() && p.user_id !== userId,
      );
      store.pairings.push({
        user_id: userId,
        hash: tokenHash(token),
        expires_at: expires.getTime(),
      });
      await atomicWrite(telegramFile(), store);
    });
  else {
    const { error } = await adminSupabase()
      .from("telegram_pairings")
      .upsert(
        {
          user_id: userId,
          token_hash: tokenHash(token),
          expires_at: expires.toISOString(),
        },
        { onConflict: "user_id" },
      );
    if (error) throw new Error("Unable to create Telegram pairing");
  }
  return token;
}
export async function redeemTelegramPairing(
  token: string,
  chatId: string,
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token) || !/^\d{1,20}$/.test(chatId))
    return null; // Private chats only.
  let userId: string | null = null;
  if (isDemoMode())
    userId = await withFileLock("telegram-links", async () => {
      const store = await readJson<TelegramLinks>(telegramFile(), () => ({
        pairings: [],
        links: {},
      }));
      const pairing = store.pairings.find(
        (p) => p.hash === tokenHash(token) && p.expires_at > Date.now(),
      );
      if (!pairing) return null;
      if (store.links[chatId] && store.links[chatId] !== pairing.user_id)
        return null;
      store.pairings = store.pairings.filter((p) => p !== pairing);
      for (const [chat, user] of Object.entries(store.links))
        if (user === pairing.user_id) delete store.links[chat];
      store.links[chatId] = pairing.user_id;
      await atomicWrite(telegramFile(), store);
      return pairing.user_id;
    });
  else {
    const { data, error } = await adminSupabase().rpc(
      "redeem_telegram_pairing",
      { p_token_hash: tokenHash(token), p_chat_id: chatId },
    );
    if (error) throw new Error("Unable to redeem Telegram pairing");
    userId = data as string | null;
  }
  if (userId)
    await mutateState(userId, (state) => {
      const account = state.integrations.find((i) => i.provider === "telegram");
      if (account) {
        account.connected = true;
        account.metadata = { paired_at: new Date().toISOString() };
      } else
        state.integrations.push({
          id: randomUUID(),
          user_id: userId!,
          provider: "telegram",
          connected: true,
          metadata: { paired_at: new Date().toISOString() },
        });
      state.settings.telegram_enabled = true;
    });
  return userId;
}
export async function findUserByTelegramChat(
  chatId: string,
): Promise<string | null> {
  if (isDemoMode())
    return (
      (
        await readJson<TelegramLinks>(telegramFile(), () => ({
          pairings: [],
          links: {},
        }))
      ).links[chatId] || null
    );
  const { data, error } = await adminSupabase()
    .from("telegram_connections")
    .select("user_id")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (error) throw new Error("Unable to resolve Telegram account");
  return data?.user_id || null;
}
export async function findTelegramChatByUser(
  userId: string,
): Promise<string | null> {
  if (isDemoMode()) {
    const store = await readJson<TelegramLinks>(telegramFile(), () => ({
      pairings: [],
      links: {},
    }));
    return (
      Object.entries(store.links).find(([, id]) => id === userId)?.[0] || null
    );
  }
  const { data, error } = await adminSupabase()
    .from("telegram_connections")
    .select("chat_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error("Unable to resolve Telegram chat");
  return data?.chat_id || null;
}
