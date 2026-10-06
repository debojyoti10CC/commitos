import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  emptyImportTarget, mergeLocalRecordImport, prepareLocalRecordImport,
} from "@/lib/records/local-import";
import type { CapturedRecord } from "@/lib/records/types";
import type { AppState } from "@/lib/types";

const sourceOwner = randomUUID(), targetUser = randomUUID();
const sourceProjectId = randomUUID(), sourceContactId = randomUUID();
const captureId = `${randomUUID()}:${"a".repeat(64)}`;
const record = (extra: Partial<CapturedRecord> = {}): CapturedRecord => ({
  id: randomUUID(), user_id: sourceOwner, title: "Submit assignment",
  content: "Original voice wording stays exactly here.", kind: "task", collection: "Atlas",
  tags: ["study"], contacts: ["Ravi"], deadline: "2026-10-09T18:30:00.000Z",
  created_at: "2026-10-05T16:01:09.325Z", updated_at: "2026-10-05T16:01:09.325Z",
  source: "voice", status: "active", capture_id: captureId,
  interpretation: { provider: "local", confidence: .8, warnings: ["Review wording"], inferred_fields: ["kind"] },
  ...extra,
});
function fixture() {
  const captured = record();
  return {
    user_id: sourceOwner, records: [captured],
    projects: [
      { id: sourceProjectId, user_id: sourceOwner, name: "Atlas", description: "Associated", color: "#111111", archived: false, created_at: captured.created_at },
      { id: randomUUID(), user_id: sourceOwner, name: "Unrelated sample", description: "Do not import", color: "#111111", archived: false, created_at: captured.created_at },
    ],
    contacts: [
      { id: sourceContactId, user_id: sourceOwner, name: "Ravi", organization: "", email: "ravi@example.com", telegram: "", notes: "Existing association" },
      { id: randomUUID(), user_id: sourceOwner, name: "Unrelated sample", organization: "", email: "", telegram: "", notes: "" },
    ],
    commitments: [{ id: randomUUID(), user_id: sourceOwner, title: "Legacy demo sample" }],
    sessions: [{ notes: "Never import" }], integrations: [{ connected: true }],
    secrets: { forbidden: "Never import integration credentials" }, settings: { telegram_enabled: true },
  };
}

