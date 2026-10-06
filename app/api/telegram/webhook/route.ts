import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  findUserByTelegramChat,
  redeemTelegramPairing,
  mutateState,
  readState,
} from "@/lib/db/repository";
import { sendTelegramMessage, answerCallback } from "@/lib/telegram/provider";
import { parseCommitment } from "@/lib/ai/provider";
import { rankCommitments } from "@/lib/risk/engine";
import { briefing } from "@/lib/notifications/rules";
import {
  actOnCommitment,
  addCommitment,
  parsedInput,
  recalculate,
  logActivity,
} from "@/lib/services";
export const runtime = "nodejs";
const chatSchema = z.object({ id: z.number().int(), type: z.string() });
const updateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({ chat: chatSchema, text: z.string().max(5000).optional() })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      data: z.string().max(100).optional(),
      message: z.object({ chat: chatSchema }).optional(),
    })
    .optional(),
});
export async function POST(request: Request) {
  let processingUser: string | null = null;
  let processingUpdate: number | null = null;
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  const actual = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (
    !expected ||
    Buffer.byteLength(expected) !== Buffer.byteLength(actual) ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
  )
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (Number(request.headers.get("content-length") ?? 0) > 65536)
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  try {
    const raw = await request.text();
    if (raw.length > 65536)
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    const update = updateSchema.parse(JSON.parse(raw));
    const chat = update.message?.chat ?? update.callback_query?.message?.chat;
    if (!chat || chat.type !== "private")
      return NextResponse.json({ ok: true });
    const chatId = String(chat.id);
    const text = update.message?.text?.trim() ?? "";
    if (text.startsWith("/start ")) {
      const userId = await redeemTelegramPairing(text.slice(7).trim(), chatId);
      await sendTelegramMessage(
        chatId,
        userId
          ? "Connected to CommitOS. Send a commitment, or use /today, /next and /inbox."
          : "Pairing expired or invalid. Generate a new pairing in CommitOS Settings.",
      );
      return NextResponse.json({ ok: true });
    }
    const userId = await findUserByTelegramChat(chatId);
    if (!userId) {
      await sendTelegramMessage(
        chatId,
        "Connect this chat in CommitOS Settings first.",
      );
      return NextResponse.json({ ok: true });
    }
    processingUser = userId;
    processingUpdate = update.update_id;
    let processUpdate = false;
    let inflight = false;
    await mutateState(userId, (s) => {
      processUpdate = false;
      inflight = false;
      const id = String(update.update_id);
      if (
        s.activity.some((e) => e.type === "telegram_update" && e.message === id)
      )
        return;
      const claimIndex = s.activity.findIndex(
        (e) => e.type === "telegram_update_claimed" && e.message === id,
      );
      const failureIndex = s.activity.findIndex(
        (e) => e.type === "telegram_update_failed" && e.message === id,
      );
      const claim = s.activity[claimIndex];
      if (
        claim &&
        Date.parse(claim.created_at) > Date.now() - 300000 &&
        (failureIndex < 0 || failureIndex > claimIndex)
      ) {
        inflight = true;
        return;
      }
      logActivity(s, "telegram_update_claimed", id);
      processUpdate = true;
    });
    if (!processUpdate)
      return NextResponse.json(
        { ok: !inflight },
        { status: inflight ? 503 : 200 },
      );
    const acknowledge = () =>
      mutateState(userId, (s) => {
        logActivity(s, "telegram_update", String(update.update_id));
      });
    if (update.callback_query) {
      const [action, id] = update.callback_query.data?.split(":") ?? [];
      if (action === "reschedule") {
        await answerCallback(
          update.callback_query.id,
          "Choose a new date in CommitOS",
        );
        await sendTelegramMessage(chatId, "Choose a new deadline in the app.", [
          [
            {
              text: "Open CommitOS",
              url: `${process.env.APP_URL}/commitments`,
            },
          ],
        ]);
      } else if (
        id &&
        ["start", "done", "snooze", "checkin"].includes(action)
      ) {
        await mutateState(userId, (s) => {
          actOnCommitment(s, id, action === "done" ? "complete" : action, {
            minutes: 30,
          });
          recalculate(s);
          logActivity(s, "telegram_update", String(update.update_id));
        });
        await answerCallback(update.callback_query.id, "Saved");
      }
      await acknowledge();
      return NextResponse.json({ ok: true });
    }
    const state = await readState(userId);
    if (text === "/today") {
      await sendTelegramMessage(chatId, briefing(state));
    } else if (text === "/next") {
      const next = rankCommitments(state).slice(0, 4);
      await sendTelegramMessage(
        chatId,
        next.length
          ? next
              .map(
                (c) =>
                  `${c.title} · ${Math.ceil(c.remaining_minutes)} min · ${c.risk_level}`,
              )
              .join("\n")
          : "No commitments need attention.",
      );
    } else if (text === "/inbox") {
      const inbox = state.commitments.filter((c) => c.status === "inbox");
      await sendTelegramMessage(
        chatId,
        inbox.length
          ? inbox.map((c) => `${c.id.slice(0, 8)} · ${c.title}`).join("\n")
          : "Inbox is clear.",
      );
    } else if (text.startsWith("/done ")) {
      const query = text.slice(6).toLowerCase();
      const matches = state.commitments.filter(
        (c) => c.id.startsWith(query) || c.title.toLowerCase().includes(query),
      );
      if (matches.length !== 1) {
        await sendTelegramMessage(
          chatId,
          "Use a unique commitment title or ID prefix.",
        );
      } else {
        await mutateState(userId, (s) => {
          actOnCommitment(s, matches[0].id, "complete");
          recalculate(s);
          logActivity(s, "telegram_update", String(update.update_id));
        });
        await sendTelegramMessage(chatId, `Completed: ${matches[0].title}`);
      }
    } else if (text === "/start" || text === "/help") {
      await sendTelegramMessage(
        chatId,
        "Send any commitment as plain text. Commands: /add <commitment>, /today, /next, /inbox, /done <unique title or ID>.",
      );
    } else if (text) {
      const capture = text.replace(/^\/add\s+/, "");
      await mutateState(userId, (s) => {
        const now = Date.now();
        if (
          s.activity.filter(
            (e) =>
              e.type === "parse_requested" &&
              Date.parse(e.created_at) > now - 900000,
          ).length >= 20
        )
          throw new Error("Capture rate limit reached");
        logActivity(s, "parse_requested", "Telegram capture");
      });
      const parsed = await parseCommitment(capture, {
        timezone: state.settings.timezone,
        projects: state.projects.map((p) => p.name),
        defaultMinutes: state.settings.default_task_minutes,
      });
      const result = await mutateState(userId, (s) => {
        addCommitment(s, {
          ...parsedInput(parsed.parsed, "telegram"),
          metadata: {
            confidence: parsed.parsed.confidence,
            inferred_fields: parsed.parsed.inferredFields,
            warnings: parsed.parsed.warnings,
            needs_review: parsed.parsed.confidence < 0.85,
          },
        });
        recalculate(s);
        logActivity(s, "telegram_update", String(update.update_id));
      });
      const c = result.commitments[0];
      await sendTelegramMessage(
        chatId,
        `Captured: ${c.title}\n${c.deadline ? `Due: ${new Intl.DateTimeFormat("en-IN", { timeZone: state.settings.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(c.deadline))}\n` : ""}${c.estimated_minutes} min · ${c.risk_level}${parsed.parsed.warnings.length ? "\nReview the interpretation in your Inbox." : ""}`,
        [[{ text: "Open Inbox", url: `${process.env.APP_URL}/inbox` }]],
      );
    }
    await acknowledge();
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (processingUser && processingUpdate !== null) {
      try {
        await mutateState(processingUser, (s) => {
          logActivity(s, "telegram_update_failed", String(processingUpdate));
        });
      } catch {
        /* The next webhook retry recovers an expired claim if storage is unavailable. */
      }
    }
    console.error(
      JSON.stringify({
        event: "telegram_update_failed",
        error: error instanceof Error ? error.name : "Unknown",
      }),
    );
    return NextResponse.json(
      { ok: false, error: "Unable to process this update; retry later" },
      { status: 503 },
    );
  }
}
