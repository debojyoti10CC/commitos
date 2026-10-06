import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import {
  readState,
  mutateState,
  createTelegramPairing,
} from "@/lib/db/repository";
import { parseCommitment } from "@/lib/ai/provider";
import { briefing } from "@/lib/notifications/rules";
import {
  createCommitment,
  commitmentAction,
  updateCommitment,
  deleteCommitment,
  getState,
  planDay,
  saveSettings,
  createLocalEvent,
  deleteLocalEvent,
  eveningReview,
  logActivity,
  ServiceError,
  addCommitment,
  parsedInput,
  recalculate,
} from "@/lib/services";
import { errorResponse, assertSafeMutation, jsonBody } from "@/lib/http";
import { runReminders } from "@/lib/notifications/runner";
import {
  googleConnectUrl,
  exchangeGoogleCode,
  consumeGoogleOAuthState,
  syncGoogleCalendar,
  writeGooglePlan,
} from "@/lib/integrations/google";
import { scanGmail } from "@/lib/integrations/gmail";
import {
  issueDeviceToken,
  verifyDeviceToken,
  revokeDeviceToken,
  listDeviceTokens,
} from "@/lib/db/device";
import { buildDeskSnapshot } from "@/lib/device/snapshot";
import { runBackgroundJobs } from "@/lib/notifications/background";
import { DEFAULT_GEMINI_MODEL } from "@/lib/config";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const configured = {
  gemini: Boolean(process.env.GEMINI_API_KEY),
  geminiModel: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
  telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
  google: Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
  ),
};
async function limitedParse(userId: string, text: string) {
  await mutateState(userId, (s) => {
    const now = Date.now();
    const recent = s.activity.filter(
      (e) =>
        e.type === "parse_requested" && Date.parse(e.created_at) > now - 900000,
    );
    if (recent.length >= 20)
      throw new ServiceError(
        "Capture limit reached. Try again in 15 minutes.",
        429,
      );
    logActivity(s, "parse_requested", "Capture requested");
  });
  const state = await readState(userId);
  return parseCommitment(text, {
    timezone: state.settings.timezone,
    projects: state.projects.map((p) => p.name),
    defaultMinutes: state.settings.default_task_minutes,
  });
}
async function handle(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    const route = path.join("/");
    const method = request.method;
    const url = new URL(request.url);
    if (route === "cron/reminders") {
      if (
        method !== "POST" ||
        !process.env.CRON_SECRET ||
        request.headers.get("authorization") !==
          `Bearer ${process.env.CRON_SECRET}`
      )
        throw new ServiceError("Unauthorized", 401);
      const { listUserIds } = await import("@/lib/db/repository");
      const results = [];
      for (const userId of await listUserIds()) {
        try {
          results.push({ userId, ...(await runReminders(userId)) });
          await runBackgroundJobs(userId);
        } catch {
          results.push({ userId, error: "Reminder processing failed" });
        }
      }
      return NextResponse.json({ results });
    }
    if (path[0] === "device") {
      const token = request.headers
        .get("authorization")
        ?.replace(/^Bearer /, "");
      const userId = token ? await verifyDeviceToken(token) : null;
      if (!userId) throw new ServiceError("Invalid device token", 401);
      if (route === "device/snapshot" && method === "GET") {
        return NextResponse.json(buildDeskSnapshot(await getState(userId)), {
          headers: { "Cache-Control": "private, no-store" },
        });
      }
      if (
        method === "GET" &&
        (route === "device/now" || route === "device/next")
      ) {
        const { rankCommitments } = await import("@/lib/risk/engine");
        const ranked = rankCommitments(await getState(userId));
        return NextResponse.json(
          route === "device/now"
            ? { commitment: ranked[0] ?? null }
            : { commitments: ranked.slice(1, 5) },
        );
      }
      const body = await jsonBody(request);
      if (route === "device/capture" && method === "POST") {
        const v = z
          .object({ text: z.string().trim().min(3).max(5000) })
          .parse(body);
        const result = await limitedParse(userId, v.text);
        const input = parsedInput(result.parsed, "device");
        return NextResponse.json(
          await createCommitment(userId, {
            ...input,
            metadata: {
              ...input.metadata,
              needs_review:
                result.parsed.confidence < 0.8 ||
                result.parsed.warnings.length > 0,
            },
          }),
        );
      }
      if (
        path.length === 3 &&
        method === "POST" &&
        ["start", "pause", "complete"].includes(path[2])
      )
        return NextResponse.json(
          await commitmentAction(userId, path[1], path[2], body),
        );
      throw new ServiceError("Device endpoint not found", 404);
    }
    const user = await requireUser(request);
    if (method !== "GET") assertSafeMutation(request);
    const body =
      method === "POST" || method === "PATCH" ? await jsonBody(request) : {};
    if (route === "state" && method === "GET")
      return NextResponse.json(
        {
          state: await getState(user.id),
          mode: user.demo ? "demo" : "supabase",
          capabilities: configured,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    if (route === "commitments/parse" && method === "POST") {
      const v = z
        .object({ text: z.string().trim().min(3).max(5000) })
        .parse(body);
      return NextResponse.json(await limitedParse(user.id, v.text));
    }
    if (route === "commitments" && method === "POST")
      return NextResponse.json(await createCommitment(user.id, body), {
        status: 201,
      });
    if (route === "commitments" && method === "GET")
      return NextResponse.json({
        commitments: (await getState(user.id)).commitments,
      });
    if (path[0] === "commitments" && path.length === 2) {
      if (method === "PATCH")
        return NextResponse.json(
          await updateCommitment(user.id, path[1], body),
        );
      if (method === "DELETE")
        return NextResponse.json(await deleteCommitment(user.id, path[1]));
    }
    if (path[0] === "commitments" && path.length === 3 && method === "POST")
      return NextResponse.json(
        await commitmentAction(user.id, path[1], path[2], body),
      );
    if (route === "planning/generate" && method === "POST") {
      const v = z
        .object({
          day: z.string().optional(),
          apply: z.boolean().default(false),
        })
        .parse(body);
      return NextResponse.json(await planDay(user.id, v.day, v.apply));
    }
    if (route === "planning/capacity" && method === "GET") {
      const { plan } = await planDay(
        user.id,
        url.searchParams.get("day") ?? undefined,
      );
      return NextResponse.json({
        capacityMinutes: plan.capacityMinutes,
        requiredMinutes: plan.requiredMinutes,
        deficitMinutes: plan.deficitMinutes,
      });
    }
    if (route === "risk/recalculate" && method === "POST") {
      const state = await mutateState(user.id, (s) => {
        recalculate(s);
      });
      return NextResponse.json({ state });
    }
    if (route === "settings" && method === "POST")
      return NextResponse.json(await saveSettings(user.id, body));
    if (route === "review/evening" && method === "POST") {
      const v = z
        .object({ summary: z.string().max(10000).optional() })
        .parse(body);
      return NextResponse.json(await eveningReview(user.id, v.summary));
    }
    if (route === "review/morning" && method === "GET")
      return NextResponse.json({ briefing: briefing(await getState(user.id)) });
    if (route === "calendar/events" && method === "POST")
      return NextResponse.json(await createLocalEvent(user.id, body));
    if (
      path[0] === "calendar" &&
      path[1] === "events" &&
      path.length === 3 &&
      method === "DELETE"
    )
      return NextResponse.json(await deleteLocalEvent(user.id, path[2]));
    if (route === "projects" && method === "POST") {
      const v = z
        .object({
          name: z.string().trim().min(1).max(100),
          description: z.string().max(2000).default(""),
          color: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .default("#a3e635"),
        })
        .parse(body);
      const state = await mutateState(user.id, (s) => {
        if (
          s.projects.some((p) => p.name.toLowerCase() === v.name.toLowerCase())
        )
          throw new ServiceError("A project with that name already exists");
        s.projects.push({
          ...v,
          id: randomUUID(),
          user_id: user.id,
          archived: false,
          created_at: new Date().toISOString(),
        });
        logActivity(s, "project_created", v.name);
      });
      return NextResponse.json({ state });
    }
    if (path[0] === "projects" && path.length === 2 && method === "PATCH") {
      const v = z.object({ archived: z.boolean() }).parse(body);
      const state = await mutateState(user.id, (s) => {
        const p = s.projects.find((p) => p.id === path[1]);
        if (!p) throw new ServiceError("Project not found", 404);
        p.archived = v.archived;
      });
      return NextResponse.json({ state });
    }
    if (route === "contacts" && method === "POST") {
      const v = z
        .object({
          name: z.string().trim().min(1).max(150),
          organization: z.string().max(150).default(""),
          email: z.union([z.email(), z.literal("")]).default(""),
          telegram: z.string().max(100).default(""),
          notes: z.string().max(3000).default(""),
        })
        .parse(body);
      const state = await mutateState(user.id, (s) => {
        s.contacts.push({ ...v, id: randomUUID(), user_id: user.id });
        logActivity(s, "contact_created", v.name);
      });
      return NextResponse.json({ state });
    }
    if (route === "telegram/pair" && method === "POST") {
      const token = await createTelegramPairing(user.id);
      const name = process.env.TELEGRAM_BOT_USERNAME;
      return NextResponse.json({
        token,
        configured: configured.telegram,
        url:
          configured.telegram && name
            ? `https://t.me/${name.replace(/^@/, "")}?start=${token}`
            : null,
      });
    }
    if (route === "integrations/google/connect" && method === "POST")
      return NextResponse.json({
        configured: configured.google,
        url: configured.google ? await googleConnectUrl(user.id) : null,
      });
    if (route === "integrations/google/callback" && method === "GET") {
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!state || !code)
        throw new ServiceError(
          url.searchParams.get("error") ?? "Missing OAuth authorization",
        );
      await consumeGoogleOAuthState(state, user.id);
      await exchangeGoogleCode(code, user.id);
      return NextResponse.redirect(
        new URL(
          "/settings?connected=google",
          process.env.APP_URL ?? request.url,
        ),
      );
    }
    if (route === "integrations/google/sync" && method === "POST") {
      const events = await syncGoogleCalendar(user.id);
      const state = await mutateState(user.id, (s) => {
        s.calendar_events = [
          ...s.calendar_events.filter((e) => e.source !== "google"),
          ...events,
        ];
        logActivity(
          s,
          "calendar_synced",
          `${events.length} Google events synced`,
        );
        recalculate(s);
      });
      return NextResponse.json({ state });
    }
    if (route === "integrations/google/write" && method === "POST") {
      const s = await getState(user.id);
      if (!s.settings.calendar_write_enabled)
        throw new ServiceError("Enable writing focus blocks in Settings first");
      const blocks = s.calendar_events
        .filter((e) => e.source === "focus" && Date.parse(e.end) > Date.now())
        .map((e) => ({
          commitment_id: e.commitment_id ?? "",
          title: e.title,
          start: e.start,
          end: e.end,
          minutes: (Date.parse(e.end) - Date.parse(e.start)) / 60000,
        }));
      await writeGooglePlan(user.id, blocks);
      return NextResponse.json({ state: await getState(user.id) });
    }
    if (route === "gmail/scan" && method === "POST") {
      const candidates = await scanGmail(user.id);
      const state = await mutateState(user.id, (s) => {
        for (const candidate of candidates)
          if (!s.candidates.some((c) => c.email_id === candidate.email_id))
            s.candidates.push(candidate);
        logActivity(
          s,
          "gmail_scanned",
          `${candidates.length} possible commitments`,
        );
      });
      return NextResponse.json({ state });
    }
    if (path[0] === "inbox" && path.length === 2 && method === "POST") {
      const v = z.object({ action: z.enum(["accept", "ignore"]) }).parse(body);
      let current = await getState(user.id);
      const candidate = current.candidates.find((c) => c.id === path[1]);
      if (!candidate)
        throw new ServiceError("Detected commitment not found", 404);
      const parsed =
        v.action === "accept"
          ? (candidate.parsed ??
            (
              await limitedParse(
                user.id,
                `${candidate.subject}. ${candidate.body}`.slice(0, 5000),
              )
            ).parsed)
          : null;
      current = await mutateState(user.id, (s) => {
        const c = s.candidates.find((x) => x.id === candidate.id);
        if (!c || c.status !== "pending")
          throw new ServiceError("This item was already processed");
        c.status = v.action === "accept" ? "accepted" : "ignored";
        if (parsed)
          addCommitment(s, {
            ...parsedInput(parsed, "gmail"),
            source_reference: c.email_id,
            source_url: `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(c.email_id)}`,
          });
        recalculate(s);
      });
      return NextResponse.json({ state: current });
    }
    if (route === "reminders/run" && method === "POST") {
      const result = await runReminders(user.id);
      return NextResponse.json({ state: await getState(user.id), ...result });
    }
    if (route === "devices" && method === "POST") {
      const v = z
        .object({
          label: z.string().trim().min(1).max(100).default("Desk device"),
        })
        .parse(body);
      return NextResponse.json(await issueDeviceToken(user.id, v.label), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (route === "devices" && method === "GET") {
      return NextResponse.json(
        { devices: await listDeviceTokens(user.id) },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }
    if (path[0] === "devices" && path.length === 2 && method === "DELETE") {
      await revokeDeviceToken(user.id, path[1]);
      return NextResponse.json({ ok: true });
    }
    throw new ServiceError("Endpoint not found", 404);
  } catch (error) {
    return errorResponse(error);
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
