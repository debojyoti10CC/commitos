import { describe, expect, it, vi } from "vitest";
import {
  deterministicParse,
  normalizeNaturalDate,
  parseCommitment,
  GeminiProvider,
} from "../lib/ai/provider";
import { ParsedCommitmentSchema } from "../lib/ai/schema";
import { defaultSettings, createSeedState } from "../lib/seed";
import {
  calculateAvailableTime,
  totalWorkCapacity,
  workspaceEvents,
} from "../lib/scheduling/capacity";
import { generateDailyPlan } from "../lib/scheduling/planner";
import {
  briefing,
  calculateRiskScore,
  rankCommitments,
} from "../lib/risk/engine";
import { generateReminderSchedule } from "../lib/notifications/rules";
import { minutesBetween, zonedDate } from "../lib/scheduling/time";
import type { AppState, CalendarEvent, Commitment } from "../lib/types";

const now = new Date("2026-10-05T03:30:00Z"); // Monday 09:00 in Kolkata.
const day = "2026-10-05";
describe("named calendar dates and spoken midnight", () => {
  it.each(["tmrw", "tmr"])("resolves conventional %s shorthand in the user's timezone", (word) => {
    const result = normalizeNaturalDate(`Submit before 10 AM ${word}`, { now: new Date("2026-10-06T16:02:00Z"), timezone: "Asia/Kolkata" });
    expect(result.date).toBe("2026-10-07T04:30:00.000Z");
    expect(result.warnings).toEqual([]);
    expect(normalizeNaturalDate(`${word}land`, { now, timezone: "Asia/Kolkata" }).date).toBeNull();
  });
  it.each([
    "IIT submission assignment by 10th October 12 a.m. and I need to get an update",
    "Submit by 10 October at 12 AM",
    "Submit by tenth October at twelve a.m.",
    "Submit by the tenth of October at twelve a.m.",
    "Submit by October 10th at 12 a.m.",
    "Submit by October tenth at twelve a.m.",
    "Submit by 10th October 2026 12 a.m.",
    "Submit by October 10, 2026 at 12 AM",
  ])("keeps October 10 as the date in %s", (text) => {
    expect(normalizeNaturalDate(text, { now, timezone: "Asia/Kolkata" }).date)
      .toBe("2026-10-09T18:30:00.000Z");
  });

  it("keeps the date number out of a separate inferred clock", () => {
    const result = normalizeNaturalDate("Submit by 10 October at 9 PM", { now, timezone: "Asia/Kolkata" });
    expect(result.date).toBe("2026-10-10T15:30:00.000Z");
    expect(result.warnings.some((warning) => /AM\/PM/.test(warning))).toBe(false);
  });

  it("does not use a clock after a month name as a day of the month", () => {
    const result = normalizeNaturalDate("Submit in October 12 a.m.", { now, timezone: "Asia/Kolkata" });
    expect(result.date).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
const at = (clock: string) =>
  zonedDate(day, clock, "Asia/Kolkata").toISOString();
function state(): AppState {
  const data = createSeedState("test-user", now);
  return {
    ...data,
    commitments: [],
    calendar_events: [],
    reminders: [],
    sessions: [],
    settings: {
      ...defaultSettings(),
      workday_end: "18:00",
      max_deep_work_minutes: 480,
      meal_blocks: [{ start: "13:00", end: "14:00", label: "Lunch" }],
      break_minutes: 10,
      focus_block_minutes: 50,
    },
  };
}
function task(id: string, extra: Partial<Commitment> = {}): Commitment {
  return {
    ...createSeedState("test-user", now).commitments[0],
    id,
    status: "inbox",
    project: null,
    contact_name: null,
    organization: null,
    deadline: at("18:00"),
    check_in_at: null,
    estimated_minutes: 60,
    completed_minutes: 0,
    remaining_minutes: 60,
    scheduled_start: null,
    scheduled_end: null,
    priority: "medium",
    metadata: {},
    ...extra,
  };
}
function event(
  id: string,
  start: string,
  end: string,
  source: CalendarEvent["source"] = "local",
  commitmentId: string | null = null,
): CalendarEvent {
  return {
    id,
    user_id: "test-user",
    title: id,
    start: at(start),
    end: at(end),
    source,
    commitment_id: commitmentId,
    external_id: null,
  };
}
const total = (windows: { start: string; end: string }[]) =>
  windows.reduce(
    (sum, window) => sum + minutesBetween(window.start, window.end),
    0,
  );

describe("Timezone-aware natural language capture", () => {
  it("resolves local tomorrow at a UTC date boundary", () => {
    const result = normalizeNaturalDate("tomorrow morning", {
      now: new Date("2026-10-06T01:00:00Z"),
      timezone: "America/Los_Angeles",
    });
    expect(result.date).toBe("2026-10-06T16:00:00.000Z");
    expect(result.inferred).toBe(true);
  });
  it("keeps relative deadlines separate from effort", () => {
    const parsed = deterministicParse(
      "Finish API in two hours, takes 30 minutes",
      { now, timezone: "Asia/Kolkata" },
    );
    expect(parsed.deadline).toBe("2026-10-05T05:30:00.000Z");
    expect(parsed.estimatedMinutes).toBe(30);
  });
  it("parses the acceptance example, delivery and intermediate update", () => {
    const parsed = deterministicParse(
      "Finish HydraDB video tonight by 9. Need to send them an update around 6. Will probably take two hours.",
      {
        now: new Date("2026-10-05T04:30:00Z"),
        timezone: "Asia/Kolkata",
        projects: ["HydraDB"],
      },
    );
    expect(parsed.title).toBe("Finish HydraDB video");
    expect(parsed.project).toBe("HydraDB");
    expect(parsed.deadline).toBe(at("21:00"));
    expect(parsed.checkInAt).toBe(at("18:00"));
    expect(parsed.estimatedMinutes).toBe(120);
    expect(parsed.inferredFields).toContain("checkInAt");
  });
  it("parses compact effort and a named contact", () => {
    const parsed = deterministicParse(
      "Finish Soleil demo tonight by 11, probably 3h and send Ayush an update at 8.",
      {
        now: new Date("2026-10-05T11:30:00Z"),
        timezone: "Asia/Kolkata",
        projects: ["Soleil"],
      },
    );
    expect(parsed.deadline).toBe(at("23:00"));
    expect(parsed.checkInAt).toBe(at("20:00"));
    expect(parsed.contactName).toBe("Ayush");
    expect(parsed.estimatedMinutes).toBe(180);
    expect(
      deterministicParse("Build demo tomorrow 2h30m", {
        now,
        timezone: "Asia/Kolkata",
      }).estimatedMinutes,
    ).toBe(150);
  });
  it("does not invent a class time or reinterpret a single update as a separate check-in", () => {
    expect(
      normalizeNaturalDate("finish before class", {
        now,
        timezone: "Asia/Kolkata",
      }).date,
    ).toBeNull();
    const parsed = deterministicParse(
      "Send Ayush an update tomorrow at 5 PM 15 min",
      { now, timezone: "Asia/Kolkata" },
    );
    expect(parsed.checkInAt).toBeNull();
    expect(parsed.deadline).toBe("2026-10-06T11:30:00.000Z");
  });
  it("rejects nonexistent dates and daylight-saving wall times", () => {
    expect(
      normalizeNaturalDate("2026-02-31 at 9 AM", {
        now,
        timezone: "Asia/Kolkata",
      }).date,
    ).toBeNull();
    expect(
      normalizeNaturalDate("2026-03-08 at 02:30", {
        now: new Date("2026-03-07T12:00:00Z"),
        timezone: "America/New_York",
      }).date,
    ).toBeNull();
  });
  it("resolves next Friday and surfaces the interpretation", () => {
    const result = normalizeNaturalDate("next Friday by evening", {
      now,
      timezone: "Asia/Kolkata",
    });
    expect(result.date).toBe("2026-10-09T12:30:00.000Z");
    expect(result.warnings.length).toBeGreaterThan(0);
  });
  it("validates timestamps from AI rather than trusting raw JSON", () => {
    const parsed = deterministicParse("Finish report tomorrow 30 minutes", {
      now,
      timezone: "Asia/Kolkata",
    });
    expect(
      ParsedCommitmentSchema.safeParse({ ...parsed, deadline: "tomorrow" })
        .success,
    ).toBe(false);
    expect(
      ParsedCommitmentSchema.safeParse({ ...parsed, confidence: 2 }).success,
    ).toBe(false);
  });
  it("rejects invalid Gemini output", async () => {
    const mock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            { content: { parts: [{ text: '{"title":"invalid"}' }] } },
          ],
        }),
      });
    vi.stubGlobal("fetch", mock);
    await expect(
      new GeminiProvider("test-key").parse("Finish report tomorrow", {
        now,
        timezone: "Asia/Kolkata",
      }),
    ).rejects.toThrow();
    vi.unstubAllGlobals();
  });
  it("works without credentials", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const result = await parseCommitment(
      "Submit report tomorrow morning 15 min",
      { now, timezone: "Asia/Kolkata" },
    );
    expect(result.provider).toBe("deterministic");
    expect(result.parsed.estimatedMinutes).toBe(15);
    vi.unstubAllEnvs();
  });
});

