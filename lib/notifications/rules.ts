import type { AppState, Commitment } from "../types";
import {
  calculateRemainingEffort,
  calculateRiskScore,
  needsInterpretationReview,
  briefing,
} from "../risk/engine";
import {
  formatMinutes,
  localDate,
  localTime,
  MINUTE,
} from "../scheduling/time";
export { briefing } from "../risk/engine";

export interface DueNotification {
  commitment_id: string | null;
  type: string;
  dedupe_key: string;
  text: string;
}
function reminderStage(
  c: Commitment,
  state: AppState,
  now: Date,
): { stage: string; cooldown: number } | null {
  if (!c.deadline) return null;
  const minutes = (Date.parse(c.deadline) - now.getTime()) / MINUTE;
  if (minutes <= 0) return { stage: "overdue", cooldown: 120 };
  if (minutes <= 30) return { stage: "critical", cooldown: 30 };
  if (minutes <= 120) return { stage: "high", cooldown: 60 };
  if (minutes <= 240) return { stage: "heads-up", cooldown: 120 };
  const risk = calculateRiskScore(c, state, now);
  return ["critical", "impossible"].includes(risk.level)
    ? { stage: "capacity-risk", cooldown: 240 }
    : null;
}
function alreadyQueued(state: AppState, key: string): boolean {
  return state.reminders.some(
    (reminder) => reminder.dedupe_key === key && reminder.status !== "failed",
  );
}

/** Due notifications for a cron tick; persistent outbox claims make delivery idempotent. */
export function generateReminderSchedule(
  state: AppState,
  now = new Date(),
): DueNotification[] {
  const notifications: DueNotification[] = [];
  const nowMs = now.getTime();
  const day = localDate(now, state.settings.timezone);
  const currentTime = localTime(now, state.settings.timezone);
  for (const c of state.commitments) {
    if (
      needsInterpretationReview(c) ||
      ["done", "cancelled", "waiting", "blocked"].includes(c.status) ||
      (c.snoozed_until && Date.parse(c.snoozed_until) > nowMs)
    )
      continue;
    const lastReminded = c.last_reminded_at
      ? Date.parse(c.last_reminded_at)
      : 0;
    const rescheduled = String(c.metadata.rescheduled_at ?? "");
    const checkInMs = c.check_in_at ? Date.parse(c.check_in_at) : 0;
    const completedCheckIn =
      typeof c.metadata.check_in_completed_at === "string"
        ? Date.parse(c.metadata.check_in_completed_at)
        : 0;
    if (
      state.settings.check_in_alerts &&
      checkInMs &&
      checkInMs <= nowMs &&
      completedCheckIn < checkInMs
    ) {
      const cooldown = 120;
      const bucket = Math.floor((nowMs - checkInMs) / (cooldown * MINUTE));
      const key = `check-in:${c.id}:${c.check_in_at}:${rescheduled}:${bucket}`;
      if (
        nowMs - lastReminded >= cooldown * MINUTE &&
        !alreadyQueued(state, key)
      ) {
        notifications.push({
          commitment_id: c.id,
          type: "check_in",
          dedupe_key: key,
          text: `You promised a progress update: ${c.title}. Check-in ${bucket ? "is still overdue" : "is due now"}. Send the update, mark the check-in done, or reschedule it.`,
        });
        // One task receives at most one reminder in a single tick.
        continue;
      }
    }
    if (!state.settings.risk_alerts) continue;
    const stage = reminderStage(c, state, now);
    if (!stage) continue;
    const bucket = Math.floor(nowMs / (stage.cooldown * MINUTE));
    const key = `deadline:${c.id}:${c.deadline}:${rescheduled}:${stage.stage}:${bucket}`;
    // Risk can escalate after 15m; repeated reminders at the same level respect full cooldown.
    const latest = state.reminders
      .filter(
        (reminder) =>
          reminder.commitment_id === c.id && reminder.status === "sent",
      )
      .sort((a, b) =>
        (b.sent_at ?? b.scheduled_for).localeCompare(
          a.sent_at ?? a.scheduled_for,
        ),
      )[0];
    const escalation =
      latest?.type.startsWith("deadline_") &&
      latest.type !== `deadline_${stage.stage}`;
    const cooldown = escalation ? Math.min(15, stage.cooldown) : stage.cooldown;
    if (nowMs - lastReminded < cooldown * MINUTE || alreadyQueued(state, key))
      continue;
    const remaining = formatMinutes(calculateRemainingEffort(c));
    const until = c.deadline ? (Date.parse(c.deadline) - nowMs) / MINUTE : 0;
    const risk = calculateRiskScore(c, state, now);
    notifications.push({
      commitment_id: c.id,
      type: `deadline_${stage.stage}`,
      dedupe_key: key,
      text: `${risk.level.toUpperCase()}: ${c.title}. ${until <= 0 ? "Deadline missed" : `Due in ${formatMinutes(until)}`}; ${remaining} work remains. ${risk.level === "impossible" ? "Reduce scope or renegotiate the deadline." : "Start, complete, snooze, or reschedule this commitment."}`,
    });
  }
  if (state.settings.telegram_enabled) {
    const briefKey = `briefing:${state.user_id}:${day}`;
    if (
      currentTime >= state.settings.briefing_time &&
      currentTime < state.settings.review_time &&
      !alreadyQueued(state, briefKey)
    )
      notifications.push({
        commitment_id: null,
        type: "morning_briefing",
        dedupe_key: briefKey,
        text: briefing(state, now),
      });
    const reviewKey = `review:${state.user_id}:${day}`;
    if (
      currentTime >= state.settings.review_time &&
      !alreadyQueued(state, reviewKey)
    ) {
      const unresolved = state.commitments.filter(
        (c) =>
          !needsInterpretationReview(c) &&
          !["done", "cancelled"].includes(c.status),
      );
      const completed = state.commitments.filter(
        (c) =>
          c.completed_at &&
          localDate(new Date(c.completed_at), state.settings.timezone) === day,
      ).length;
      notifications.push({
        commitment_id: null,
        type: "nightly_review",
        dedupe_key: reviewKey,
        text: `Daily review: ${completed} commitments completed. ${unresolved.length} remain unresolved. ${
          unresolved.length
            ? `Carry forward or renegotiate: ${unresolved
                .slice(0, 4)
                .map((c) => c.title)
                .join("; ")}.`
            : "You are clear for the day."
        }`,
      });
    }
  }
  return notifications;
}
