import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDemoSession, DEMO_COOKIE } from "@/lib/auth";
import { mutateState, readState } from "@/lib/db/repository";
import { captureRecords, updateRecord } from "@/lib/records/service";
import { defaultSettings } from "@/lib/seed";
import { GET, POST } from "@/app/api/records/route";
import { DELETE, PATCH } from "@/app/api/records/[id]/route";
import type { AppState } from "@/lib/types";
import type { CapturedRecord } from "@/lib/records/types";
import { deadlinePatchFromInput, inputDate } from "@/components/format";

const scratch = path.resolve(process.cwd(), "..", "..", "work");
const directory = path.join(scratch, `records-tests-${randomUUID()}`);
let first: { id: string; token: string }, second: { id: string; token: string };
const now = new Date("2026-10-05T04:30:00Z");
beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  vi.stubEnv("DEMO_MODE", "true");
  vi.stubEnv("DEMO_DATA_DIR", directory);
  vi.stubEnv("SESSION_SECRET", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  [first, second] = await Promise.all([createDemoSession(), createDemoSession()]);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (directory.startsWith(scratch + path.sep)) await rm(directory, { recursive: true, force: true });
});
function request(user: { token: string }, method = "GET", body?: unknown, endpoint = "/api/records") {
  return new Request(`http://localhost${endpoint}`, {
    method,
    headers: { cookie: `${DEMO_COOKIE}=${user.token}`, "content-type": "application/json", origin: "http://localhost" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
type CaptureResponse = { state: AppState; records: CapturedRecord[]; provider: string };

describe("automatic record persistence and authenticated correction routes", () => {
  it("saves an ordinary note with no invented deadline, then reloads it from disk", async () => {
    const result = await POST(request(first, "POST", { text: "Note: The spare keys are in the blue kitchen drawer.", request_id: randomUUID() }));
    expect(result.status).toBe(200);
    const saved = await result.json() as CaptureResponse;
    expect(saved.provider).toBe("local");
    expect(saved.records).toHaveLength(1);
    expect(saved.records[0]).toMatchObject({ user_id: first.id, kind: "note", deadline: null, source: "text", status: "active", collection: "Notes" });
    const durable = JSON.parse(await readFile(path.join(directory, `state-${first.id}.json`), "utf8")) as AppState;
    expect(durable.records.find(record => record.id === saved.records[0].id)?.content).toContain("spare keys");
    const reloaded = await GET(request(first));
    expect(reloaded.headers.get("cache-control")).toBe("private, no-store");
    expect((await reloaded.json()).records).toContainEqual(saved.records[0]);
  });

  it("atomically saves multiple related entries and creates only explicit collection/contact associations", async () => {
    const result = await captureRecords(first.id, "Project: Atlas\nNote: The launch palette uses charcoal and white.\nSend the API draft to Ravi tomorrow at 5 PM.", { now, source: "voice" });
    expect(result.records).toHaveLength(2);
    expect(new Set(result.records.map(record => record.capture_id)).size).toBe(1);
    expect(result.records.every(record => record.collection === "Atlas" && record.source === "voice")).toBe(true);
    expect(result.records[0].deadline).toBeNull();
    expect(result.records[1].deadline).toBe("2026-10-06T11:30:00.000Z");
    expect(result.state.projects.filter(project => project.name === "Atlas")).toHaveLength(1);
    expect(result.state.contacts.filter(contact => contact.name === "Ravi")).toHaveLength(1);
    const projectCount = result.state.projects.length, contactCount = result.state.contacts.length;
    const fallback = await captureRecords(first.id, "Idea: Make a reversible laptop stand", { now });
    expect(fallback.records[0].kind).toBe("idea");
    expect(fallback.records[0].collection).toBe("Ideas");
    expect(fallback.state.projects).toHaveLength(projectCount);
    expect(fallback.state.contacts).toHaveLength(contactCount);
  });

  it("preserves ambiguous wording and warnings without blocking a save", async () => {
    const saved = await captureRecords(first.id, "Finish the outline soon", { now });
    expect(saved.records[0].content).toBe("Finish the outline soon");
    expect(saved.records[0].deadline).toBeNull();
    expect(saved.records[0].interpretation.warnings.length).toBeGreaterThan(0);
    expect((await readState(first.id)).records).toContainEqual(saved.records[0]);
  });

  it("returns the same records for concurrent replay and rejects changed text with the same request id", async () => {
    const requestId = randomUUID();
    const text = "Note: The test locker code is written in the paper notebook.";
    const versionBefore = (await readState(first.id)).version;
    const saved = await Promise.all(Array.from({ length: 8 }, () => captureRecords(first.id, text, { request_id: requestId, now })));
    expect(new Set(saved.flatMap(result => result.records.map(record => record.id))).size).toBe(1);
    const state = await readState(first.id);
    expect(state.records.filter(record => record.capture_id.startsWith(`${requestId}:`))).toHaveLength(1);
    expect(state.version).toBe(versionBefore + 1);
    const replayed = await POST(request(first, "POST", { text, request_id: requestId }));
    expect(replayed.status).toBe(200);
    expect((await replayed.json()).records[0].id).toBe(saved[0].records[0].id);
    const conflict = await POST(request(first, "POST", { text: "Different note", request_id: requestId }));
    expect(conflict.status).toBe(409);
    expect((await POST(request(first, "POST", { text, source: "voice", request_id: requestId }))).status).toBe(409);
  });

  it("isolates owners, corrects saved fields, and archives without destroying capture history", async () => {
    const saved = await captureRecords(first.id, "Task: Prepare the outline soon", { now });
    const id = saved.records[0].id;
    const denied = await PATCH(request(second, "PATCH", { title: "Foreign edit" }), context(id));
    expect(denied.status).toBe(404);
    expect((await GET(request(second))).status).toBe(200);
    expect((await (await GET(request(second))).json()).records).toEqual([]);
    const corrected = await PATCH(request(first, "PATCH", { title: "Write the product outline", collection: "Atlas", deadline: "2026-10-09T17:00:00+05:30", tags: ["draft", "draft"] }), context(id));
    expect(corrected.status).toBe(200);
    expect((await corrected.json()).record).toMatchObject({ id, title: "Write the product outline", collection: "Atlas", deadline: "2026-10-09T11:30:00.000Z", tags: ["draft"] });
    const archived = await DELETE(request(first, "DELETE"), context(id));
    expect(archived.status).toBe(200);
    const after = (await readState(first.id)).records.find(record => record.id === id)!;
    expect(after.status).toBe("archived");
    expect(after.content).toBe("Task: Prepare the outline soon");
    expect(after.capture_id).toBe(saved.records[0].capture_id);
    expect((await updateRecord(first.id, id, { status: "active" })).record.status).toBe("active");
  });

  it.each([
    ["2026-10-10T06:30:37.456Z", "Asia/Kolkata"],
    ["2026-11-01T01:30:00-04:00", "America/New_York"],
    ["2026-11-01T06:30:00.000Z", "America/New_York"],
  ])("persists a heading correction without rewriting the unchanged deadline %s", async (original, timezone) => {
    const saved = await captureRecords(first.id, "Note: Keep this original wording", { now });
    const id = saved.records[0].id;
    await mutateState(first.id, state => {
      state.records.find(record => record.id === id)!.deadline = original;
    });
    const openedDate = inputDate(original, timezone);
    const corrected = await PATCH(request(first, "PATCH", {
      title: "Revised heading",
      ...deadlinePatchFromInput(openedDate, openedDate, timezone),
    }), context(id));
    expect(corrected.status).toBe(200);
    expect((await corrected.json()).record).toMatchObject({ deadline: original, content: saved.records[0].content });
    expect((await readState(first.id)).records.find(record => record.id === id)?.deadline).toBe(original);
  });

  it("keeps a newer server deadline when an older modal saves another field", async () => {
    const saved = await captureRecords(first.id, "Task: Review the launch memo", { now });
    const id = saved.records[0].id;
    const openedDeadline = "2026-10-10T06:30:37.456Z";
    const opened = await updateRecord(first.id, id, { deadline: openedDeadline });
    const openedDate = inputDate(opened.record.deadline, "Asia/Kolkata");
    await updateRecord(first.id, id, { deadline: "2026-10-10T07:30:37.456Z" });
    const corrected = await PATCH(request(first, "PATCH", {
      title: "Revised launch memo",
      ...deadlinePatchFromInput(openedDate, openedDate, "Asia/Kolkata"),
    }), context(id));
    expect(corrected.status).toBe(200);
    expect((await corrected.json()).record.deadline).toBe("2026-10-10T07:30:37.456Z");
  });

  it("rejects invalid dates, untrusted mutation origins, unauthenticated reads and invalid bodies", async () => {
    const saved = await captureRecords(first.id, "Note: Validation target", { now });
    const id = saved.records[0].id;
    expect((await PATCH(request(first, "PATCH", { deadline: "2026-02-30T12:00:00Z" }), context(id))).status).toBe(400);
    expect((await PATCH(request(first, "PATCH", { user_id: second.id }), context(id))).status).toBe(400);
    expect((await POST(request(first, "POST", { text: "  " }))).status).toBe(400);
    expect((await GET(new Request("http://localhost/api/records"))).status).toBe(401);
    const crossSite = request(first, "POST", { text: "Do not save cross site" });
    crossSite.headers.set("origin", "https://untrusted.example");
    expect((await POST(crossSite)).status).toBe(403);
    const tooLarge = request(first, "POST", { text: "Too large" });
    tooLarge.headers.set("content-length", "70000");
    expect((await POST(tooLarge)).status).toBe(413);
  });

  it("expands an old file snapshot without changing its commitments or saved theme", async () => {
    const legacyUser = randomUUID();
    const before = await readState(legacyUser);
    const legacy = { ...before } as Partial<AppState>;
    delete legacy.records;
    legacy.settings = { ...before.settings, theme: "dark" };
    await writeFile(path.join(directory, `state-${legacyUser}.json`), JSON.stringify(legacy));
    const normalized = await readState(legacyUser);
    expect(normalized.records).toEqual([]);
    expect(normalized.commitments).toEqual(before.commitments);
    expect(normalized.settings.theme).toBe("dark");
    expect(defaultSettings().theme).toBe("light");
    await expect(mutateState(legacyUser, state => { state.records.push({ ...(savedRecord()), user_id: second.id }); })).rejects.toThrow("another user");
    expect((await readState(legacyUser)).records).toEqual([]);
  });
});

function savedRecord(): CapturedRecord {
  return { id: randomUUID(), user_id: first.id, title: "Foreign", content: "Foreign", collection: "Notes", kind: "note", tags: [], contacts: [], deadline: null, source: "text", status: "active", capture_id: randomUUID(), created_at: now.toISOString(), updated_at: now.toISOString(), interpretation: { provider: "local", confidence: 1, warnings: [], inferred_fields: [] } };
}
