import type {
  AppState,
  CalendarEvent,
  Commitment,
  TimeWindow,
  UserSettings,
} from "../types";
import {
  addLocalDays,
  dayBounds,
  isValidInstant,
  localDate,
  MINUTE,
  minutesBetween,
  zonedDate,
} from "./time";

type Interval = { start: number; end: number };
export function hasFocusRecovery(event: CalendarEvent): boolean {
  return event.source === "focus" && !event.id.startsWith("tracked-running-");
}
function unionMinutes(intervals: Interval[]): number {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end)
      last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged.reduce(
    (sum, interval) => sum + (interval.end - interval.start) / MINUTE,
    0,
  );
}
function localInterval(
  day: string,
  start: string,
  end: string,
  timezone: string,
): Interval {
  return {
    start: zonedDate(day, start, timezone).getTime(),
    end: zonedDate(
      end <= start ? addLocalDays(day, 1) : day,
      end,
      timezone,
    ).getTime(),
  };
}
function subtract(windows: Interval[], busy: Interval): Interval[] {
  return windows.flatMap((window) => {
    if (busy.end <= window.start || busy.start >= window.end) return [window];
    return [
      { start: window.start, end: Math.min(window.end, busy.start) },
      { start: Math.max(window.start, busy.end), end: window.end },
    ].filter((part) => part.end > part.start);
  });
}

/** Real free working windows, clipped to now and capped by the daily deep-work budget. */
export function calculateAvailableTime(
  day: string,
  settings: UserSettings,
  events: CalendarEvent[],
  now = new Date(),
): TimeWindow[] {
  const [dayStart, dayEnd] = dayBounds(day, settings.timezone);
  const floor = Math.max(dayStart.getTime(), now.getTime());
  if (floor >= dayEnd.getTime()) return [];
  let windows: Interval[] = [];
  // The preceding workday can cross midnight into this calendar date.
  for (const startDay of [addLocalDays(day, -1), day]) {
    const work = localInterval(
      startDay,
      settings.workday_start,
      settings.workday_end,
      settings.timezone,
    );
    const interval = {
      start: Math.max(work.start, floor),
      end: Math.min(work.end, dayEnd.getTime()),
    };
    if (interval.end > interval.start) windows.push(interval);
  }
  for (const startDay of [addLocalDays(day, -1), day]) {
    if (settings.sleep_start !== settings.sleep_end)
      windows = subtract(
        windows,
        localInterval(
          startDay,
          settings.sleep_start,
          settings.sleep_end,
          settings.timezone,
        ),
      );
    for (const meal of settings.meal_blocks)
      if (meal.start !== meal.end)
        windows = subtract(
          windows,
          localInterval(startDay, meal.start, meal.end, settings.timezone),
        );
  }
  const focusIntervals: Interval[] = [];
  for (const event of events) {
    if (!isValidInstant(event.start) || !isValidInstant(event.end)) continue;
    const busy = { start: Date.parse(event.start), end: Date.parse(event.end) };
    if (busy.end <= busy.start) continue;
    windows = subtract(windows, busy);
    if (hasFocusRecovery(event) && settings.break_minutes > 0)
      windows = subtract(windows, {
        start: busy.end,
        end: busy.end + settings.break_minutes * MINUTE,
      });
    if (event.source === "focus")
      focusIntervals.push({
        start: Math.max(busy.start, dayStart.getTime()),
        end: Math.min(busy.end, dayEnd.getTime()),
      });
  }
  windows.sort((a, b) => a.start - b.start);
  // Past focus time still consumes today's budget; hard events never consume deep-work allowance.
  let remaining = Math.max(
    0,
    settings.max_deep_work_minutes - unionMinutes(focusIntervals),
  );
  return windows.flatMap((window) => {
    const minutes = Math.min((window.end - window.start) / MINUTE, remaining);
    remaining -= minutes;
    return minutes >= 1
      ? [
          {
            start: new Date(window.start).toISOString(),
            end: new Date(window.start + minutes * MINUTE).toISOString(),
          },
        ]
      : [];
  });
}

