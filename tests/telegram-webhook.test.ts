import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { POST } from "@/app/api/telegram/webhook/route";
import {
  createTelegramPairing,
  findUserByTelegramChat,
  mutateState,
  readState,
} from "@/lib/db/repository";
import {
  commitmentAction,
  createCommitment,
  logActivity,
} from "@/lib/services";
import { generateReminderSchedule } from "@/lib/notifications/rules";
import * as ai from "@/lib/ai/provider";

const scratch = path.resolve(process.cwd(), "..", "..", "work");
const directory = path.join(scratch, `telegram-tests-${randomUUID()}`);
const instant = new Date("2026-10-05T04:30:00Z");
const secret = "valid-local-webhook-secret";
let user: string;
let chat: number;
let sequence = 0;
let failNextSend = false;
let sent: { method: string; body: Record<string, unknown> }[] = [];
let parser: MockInstance<typeof ai.parseCommitment>;
const update = (text: string, id = ++sequence) => ({
  update_id: id,
  message: { chat: { id: chat, type: "private" }, text },
});
const deliver = (body: unknown, webhookSecret = secret) =>
  POST(
    new Request("http://localhost:3000/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": webhookSecret,
      },
      body: JSON.stringify(body),
    }),
  );

beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  vi.stubEnv("DEMO_MODE", "true");
  vi.stubEnv("DEMO_DATA_DIR", directory);
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", secret);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test:fake-local-token");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(instant);
});
beforeEach(async () => {
  user = randomUUID();
  chat = 100000 + sequence++;
  sent = [];
  failNextSend = false;
  vi.setSystemTime(instant);
  await mutateState(user, (s) => {
    s.commitments = [];
    s.sessions = [];
    s.reminders = [];
    s.activity = [];
    s.calendar_events = [];
  });
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname !== "api.telegram.org")
        throw new Error(
          "Unexpected external network request blocked by Telegram test",
        );
      const method = url.pathname.split("/").pop()!;
      const body = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      sent.push({ method, body });
      if (method === "sendMessage" && failNextSend) {
        failNextSend = false;
        return Response.json({ ok: false, error_code: 500 }, { status: 500 });
      }
      return Response.json({ ok: true, result: { message_id: sequence } });
    },
  );
  parser = vi
    .spyOn(ai, "parseCommitment")
    .mockImplementation(async (text, context) => ({
      parsed: ai.deterministicParse(text, context),
      provider: "deterministic-test",
    }));
  const token = await createTelegramPairing(user);
  expect((await deliver(update(`/start ${token}`))).status).toBe(200);
  expect(await findUserByTelegramChat(String(chat))).toBe(user);
  sent = [];
  parser.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (directory.startsWith(scratch + path.sep))
    await rm(directory, { recursive: true, force: true });
});

