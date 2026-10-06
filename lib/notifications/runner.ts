import { randomUUID } from "node:crypto";
import { readState, mutateState } from "@/lib/db/repository";
import { generateReminderSchedule } from "./rules";
import { getNotificationProvider } from "@/lib/telegram/provider";
import { logActivity, recalculate } from "@/lib/services";
import type { Reminder } from "@/lib/types";

/** Persist a claim before provider I/O. Concurrent cron calls cannot claim the same key. */
export async function runReminders(userId: string, now = new Date()) {
  let claimed: Reminder[] = [];
  await mutateState(userId, (s) => {
    claimed = [];
    recalculate(s, now);
    for (const reminder of s.reminders) {
      if (
        reminder.status === "sending" &&
        now.getTime() -
          Date.parse(
            String(reminder.payload.claimed_at ?? reminder.scheduled_for),
          ) >=
          10 * 60000 &&
        Number(reminder.payload.attempts ?? 0) < 5
      ) {
        reminder.payload.claimed_at = now.toISOString();
        reminder.payload.attempts = Number(reminder.payload.attempts ?? 0) + 1;
        claimed.push(structuredClone(reminder));
      }
    }
    for (const due of generateReminderSchedule(s, now)) {
      if (
        claimed.some(
          (r) => r.commitment_id === due.commitment_id && r.type === due.type,
        )
      )
        continue;
      const existing = s.reminders.find((r) => r.dedupe_key === due.dedupe_key);
      if (existing) {
        const lastTry = Date.parse(
          String(existing.payload.claimed_at ?? existing.scheduled_for),
        );
        if (
          existing.status === "sent" ||
          now.getTime() - lastTry < 10 * 60000 ||
          Number(existing.payload.attempts ?? 0) >= 5
        )
          continue;
        existing.status = "sending";
        existing.payload.claimed_at = now.toISOString();
        existing.payload.attempts = Number(existing.payload.attempts ?? 0) + 1;
        claimed.push(structuredClone(existing));
      } else {
        const reminder: Reminder = {
          id: randomUUID(),
          user_id: userId,
          commitment_id: due.commitment_id,
          scheduled_for: now.toISOString(),
          type: due.type,
          status: "sending",
          sent_at: null,
          provider: "pending",
          dedupe_key: due.dedupe_key,
          payload: {
            text: due.text,
            claimed_at: now.toISOString(),
            attempts: 1,
          },
        };
        s.reminders.unshift(reminder);
        claimed.push(structuredClone(reminder));
      }
    }
  });
  let sent = 0,
    failed = 0;
  for (const item of claimed) {
    const current = await readState(userId);
    const c = item.commitment_id
      ? current.commitments.find((c) => c.id === item.commitment_id)
      : null;
    const validationState = structuredClone(current);
    validationState.reminders = validationState.reminders.filter(
      (r) => r.id !== item.id,
    );
    const stillDue = generateReminderSchedule(validationState, now).some(
      (due) => due.dedupe_key === item.dedupe_key,
    );
    if (
      !stillDue ||
      (item.commitment_id &&
        (!c ||
          ["done", "cancelled", "waiting", "blocked"].includes(c.status) ||
          (c.snoozed_until && Date.parse(c.snoozed_until) > now.getTime())))
    ) {
      await mutateState(userId, (s) => {
        s.reminders = s.reminders.filter((r) => r.id !== item.id);
      });
      continue;
    }
    let provider = "console";
    try {
      const account = current.integrations.find(
        (i) => i.provider === "telegram",
      );
      provider =
        current.settings.telegram_enabled &&
        account?.connected &&
        process.env.TELEGRAM_BOT_TOKEN
          ? "telegram"
          : "console";
      const adapter = await getNotificationProvider(userId);
      await adapter.send({
        userId,
        title:
          c?.title ??
          (item.type === "morning_briefing"
            ? "Morning briefing"
            : "Evening review"),
        message: String(item.payload.text ?? ""),
        commitmentId: item.commitment_id ?? undefined,
        actions: item.commitment_id
          ? [
              { label: "Start", action: "start" },
              { label: "Done", action: "done" },
              { label: "Snooze 30m", action: "snooze" },
              ...(item.type.includes("check")
                ? [{ label: "Update sent", action: "checkin" as const }]
                : [{ label: "Reschedule", action: "reschedule" as const }]),
            ]
          : undefined,
      });
      await mutateState(userId, (s) => {
        const reminder = s.reminders.find((r) => r.id === item.id);
        if (reminder) {
          reminder.status = "sent";
          reminder.provider = provider;
          reminder.sent_at = now.toISOString();
        }
        const target = s.commitments.find((c) => c.id === item.commitment_id);
        if (target) {
          target.last_reminded_at = now.toISOString();
          target.reminder_count++;
        }
        logActivity(
          s,
          "reminder_sent",
          `${provider}: ${String(item.payload.text).slice(0, 120)}`,
          item.commitment_id,
          now,
        );
      });
      sent++;
    } catch {
      await mutateState(userId, (s) => {
        const reminder = s.reminders.find((r) => r.id === item.id);
        if (reminder) {
          reminder.status = "failed";
          reminder.provider = provider;
          reminder.payload.error = "Delivery failed; will retry after cooldown";
        }
        logActivity(
          s,
          "reminder_failed",
          `${provider} unavailable`,
          item.commitment_id,
          now,
        );
      });
      failed++;
    }
  }
  console.info(
    JSON.stringify({
      event: "reminder_run",
      userId,
      claimed: claimed.length,
      sent,
      failed,
    }),
  );
  return { sent, failed };
}
