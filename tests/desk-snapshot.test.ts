import { describe, expect, it } from "vitest";
import { buildDeskSnapshot } from "@/lib/device/snapshot";
import { createSeedState } from "@/lib/seed";
import { zonedDate } from "@/lib/scheduling/time";
import type { AppState, Commitment } from "@/lib/types";

const day = "2026-10-05";
const timezone = "Asia/Kolkata";
const at = (clock: string) => zonedDate(day, clock, timezone).toISOString();
const now = new Date(at("11:00"));
function state(): AppState {
  const s = createSeedState("desk-test", now);
  return {
    ...s,
    commitments: [],
    sessions: [],
    calendar_events: [],
    reminders: [],
    activity: [],
    settings: {
      ...s.settings,
      timezone,
      workday_start: "09:00",
      workday_end: "22:00",
      meal_blocks: [],
      max_deep_work_minutes: 360,
      break_minutes: 10,
      focus_block_minutes: 50,
    },
  };
}
function c(id: string, patch: Partial<Commitment> = {}): Commitment {
  return {
    ...createSeedState("desk-test", now).commitments[0],
    id,
    title: `Task ${id}`,
    project: null,
    status: "inbox",
    deadline: null,
    check_in_at: null,
    estimated_minutes: 120,
    completed_minutes: 0,
    remaining_minutes: 120,
    started_at: null,
    scheduled_start: null,
    scheduled_end: null,
    contact_name: null,
    organization: null,
    priority: "medium",
    metadata: {},
    ...patch,
  };
}
function running(s: AppState, commitment: Commitment, start = at("10:30")) {
  commitment.status = "in_progress";
  s.sessions.push({
    id: "current-session",
    user_id: s.user_id,
    commitment_id: commitment.id,
    started_at: start,
    ended_at: null,
    duration_minutes: 0,
    notes: "",
  });
}

