import { randomUUID } from "node:crypto";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { readState, mutateState } from "./db/repository";
import {
  commitmentInput,
  commitmentPatch,
  settingsPatch,
  calendarInput,
} from "./validation";
import { ParsedCommitmentSchema } from "./ai/schema";
import { calculateRiskScore, rankCommitments } from "./risk/engine";
import { generateDailyPlan } from "./scheduling/planner";
import type {
  AppState,
  Commitment,
  ParsedCommitment,
  WorkSession,
  DailyReview,
} from "./types";

export function logActivity(
  state: AppState,
  type: string,
  message: string,
  commitment_id: string | null = null,
  now = new Date(),
) {
  state.activity.unshift({
    id: randomUUID(),
    user_id: state.user_id,
    commitment_id,
    type,
    message,
    created_at: now.toISOString(),
  });
  state.activity = state.activity.slice(0, 2000);
}
export function recalculate(state: AppState, now = new Date()) {
  for (const c of state.commitments) {
    const risk = calculateRiskScore(c, state, now);
    c.risk_score = risk.score;
    c.risk_level = risk.level;
    c.last_risk_calculation_at = now.toISOString();
  }
  return state;
}
export async function getState(userId: string) {
  return recalculate(await readState(userId));
}
export function parsedInput(parsed: ParsedCommitment, source = "manual") {
  return {
    title: parsed.title,
    description: parsed.description ?? "",
    project: parsed.project,
    commitment_type: parsed.commitmentType,
    contact_name: parsed.contactName,
    organization: parsed.organization,
    deadline: parsed.deadline,
    check_in_at: parsed.checkInAt,
    estimated_minutes: parsed.estimatedMinutes ?? 30,
    priority: parsed.priority,
    next_action: parsed.nextAction,
    source,
    metadata: {
      confidence: parsed.confidence,
      inferred_fields: parsed.inferredFields,
      warnings: parsed.warnings,
    },
  };
}
export function addCommitment(
  state: AppState,
  input: unknown,
  now = new Date(),
): Commitment {
  const v = commitmentInput.parse(input);
  const stamp = now.toISOString();
  if (["in_progress", "done", "cancelled"].includes(v.status))
    throw new ServiceError(
      "Capture the commitment first, then start, complete, or cancel it.",
    );
  const c: Commitment = {
    ...v,
    id: randomUUID(),
    user_id: state.user_id,
    created_at: stamp,
    updated_at: stamp,
    scheduled_start: null,
    scheduled_end: null,
    completed_minutes: 0,
    remaining_minutes: v.estimated_minutes,
    risk_score: 0,
    risk_level: "safe",
    last_risk_calculation_at: null,
    last_reminded_at: null,
    reminder_count: 0,
    snoozed_until: null,
    started_at: null,
    completed_at: null,
    cancelled_at: null,
  };
  state.commitments.unshift(c);
  if (
    c.project &&
    !state.projects.some(
      (p) => p.name.toLowerCase() === c.project?.toLowerCase(),
    )
  )
    state.projects.push({
      id: randomUUID(),
      user_id: state.user_id,
      name: c.project,
      description: "",
      color: "#a3e635",
      archived: false,
      created_at: stamp,
    });
  if (
    c.contact_name &&
    !state.contacts.some(
      (p) => p.name.toLowerCase() === c.contact_name?.toLowerCase(),
    )
  )
    state.contacts.push({
      id: randomUUID(),
      user_id: state.user_id,
      name: c.contact_name,
      organization: c.organization ?? "",
      email: "",
      telegram: "",
      notes: "",
    });
  logActivity(state, "commitment_created", c.title, c.id, now);
  return c;
}
export async function createCommitment(
  userId: string,
  body: Record<string, unknown>,
) {
  const input = body.parsed
    ? parsedInput(
        ParsedCommitmentSchema.parse(body.parsed),
        String(body.source ?? "manual"),
      )
    : body;
  let commitment: Commitment | undefined;
  const state = await mutateState(userId, (s) => {
    commitment = addCommitment(s, input);
    recalculate(s);
  });
  return { state, commitment };
}
export function findCommitment(state: AppState, id: string) {
  const c = state.commitments.find((c) => c.id === id);
  if (!c) throw new ServiceError("Commitment not found", 404);
  return c;
}
export class ServiceError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
function stopSession(state: AppState, c: Commitment, now: Date) {
  for (const session of state.sessions.filter(
    (s) => s.commitment_id === c.id && !s.ended_at,
  )) {
    session.ended_at = now.toISOString();
    session.duration_minutes = Math.max(
      0,
      Math.round(
        ((now.getTime() - new Date(session.started_at).getTime()) / 60000) *
          100,
      ) / 100,
    );
    c.completed_minutes =
      Math.round((c.completed_minutes + session.duration_minutes) * 100) / 100;
    c.remaining_minutes = Math.max(
      0,
      c.estimated_minutes - c.completed_minutes,
    );
  }
}
function releaseReservations(state: AppState, id: string, now: Date) {
  state.calendar_events = state.calendar_events.filter(
    (e) =>
      e.source !== "focus" ||
      e.commitment_id !== id ||
      Date.parse(e.start) < now.getTime(),
  );
  for (const event of state.calendar_events)
    if (
      event.source === "focus" &&
      event.commitment_id === id &&
      Date.parse(event.end) > now.getTime()
    )
      event.end = now.toISOString();
}
export function actOnCommitment(
  state: AppState,
  id: string,
  action: string,
  body: Record<string, unknown> = {},
  now = new Date(),
) {
  const c = findCommitment(state, id);
  const stamp = now.toISOString();
  if (action === "complete" && c.status === "done") return;
  if (action === "start") {
    if (["done", "cancelled", "blocked", "waiting"].includes(c.status))
      throw new ServiceError(
        "Resolve or reopen this commitment before starting it",
      );
    c.metadata.needs_review = false;
    if (state.sessions.some((s) => s.commitment_id === c.id && !s.ended_at))
      return;
    for (const active of state.commitments.filter(
      (x) => x.status === "in_progress",
    )) {
      stopSession(state, active, now);
      active.status = active.scheduled_start ? "scheduled" : "inbox";
      active.updated_at = stamp;
    }
    const session: WorkSession = {
      id: randomUUID(),
      user_id: state.user_id,
      commitment_id: id,
      started_at: stamp,
      ended_at: null,
      duration_minutes: 0,
      notes: "",
    };
    state.sessions.push(session);
    c.status = "in_progress";
    c.started_at ??= stamp;
    c.snoozed_until = null;
    logActivity(state, "commitment_started", c.title, id, now);
  } else if (action === "pause") {
    stopSession(state, c, now);
    if (c.status === "in_progress")
      c.status = c.scheduled_start ? "scheduled" : "inbox";
    logActivity(state, "commitment_paused", c.title, id, now);
  } else if (action === "complete") {
    stopSession(state, c, now);
    releaseReservations(state, id, now);
    c.status = "done";
    c.completed_at = stamp;
    c.cancelled_at = null;
    c.remaining_minutes = 0;
    c.snoozed_until = null;
    state.reminders = state.reminders.filter(
      (r) => r.commitment_id !== id || r.status === "sent",
    );
    logActivity(state, "commitment_completed", c.title, id, now);
  } else if (action === "snooze") {
    const minutes = Number(body.minutes ?? 30);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080)
      throw new ServiceError("Snooze must be 1–10080 minutes");
    stopSession(state, c, now);
    releaseReservations(state, id, now);
    if (c.status === "in_progress" || c.status === "scheduled")
      c.status = "inbox";
    c.scheduled_start = null;
    c.scheduled_end = null;
    c.snoozed_until = new Date(now.getTime() + minutes * 60000).toISOString();
    c.metadata.snooze_count = Number(c.metadata.snooze_count ?? 0) + 1;
    logActivity(
      state,
      "commitment_snoozed",
      `${c.title} · ${minutes} min`,
      id,
      now,
    );
  } else if (action === "checkin") {
    c.metadata.check_in_completed_at = stamp;
    logActivity(
      state,
      "check_in_completed",
      `Update sent: ${c.title}`,
      id,
      now,
    );
  } else if (action === "reschedule") {
    const deadline = body.deadline;
    if (
      typeof deadline !== "string" ||
      !Number.isFinite(Date.parse(deadline)) ||
      !/(?:Z|[+-]\d{2}:\d{2})$/.test(deadline)
    )
      throw new ServiceError("Choose a valid deadline with a timezone");
    stopSession(state, c, now);
    releaseReservations(state, id, now);
    c.deadline = new Date(deadline).toISOString();
    c.scheduled_start = null;
    c.scheduled_end = null;
    c.remaining_minutes = Math.max(
      0,
      c.estimated_minutes - c.completed_minutes,
    );
    c.completed_at = null;
    c.cancelled_at = null;
    c.status = "inbox";
    c.snoozed_until = null;
    c.last_reminded_at = null;
    c.metadata.rescheduled_at = stamp;
    c.metadata.check_in_completed_at = null;
    c.check_in_at = null;
    logActivity(state, "commitment_rescheduled", c.title, id, now);
  } else throw new ServiceError("Unknown action", 404);
  c.updated_at = stamp;
}
export async function commitmentAction(
  userId: string,
  id: string,
  action: string,
  body: Record<string, unknown> = {},
) {
  const state = await mutateState(userId, (s) => {
    actOnCommitment(s, id, action, body);
    recalculate(s);
  });
  return { state };
}
export async function updateCommitment(
  userId: string,
  id: string,
  body: unknown,
) {
  const patch = commitmentPatch.parse(body);
  const state = await mutateState(userId, (s) => {
    const c = findCommitment(s, id);
    const now = new Date();
    const oldDeadline = c.deadline;
    c.metadata.needs_review = false;
    if (patch.status && patch.status !== c.status) {
      if (patch.status === "in_progress")
        actOnCommitment(s, id, "start", {}, now);
      else if (patch.status === "done")
        actOnCommitment(s, id, "complete", {}, now);
      else {
        const resolved = ["done", "cancelled"].includes(c.status);
        stopSession(s, c, now);
        if (["cancelled", "waiting", "blocked"].includes(patch.status)) {
          releaseReservations(s, id, now);
          c.scheduled_start = null;
          c.scheduled_end = null;
        }
        if (resolved) {
          c.completed_at = null;
          c.cancelled_at = null;
          c.remaining_minutes = Math.max(
            0,
            c.estimated_minutes - c.completed_minutes,
          );
        }
        if (patch.status === "cancelled") {
          c.cancelled_at = now.toISOString();
          c.completed_at = null;
        }
      }
    }
    Object.assign(c, patch);
    if (patch.estimated_minutes !== undefined && c.status !== "done")
      c.remaining_minutes = Math.max(
        0,
        c.estimated_minutes - c.completed_minutes,
      );
    if (c.deadline !== oldDeadline) {
      c.last_reminded_at = null;
      if (
        c.scheduled_end &&
        c.deadline &&
        Date.parse(c.scheduled_end) > Date.parse(c.deadline)
      ) {
        releaseReservations(s, id, now);
        c.scheduled_start = null;
        c.scheduled_end = null;
        if (c.status === "scheduled") c.status = "inbox";
      }
      logActivity(s, "deadline_changed", c.title, id, now);
    }
    c.updated_at = now.toISOString();
    logActivity(s, "commitment_updated", c.title, id, now);
    recalculate(s);
  });
  return { state };
}
export async function deleteCommitment(userId: string, id: string) {
  const state = await mutateState(userId, (s) => {
    const c = findCommitment(s, id);
    s.commitments = s.commitments.filter((x) => x.id !== id);
    s.sessions = s.sessions.filter((x) => x.commitment_id !== id);
    s.reminders = s.reminders.filter((x) => x.commitment_id !== id);
    s.calendar_events = s.calendar_events.filter((x) => x.commitment_id !== id);
    s.activity.forEach((x) => {
      if (x.commitment_id === id) x.commitment_id = null;
    });
    logActivity(s, "commitment_deleted", c.title);
  });
  return { state };
}
export async function planDay(userId: string, day?: string, apply = false) {
  let state = await getState(userId);
  const selected =
    day ?? formatInTimeZone(new Date(), state.settings.timezone, "yyyy-MM-dd");
  const checkedDate = new Date(`${selected}T12:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(selected) ||
    !Number.isFinite(checkedDate.getTime()) ||
    checkedDate.toISOString().slice(0, 10) !== selected
  )
    throw new ServiceError("Use a valid YYYY-MM-DD date");
  const clearFuturePlan = (s: AppState) => {
    const startNow = Date.now();
    s.calendar_events = s.calendar_events.filter(
      (e) =>
        e.source !== "focus" ||
        formatInTimeZone(
          new Date(e.start),
          s.settings.timezone,
          "yyyy-MM-dd",
        ) !== selected ||
        Date.parse(e.start) < startNow,
    );
    for (const c of s.commitments)
      if (
        c.scheduled_start &&
        Date.parse(c.scheduled_start) >= startNow &&
        formatInTimeZone(
          new Date(c.scheduled_start),
          s.settings.timezone,
          "yyyy-MM-dd",
        ) === selected &&
        c.status !== "in_progress"
      ) {
        c.scheduled_start = null;
        c.scheduled_end = null;
        if (c.status === "scheduled") c.status = "inbox";
      }
  };
  const planningState = structuredClone(state);
  clearFuturePlan(planningState);
  let plan = generateDailyPlan(planningState, selected);
  if (apply) {
    state = await mutateState(userId, (s) => {
      clearFuturePlan(s);
      plan = generateDailyPlan(s, selected);
      const now = new Date();
      // Reconcile preserved reservations with the engine's result after calendar/estimate changes.
      s.calendar_events = s.calendar_events.filter((e) => {
        if (
          e.source !== "focus" ||
          formatInTimeZone(
            new Date(e.start),
            s.settings.timezone,
            "yyyy-MM-dd",
          ) !== selected ||
          Date.parse(e.end) <= now.getTime()
        )
          return true;
        const futureStart = Math.max(now.getTime(), Date.parse(e.start));
        const retained = plan.blocks.some(
          (b) =>
            b.commitment_id === e.commitment_id &&
            Date.parse(b.start) <= futureStart &&
            Date.parse(b.end) >= Date.parse(e.end),
        );
        if (retained) return true;
        if (Date.parse(e.start) < now.getTime()) {
          e.end = now.toISOString();
          return true;
        }
        return false;
      });
      for (const c of s.commitments) {
        const future = plan.blocks.filter((b) => b.commitment_id === c.id);
        if (future.length) {
          c.scheduled_start = future[0].start;
          c.scheduled_end = future[0].end;
          const previous = c.metadata.planned_minutes_by_day;
          const history: Record<string, number> =
            previous && typeof previous === "object" && !Array.isArray(previous)
              ? (previous as Record<string, number>)
              : {};
          history[selected] = Math.max(
            Number(history[selected] ?? 0),
            Math.round(future.reduce((total, b) => total + b.minutes, 0)),
          );
          c.metadata.planned_minutes_by_day = history;
        } else if (
          c.scheduled_end &&
          Date.parse(c.scheduled_end) > now.getTime() &&
          formatInTimeZone(
            new Date(c.scheduled_start ?? c.scheduled_end),
            s.settings.timezone,
            "yyyy-MM-dd",
          ) === selected
        ) {
          c.scheduled_start = null;
          c.scheduled_end = null;
          if (c.status === "scheduled") c.status = "inbox";
        }
      }
      for (const b of plan.blocks) {
        if (
          s.calendar_events.some(
            (e) =>
              e.source === "focus" &&
              e.commitment_id === b.commitment_id &&
              Date.parse(e.start) <= Date.parse(b.start) &&
              Date.parse(e.end) >= Date.parse(b.end),
          )
        )
          continue;
        s.calendar_events.push({
          id: randomUUID(),
          user_id: userId,
          title: b.title,
          start: b.start,
          end: b.end,
          source: "focus",
          commitment_id: b.commitment_id,
          external_id: null,
        });
        const c = findCommitment(s, b.commitment_id);
        if (c.status === "inbox") c.status = "scheduled";
        logActivity(
          s,
          "calendar_block_created",
          `${b.title} · ${b.minutes} min`,
          c.id,
        );
      }
      logActivity(
        s,
        "plan_generated",
        `${plan.blocks.length} blocks; ${plan.deficitMinutes} min deficit`,
      );
      recalculate(s);
    });
  }
  return { state, plan };
}
export async function saveSettings(userId: string, body: unknown) {
  const patch = settingsPatch.parse(body);
  const state = await mutateState(userId, (s) => {
    const next = { ...s.settings, ...patch };
    if (next.workday_start >= next.workday_end)
      throw new ServiceError("Workday end must follow start");
    for (const meal of next.meal_blocks)
      if (meal.end <= meal.start)
        throw new ServiceError("Meal end must follow start");
    s.settings = next;
    logActivity(s, "settings_updated", "Preferences saved");
    recalculate(s);
  });
  return { state };
}
export async function createLocalEvent(userId: string, body: unknown) {
  const v = calendarInput.parse(body);
  const state = await mutateState(userId, (s) => {
    s.calendar_events.push({
      ...v,
      id: randomUUID(),
      user_id: userId,
      source: "local",
      commitment_id: null,
      external_id: null,
    });
    logActivity(s, "calendar_event_created", v.title);
    recalculate(s);
  });
  return { state };
}
export async function deleteLocalEvent(userId: string, id: string) {
  const state = await mutateState(userId, (s) => {
    const event = s.calendar_events.find((e) => e.id === id);
    if (!event) throw new ServiceError("Event not found", 404);
    if (event.source === "google")
      throw new ServiceError("Edit external events in Google Calendar");
    s.calendar_events = s.calendar_events.filter((e) => e.id !== id);
    logActivity(s, "calendar_event_removed", event.title);
    recalculate(s);
  });
  return { state };
}
export async function eveningReview(userId: string, summary = "") {
  let review: DailyReview | undefined;
  const state = await mutateState(userId, (s) => {
    const now = new Date();
    const day = formatInTimeZone(now, s.settings.timezone, "yyyy-MM-dd");
    const inDay = (v: string) =>
      formatInTimeZone(new Date(v), s.settings.timezone, "yyyy-MM-dd") === day;
    const start = fromZonedTime(
      `${day}T00:00:00`,
      s.settings.timezone,
    ).getTime();
    const tomorrow = new Date(`${day}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const end = fromZonedTime(
      `${tomorrow.toISOString().slice(0, 10)}T00:00:00`,
      s.settings.timezone,
    ).getTime();
    const overlap = (from: string, to: string) =>
      Math.max(
        0,
        Math.min(end, Date.parse(to)) - Math.max(start, Date.parse(from)),
      ) / 60000;
    const completed = s.commitments.filter(
      (c) => c.status === "done" && c.completed_at && inDay(c.completed_at),
    );
    const unresolved = s.commitments.filter(
      (c) => !["done", "cancelled"].includes(c.status),
    );
    const baseline = s.commitments.reduce((total, c) => {
      const h = c.metadata.planned_minutes_by_day as
        Record<string, unknown> | undefined;
      return (
        total + (h && Number.isFinite(Number(h[day])) ? Number(h[day]) : 0)
      );
    }, 0);
    review = {
      id: s.reviews.find((r) => r.date === day)?.id ?? randomUUID(),
      user_id: userId,
      date: day,
      planned_minutes: Math.max(
        baseline,
        Math.round(
          s.calendar_events
            .filter((e) => e.source === "focus")
            .reduce((a, e) => a + overlap(e.start, e.end), 0),
        ),
      ),
      completed_minutes: Math.round(
        s.sessions.reduce(
          (a, x) => a + overlap(x.started_at, x.ended_at ?? now.toISOString()),
          0,
        ),
      ),
      completed_count: completed.length,
      overdue_count: unresolved.filter(
        (c) => c.deadline && Date.parse(c.deadline) < now.getTime(),
      ).length,
      summary:
        summary.slice(0, 10000) ||
        `${completed.length} commitments completed. ${unresolved.length} commitments remain.`,
      created_at: now.toISOString(),
    };
    s.reviews = s.reviews.filter((r) => r.date !== day);
    s.reviews.unshift(review);
    logActivity(s, "daily_review_saved", day);
  });
  return { state, review };
}
