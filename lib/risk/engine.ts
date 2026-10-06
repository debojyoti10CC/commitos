import type { AppState, Commitment, RiskResult } from "../types";
import {
  availableBeforeDeadline,
  totalWorkCapacity,
  workspaceEvents,
} from "../scheduling/capacity";
import {
  addLocalDays,
  dayBounds,
  formatMinutes,
  isValidInstant,
  localDate,
  MINUTE,
  minutesBetween,
  zonedDate,
} from "../scheduling/time";

export function calculateRemainingEffort(c: Commitment): number {
  return Math.max(
    0,
    Number.isFinite(c.remaining_minutes)
      ? c.remaining_minutes
      : c.estimated_minutes - c.completed_minutes,
  );
}
export function needsInterpretationReview(c: Commitment): boolean {
  return c.metadata.needs_review === true;
}
export function executionDeadlineTier(c: Commitment, now: Date): number {
  return c.deadline &&
    Date.parse(c.deadline) <= now.getTime() + 24 * 60 * MINUTE
    ? 0
    : 1;
}
export function calculatePressureRatio(
  remaining: number,
  available: number,
): number {
  return remaining / Math.max(1, available);
}
export function dependencyIds(c: Commitment): string[] {
  const ids = c.metadata.depends_on ?? c.metadata.dependencies;
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === "string")
    : [];
}
export function hasUnresolvedDependencies(
  c: Commitment,
  state: AppState,
): boolean {
  return dependencyIds(c).some(
    (id) => state.commitments.find((item) => item.id === id)?.status !== "done",
  );
}

/** Score = deadline urgency (0–30) + pressure (0–25) + priority (0–15) + concrete warning signals. */
export function calculateRiskScore(
  c: Commitment,
  state: AppState,
  now = new Date(),
): RiskResult {
  if (["done", "cancelled"].includes(c.status))
    return {
      score: 0,
      level: "safe",
      explanation: ["This commitment is resolved."],
      pressure: 0,
      availableMinutes: 0,
    };
  if (needsInterpretationReview(c))
    return {
      score: 0,
      level: "safe",
      explanation: [
        "Review the capture interpretation in Inbox before planning or starting work.",
      ],
      pressure: 0,
      availableMinutes: 0,
    };
  const remaining = calculateRemainingEffort(c);
  const explanation = [`${formatMinutes(remaining)} of work remaining.`];
  const deadline = isValidInstant(c.deadline) ? new Date(c.deadline) : null;
  const horizon =
    deadline ??
    zonedDate(
      addLocalDays(localDate(now, state.settings.timezone), 7),
      state.settings.workday_end,
      state.settings.timezone,
    );
  const bufferMinutes = deadline ? Math.min(15, Math.max(0, remaining / 4)) : 0;
  const available = availableBeforeDeadline(
    new Date(horizon.getTime() - bufferMinutes * MINUTE),
    state.settings,
    workspaceEvents(state, now, c.id),
    now,
  );
  const pressure = calculatePressureRatio(remaining, available);
  const hoursUntil = deadline
    ? (deadline.getTime() - now.getTime()) / (60 * MINUTE)
    : null;
  let score =
    { low: 0, medium: 5, high: 10, critical: 15 }[c.priority] +
    Math.min(25, pressure * 25);
  if (deadline) {
    explanation.push(
      deadline <= now
        ? "Delivery deadline has passed."
        : `${formatMinutes(Math.max(0, (deadline.getTime() - now.getTime()) / MINUTE))} until delivery.`,
    );
    explanation.push(
      `${formatMinutes(available)} of free work capacity before the deadline buffer.`,
    );
    score += Math.max(0, 30 * (1 - Math.max(0, hoursUntil!) / 48));
  } else {
    explanation.push("No delivery deadline set.");
  }
  if (deadline && deadline <= now) score = Math.max(score, 88);
  if (!c.started_at && hoursUntil !== null && hoursUntil <= 24) {
    score += 6;
    explanation.push("Work has not been started.");
  }
  if (
    c.scheduled_end &&
    Date.parse(c.scheduled_end) < now.getTime() &&
    !c.started_at
  ) {
    score += 10;
    explanation.push("The scheduled work block was missed.");
  }
  const checkIn = isValidInstant(c.check_in_at)
    ? Date.parse(c.check_in_at)
    : null;
  const checkInCompleted =
    typeof c.metadata.check_in_completed_at === "string"
      ? Date.parse(c.metadata.check_in_completed_at)
      : 0;
  if (checkIn && checkIn <= now.getTime() && !(checkInCompleted >= checkIn)) {
    score += 12;
    explanation.push("A promised progress check-in is overdue.");
  } else if (
    checkIn &&
    checkIn - now.getTime() <= 60 * MINUTE &&
    !(checkInCompleted >= checkIn)
  ) {
    score += 6;
    explanation.push("A progress check-in is due within an hour.");
  }
  if (c.status === "blocked" || hasUnresolvedDependencies(c, state)) {
    score += 15;
    explanation.push(
      c.status === "blocked"
        ? "Work is blocked; resolve or renegotiate it."
        : "An unfinished dependency prevents execution.",
    );
  }
  if (c.status === "waiting") {
    score += 4;
    explanation.push(
      "Waiting for another person; follow up at the next check-in.",
    );
  }
  if (
    c.contact_name ||
    c.organization ||
    c.source === "gmail" ||
    c.source === "telegram"
  ) {
    score += 5;
    explanation.push("This commitment is owed to someone else.");
  }
  const snoozes = Number(c.metadata.snooze_count ?? 0);
  if (snoozes > 1) {
    score += Math.min(10, snoozes * 2);
    explanation.push(`Snoozed ${snoozes} times.`);
  }
  if (deadline) {
    const rawAvailable = availableBeforeDeadline(
      deadline,
      state.settings,
      workspaceEvents(state, now).filter(
        (event) =>
          event.source !== "focus" || Date.parse(event.end) <= now.getTime(),
      ),
      now,
    );
    const competingEffort = state.commitments
      .filter(
        (item) =>
          !needsInterpretationReview(item) &&
          !["done", "cancelled", "waiting"].includes(item.status) &&
          isValidInstant(item.deadline) &&
          Date.parse(item.deadline) <= deadline.getTime(),
      )
      .reduce((total, item) => total + calculateRemainingEffort(item), 0);
    if (competingEffort > rawAvailable) {
      score += 12;
      explanation.push(
        `Earlier and same-deadline work totals ${formatMinutes(competingEffort)} against ${formatMinutes(rawAvailable)} capacity; something must move.`,
      );
    }
  }
  const impossible = Boolean(
    deadline && remaining > available && remaining > 0,
  );
  score = Math.max(
    0,
    Math.min(100, Math.round(impossible ? Math.max(score, 95) : score)),
  );
  if (impossible)
    explanation.push(
      "The remaining effort cannot fit before this deadline. Reduce scope or renegotiate.",
    );
  const level: RiskResult["level"] = impossible
    ? "impossible"
    : score >= 80
      ? "critical"
      : score >= 60
        ? "high"
        : score >= 30
          ? "attention"
          : "safe";
  return {
    score,
    level,
    explanation,
    pressure: Math.round(pressure * 100) / 100,
    availableMinutes: Math.round(available),
  };
}

