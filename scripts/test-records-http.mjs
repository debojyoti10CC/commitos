import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const origin = process.env.CHECK_ORIGIN || "http://127.0.0.1:3001";
const jars = { a: "", b: "" };
const checks = [];
async function request(
  path,
  { method = "GET", body, who = "a", headers = {} } = {},
) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      ...headers,
      ...(jars[who] ? { cookie: jars[who] } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length)
    jars[who] = cookies.map((cookie) => cookie.split(";")[0]).join("; ");
  const data = await response.json();
  return { status: response.status, headers: response.headers, ...data };
}
const seed = await request("/api/state");
assert.equal(seed.status, 200);
assert(Array.isArray(seed.state.records));
checks.push("existing workspace loads with a records collection");
const requestId = randomUUID();
const text =
  "HydraDB: Send the onboarding video tomorrow at 9 PM\nIdea for HydraDB: simplify signup\nRohan prefers email updates.\nSave https://example.com/guide for HydraDB";
const captured = await request("/api/records", {
  method: "POST",
  body: { text, source: "text", request_id: requestId },
});
assert([200, 201].includes(captured.status));
assert.equal(captured.records.length, 4);
assert.deepEqual(
  new Set(captured.records.map((record) => record.kind)),
  new Set(["task", "idea", "note", "reference"]),
);
assert.equal(captured.records.filter((record) => record.deadline).length, 1);
assert(
  captured.records.every(
    (record) => record.content && record.created_at && record.interpretation,
  ),
);
assert(
  captured.records
    .filter((record) => record.content.includes("HydraDB"))
    .every((record) => record.collection === "HydraDB"),
);
checks.push(
  "mixed capture saves automatically and files tasks, ideas, notes, and links",
);
const savedId = captured.records.find((record) => record.kind === "task").id;
const loaded = await request("/api/state");
assert(
  captured.records.every((record) =>
    loaded.state.records.some((saved) => saved.id === record.id),
  ),
);
const listed = await request("/api/records");
assert.equal(listed.status, 200);
assert(listed.headers.get("cache-control")?.includes("no-store"));
assert(
  captured.records.every((record) =>
    listed.records.some((saved) => saved.id === record.id),
  ),
);
checks.push(
  "records and original content survive reload and private list reads",
);
const replay = await request("/api/records", {
  method: "POST",
  body: { text, source: "text", request_id: requestId },
});
assert.deepEqual(
  replay.records.map((record) => record.id),
  captured.records.map((record) => record.id),
);
const mismatch = await request("/api/records", {
  method: "POST",
  body: { text: "A different thought", source: "text", request_id: requestId },
});
assert.equal(mismatch.status, 409);
checks.push("capture retries do not duplicate records");
const note = await request("/api/records", {
  method: "POST",
  body: {
    text: "My preferred notebook has plain pages.",
    source: "voice",
    request_id: randomUUID(),
  },
});
assert([200, 201].includes(note.status));
assert.equal(note.records[0].kind, "note");
assert.equal(note.records[0].deadline, null);
assert.equal(note.records[0].source, "voice");
checks.push(
  "general information and voice transcripts are retained without invented deadlines",
);
const speechDate = await request("/api/records", {
  method: "POST",
  body: {
    text: "IIT submission assignment by 10th October 2026 12 a.m. and I need to get an update",
    source: "voice",
    request_id: randomUUID(),
  },
});
assert.equal(speechDate.status, 200);
assert.equal(speechDate.records[0].deadline, "2026-10-09T18:30:00.000Z");
assert.equal(speechDate.records[0].title, "Submit IIT assignment");
assert(speechDate.records[0].content.includes("and I need to get an update"));
checks.push(
  "speech creates a brief heading while preserving October 10 and original wording",
);
const corrected = await request(`/api/records/${savedId}`, {
  method: "PATCH",
  body: {
    title: "Send onboarding video",
    collection: "Launch",
    deadline: null,
  },
});
assert.equal(corrected.status, 200);
assert.equal(corrected.record.collection, "Launch");
assert.equal(corrected.record.deadline, null);
assert(corrected.record.content.includes("tomorrow at 9 PM"));
checks.push(
  "classification and dates can be corrected while original content stays saved",
);
await request("/api/state", { who: "b" });
const other = await request("/api/records", { who: "b" });
assert(!other.records.some((record) => record.id === savedId));
const foreign = await request(`/api/records/${savedId}`, {
  method: "PATCH",
  who: "b",
  body: { title: "Not owned" },
});
assert.equal(foreign.status, 404);
checks.push("record reads and edits are scoped to their owner");
for (const body of [{ text: "" }, { text: "Hello", source: "invalid" }])
  assert.equal(
    (await request("/api/records", { method: "POST", body })).status,
    400,
  );
assert.equal(
  (
    await request(`/api/records/${savedId}`, {
      method: "PATCH",
      body: { deadline: "not-a-date" },
    })
  ).status,
  400,
);
assert.equal(
  (
    await request("/api/records", {
      method: "POST",
      body: { text: "Hello" },
      headers: { Origin: "https://unrelated.example" },
    })
  ).status,
  403,
);
checks.push("invalid capture, dates, and foreign origins are rejected");
for (const path of [
  "/dashboard",
  "/today",
  "/commitments",
  "/projects",
  "/people",
])
  assert.equal((await fetch(origin + path)).status, 200);
const desk = await fetch(origin + "/desk");
assert.equal(desk.status, 200);
// A prerendered Next redirect is delivered as a browser meta refresh.
assert(
  desk.url.endsWith("/dashboard") ||
    /<meta[^>]+http-equiv="refresh"[^>]+content="\d+;url=\/dashboard"/.test(
      await desk.text(),
    ),
);
checks.push(
  "unified record pages serve and old desk links lead to the capture app",
);
console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