describe("Real capacity", () => {
  it("subtracts overlapping hard events once and preserves the meal break", () => {
    const data = state();
    const windows = calculateAvailableTime(
      day,
      data.settings,
      [event("a", "10:00", "11:00"), event("b", "10:30", "12:00")],
      now,
    );
    expect(total(windows)).toBe(360);
    expect(windows).toHaveLength(3);
  });
  it("clips past time and caps daily deep work including reserved focus", () => {
    const data = state();
    data.settings.max_deep_work_minutes = 240;
    expect(total(calculateAvailableTime(day, data.settings, [], now))).toBe(
      240,
    );
    expect(
      total(
        calculateAvailableTime(
          day,
          data.settings,
          [event("focus", "09:00", "10:00", "focus", "a")],
          new Date(at("10:00")),
        ),
      ),
    ).toBe(180);
    expect(
      total(
        calculateAvailableTime(day, data.settings, [], new Date(at("17:00"))),
      ),
    ).toBe(60);
  });
  it("avoids sleep even with an overnight workday", () => {
    const data = state();
    Object.assign(data.settings, {
      workday_start: "20:00",
      workday_end: "04:00",
      sleep_start: "23:00",
      sleep_end: "07:00",
      meal_blocks: [],
      max_deep_work_minutes: 600,
    });
    expect(total(calculateAvailableTime(day, data.settings, [], now))).toBe(
      180,
    );
  });
  it("uses real elapsed minutes on a daylight-saving transition", () => {
    const data = state();
    Object.assign(data.settings, {
      timezone: "America/New_York",
      workday_start: "00:00",
      workday_end: "04:00",
      sleep_start: "00:00",
      sleep_end: "00:00",
      meal_blocks: [],
      max_deep_work_minutes: 600,
    });
    expect(
      total(
        calculateAvailableTime(
          "2026-03-08",
          data.settings,
          [],
          new Date("2026-03-07T00:00:00Z"),
        ),
      ),
    ).toBe(180);
  });
  it("deducts tracked manual work from the daily budget without a calendar reservation", () => {
    const data = state();
    data.settings.max_deep_work_minutes = 360;
    data.sessions = [
      {
        id: "manual-work",
        user_id: data.user_id,
        commitment_id: "old",
        started_at: at("09:00"),
        ended_at: at("11:00"),
        duration_minutes: 120,
        notes: "",
      },
    ];
    const later = new Date(at("11:00"));
    expect(
      totalWorkCapacity(
        day,
        data.settings,
        workspaceEvents(data, later),
        later,
      ),
    ).toBe(240);
    expect(generateDailyPlan(data, day, later).capacityMinutes).toBe(240);
    expect(briefing(data, later)).toContain("Available work time: 4h");
  });
  it("unions tracked work with its planned reservation instead of double-counting effort", () => {
    const data = state();
    data.settings.max_deep_work_minutes = 360;
    data.calendar_events = [
      event("old-focus", "09:00", "11:00", "focus", "old"),
    ];
    data.sessions = [
      {
        id: "manual-work",
        user_id: data.user_id,
        commitment_id: "old",
        started_at: at("09:00"),
        ended_at: at("11:00"),
        duration_minutes: 120,
        notes: "",
      },
    ];
    const later = new Date(at("11:00"));
    expect(
      totalWorkCapacity(
        day,
        data.settings,
        workspaceEvents(data, later),
        later,
      ),
    ).toBe(240);
    expect(
      total(
        calculateAvailableTime(
          day,
          data.settings,
          workspaceEvents(data, later),
          later,
        ),
      ),
    ).toBe(240);
  });
  it("keeps elapsed active work in risk capacity while excluding its future reservation", () => {
    const data = state();
    data.settings.max_deep_work_minutes = 360;
    const c = task("running", {
      status: "in_progress",
      scheduled_start: at("09:00"),
      scheduled_end: at("12:00"),
      remaining_minutes: 300,
      deadline: at("18:00"),
    });
    data.commitments = [c];
    data.calendar_events = [
      event("current-focus", "09:00", "12:00", "focus", c.id),
    ];
    data.sessions = [
      {
        id: "active",
        user_id: data.user_id,
        commitment_id: c.id,
        started_at: at("09:00"),
        ended_at: null,
        duration_minutes: 0,
        notes: "",
      },
    ];
    const later = new Date(at("11:00"));
    const risk = calculateRiskScore(c, data, later);
    expect(risk.availableMinutes).toBe(240);
    expect(risk.level).toBe("impossible");
  });
});