describe("authenticated Telegram webhook capture and execution", () => {
  it("rejects invalid webhook secrets before parsing or provider I/O", async () => {
    const response = await deliver(
      update("/add Send the sponsor update today 10m"),
      "wrong",
    );
    expect(response.status).toBe(401);
    expect(parser).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect((await readState(user)).commitments).toHaveLength(0);
  });
  it("captures /add once despite duplicate update replay", async () => {
    const body = update(
      "/add Finish HydraDB video tonight by 9 PM. Will take two hours.",
    );
    expect((await deliver(body)).status).toBe(200);
    expect((await deliver(body)).status).toBe(200);
    const state = await readState(user);
    expect(state.commitments).toHaveLength(1);
    expect(state.commitments[0].source).toBe("telegram");
    expect(state.commitments[0].estimated_minutes).toBe(120);
    expect(parser).toHaveBeenCalledTimes(1);
    expect(sent.filter((item) => item.method === "sendMessage")).toHaveLength(
      1,
    );
  });
  it("keeps uncertain interpretations in the Inbox for review", async () => {
    expect(
      (await deliver(update("/add Work on the side project before class")))
        .status,
    ).toBe(200);
    const commitment = (await readState(user)).commitments[0];
    expect(commitment.status).toBe("inbox");
    expect(commitment.metadata.needs_review).toBe(true);
    expect(commitment.metadata.confidence).toBeLessThan(0.85);
    expect(commitment.deadline).toBeNull();
  });
  it("inline Done stops the running session and future reminders", async () => {
    const created = await createCommitment(user, {
      title: "Send sponsor update",
      estimated_minutes: 30,
      deadline: "2026-10-05T05:00:00Z",
    });
    const id = created.commitment!.id;
    await commitmentAction(user, id, "start");
    await mutateState(user, (s) => {
      s.reminders.push({
        id: randomUUID(),
        user_id: user,
        commitment_id: id,
        scheduled_for: instant.toISOString(),
        type: "deadline",
        status: "pending",
        sent_at: null,
        provider: "telegram",
        dedupe_key: "telegram-done-test",
        payload: {},
      });
    });
    vi.setSystemTime(new Date(instant.getTime() + 45000));
    const body = {
      update_id: ++sequence,
      callback_query: {
        id: "callback-done",
        data: `done:${id}`,
        message: { chat: { id: chat, type: "private" } },
      },
    };
    expect((await deliver(body)).status).toBe(200);
    expect((await deliver(body)).status).toBe(200);
    const state = await readState(user),
      commitment = state.commitments.find((c) => c.id === id)!;
    expect(commitment.status).toBe("done");
    expect(commitment.completed_minutes).toBe(0.75);
    expect(state.sessions.every((s) => s.ended_at)).toBe(true);
    expect(
      state.reminders.filter(
        (r) => r.commitment_id === id && r.status !== "sent",
      ),
    ).toHaveLength(0);
    expect(
      generateReminderSchedule(state, new Date("2026-10-05T04:55:00Z")).some(
        (r) => r.commitment_id === id,
      ),
    ).toBe(false);
    expect(
      sent.filter((item) => item.method === "answerCallbackQuery"),
    ).toHaveLength(1);
  });
  it("provider failure returns 503 and a replay keeps the saved capture singular", async () => {
    const body = update("/add Send project update tomorrow 15m");
    failNextSend = true;
    expect((await deliver(body)).status).toBe(503);
    expect((await readState(user)).commitments).toHaveLength(1);
    expect((await deliver(body)).status).toBe(200);
    expect((await readState(user)).commitments).toHaveLength(1);
    expect(parser).toHaveBeenCalledTimes(1);
  });
  it("recovers immediately after a pre-capture parser failure", async () => {
    const body = update("/add Fill the college form tomorrow 10m");
    parser.mockRejectedValueOnce(new Error("Temporary parser failure"));
    expect((await deliver(body)).status).toBe(503);
    expect((await readState(user)).commitments).toHaveLength(0);
    expect((await deliver(body)).status).toBe(200);
    expect((await readState(user)).commitments).toHaveLength(1);
    expect(parser).toHaveBeenCalledTimes(2);
  });
  it("keeps /done completion time stable when provider failure is replayed next day", async () => {
    const created = await createCommitment(user, {
      title: "Reply to the speaker",
      estimated_minutes: 10,
    });
    const id = created.commitment!.id;
    const body = update(`/done ${id}`);
    failNextSend = true;
    expect((await deliver(body)).status).toBe(503);
    const completedAt = (await readState(user)).commitments[0].completed_at;
    expect(completedAt).toBe(instant.toISOString());
    vi.setSystemTime(new Date(instant.getTime() + 86400000));
    expect((await deliver(body)).status).toBe(200);
    expect((await readState(user)).commitments[0].completed_at).toBe(
      completedAt,
    );
  });
  it("rate limits captures before invoking the AI/parser", async () => {
    await mutateState(user, (s) => {
      for (let i = 0; i < 20; i++)
        logActivity(s, "parse_requested", `Earlier capture ${i}`);
    });
    expect(
      (await deliver(update("/add Finish expensive request tonight 2h")))
        .status,
    ).toBe(503);
    expect(parser).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect((await readState(user)).commitments).toHaveLength(0);
  });
  it("serializes simultaneous retries after a failed update even with equal timestamps", async () => {
    const body = update("/add Send a retry-safe update today 10m");
    parser.mockRejectedValueOnce(new Error("Temporary parser failure"));
    expect((await deliver(body)).status).toBe(503);
    let release!: () => void;
    let announce!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      announce = resolve;
    });
    parser.mockImplementation(async (text, context) => {
      announce();
      await gate;
      return {
        parsed: ai.deterministicParse(text, context),
        provider: "deterministic-test",
      };
    });
    const first = deliver(body);
    await entered;
    const second = deliver(body);
    // Hold parsing so both requests reach the persisted claim before effects can be acknowledged.
    await Promise.race([
      second,
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
    release();
    const responses = await Promise.all([first, second]);
    expect((await readState(user)).commitments).toHaveLength(1);
    expect(parser).toHaveBeenCalledTimes(2);
    expect(responses.some((r) => r.status === 200)).toBe(true);
    expect(responses.every((r) => [200, 503].includes(r.status))).toBe(true);
  });
});