describe("selected local records import", () => {
  it("preserves every record field except owner and includes only referenced associations", () => {
    const source = fixture(), original = structuredClone(source);
    const plan = prepareLocalRecordImport(source, sourceOwner, targetUser);
    const merged = mergeLocalRecordImport(emptyImportTarget(targetUser), plan);
    expect(merged.state.records[0]).toEqual({ ...original.records[0], user_id: targetUser });
    expect(source).toEqual(original);
    expect(merged.state.projects).toHaveLength(1);
    expect(merged.state.contacts).toHaveLength(1);
    expect(merged.state.projects[0]).toMatchObject({ user_id: targetUser, name: "Atlas" });
    expect(merged.state.projects[0].id).not.toBe(sourceProjectId);
    expect(merged.state.contacts[0].id).not.toBe(sourceContactId);
    expect(merged.state.commitments).toEqual([]);
    expect(merged.state.sessions).toEqual([]);
    expect(merged.state.integrations).toEqual([]);
    expect(merged.state.settings.telegram_enabled).toBe(false);
    expect(merged.state).not.toHaveProperty("secrets");
  });

  it("skips legacy adapter records while retaining archived genuine captures", () => {
    const source = fixture();
    const legacyId = `legacy:${randomUUID()}`;
    source.records.push(record({ id: legacyId, source: "legacy", capture_id: legacyId }), record({ status: "archived", capture_id: randomUUID() }));
    const plan = prepareLocalRecordImport(source, sourceOwner, targetUser);
    expect(plan.skippedLegacyRecords).toBe(1);
    expect(plan.records).toHaveLength(2);
    expect(plan.records.some(entry => entry.status === "archived")).toBe(true);
  });

  it("is stable across replay and PostgreSQL timestamp formatting", () => {
    const source = fixture();
    const first = prepareLocalRecordImport(source, sourceOwner, targetUser);
    const second = prepareLocalRecordImport(source, sourceOwner, targetUser);
    expect(second).toEqual(first);
    const stored = mergeLocalRecordImport(emptyImportTarget(targetUser), first).state;
    stored.records[0].deadline = "2026-10-09T18:30:00+00:00";
    stored.records[0].created_at = "2026-10-05T16:01:09.325+00:00";
    stored.records[0].updated_at = "2026-10-05T16:01:09.325+00:00";
    const before = structuredClone(stored);
    const replay = mergeLocalRecordImport(stored, second);
    expect(replay.summary).toMatchObject({ addedRecords: 0, existingRecords: 1, addedProjects: 0, addedContacts: 0 });
    expect(replay.state).toEqual(before);
    expect(stored).toEqual(before);
  });

  it("reuses existing named associations and preserves unrelated target data", () => {
    const source = fixture(), target = emptyImportTarget(targetUser);
    target.projects = [{ ...source.projects[0], id: randomUUID(), user_id: targetUser, name: "atlas", description: "Keep account description" }];
    target.contacts = [{ ...source.contacts[0], id: randomUUID(), user_id: targetUser, name: "ravi", notes: "Keep account note" }];
    target.records.push(record({ user_id: targetUser, capture_id: randomUUID(), title: "Unrelated account record" }));
    const before = structuredClone(target);
    const merged = mergeLocalRecordImport(target, prepareLocalRecordImport(source, sourceOwner, targetUser));
    expect(merged.state.projects).toEqual(before.projects);
    expect(merged.state.contacts).toEqual(before.contacts);
    expect(merged.state.records[0]).toEqual(before.records[0]);
    expect(merged.summary).toMatchObject({ addedRecords: 1, addedProjects: 0, addedContacts: 0 });
  });

  it("rejects source/target owner mismatch and foreign rows before merging", () => {
    const source = fixture();
    expect(() => prepareLocalRecordImport(source, randomUUID(), targetUser)).toThrow("another owner");
    source.records[0].user_id = randomUUID();
    expect(() => prepareLocalRecordImport(source, sourceOwner, targetUser)).toThrow("foreign captured record");
    const plan = prepareLocalRecordImport(fixture(), sourceOwner, targetUser);
    expect(() => mergeLocalRecordImport(emptyImportTarget(randomUUID()), plan)).toThrow("verified account");
    const target = emptyImportTarget(targetUser);
    target.contacts.push({ id: randomUUID(), user_id: randomUUID(), name: "Foreign", organization: "", email: "", telegram: "", notes: "" });
    expect(() => mergeLocalRecordImport(target, plan)).toThrow("another account");
  });

  it("rejects record ID and capture request collisions without overwriting target", () => {
    const source = fixture(), plan = prepareLocalRecordImport(source, sourceOwner, targetUser);
    const target = emptyImportTarget(targetUser);
    target.records = [{ ...plan.records[0], content: "Different existing content" }];
    const before = structuredClone(target);
    expect(() => mergeLocalRecordImport(target, plan)).toThrow("Record ID collision");
    expect(target).toEqual(before);
    target.records = [{ ...plan.records[0], id: randomUUID(), capture_id: captureId.replace(/a{64}$/, "b".repeat(64)) }];
    expect(() => mergeLocalRecordImport(target, plan)).toThrow("Capture request collision");
    source.records.push(structuredClone(source.records[0]));
    expect(() => prepareLocalRecordImport(source, sourceOwner, targetUser)).toThrow("duplicate record IDs");
  });

  it("rejects association ID collisions and gives different accounts distinct association IDs", () => {
    const source = fixture(), plan = prepareLocalRecordImport(source, sourceOwner, targetUser);
    const other = prepareLocalRecordImport(source, sourceOwner, randomUUID());
    expect(other.projects[0].id).not.toBe(plan.projects[0].id);
    expect(other.contacts[0].id).not.toBe(plan.contacts[0].id);
    const target = emptyImportTarget(targetUser);
    target.projects = [{ ...plan.projects[0], name: "Different project" }];
    expect(() => mergeLocalRecordImport(target, plan)).toThrow("Project ID collision");
    expect(target.records).toEqual([]);
  });
});

const app = process.cwd(), scratch = path.resolve(app, "..", "..", "work");
const directory = path.join(scratch, `import-cli-tests-${randomUUID()}`);
afterAll(async () => { if (directory.startsWith(scratch + path.sep)) await rm(directory, { recursive: true, force: true }); });
async function cli(extra: string[] = []) {
  const env = { ...process.env };
  for (const key of ["DEMO_MODE", "DEMO_DATA_DIR", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) delete env[key];
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(app, "node_modules", "tsx", "dist", "cli.mjs"), "--tsconfig", path.join(app, "tsconfig.json"), path.join(app, "scripts", "import-local-records.ts"), "--source-owner", sourceOwner, "--target-user", targetUser, ...extra], { cwd: directory, env, windowsHide: true });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject); child.on("close", code => resolve({ code, output }));
  });
}

