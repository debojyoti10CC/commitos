import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { readState, mutateState } from "@/lib/db/repository";
import {
  createCommitment,
  commitmentAction,
  planDay,
  eveningReview,
  updateCommitment,
  deleteCommitment,
} from "@/lib/services";
import { parseCommitment } from "@/lib/ai/provider";
import { generateReminderSchedule } from "@/lib/notifications/rules";
import { runReminders } from "@/lib/notifications/runner";

const scratchRoot = path.resolve(process.cwd(), "..", "..", "work");
const directory = path.join(scratchRoot, `test-data-${randomUUID()}`);
const user = randomUUID();
const secondUser = randomUUID();
const now = new Date("2026-10-05T04:30:00Z");
beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  vi.stubEnv("DEMO_MODE", "true");
  vi.stubEnv("DEMO_DATA_DIR", directory);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  await mutateState(user, (s) => {
    s.commitments = [];
    s.sessions = [];
    s.calendar_events = [];
    s.reminders = [];
    s.activity = [];
    s.settings.telegram_enabled = false;
  });
});
afterAll(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (directory.startsWith(scratchRoot + path.sep))
    await rm(directory, { recursive: true, force: true });
});
describe("persistent capture → plan → execute → review", () => {
  it("parses the requested commitment, saves it, tracks actual work and ends reminders", async () => {
    const { parsed } = await parseCommitment(
      "Finish HydraDB video tonight by 9. Need to send them an update around 6. Will probably take two hours.",
      { now, timezone: "Asia/Kolkata", projects: ["HydraDB"] },
    );
    expect(parsed.estimatedMinutes).toBe(120);
    expect(parsed.deadline).toBe("2026-10-05T15:30:00.000Z");
    expect(parsed.checkInAt).toBe("2026-10-05T12:30:00.000Z");
    const created = await createCommitment(user, { parsed });
    const id = created.commitment!.id;
    expect(
      (await readState(user)).commitments.find((c) => c.id === id)?.title,
    ).toContain("HydraDB");
    const { plan, state: planned } = await planDay(user, "2026-10-05", true);
    expect(plan.blocks.some((b) => b.commitment_id === id)).toBe(true);
    expect(
      planned.calendar_events.some(
        (e) => e.source === "focus" && e.commitment_id === id,
      ),
    ).toBe(true);
    const started = await commitmentAction(user, id, "start");
    expect(
      started.state.sessions.filter(
        (s) => s.commitment_id === id && !s.ended_at,
      ),
    ).toHaveLength(1);
    await commitmentAction(user, id, "start");
    expect(
      (await readState(user)).sessions.filter(
        (s) => s.commitment_id === id && !s.ended_at,
      ),
    ).toHaveLength(1);
    vi.setSystemTime(new Date(now.getTime() + 30 * 60000));
    const paused = await commitmentAction(user, id, "pause");
    expect(
      paused.state.commitments.find((c) => c.id === id)?.completed_minutes,
    ).toBe(30);
    await commitmentAction(user, id, "start");
    vi.setSystemTime(new Date(now.getTime() + 40 * 60000));
    const finished = await commitmentAction(user, id, "complete");
    const c = finished.state.commitments.find((c) => c.id === id)!;
    expect(c.status).toBe("done");
    expect(c.completed_minutes).toBe(40);
    expect(c.remaining_minutes).toBe(0);
    expect(finished.state.sessions.every((s) => s.ended_at)).toBe(true);
    expect(
      generateReminderSchedule(
        finished.state,
        new Date("2026-10-05T15:15:00Z"),
      ).some((r) => r.commitment_id === id),
    ).toBe(false);
    const review = await eveningReview(user, "Completed the launch video");
    expect(review.review?.completed_count).toBe(1);
    expect(review.review?.completed_minutes).toBe(40);
    await eveningReview(user, "Updated review");
    expect((await readState(user)).reviews).toHaveLength(1);
  });
  it("keeps users isolated and serializes concurrent writes", async () => {
    const before = (await readState(user)).commitments.length;
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        createCommitment(user, {
          title: `Concurrent ${i}`,
          estimated_minutes: 10,
        }),
      ),
    );
    expect((await readState(user)).commitments.length).toBe(before + 4);
    const another = await readState(secondUser);
    expect(
      another.commitments.some((c) => c.title.startsWith("Concurrent")),
    ).toBe(false);
    await expect(
      updateCommitment(secondUser, (await readState(user)).commitments[0].id, {
        title: "Cross-user edit",
      }),
    ).rejects.toThrow("not found");
  });
  it("honors estimates, snooze, cancellation and deletion", async () => {
    const { commitment } = await createCommitment(user, {
      title: "Email sponsor",
      estimated_minutes: 10,
      deadline: "2026-10-05T10:00:00Z",
    });
    const id = commitment!.id;
    await updateCommitment(user, id, { estimated_minutes: 20 });
    expect(
      (await readState(user)).commitments.find((c) => c.id === id)
        ?.remaining_minutes,
    ).toBe(20);
    const snoozed = await commitmentAction(user, id, "snooze", { minutes: 30 });
    expect(
      generateReminderSchedule(snoozed.state, new Date()).some(
        (r) => r.commitment_id === id,
      ),
    ).toBe(false);
    await updateCommitment(user, id, { status: "cancelled" });
    expect(
      (await readState(user)).commitments.find((c) => c.id === id)
        ?.cancelled_at,
    ).toBeTruthy();
    await deleteCommitment(user, id);
    expect((await readState(user)).commitments.some((c) => c.id === id)).toBe(
      false,
    );
  });
  it("claims each due reminder once across overlapping runs", async () => {
    vi.setSystemTime(now);
    await mutateState(user, (s) => {
      s.commitments = [];
      s.reminders = [];
      s.calendar_events = [];
    });
    const { commitment } = await createCommitment(user, {
      title: "Submit form",
      estimated_minutes: 10,
      deadline: "2026-10-05T04:50:00Z",
    });
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const results = await Promise.all([
        runReminders(user, now),
        runReminders(user, now),
      ]);
      expect(results.reduce((sum, r) => sum + r.sent, 0)).toBe(1);
      expect(
        (await readState(user)).reminders.filter((r) => r.status === "sent"),
      ).toHaveLength(1);
      await commitmentAction(user, commitment!.id, "complete");
      expect(
        (await runReminders(user, new Date(now.getTime() + 3600000))).sent,
      ).toBe(0);
    } finally {
      log.mockRestore();
    }
  });
});