export function scheduledEvents(
  commitments: Commitment[],
  existing: CalendarEvent[],
  userId: string,
  excludeId?: string,
): CalendarEvent[] {
  const events = [
    ...existing.filter(
      (event) =>
        !(event.source === "focus" && event.commitment_id === excludeId),
    ),
  ];
  for (const c of commitments) {
    if (
      c.id === excludeId ||
      c.metadata.needs_review === true ||
      ["done", "cancelled", "waiting", "blocked"].includes(c.status) ||
      !isValidInstant(c.scheduled_start) ||
      !isValidInstant(c.scheduled_end)
    )
      continue;
    if (
      events.some(
        (event) =>
          event.source === "focus" &&
          event.commitment_id === c.id &&
          event.start === c.scheduled_start,
      )
    )
      continue;
    events.push({
      id: `reservation-${c.id}`,
      user_id: userId,
      title: c.title,
      start: c.scheduled_start,
      end: c.scheduled_end,
      source: "focus",
      commitment_id: c.id,
      external_id: null,
    });
  }
  return events;
}

/** Virtual actual-work intervals affect capacity without being written to the calendar. */
export function workspaceEvents(
  state: AppState,
  now = new Date(),
  excludeId?: string,
): CalendarEvent[] {
  const events = scheduledEvents(
    state.commitments,
    state.calendar_events,
    state.user_id,
  ).flatMap((event) => {
    if (
      event.source !== "focus" ||
      event.commitment_id !== excludeId ||
      !excludeId
    )
      return [event];
    if (Date.parse(event.start) >= now.getTime()) return [];
    if (Date.parse(event.end) <= now.getTime()) return [event];
    // Risk excludes this task's future reservation but keeps elapsed productive time.
    return [
      { ...event, id: `tracked-running-${event.id}`, end: now.toISOString() },
    ];
  });
  for (const session of state.sessions) {
    if (
      !isValidInstant(session.started_at) ||
      (session.ended_at && !isValidInstant(session.ended_at))
    )
      continue;
    const end = Math.min(
      now.getTime(),
      session.ended_at ? Date.parse(session.ended_at) : now.getTime(),
    );
    if (end <= Date.parse(session.started_at)) continue;
    const c = state.commitments.find(
      (item) => item.id === session.commitment_id,
    );
    events.push({
      id: `${session.ended_at ? "tracked-session-" : "tracked-running-"}${session.id}`,
      user_id: state.user_id,
      title: c?.title ?? "Tracked focus",
      start: session.started_at,
      end: new Date(end).toISOString(),
      source: "focus",
      commitment_id: session.commitment_id,
      external_id: null,
    });
  }
  return events;
}

/** Capacity includes allocated future focus; only actual past focus consumes the remaining budget. */
export function totalWorkCapacity(
  day: string,
  settings: UserSettings,
  events: CalendarEvent[],
  now = new Date(),
): number {
  const elapsedEvents = events.flatMap((event) =>
    event.source !== "focus"
      ? [event]
      : Date.parse(event.start) < now.getTime()
        ? [
            {
              ...event,
              end: new Date(
                Math.min(Date.parse(event.end), now.getTime()),
              ).toISOString(),
            },
          ]
        : [],
  );
  const recoveryEvents: CalendarEvent[] =
    settings.break_minutes > 0
      ? events
          .filter(
            (event) => hasFocusRecovery(event) && isValidInstant(event.end),
          )
          .map((event) => ({
            ...event,
            id: `recovery-${event.id}`,
            title: "Recovery break",
            start: event.end,
            end: new Date(
              Date.parse(event.end) + settings.break_minutes * MINUTE,
            ).toISOString(),
            source: "local",
            commitment_id: null,
            external_id: null,
          }))
      : [];
  // Clipping elapsed focus to now must not create a recovery break in the middle of a running block.
  return calculateAvailableTime(
    day,
    { ...settings, break_minutes: 0 },
    [...elapsedEvents, ...recoveryEvents],
    now,
  ).reduce((sum, window) => sum + minutesBetween(window.start, window.end), 0);
}

export function availableBeforeDeadline(
  deadline: Date,
  settings: UserSettings,
  events: CalendarEvent[],
  now = new Date(),
): number {
  if (deadline <= now) return 0;
  let day = localDate(now, settings.timezone);
  const lastDay = localDate(deadline, settings.timezone);
  let available = 0;
  // A bounded horizon protects the API from accidental dates decades in the future.
  for (
    let index = 0;
    index < 366 && day <= lastDay;
    index++, day = addLocalDays(day, 1)
  ) {
    available += calculateAvailableTime(day, settings, events, now).reduce(
      (total, window) =>
        total +
        minutesBetween(
          window.start,
          new Date(Math.min(Date.parse(window.end), deadline.getTime())),
        ),
      0,
    );
  }
  return available;
}