describe("CLI dry-run and transaction retry against a local fake Supabase transport", () => {
  it("loads .env.local, verifies Auth, never writes in dry-run, retries a concurrent change and safely replays", async () => {
    await mkdir(path.join(directory, ".data"), { recursive: true });
    const source = fixture(), original = JSON.stringify(source, null, 2);
    const sourceFile = path.join(directory, ".data", `state-${sourceOwner}.json`);
    await writeFile(sourceFile, original);
    let stored: AppState | null = null, writes = 0, conflictOnce = true, authCalls = 0;
    const concurrent = record({ user_id: targetUser, title: "Concurrent record", capture_id: randomUUID() });
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.startsWith("/auth/v1/admin/users/")) {
        authCalls++; response.end(JSON.stringify({ id: targetUser, email: "test@example.com" })); return;
      }
      if (request.url === "/rest/v1/rpc/load_commitos_state") { response.end(JSON.stringify(stored)); return; }
      if (request.url === "/rest/v1/rpc/save_commitos_state") {
        let body = ""; for await (const chunk of request) body += chunk;
        const parsed = JSON.parse(body);
        if (stored && conflictOnce) {
          conflictOnce = false; stored.records.push(concurrent); stored.version++;
          response.statusCode = 409; response.end(JSON.stringify({ code: "P0001", message: "VERSION_CONFLICT" })); return;
        }
        expect(parsed.p_expected_version).toBe(stored?.version ?? 0);
        stored = { ...parsed.p_state, version: parsed.p_expected_version + 1 };
        writes++; response.end(JSON.stringify(stored!.version)); return;
      }
      response.statusCode = 404; response.end(JSON.stringify({ error: "Unexpected test request" }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local test listener");
    await writeFile(path.join(directory, ".env.local"), `DEMO_MODE=false\nNEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:${address.port}\nNEXT_PUBLIC_SUPABASE_ANON_KEY=test-only-public-key\nSUPABASE_SERVICE_ROLE_KEY=test-only-server-key\n`);
    try {
      const dry = await cli();
      expect(dry.code).toBe(0);
      expect(JSON.parse(dry.output.trim())).toMatchObject({ mode: "dry-run", wrote: false, addedRecords: 1 });
      expect(writes).toBe(0); expect(stored).toBeNull(); expect(authCalls).toBe(1);
      expect(await readFile(sourceFile, "utf8")).toBe(original);
      const applied = await cli(["--apply"]);
      expect(applied.code).toBe(0);
      expect(JSON.parse(applied.output.trim())).toMatchObject({ mode: "apply", wrote: true, addedRecords: 1 });
      const persisted = stored as AppState | null;
      expect(persisted?.records).toContainEqual({ ...source.records[0], user_id: targetUser });
      expect(persisted?.records).toContainEqual(concurrent);
      expect(persisted?.commitments).toEqual([]);
      expect(writes).toBe(2); // Empty account initialization, then one complete merge.
      const version = persisted?.version;
      const again = await cli(["--apply"]);
      expect(again.code).toBe(0);
      expect(JSON.parse(again.output.trim())).toMatchObject({ wrote: false, addedRecords: 0, existingRecords: 1 });
      expect(writes).toBe(2); expect((stored as AppState | null)?.version).toBe(version);
      expect(await readFile(sourceFile, "utf8")).toBe(original);
      expect(applied.output).not.toContain("test-only-server-key");
      expect(applied.output).not.toContain(source.records[0].content);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }, 20000);

  it("stops if the target Auth user cannot be verified", async () => {
    let rpcCalls = 0;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.startsWith("/rest/v1/")) rpcCalls++;
      response.statusCode = 404; response.end(JSON.stringify({ message: "User not found" }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local test listener");
    await writeFile(path.join(directory, ".env.local"), `DEMO_MODE=false\nNEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:${address.port}\nNEXT_PUBLIC_SUPABASE_ANON_KEY=test-only-public-key\nSUPABASE_SERVICE_ROLE_KEY=test-only-server-key\n`);
    try {
      const result = await cli(["--apply"]);
      expect(result.code).toBe(1);
      expect(result.output).toContain("Could not verify the target account");
      expect(result.output).not.toContain("test-only-server-key");
      expect(rpcCalls).toBe(0);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }, 10000);
});