export function rankCommitments(
  state: AppState,
  now = new Date(),
): Commitment[] {
  return state.commitments
    .filter(
      (c) =>
        !needsInterpretationReview(c) &&
        !["done", "cancelled", "waiting", "blocked"].includes(c.status) &&
        !hasUnresolvedDependencies(c, state) &&
        !(c.snoozed_until && Date.parse(c.snoozed_until) > now.getTime()),
    )
    .map((c) => {
      const risk = calculateRiskScore(c, state, now);
      const deadlineMinutes = c.deadline
        ? Math.max(0, (Date.parse(c.deadline) - now.getTime()) / MINUTE)
        : Number.POSITIVE_INFINITY;
      const progressBonus = c.status === "in_progress" ? 18 : 0;
      // A distant impossible project needs renegotiation, while tonight's deliverable needs execution.
      const nearDeadlineBonus = Math.max(
        0,
        35 * (1 - deadlineMinutes / (24 * 60)),
      );
      const quickWinBonus = calculateRemainingEffort(c) <= 15 ? 5 : 0;
      return {
        c,
        score: risk.score + progressBonus + quickWinBonus + nearDeadlineBonus,
        deadlineMinutes,
      };
    })
    .sort(
      (a, b) =>
        Number(b.c.status === "in_progress") -
          Number(a.c.status === "in_progress") ||
        executionDeadlineTier(a.c, now) - executionDeadlineTier(b.c, now) ||
        b.score - a.score ||
        a.deadlineMinutes - b.deadlineMinutes ||
        a.c.created_at.localeCompare(b.c.created_at) ||
        a.c.id.localeCompare(b.c.id),
    )
    .map((item) => item.c);
}

export function briefing(state: AppState, now = new Date()): string {
  const day = localDate(now, state.settings.timezone);
  const [, end] = dayBounds(day, state.settings.timezone);
  const active = state.commitments.filter(
    (c) =>
      !needsInterpretationReview(c) &&
      !["done", "cancelled"].includes(c.status),
  );
  const available = totalWorkCapacity(
    day,
    state.settings,
    workspaceEvents(state, now),
    now,
  );
  const required = active
    .filter(
      (c) =>
        c.status !== "waiting" &&
        c.deadline &&
        Date.parse(c.deadline) < end.getTime(),
    )
    .reduce((sum, c) => sum + calculateRemainingEffort(c), 0);
  const ranked = rankCommitments(state, now);
  const sensitive = active.filter((c) =>
    ["high", "critical", "impossible"].includes(
      calculateRiskScore(c, state, now).level,
    ),
  );
  return `${day} · ${active.length} active commitments, ${sensitive.length} deadline-sensitive.\nAvailable work time: ${formatMinutes(available)}. Due work: ${formatMinutes(required)}.${required > available ? ` Overcommitted by ${formatMinutes(required - available)}; reduce scope or renegotiate one commitment.` : ""}\n${
    ranked.length
      ? `Top priorities: ${ranked
          .slice(0, 3)
          .map((c, index) => `${index + 1}. ${c.title}`)
          .join("; ")}.`
      : "No executable commitments. Capture something new or clear a dependency."
  }`;
}