describe("Risk, ranking and execution planning", () => {
  it("detects impossible effort and removes terminal risk", () => {
    const data = state();
    const c = task("a", { estimated_minutes: 600, remaining_minutes: 600 });
    data.commitments = [c];
    const risk = calculateRiskScore(c, data, now);
    expect(risk.level).toBe("impossible");
    expect(risk.score).toBeGreaterThanOrEqual(95);
    expect(risk.pressure).toBeGreaterThan(1);
    expect(calculateRiskScore({ ...c, status: "done" }, data, now).score).toBe(
      0,
    );
  });
  it("explains missed check-ins and blocks waiting, dependency and snoozed recommendations", () => {
    const data = state();
    const c = task("a", { check_in_at: at("08:00") });
    data.commitments = [
      c,
      task("b", { status: "waiting" }),
      task("c", { metadata: { depends_on: ["a"] } }),
      task("d", { snoozed_until: at("12:00") }),
    ];
    expect(calculateRiskScore(c, data, now).explanation.join(" ")).toContain(
      "check-in is overdue",
    );
    expect(rankCommitments(data, now).map((c) => c.id)).toEqual(["a"]);
  });
  it("ranks tonight above a distant overloaded project", () => {
    const data = createSeedState("demo", new Date("2026-10-05T11:30:00Z"));
    expect(
      rankCommitments(data, new Date("2026-10-05T11:30:00Z"))[0].title,
    ).not.toBe("Ship hackathon submission");
  });
  it("keeps an active focus session as the primary Now recommendation", () => {
    const data = state();
    data.commitments = [
      task("urgent", { priority: "critical", remaining_minutes: 500 }),
      task("running", {
        status: "in_progress",
        deadline: null,
        started_at: now.toISOString(),
      }),
    ];
    expect(rankCommitments(data, now)[0].id).toBe("running");
  });
  it("executes today obligations before a distant impossible project", () => {
    const data = state();
    data.settings.max_deep_work_minutes = 40;
    data.commitments = [
      task("future", {
        title: "Friday hackathon",
        deadline: "2026-10-09T18:29:00.000Z",
        remaining_minutes: 1560,
        priority: "critical",
      }),
      task("today", {
        title: "Publish community post",
        remaining_minutes: 30,
        deadline: at("18:00"),
      }),
    ];
    expect(rankCommitments(data, now)[0].id).toBe("today");
    const plan = generateDailyPlan(data, day, now);
    expect(plan.blocks[0].commitment_id).toBe("today");
    expect(
      plan.blocks
        .filter((block) => block.commitment_id === "today")
        .reduce((sum, block) => sum + block.minutes, 0),
    ).toBe(30);
  });
  it("keeps unconfirmed low-confidence captures out of recommendations, schedules and capacity pressure", () => {
    const data = state();
    data.commitments = [
      task("draft", {
        title: "Ambiguous Telegram capture",
        remaining_minutes: 900,
        deadline: at("09:15"),
        metadata: { needs_review: true },
      }),
    ];
    expect(rankCommitments(data, now)).toHaveLength(0);
    const plan = generateDailyPlan(data, day, now);
    expect(plan.blocks).toHaveLength(0);
    expect(plan.requiredMinutes).toBe(0);
    expect(plan.deficitMinutes).toBe(0);
    expect(briefing(data, now)).toContain("0 active commitments");
    expect(calculateRiskScore(data.commitments[0], data, now).score).toBe(0);
    data.commitments[0].metadata.needs_review = false;
    expect(rankCommitments(data, now)).toHaveLength(1);
    expect(generateDailyPlan(data, day, now).requiredMinutes).toBe(900);
  });
  it("splits effort, retains breaks and never overlaps hard events", () => {
    const data = state();
    data.commitments = [
      task("a", { remaining_minutes: 180, estimated_minutes: 180 }),
    ];
    data.calendar_events = [event("meeting", "10:00", "11:00")];
    const plan = generateDailyPlan(data, day, now);
    expect(plan.blocks.reduce((sum, block) => sum + block.minutes, 0)).toBe(
      180,
    );
    expect(plan.blocks.every((block) => block.minutes <= 50)).toBe(true);
    for (const block of plan.blocks)
      expect(
        Date.parse(block.end) <= Date.parse(at("10:00")) ||
          Date.parse(block.start) >= Date.parse(at("11:00")),
      ).toBe(true);
    for (let index = 1; index < plan.blocks.length; index++)
      expect(
        Date.parse(plan.blocks[index].start) -
          Date.parse(plan.blocks[index - 1].end),
      ).toBeGreaterThanOrEqual(10 * 60_000);
  });
  it("exposes deadline deficit instead of inventing work time", () => {
    const data = state();
    data.commitments = [
      task("a", { remaining_minutes: 100, deadline: at("10:00") }),
    ];
    const plan = generateDailyPlan(data, day, now);
    expect(plan.unscheduled[0].minutes).toBeGreaterThan(0);
    expect(plan.deficitMinutes).toBeGreaterThan(0);
    expect(
      plan.blocks.every(
        (block) => Date.parse(block.end) <= Date.parse(at("09:45")),
      ),
    ).toBe(true);
  });
  it("plans prerequisites before dependents and surfaces cyclic dependencies", () => {
    const data = state();
    data.commitments = [
      task("b", {
        priority: "critical",
        remaining_minutes: 30,
        metadata: { depends_on: ["a"] },
      }),
      task("a", { remaining_minutes: 30, priority: "low" }),
    ];
    const plan = generateDailyPlan(data, day, now);
    expect(plan.blocks.map((block) => block.commitment_id)).toEqual(["a", "b"]);
    expect(Date.parse(plan.blocks[1].start)).toBeGreaterThanOrEqual(
      Date.parse(plan.blocks[0].end),
    );
    data.commitments[1].metadata = { depends_on: ["b"] };
    expect(generateDailyPlan(data, day, now).unscheduled).toHaveLength(2);
  });
  it("preserves planned focus and includes it in capacity on a second generation", () => {
    const data = state();
    data.commitments = [task("a", { remaining_minutes: 60 })];
    const initial = generateDailyPlan(data, day, now);
    data.calendar_events = initial.blocks.map((block, i) => ({
      id: `block-${i}`,
      user_id: data.user_id,
      title: block.title,
      start: block.start,
      end: block.end,
      source: "focus",
      commitment_id: block.commitment_id,
      external_id: null,
    }));
    const regenerated = generateDailyPlan(data, day, now);
    expect(regenerated.capacityMinutes).toBe(initial.capacityMinutes);
    expect(regenerated.blocks).toHaveLength(initial.blocks.length);
    expect(
      regenerated.blocks.reduce((sum, block) => sum + block.minutes, 0),
    ).toBe(60);
  });
  it("moves a reservation when a new hard event conflicts with it", () => {
    const data = state();
    data.commitments = [task("a", { remaining_minutes: 60 })];
    data.calendar_events = [
      event("old-focus", "09:00", "10:00", "focus", "a"),
      event("new-meeting", "09:00", "10:00"),
    ];
    const plan = generateDailyPlan(data, day, now);
    expect(plan.blocks.length).toBeGreaterThan(0);
    expect(
      plan.blocks.every(
        (block) => Date.parse(block.start) >= Date.parse(at("10:00")),
      ),
    ).toBe(true);
  });
  it("does not preserve future reservations beyond the deep-work limit", () => {
    const data = state();
    data.settings.max_deep_work_minutes = 120;
    data.commitments = [task("a", { remaining_minutes: 180 })];
    data.calendar_events = [event("too-long", "09:00", "12:00", "focus", "a")];
    const plan = generateDailyPlan(data, day, now);
    expect(
      plan.blocks.reduce((sum, block) => sum + block.minutes, 0),
    ).toBeLessThanOrEqual(120);
    expect(plan.unscheduled[0].minutes).toBeGreaterThan(0);
  });
  it("releases excess reservation time after an effort estimate is reduced", () => {
    const data = state();
    data.commitments = [task("a", { remaining_minutes: 20 })];
    data.calendar_events = [event("old-long", "09:00", "10:00", "focus", "a")];
    const plan = generateDailyPlan(data, day, now);
    expect(plan.capacityMinutes).toBe(470);
    expect(plan.blocks.reduce((sum, block) => sum + block.minutes, 0)).toBe(20);
  });
  it("preserves recovery breaks after saving a plan and across commitment changes", () => {
    const data = state();
    data.commitments = [
      task("a", { remaining_minutes: 100, estimated_minutes: 100 }),
    ];
    const initial = generateDailyPlan(data, day, now);
    data.calendar_events = initial.blocks.map((block, index) => ({
      id: `saved-${index}`,
      user_id: data.user_id,
      title: block.title,
      start: block.start,
      end: block.end,
      source: "focus",
      commitment_id: block.commitment_id,
      external_id: null,
    }));
    data.commitments.push(
      task("quick", {
        remaining_minutes: 10,
        estimated_minutes: 10,
        priority: "critical",
      }),
    );
    const recovered = generateDailyPlan(data, day, now);
    const quick = recovered.blocks.find(
      (block) => block.commitment_id === "quick",
    )!;
    expect(quick).toBeDefined();
    for (const fixed of initial.blocks)
      expect(
        Date.parse(quick.end) <= Date.parse(fixed.start) ||
          Date.parse(quick.start) >=
            Date.parse(fixed.end) + data.settings.break_minutes * 60_000,
      ).toBe(true);
    const withoutQuick = {
      ...data,
      commitments: data.commitments.filter((c) => c.id !== "quick"),
    };
    expect(generateDailyPlan(withoutQuick, day, now).capacityMinutes).toBe(
      initial.capacityMinutes,
    );
  });
  it("uses later free windows to reach the deep-work budget after taking breaks", () => {
    const data = state();
    Object.assign(data.settings, {
      workday_end: "22:00",
      max_deep_work_minutes: 180,
    });
    data.commitments = [
      task("a", { remaining_minutes: 180, deadline: at("22:00") }),
    ];
    const plan = generateDailyPlan(data, day, now);
    expect(plan.blocks.reduce((sum, block) => sum + block.minutes, 0)).toBe(
      180,
    );
    expect(plan.unscheduled).toHaveLength(0);
  });
  it("carries recovery time across a short calendar event between free windows", () => {
    const data = state();
    data.calendar_events = [event("short-call", "09:50", "09:55")];
    data.commitments = [
      task("a", { remaining_minutes: 50, priority: "critical" }),
      task("b", { remaining_minutes: 10 }),
    ];
    const plan = generateDailyPlan(data, day, now);
    expect(plan.blocks.find((block) => block.commitment_id === "a")?.end).toBe(
      at("09:50"),
    );
    expect(
      Date.parse(
        plan.blocks.find((block) => block.commitment_id === "b")!.start,
      ),
    ).toBeGreaterThanOrEqual(Date.parse(at("10:00")));
  });
  it("releases an ongoing saved block that intrudes into the previous block recovery time", () => {
    const data = state();
    data.commitments = [task("a", { remaining_minutes: 10 })];
    data.calendar_events = [
      event("past-focus", "09:00", "09:50", "focus", "old-task"),
      event("bad-focus", "09:50", "10:10", "focus", "a"),
    ];
    const plan = generateDailyPlan(data, day, new Date(at("09:55")));
    expect(
      plan.blocks.every(
        (block) => Date.parse(block.start) >= Date.parse(at("10:05")),
      ),
    ).toBe(true);
  });
});

