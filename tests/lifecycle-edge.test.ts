import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { mutateState, readState } from "@/lib/db/repository";
import { commitmentAction, createCommitment, planDay } from "@/lib/services";
import { runReminders } from "@/lib/notifications/runner";
import { generateReminderSchedule } from "@/lib/notifications/rules";
import { zonedDate } from "@/lib/scheduling/time";

const scratchRoot = path.resolve(process.cwd(), "..", "..", "work");
const directory = path.join(scratchRoot, `lifecycle-edge-${randomUUID()}`);
const day = "2026-10-05";
const timezone = "Asia/Kolkata";
const instant = (clock: string) =>
  zonedDate(day, clock, timezone).toISOString();
const now = new Date(instant("10:00"));
let user: string;

beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  vi.stubEnv("DEMO_MODE", "true");
  vi.stubEnv("DEMO_DATA_DIR", directory);
  vi.stubEnv("APP_TIMEZONE", timezone);
  vi.useFakeTimers({ toFake: ["Date"] });
});
beforeEach(async () => {
  vi.setSystemTime(now);
  user = randomUUID();
  await mutateState(user, (s) => {
    s.commitments = [];
    s.sessions = [];
    s.calendar_events = [];
    s.reminders = [];
    s.activity = [];
    Object.assign(s.settings, {
      telegram_enabled: false,
      timezone,
      workday_start: "09:00",
      workday_end: "18:00",
      meal_blocks: [],
      max_deep_work_minutes: 480,
    });
  });
});
afterAll(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (directory.startsWith(scratchRoot + path.sep))
    await rm(directory, { recursive: true, force: true });
});

describe("Lifecycle edge regression checks", () => {
  it("does not send a reclaimed stale deadline notification after the user reschedules", async () => {
    const { commitment } = await createCommitment(user, {
      title: "Send update",
      estimated_minutes: 10,
      deadline: instant("10:20"),
    });
    await mutateState(user, (s) => {
      const due = generateReminderSchedule(s, now)[0];
      s.reminders.push({
        id: randomUUID(),
        user_id: user,
        commitment_id: commitment!.id,
        type: due.type,
        dedupe_key: due.dedupe_key,
        scheduled_for: instant("09:40"),
        sent_at: null,
        status: "sending",
        provider: "pending",
        payload: { text: due.text, claimed_at: instant("09:40"), attempts: 1 },
      });
    });
    await commitmentAction(user, commitment!.id, "reschedule", {
      deadline: zonedDate("2026-10-06", "18:00", timezone).toISOString(),
    });
    const result = await runReminders(user, now);
    expect(result.sent).toBe(0);
    expect(
      (await readState(user)).reminders.some(
        (r) => r.status === "sent" && r.type.startsWith("deadline_"),
      ),
    ).toBe(false);
  });

  it("does not send a reclaimed stale check-in after the user marked the update sent", async () => {
    const { commitment } = await createCommitment(user, {
      title: "Promised progress update",
      estimated_minutes: 15,
      check_in_at: instant("09:30"),
    });
    await mutateState(user, (s) => {
      const due = generateReminderSchedule(s, now)[0];
      s.reminders.push({
        id: randomUUID(),
        user_id: user,
        commitment_id: commitment!.id,
        type: due.type,
        dedupe_key: due.dedupe_key,
        scheduled_for: instant("09:40"),
        sent_at: null,
        status: "sending",
        provider: "pending",
        payload: { text: due.text, claimed_at: instant("09:40"), attempts: 1 },
      });
    });
    await commitmentAction(user, commitment!.id, "checkin");
    const result = await runReminders(user, now);
    expect(result.sent).toBe(0);
    expect(
      (await readState(user)).reminders.some(
        (r) => r.status === "sent" && r.type === "check_in",
      ),
    ).toBe(false);
  });

  it("reconciles an ongoing focus reservation after a newly synced hard event conflicts", async () => {
    const { commitment } = await createCommitment(user, {
      title: "Write release notes",
      estimated_minutes: 120,
      deadline: instant("18:00"),
    });
    await mutateState(user, (s) => {
      const c = s.commitments[0];
      c.status = "in_progress";
      c.started_at = instant("09:30");
      c.scheduled_start = instant("09:30");
      c.scheduled_end = instant("11:30");
      s.sessions.push({
        id: randomUUID(),
        user_id: user,
        commitment_id: c.id,
        started_at: instant("09:30"),
        ended_at: null,
        duration_minutes: 0,
        notes: "",
      });
      s.calendar_events.push({
        id: randomUUID(),
        user_id: user,
        title: c.title,
        start: instant("09:30"),
        end: instant("11:30"),
        source: "focus",
        commitment_id: c.id,
        external_id: null,
      });
      s.calendar_events.push({
        id: randomUUID(),
        user_id: user,
        title: "New calendar meeting",
        start: instant("10:00"),
        end: instant("11:00"),
        source: "google",
        commitment_id: null,
        external_id: "external",
      });
    });
    const { state: applied, plan } = await planDay(user, day, true);
    expect(
      plan.blocks.some((block) => block.commitment_id === commitment!.id),
    ).toBe(true);
    const futureFocus = applied.calendar_events.filter(
      (event) =>
        event.source === "focus" && Date.parse(event.end) > now.getTime(),
    );
    expect(
      futureFocus.every(
        (event) =>
          Date.parse(event.end) <= Date.parse(instant("10:00")) ||
          Date.parse(event.start) >= Date.parse(instant("11:00")),
      ),
    ).toBe(true);
    expect(
      applied.calendar_events.some(
        (event) =>
          event.source === "google" && event.external_id === "external",
      ),
    ).toBe(true);
  });

  it("stops active work time at snooze and releases future focus reservations", async () => {
    const { commitment } = await createCommitment(user, {
      title: "Prepare slides",
      estimated_minutes: 120,
      deadline: instant("18:00"),
    });
    await commitmentAction(user, commitment!.id, "start");
    await mutateState(user, (s) => {
      s.calendar_events.push({
        id: randomUUID(),
        user_id: user,
        title: "Focus",
        start: instant("11:00"),
        end: instant("12:00"),
        source: "focus",
        commitment_id: commitment!.id,
        external_id: null,
      });
    });
    vi.setSystemTime(new Date(instant("10:20")));
    const snoozed = await commitmentAction(user, commitment!.id, "snooze", {
      minutes: 30,
    });
    expect(
      snoozed.state.sessions.every((session) => session.ended_at !== null),
    ).toBe(true);
    expect(snoozed.state.commitments[0].completed_minutes).toBe(20);
    expect(snoozed.state.commitments[0].status).not.toBe("in_progress");
    expect(
      snoozed.state.calendar_events.some(
        (event) =>
          event.source === "focus" && Date.parse(event.start) > Date.now(),
      ),
    ).toBe(false);
    vi.setSystemTime(new Date(instant("10:50")));
    await commitmentAction(user, commitment!.id, "pause");
    expect((await readState(user)).commitments[0].completed_minutes).toBe(20);
  });

  it("reports invalid calendar dates as input errors", async () => {
    await expect(planDay(user, "2026-02-31")).rejects.toMatchObject({
      status: 400,
    });
  });
});
