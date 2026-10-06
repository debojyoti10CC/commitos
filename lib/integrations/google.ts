import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { fromZonedTime } from "date-fns-tz";
import { z } from "zod";
import type { CalendarEvent, PlanBlock } from "@/lib/types";
import {
  consumeIntegrationSecret,
  getIntegrationSecret,
  mutateState,
  readState,
  setIntegrationSecret,
} from "@/lib/db/repository";
import { localSigningKey } from "@/lib/db/local";

const tokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});
function googleConfig() {
  const {
    GOOGLE_CLIENT_ID: id,
    GOOGLE_CLIENT_SECRET: secret,
    GOOGLE_REDIRECT_URI: redirect,
  } = process.env;
  if (!id || !secret || !redirect)
    throw new Error(
      "Google is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI.",
    );
  return { id, secret, redirect };
}
function safeReturnTo(value?: string): string {
  return value &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\")
    ? value
    : "/settings";
}
export async function googleConnectUrl(
  userId: string,
  returnTo?: string,
): Promise<string> {
  const config = googleConfig(),
    nonce = randomBytes(24).toString("base64url");
  const value = Buffer.from(
    JSON.stringify({
      userId,
      nonce,
      expires: Date.now() + 10 * 60000,
      returnTo: safeReturnTo(returnTo),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", await localSigningKey())
    .update(value)
    .digest("base64url");
  await setIntegrationSecret(userId, "google_oauth", {
    nonce,
    expires: Date.now() + 10 * 60000,
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.id,
    redirect_uri: config.redirect,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: `${value}.${signature}`,
    scope:
      "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.readonly",
  }).toString();
  return url.toString();
}
export async function consumeGoogleOAuthState(
  state: string,
  userId: string,
): Promise<string> {
  if (state.length > 2000) throw new Error("Invalid OAuth state");
  const [value, signature] = state.split(".");
  if (!value || !signature) throw new Error("Invalid OAuth state");
  const expected = createHmac("sha256", await localSigningKey())
      .update(value)
      .digest(),
    received = Buffer.from(signature, "base64url");
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  )
    throw new Error("OAuth state verification failed");
  const parsed = z
    .object({
      userId: z.string(),
      nonce: z.string(),
      expires: z.number(),
      returnTo: z.string(),
    })
    .parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  if (
    parsed.userId !== userId ||
    parsed.expires < Date.now() ||
    !(await consumeIntegrationSecret(
      userId,
      "google_oauth",
      "nonce",
      parsed.nonce,
    ))
  )
    throw new Error("OAuth request expired or belongs to another session");
  return safeReturnTo(parsed.returnTo);
}
async function tokenRequest(body: Record<string, string>) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      `Google authorization failed (${response.status}). Reconnect your Google account.`,
    );
  return tokenSchema.parse(await response.json());
}
export async function exchangeGoogleCode(
  code: string,
  userId: string,
): Promise<void> {
  const config = googleConfig();
  const tokens = await tokenRequest({
    code,
    client_id: config.id,
    client_secret: config.secret,
    redirect_uri: config.redirect,
    grant_type: "authorization_code",
  });
  const previous = await getIntegrationSecret(userId, "google");
  await setIntegrationSecret(userId, "google", {
    ...tokens,
    refresh_token: tokens.refresh_token || previous?.refresh_token,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
  });
  await mutateState(userId, (state) => {
    const integration = state.integrations.find((i) => i.provider === "google");
    if (integration) {
      integration.connected = true;
      integration.metadata = { connected_at: new Date().toISOString() };
    } else
      state.integrations.push({
        id: randomUUID(),
        user_id: userId,
        provider: "google",
        connected: true,
        metadata: { connected_at: new Date().toISOString() },
      });
  });
}
export async function googleAccessToken(userId: string): Promise<string> {
  const saved = await getIntegrationSecret(userId, "google");
  if (!saved || typeof saved.access_token !== "string")
    throw new Error("Connect Google from Settings first.");
  if (Number(saved.expires_at) > Date.now() + 60000) return saved.access_token;
  if (typeof saved.refresh_token !== "string")
    throw new Error("Google authorization expired. Reconnect your account.");
  const config = googleConfig();
  const tokens = await tokenRequest({
    client_id: config.id,
    client_secret: config.secret,
    refresh_token: saved.refresh_token,
    grant_type: "refresh_token",
  });
  await setIntegrationSecret(userId, "google", {
    ...saved,
    ...tokens,
    refresh_token: tokens.refresh_token || saved.refresh_token,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
  });
  return tokens.access_token;
}
export async function googleRequest(
  userId: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  // Call sites use fixed Google origins; integration inputs may never redirect credentials elsewhere.
  const host = new URL(url).hostname;
  if (!["www.googleapis.com", "gmail.googleapis.com"].includes(host))
    throw new Error("Invalid Google API endpoint");
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
      Authorization: `Bearer ${await googleAccessToken(userId)}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new Error(
      `Google request failed (${response.status}). Check consent scopes or reconnect.`,
    );
  return response;
}
type GoogleEvent = {
  id: string;
  summary?: string;
  status?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
};
const ownerMarker = (userId: string) =>
  createHash("sha256").update(userId).digest("hex").slice(0, 32);
const localEventId = (eventId: string, userId: string) => {
  const hash = createHash("sha256")
    .update(`${userId}:${eventId}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
const calendarUrl = (calendarId: string) =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
export async function syncGoogleCalendar(
  userId: string,
): Promise<CalendarEvent[]> {
  const state = await readState(userId),
    base = calendarUrl(state.settings.calendar_id || "primary"),
    events: CalendarEvent[] = [];
  const from = new Date(Date.now() - 86400000).toISOString(),
    to = new Date(Date.now() + 45 * 86400000).toISOString();
  let page: string | undefined;
  do {
    const query = new URLSearchParams({
      timeMin: from,
      timeMax: to,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "2500",
      ...(page ? { pageToken: page } : {}),
    });
    const data = (await (
      await googleRequest(userId, `${base}?${query}`)
    ).json()) as { items?: GoogleEvent[]; nextPageToken?: string };
    for (const event of data.items || []) {
      if (event.status === "cancelled" || event.transparency === "transparent")
        continue;
      // Local focus blocks already occupy capacity. Exclude our own mirror to avoid double booking.
      if (
        event.extendedProperties?.private?.commitosOwner === ownerMarker(userId)
      )
        continue;
      const start =
        event.start?.dateTime ||
        (event.start?.date
          ? fromZonedTime(
              `${event.start.date}T00:00:00`,
              state.settings.timezone,
            ).toISOString()
          : null);
      const end =
        event.end?.dateTime ||
        (event.end?.date
          ? fromZonedTime(
              `${event.end.date}T00:00:00`,
              state.settings.timezone,
            ).toISOString()
          : null);
      if (start && end && new Date(end) > new Date(start))
        events.push({
          id: localEventId(event.id, userId),
          user_id: userId,
          title: event.summary || "Busy",
          start,
          end,
          source: "google",
          commitment_id: null,
          external_id: event.id,
        });
    }
    page = data.nextPageToken;
  } while (page);
  return events;
}
export async function writeGooglePlan(
  userId: string,
  blocks: PlanBlock[],
): Promise<void> {
  const state = await readState(userId);
  if (!state.settings.calendar_write_enabled)
    throw new Error(
      "Enable “Write focus blocks” in Settings before writing to Google Calendar.",
    );
  const base = calendarUrl(state.settings.calendar_id || "primary"),
    owner = ownerMarker(userId),
    desired = new Set<string>();
  const eventIds = new Map<string, string>();
  const query = new URLSearchParams({
    privateExtendedProperty: `commitosOwner=${owner}`,
    maxResults: "2500",
  });
  const owned: GoogleEvent[] = [];
  let page: string | undefined;
  do {
    const data = (await (
      await googleRequest(
        userId,
        `${base}?${query}${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`,
      )
    ).json()) as { items?: GoogleEvent[]; nextPageToken?: string };
    owned.push(...(data.items || []));
    page = data.nextPageToken;
  } while (page);
  for (const block of blocks) {
    if (!state.commitments.some((c) => c.id === block.commitment_id))
      throw new Error("Plan contains an unknown commitment");
    if (
      !Number.isFinite(Date.parse(block.start)) ||
      Date.parse(block.end) <= Date.parse(block.start)
    )
      throw new Error("Invalid focus block interval");
    // Stable IDs make retries idempotent, including interrupted writes.
    const id = `co${createHash("sha256").update(`${owner}:${block.commitment_id}:${block.start}`).digest("hex")}`;
    desired.add(id);
    eventIds.set(`${block.commitment_id}:${block.start}`, id);
    const body = {
      summary: `Focus: ${block.title}`,
      description: "Focus block created by CommitOS",
      start: { dateTime: block.start, timeZone: state.settings.timezone },
      end: { dateTime: block.end, timeZone: state.settings.timezone },
      extendedProperties: {
        private: { commitosOwner: owner, commitmentId: block.commitment_id },
      },
      reminders: { useDefault: false },
    };
    const existing = owned.find((event) => event.id === id);
    if (existing)
      await googleRequest(userId, `${base}/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    else {
      const token = await googleAccessToken(userId);
      const result = await fetch(base, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id, ...body }),
        signal: AbortSignal.timeout(20000),
      });
      if (result.status === 409) {
        const event = (await (
          await googleRequest(userId, `${base}/${id}`)
        ).json()) as GoogleEvent;
        if (event.extendedProperties?.private?.commitosOwner !== owner)
          throw new Error("Existing calendar event is not owned by CommitOS");
        await googleRequest(userId, `${base}/${id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      } else if (!result.ok)
        throw new Error(`Calendar write failed (${result.status})`);
    }
  }
  // The caller supplies the complete future plan. Preserve history and never touch external events.
  for (const event of owned) {
    const end = event.end?.dateTime || event.end?.date || "";
    if (
      event.extendedProperties?.private?.commitosOwner === owner &&
      Date.parse(end) > Date.now() &&
      !desired.has(event.id)
    )
      await googleRequest(userId, `${base}/${encodeURIComponent(event.id)}`, {
        method: "DELETE",
      });
  }
  await mutateState(userId, (current) => {
    for (const event of current.calendar_events) {
      if (event.source !== "focus" || !event.commitment_id) continue;
      const id = eventIds.get(`${event.commitment_id}:${event.start}`);
      if (id) event.external_id = id;
      else if (Date.parse(event.end) > Date.now()) event.external_id = null;
    }
  });
}