describe("Persistent chase rules", () => {
  it("suppresses resolved, waiting, blocked and snoozed tasks", () => {
    const data = state();
    data.commitments = ["done", "cancelled", "waiting", "blocked"].map(
      (status, i) =>
        task(String(i), {
          status: status as Commitment["status"],
          deadline: at("09:15"),
        }),
    );
    data.commitments.push(
      task("snooze", { deadline: at("09:15"), snoozed_until: at("10:00") }),
    );
    expect(generateReminderSchedule(data, now)).toHaveLength(0);
  });
  it("does not chase an unconfirmed deadline or progress check-in until review is accepted", () => {
    const data = state();
    data.commitments = [
      task("draft", {
        deadline: at("09:15"),
        check_in_at: at("08:00"),
        metadata: { needs_review: true },
      }),
    ];
    expect(generateReminderSchedule(data, now)).toHaveLength(0);
    data.commitments[0].metadata.needs_review = false;
    expect(generateReminderSchedule(data, now)[0].type).toBe("check_in");
  });
  it("chases missed check-ins, then stops when the user marks the check-in done", () => {
    const data = state();
    data.settings.risk_alerts = false;
    data.commitments = [task("a", { check_in_at: at("08:00") })];
    expect(generateReminderSchedule(data, now)[0].type).toBe("check_in");
    data.commitments[0].metadata.check_in_completed_at = at("08:15");
    expect(generateReminderSchedule(data, now)).toHaveLength(0);
  });
  it("enforces cooldown and persistent dedupe", () => {
    const data = state();
    data.commitments = [task("a", { deadline: at("09:30") })];
    const notification = generateReminderSchedule(data, now)[0];
    data.reminders.push({
      id: "sent",
      user_id: data.user_id,
      commitment_id: "a",
      scheduled_for: now.toISOString(),
      sent_at: now.toISOString(),
      type: notification.type,
      status: "sent",
      provider: "demo",
      dedupe_key: notification.dedupe_key,
      payload: {},
    });
    expect(generateReminderSchedule(data, now)).toHaveLength(0);
    data.reminders = [];
    data.commitments[0].last_reminded_at = new Date(
      now.getTime() - 5 * 60_000,
    ).toISOString();
    expect(generateReminderSchedule(data, now)).toHaveLength(0);
  });
  it("escalates from an earlier stage after 15 minutes and allows fresh rescheduling keys", () => {
    const data = state();
    data.commitments = [
      task("a", {
        deadline: at("09:20"),
        last_reminded_at: new Date(now.getTime() - 20 * 60_000).toISOString(),
      }),
    ];
    data.reminders = [
      {
        id: "old",
        user_id: data.user_id,
        commitment_id: "a",
        scheduled_for: at("08:40"),
        sent_at: at("08:40"),
        type: "deadline_high",
        status: "sent",
        provider: "demo",
        dedupe_key: "old",
        payload: {},
      },
    ];
    const before = generateReminderSchedule(data, now)[0];
    expect(before.type).toBe("deadline_critical");
    data.commitments[0].metadata.rescheduled_at = now.toISOString();
    expect(generateReminderSchedule(data, now)[0].dedupe_key).not.toBe(
      before.dedupe_key,
    );
  });
  it("includes waiting and blocked commitments in the nightly review", () => {
    const data = state();
    data.settings.telegram_enabled = true;
    data.commitments = [
      task("a", { title: "Waiting example", status: "waiting" }),
      task("b", { title: "Blocked example", status: "blocked" }),
    ];
    const review = generateReminderSchedule(data, new Date(at("22:00"))).find(
      (item) => item.type === "nightly_review",
    );
    expect(review?.text).toContain("Waiting example");
    expect(review?.text).toContain("Blocked example");
  });
});
