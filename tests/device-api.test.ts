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
import { GET, POST, DELETE } from "@/app/api/[...path]/route";
import { createDemoSession, DEMO_COOKIE } from "@/lib/auth";
import { mutateState, readState } from "@/lib/db/repository";
import { createCommitment } from "@/lib/services";
import * as ai from "@/lib/ai/provider";
import type { ParsedCommitment } from "@/lib/types";

const scratch = path.resolve(process.cwd(), "..", "..", "work");
const directory = path.join(scratch, `device-api-${randomUUID()}`);
const instant = new Date("2026-10-05T04:30:00Z");
let user: { id: string; token: string };
beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  vi.stubEnv("DEMO_MODE", "true");
  vi.stubEnv("DEMO_DATA_DIR", directory);
  vi.stubEnv("SESSION_SECRET", "");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(instant);
});
beforeEach(async () => {
  vi.setSystemTime(instant);
  vi.restoreAllMocks();
  user = await createDemoSession();
  await mutateState(user.id, (s) => {
    s.commitments = [];
    s.sessions = [];
    s.calendar_events = [];
    s.activity = [];
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (directory.startsWith(scratch + path.sep))
    await rm(directory, { recursive: true, force: true });
});
async function call(
  route: string,
  method = "GET",
  body?: unknown,
  token?: string,
  cookie = user.token,
) {
  const request = new Request(`http://localhost:3000/api/${route}`, {
    method,
    headers: {
      cookie: `${DEMO_COOKIE}=${cookie}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method === "POST"
        ? {
            "content-type": "application/json",
            origin: "http://localhost:3000",
          }
        : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const handler = method === "POST" ? POST : method === "DELETE" ? DELETE : GET;
  return handler(request, {
    params: Promise.resolve({ path: route.split("/") }),
  });
}
async function device() {
  const response = await call("devices", "POST", {
    label: "Disposable desk test",
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ id: string; token: string }>;
}
const parsed: ParsedCommitment = {
  title: "Ambiguous voice commitment",
  description: "Private spoken notes",
  project: null,
  commitmentType: "other",
  contactName: null,
  organization: null,
  deadline: null,
  checkInAt: null,
  estimatedMinutes: 30,
  priority: "medium",
  nextAction: null,
  confidence: 0.5,
  inferredFields: ["deadline"],
  warnings: ["Review the date."],
};

describe("authenticated desk API", () => {
  it("lists public device metadata without ever returning tokens or hashes", async () => {
    const issued = await device();
    const response = await call("devices");
    const data = await response.json();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(data.devices).toHaveLength(1);
    expect(Object.keys(data.devices[0]).sort()).toEqual([
      "created_at",
      "id",
      "label",
      "revoked_at",
    ]);
    expect(JSON.stringify(data)).not.toContain(issued.token);
    const other = await createDemoSession();
    expect(
      (
        await (
          await call("devices", "GET", undefined, undefined, other.token)
        ).json()
      ).devices,
    ).toEqual([]);
  });
  it("requires a valid device credential even if browser authentication exists", async () => {
    expect((await call("device/snapshot")).status).toBe(401);
    expect(
      (await call("device/snapshot", "GET", undefined, "wrong-token")).status,
    ).toBe(401);
  });
  it("provides the snapshot, live effort, pause and completion through one user's token", async () => {
    const { commitment } = await createCommitment(user.id, {
      title: "Desk workflow",
      estimated_minutes: 60,
      description: "PRIVATE_BODY",
    });
    const { token } = await device();
    expect(
      (await call(`device/${commitment!.id}/start`, "POST", {}, token)).status,
    ).toBe(200);
    vi.setSystemTime(new Date(instant.getTime() + 10 * 60000));
    const response = await call("device/snapshot", "GET", undefined, token);
    const snapshot = await response.json();
    expect(snapshot.now.id).toBe(commitment!.id);
    expect(snapshot.now.remaining_minutes).toBe(50);
    expect(snapshot.timer.elapsed_seconds).toBe(600);
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_BODY");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(
      (await call(`device/${commitment!.id}/pause`, "POST", {}, token)).status,
    ).toBe(200);
    expect(
      (await (await call("device/snapshot", "GET", undefined, token)).json())
        .timer,
    ).toBeNull();
    expect(
      (await call(`device/${commitment!.id}/complete`, "POST", {}, token))
        .status,
    ).toBe(200);
    expect(
      (await (await call("device/snapshot", "GET", undefined, token)).json())
        .now,
    ).toBeNull();
  });
  it("a token cannot operate on another user's commitment, and revocation takes effect immediately", async () => {
    const issued = await device();
    const other = await createDemoSession();
    const { commitment } = await createCommitment(other.id, {
      title: "Other user's task",
    });
    expect(
      (await call(`device/${commitment!.id}/start`, "POST", {}, issued.token))
        .status,
    ).toBe(404);
    await call(
      `devices/${issued.id}`,
      "DELETE",
      undefined,
      undefined,
      other.token,
    );
    expect(
      (await call("device/snapshot", "GET", undefined, issued.token)).status,
    ).toBe(200);
    expect((await call(`devices/${issued.id}`, "DELETE")).status).toBe(200);
    expect(
      (await call("device/snapshot", "GET", undefined, issued.token)).status,
    ).toBe(401);
  });
  it("stages ambiguous device transcripts for review and keeps them out of NOW", async () => {
    vi.spyOn(ai, "parseCommitment").mockResolvedValue({
      parsed,
      provider: "deterministic",
    });
    const { token } = await device();
    const response = await call(
      "device/capture",
      "POST",
      { text: "Do the thing before class" },
      token,
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.commitment.source).toBe("device");
    expect(data.commitment.metadata.needs_review).toBe(true);
    expect(
      (await (await call("device/snapshot", "GET", undefined, token)).json())
        .now,
    ).toBeNull();
  });
  it("accepts a clear device transcript and rejects oversized or invalid input", async () => {
    vi.spyOn(ai, "parseCommitment").mockResolvedValue({
      parsed: { ...parsed, confidence: 0.98, warnings: [], inferredFields: [] },
      provider: "gemini",
    });
    const { token } = await device();
    const response = await call(
      "device/capture",
      "POST",
      { text: "Send the sponsor deck today at 5pm, 30 minutes" },
      token,
    );
    expect(response.status).toBe(200);
    const snapshot = await (
      await call("device/snapshot", "GET", undefined, token)
    ).json();
    expect(snapshot.now.title).toBe(parsed.title);
    expect(
      (await call("device/capture", "POST", { text: "x" }, token)).status,
    ).toBe(400);
    expect(
      (await call("device/capture", "POST", { text: "x".repeat(70000) }, token))
        .status,
    ).toBe(413);
  });
  it("repeated completion preserves the original timestamp and history", async () => {
    const { commitment } = await createCommitment(user.id, {
      title: "Replay-safe finish",
    });
    const { token } = await device();
    await call(`device/${commitment!.id}/complete`, "POST", {}, token);
    vi.setSystemTime(new Date(instant.getTime() + 60000));
    await call(`device/${commitment!.id}/complete`, "POST", {}, token);
    const state = await readState(user.id);
    expect(state.commitments[0].completed_at).toBe(instant.toISOString());
    expect(
      state.activity.filter((e) => e.type === "commitment_completed"),
    ).toHaveLength(1);
  });
});