describe("Bounded desk snapshots", () => {
  it("pins active focus, derives live remaining work and progress, and does not mutate input", () => {
    const s = state();
    const active = c("active");
    s.commitments = [
      c("urgent", {
        deadline: at("11:20"),
        priority: "critical",
        remaining_minutes: 60,
      }),
      active,
    ];
    running(s, active);
    const before = JSON.stringify(s);
    const snapshot = buildDeskSnapshot(s, now);
    expect(snapshot.now?.id).toBe("active");
    expect(snapshot.now?.remaining_minutes).toBe(90);
    expect(snapshot.now?.progress_percent).toBe(25);
    expect(snapshot.timer).toEqual({
      session_id: "current-session",
      commitment_id: "active",
      started_at: at("10:30"),
      elapsed_seconds: 1800,
    });
    expect(snapshot.next[0].id).toBe("urgent");
    expect(JSON.stringify(s)).toBe(before);
    expect(snapshot.server_time).toBe(now.toISOString());
    expect(snapshot.timezone).toBe(timezone);
  });
  it("combines earlier closed progress with only the current resumed session", () => {
    const s = state();
    const active = c("active", {
      completed_minutes: 30,
      remaining_minutes: 90,
      started_at: at("09:00"),
    });
    s.commitments = [active];
    s.sessions.push({
      id: "previous",
      user_id: s.user_id,
      commitment_id: active.id,
      started_at: at("09:00"),
      ended_at: at("09:30"),
      duration_minutes: 30,
      notes: "",
    });
    running(s, active);
    const result = buildDeskSnapshot(s, now);
    expect(result.now?.remaining_minutes).toBe(60);
    expect(result.now?.progress_percent).toBe(50);
    expect(result.timer?.elapsed_seconds).toBe(1800);
  });
  it("unions tracked and planned focus when calculating remaining daily capacity", () => {
    const s = state();
    const active = c("active", {
      estimated_minutes: 300,
      remaining_minutes: 300,
    });
    s.commitments = [active];
    running(s, active, at("09:00"));
    s.calendar_events.push({
      id: "planned",
      user_id: s.user_id,
      title: active.title,
      start: at("09:00"),
      end: at("12:00"),
      source: "focus",
      commitment_id: active.id,
      external_id: null,
    });
    const result = buildDeskSnapshot(s, now);
    expect(result.now?.remaining_minutes).toBe(180);
    expect(result.capacity.capacityMinutes).toBe(240);
    expect(result.timer?.elapsed_seconds).toBe(7200);
  });
  it("bounds NEXT to three tasks and advances NOW after completion", () => {
    const s = state();
    s.commitments = Array.from({ length: 8 }, (_, index) =>
      c(String(index), { created_at: `2026-10-01T00:0${index}:00.000Z` }),
    );
    const initial = buildDeskSnapshot(s, now);
    expect(initial.next).toHaveLength(3);
    expect(initial.next.some((task) => task.id === initial.now?.id)).toBe(
      false,
    );
    s.commitments.find((task) => task.id === initial.now!.id)!.status = "done";
    expect(buildDeskSnapshot(s, now).now?.id).toBe(initial.next[0].id);
  });
  it("excludes drafts, snoozed, waiting, blocked and resolved items from the execution queue", () => {
    const s = state();
    s.commitments = [
      c("draft", { metadata: { needs_review: true } }),
      c("snoozed", { snoozed_until: at("12:00") }),
      c("waiting", { status: "waiting" }),
      c("blocked", { status: "blocked" }),
      c("done", { status: "done" }),
      c("cancelled", { status: "cancelled" }),
    ];
    const result = buildDeskSnapshot(s, now);
    expect(result.now).toBeNull();
    expect(result.next).toHaveLength(0);
    expect(result.timer).toBeNull();
    expect(result.risk_counts.total).toBe(3);
  });
  it("returns finite empty capacity and a calm empty state", () => {
    const s = state();
    const result = buildDeskSnapshot(s, new Date(at("23:30")));
    expect(result.now).toBeNull();
    expect(result.capacity).toMatchObject({
      capacityMinutes: 0,
      requiredMinutes: 0,
      deficitMinutes: 0,
      utilization: 0,
      signal: "green",
    });
    expect(JSON.stringify(result)).not.toContain("NaN");
  });
  it("clamps estimated progress without completing the commitment automatically", () => {
    const s = state();
    const active = c("active", {
      estimated_minutes: 20,
      remaining_minutes: 20,
    });
    s.commitments = [active];
    running(s, active);
    const result = buildDeskSnapshot(s, now);
    expect(result.now?.remaining_minutes).toBe(0);
    expect(result.now?.progress_percent).toBe(100);
    expect(result.now?.status).toBe("in_progress");
  });
  it("does not credit future or orphaned open sessions", () => {
    const s = state();
    s.commitments = [c("task")];
    s.sessions = [
      {
        id: "future",
        user_id: s.user_id,
        commitment_id: "task",
        started_at: at("12:00"),
        ended_at: null,
        duration_minutes: 0,
        notes: "",
      },
      {
        id: "orphan",
        user_id: s.user_id,
        commitment_id: "missing",
        started_at: at("09:00"),
        ended_at: null,
        duration_minutes: 0,
        notes: "",
      },
    ];
    const result = buildDeskSnapshot(s, now);
    expect(result.timer).toBeNull();
    expect(result.now?.remaining_minutes).toBe(120);
  });
  it("uses green, yellow, red and flashing red for current and imminent workload", () => {
    const s = state();
    expect(buildDeskSnapshot(s, now).capacity.signal).toBe("green");
    s.commitments = [
      c("attention", {
        remaining_minutes: 30,
        estimated_minutes: 30,
        deadline: at("22:00"),
        priority: "medium",
      }),
    ];
    expect(buildDeskSnapshot(s, now).capacity.signal).toBe("yellow");
    s.commitments = [
      c("high", {
        remaining_minutes: 120,
        deadline: at("15:00"),
        priority: "critical",
      }),
    ];
    expect(buildDeskSnapshot(s, now).capacity.signal).toBe("red");
    s.commitments = [
      c("impossible", {
        remaining_minutes: 120,
        deadline: at("11:20"),
        priority: "critical",
      }),
    ];
    expect(buildDeskSnapshot(s, now).capacity.signal).toBe("flashing_red");
  });
  it("does not flash for a distant impossible project when today remains manageable", () => {
    const s = state();
    s.commitments = [
      c("distant", {
        remaining_minutes: 20000,
        deadline: "2026-11-05T15:30:00.000Z",
        priority: "critical",
      }),
    ];
    const result = buildDeskSnapshot(s, now);
    expect(result.risk_counts.impossible).toBe(1);
    expect(result.risk_counts.near_impossible).toBe(0);
    expect(result.capacity.signal).toBe("green");
  });
  it("omits secrets, contacts, metadata and the full backlog from its wire payload", () => {
    const s = state();
    s.commitments = [
      c("task", {
        metadata: { private_token: "never-send-this" },
        contact_name: "Private Person",
        description: "Private description",
      }),
    ];
    const json = JSON.stringify(buildDeskSnapshot(s, now));
    expect(json).not.toContain("never-send-this");
    expect(json).not.toContain("Private Person");
    expect(json).not.toContain("Private description");
    expect(json).not.toContain("contacts");
    expect(json).not.toContain("commitments");
  });
});
