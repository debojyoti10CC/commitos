import type {
  AppState,
  CalendarEvent,
  Commitment,
  DailyPlan,
  PlanBlock,
} from "../types";
import {
  calculateAvailableTime,
  hasFocusRecovery,
  totalWorkCapacity,
  workspaceEvents,
} from "./capacity";
import {
  calculateRemainingEffort,
  calculateRiskScore,
  dependencyIds,
  needsInterpretationReview,
} from "../risk/engine";
import { dayBounds, isValidInstant, MINUTE, minutesBetween } from "./time";

/** Earliest-deadline/risk planning, with hard events, dependency order, split blocks, breaks and deadline buffers. */
export function generateDailyPlan(
  state: AppState,
  day: string,
  now = new Date(),
): DailyPlan {
  const [startOfDay, endOfDay] = dayBounds(day, state.settings.timezone);
  const floor = Math.max(startOfDay.getTime(), now.getTime());
  const blocks: PlanBlock[] = [];
  const unscheduled: DailyPlan["unscheduled"] = [];
  const active = state.commitments.filter(
    (c) =>
      !needsInterpretationReview(c) &&
      !["done", "cancelled", "waiting"].includes(c.status),
  );
  const remaining = new Map(
    active.map((c) => [c.id, calculateRemainingEffort(c)]),
  );
  let reservations = workspaceEvents(state, now);
  const known = new Map(active.map((c) => [c.id, c]));
  const fixed: CalendarEvent[] = reservations.filter(
    (event) =>
      event.source === "focus" &&
      event.commitment_id &&
      known.has(event.commitment_id),
  );
  const hardWindows = calculateAvailableTime(
    day,
    { ...state.settings, max_deep_work_minutes: 2880 },
    reservations.filter((event) => event.source !== "focus"),
    now,
  );
  const preserved = new Map<string, CalendarEvent>();
  let reservedBudget = totalWorkCapacity(
    day,
    state.settings,
    reservations,
    now,
  );
  const dependencyEnds = new Map<string, number>();
  for (const c of state.commitments)
    if (c.status === "done") dependencyEnds.set(c.id, floor);
  for (const event of fixed.sort((a, b) => a.start.localeCompare(b.start))) {
    const c = known.get(event.commitment_id!);
    if (
      !c ||
      c.status === "blocked" ||
      !isValidInstant(event.start) ||
      !isValidInstant(event.end)
    )
      continue;
    const start = Math.max(floor, Date.parse(event.start));
    const end = Math.min(endOfDay.getTime(), Date.parse(event.end));
    if (end <= start) continue;
    const minutes = Math.min(
      remaining.get(c.id) ?? 0,
      (end - start) / MINUTE,
      reservedBudget,
    );
    if (minutes <= 0) continue;
    const effectiveEnd = start + minutes * MINUTE;
    const latest = c.deadline
      ? Date.parse(c.deadline) -
        Math.min(15, calculateRemainingEffort(c) / 4) * MINUTE
      : endOfDay.getTime();
    const fitsHardWindow = hardWindows.some(
      (window) =>
        Date.parse(window.start) <= start &&
        Date.parse(window.end) >= effectiveEnd,
    );
    const conflict = blocks.some(
      (block) =>
        Date.parse(block.start) < effectiveEnd &&
        Date.parse(block.end) + state.settings.break_minutes * MINUTE > start,
    );
    const recoveringFromPastFocus = reservations.some(
      (previous) =>
        previous.id !== event.id &&
        hasFocusRecovery(previous) &&
        Date.parse(previous.end) <= floor &&
        Date.parse(previous.end) + state.settings.break_minutes * MINUTE >
          start,
    );
    const unresolvedDependency = dependencyIds(c).some(
      (id) =>
        !dependencyEnds.has(id) || (dependencyEnds.get(id) ?? floor) > start,
    );
    if (
      !fitsHardWindow ||
      conflict ||
      recoveringFromPastFocus ||
      unresolvedDependency ||
      effectiveEnd > latest ||
      (c.snoozed_until && Date.parse(c.snoozed_until) > start)
    )
      continue;
    blocks.push({
      commitment_id: c.id,
      title: c.title,
      start: new Date(start).toISOString(),
      end: new Date(start + minutes * MINUTE).toISOString(),
      minutes,
    });
    preserved.set(event.id, {
      ...event,
      end: new Date(effectiveEnd).toISOString(),
    });
    reservedBudget -= minutes;
    remaining.set(c.id, Math.max(0, (remaining.get(c.id) ?? 0) - minutes));
    if (remaining.get(c.id) === 0)
      dependencyEnds.set(c.id, start + minutes * MINUTE);
  }
  // Invalidated reservations are released so a calendar change can produce a new executable plan.
  reservations = reservations.flatMap((event) =>
    preserved.has(event.id)
      ? [preserved.get(event.id)!]
      : event.source !== "focus" ||
          !event.commitment_id ||
          !known.has(event.commitment_id) ||
          Date.parse(event.end) <= floor
        ? [event]
        : Date.parse(event.start) < floor
          ? [{ ...event, end: new Date(floor).toISOString() }]
          : [],
  );
  // Keep the entire day's free windows; enforce productive effort separately so breaks
  // do not prematurely truncate the windows before later afternoon capacity.
  let windows = calculateAvailableTime(
    day,
    { ...state.settings, max_deep_work_minutes: 2880 },
    reservations,
    now,
  ).map((window) => ({
    start: Date.parse(window.start),
    end: Date.parse(window.end),
  }));
  let capacityMinutes = Math.round(
    totalWorkCapacity(day, state.settings, reservations, now),
  );
  let focusBudget = Math.max(
    0,
    capacityMinutes - blocks.reduce((sum, block) => sum + block.minutes, 0),
  );
  const dueToday = active.filter(
    (c) => c.deadline && Date.parse(c.deadline) < endOfDay.getTime(),
  );
  const requiredMinutes = dueToday.reduce(
    (sum, c) => sum + calculateRemainingEffort(c),
    0,
  );
  const dueTier = (c: Commitment) =>
    c.deadline && Date.parse(c.deadline) < endOfDay.getTime() ? 0 : 1;
  const ranked = active
    .map((c) => ({ c, risk: calculateRiskScore(c, state, now).score }))
    .sort(
      (a, b) =>
        Number(b.c.status === "in_progress") -
          Number(a.c.status === "in_progress") ||
        dueTier(a.c) - dueTier(b.c) ||
        b.risk - a.risk ||
        (a.c.deadline ?? "9999").localeCompare(b.c.deadline ?? "9999"),
    );
  const pending = ranked.map((item) => item.c);
  // Complete prerequisite planning before considering dependent work, even if it ranks lower.
  for (let pass = 0; pass <= active.length && pending.length; pass++) {
    let progressed = false;
    for (let index = 0; index < pending.length;) {
      const c = pending[index];
      if (
        c.status === "blocked" ||
        (c.snoozed_until && Date.parse(c.snoozed_until) >= endOfDay.getTime())
      ) {
        unscheduled.push({
          commitment_id: c.id,
          minutes: remaining.get(c.id) ?? 0,
          reason:
            c.status === "blocked"
              ? "Blocked: resolve the obstacle before planning."
              : "Snoozed beyond this day.",
        });
        pending.splice(index, 1);
        progressed = true;
        continue;
      }
      const dependencies = dependencyIds(c);
      if (dependencies.some((id) => !dependencyEnds.has(id))) {
        index++;
        continue;
      }
      let readyAt = dependencies.reduce(
        (max, id) => Math.max(max, dependencyEnds.get(id) ?? floor),
        floor,
      );
      if (c.snoozed_until)
        readyAt = Math.max(readyAt, Date.parse(c.snoozed_until));
      let todo = remaining.get(c.id) ?? 0;
      const buffer = Math.min(15, Math.max(0, todo / 4));
      const latest = c.deadline
        ? Math.min(endOfDay.getTime(), Date.parse(c.deadline) - buffer * MINUTE)
        : endOfDay.getTime();
      let lastEnd = readyAt;
      for (
        let windowIndex = 0;
        windowIndex < windows.length && todo > 0 && focusBudget > 0;
        windowIndex++
      ) {
        const window = windows[windowIndex];
        let start = Math.max(window.start, readyAt);
        const limit = Math.min(window.end, latest);
        while (todo > 0 && start < limit && focusBudget > 0) {
          const available = (limit - start) / MINUTE;
          if (available < Math.min(15, todo)) break;
          const minutes = Math.min(
            todo,
            available,
            focusBudget,
            Math.max(15, state.settings.focus_block_minutes),
          );
          const end = start + minutes * MINUTE;
          blocks.push({
            commitment_id: c.id,
            title: c.title,
            start: new Date(start).toISOString(),
            end: new Date(end).toISOString(),
            minutes,
          });
          todo = Math.max(0, todo - minutes);
          focusBudget = Math.max(0, focusBudget - minutes);
          lastEnd = end;
          // Breaks reserve calendar time without pretending they are productive effort.
          const recoveryEnd =
            end + Math.max(0, state.settings.break_minutes) * MINUTE;
          window.start = Math.min(window.end, recoveryEnd);
          for (const following of windows.slice(windowIndex + 1))
            if (following.start < recoveryEnd && following.end > end)
              following.start = Math.min(
                following.end,
                Math.max(following.start, recoveryEnd),
              );
          start = window.start;
        }
      }
      remaining.set(c.id, todo);
      if (todo === 0) dependencyEnds.set(c.id, lastEnd);
      else
        unscheduled.push({
          commitment_id: c.id,
          minutes: Math.ceil(todo),
          reason:
            latest <= floor
              ? "Deadline is overdue or inside the safety buffer. Renegotiate it."
              : "Insufficient free time before the deadline, after breaks and buffers.",
        });
      pending.splice(index, 1);
      progressed = true;
    }
    if (!progressed) break;
  }
  for (const c of pending)
    unscheduled.push({
      commitment_id: c.id,
      minutes: remaining.get(c.id) ?? 0,
      reason: "Dependency is unfinished, missing, cyclic, or cannot fit today.",
    });
  windows = windows.filter((window) => window.end > window.start);
  blocks.sort((a, b) => a.start.localeCompare(b.start));
  const finalEvents = [...reservations];
  for (const [index, block] of blocks.entries())
    if (
      !finalEvents.some(
        (event) =>
          event.source === "focus" &&
          event.commitment_id === block.commitment_id &&
          event.start === block.start &&
          event.end === block.end,
      )
    )
      finalEvents.push({
        id: `proposed-${index}`,
        user_id: state.user_id,
        title: block.title,
        start: block.start,
        end: block.end,
        source: "focus",
        commitment_id: block.commitment_id,
        external_id: null,
      });
  capacityMinutes = Math.round(
    totalWorkCapacity(day, state.settings, finalEvents, now),
  );
  const dueUnscheduled = unscheduled
    .filter((item) => dueToday.some((c) => c.id === item.commitment_id))
    .reduce((sum, item) => sum + item.minutes, 0);
  return {
    blocks,
    unscheduled: unscheduled.filter((item) => item.minutes > 0),
    capacityMinutes,
    requiredMinutes,
    deficitMinutes: Math.max(
      0,
      Math.round(requiredMinutes - capacityMinutes),
      Math.ceil(dueUnscheduled),
    ),
  };
}
