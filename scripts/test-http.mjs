import assert from "node:assert/strict";
const origin = process.env.CHECK_ORIGIN || "http://127.0.0.1:3001";
const jars = { a: "", b: "" };
const checks = [];
async function request(
  url,
  { method = "GET", body, who = "a", headers = {} } = {},
) {
  const response = await fetch(origin + url, {
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
    jars[who] = cookies.map((c) => c.split(";")[0]).join("; ");
  let result;
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  return { status: response.status, ...result };
}
const first = await request("/api/state");
assert.equal(first.status, 200);
assert.equal(first.mode, "demo");
assert(first.state.commitments.length > 0);
checks.push("signed demo session and seed");
const parsed = await request("/api/commitments/parse", {
  method: "POST",
  body: {
    text: "Finish HydraDB video tonight by 9. Need to send them an update around 6. Will probably take two hours.",
  },
});
assert.equal(parsed.status, 200);
assert.equal(parsed.parsed.estimatedMinutes, 120);
assert(parsed.parsed.deadline && parsed.parsed.checkInAt);
checks.push("natural language capture");
const created = await request("/api/commitments", {
  method: "POST",
  body: { parsed: parsed.parsed },
});
assert.equal(created.status, 201);
const id = created.commitment.id;
checks.push("commitment persisted");
const plan = await request("/api/planning/generate", {
  method: "POST",
  body: { apply: true },
});
assert.equal(plan.status, 200);
assert(Array.isArray(plan.plan.blocks));
assert(Array.isArray(plan.plan.unscheduled));
checks.push("feasible plan and unscheduled risk");
const started = await request(`/api/commitments/${id}/start`, {
  method: "POST",
  body: {},
});
assert.equal(started.status, 200);
assert(
  started.state.sessions.some((s) => s.commitment_id === id && !s.ended_at),
);
const reload = await request("/api/state");
assert(
  reload.state.sessions.some((s) => s.commitment_id === id && !s.ended_at),
);
checks.push("focus session survives state reload");
const finished = await request(`/api/commitments/${id}/complete`, {
  method: "POST",
  body: {},
});
assert.equal(finished.status, 200);
assert.equal(
  finished.state.commitments.find((c) => c.id === id).status,
  "done",
);
assert(
  finished.state.sessions
    .filter((s) => s.commitment_id === id)
    .every((s) => s.ended_at),
);
checks.push("completion closes work session");
const chase = await request("/api/reminders/run", { method: "POST", body: {} });
assert.equal(chase.status, 200);
assert(
  !chase.state.reminders.some(
    (r) => r.commitment_id === id && r.status === "sending",
  ),
);
checks.push("reminder terminal suppression");
const review = await request("/api/review/evening", {
  method: "POST",
  body: { summary: "HTTP acceptance workflow completed" },
});
assert.equal(review.status, 200);
assert(review.review.completed_count >= 1);
assert.equal((await request("/api/review/morning")).status, 200);
checks.push("night review and morning briefing");
assert.equal((await request("/api/state", { who: "b" })).status, 200);
assert.equal(
  (
    await request(`/api/commitments/${id}`, {
      method: "PATCH",
      who: "b",
      body: { title: "Unauthorized edit" },
    })
  ).status,
  404,
);
checks.push("cross-user isolation");
assert.equal(
  (
    await request("/api/commitments", {
      method: "POST",
      body: { title: "Bad URL", source_url: "javascript:alert(1)" },
    })
  ).status,
  400,
);
assert.equal(
  (
    await request("/api/planning/generate", {
      method: "POST",
      body: { day: "2026-02-31" },
    })
  ).status,
  400,
);
assert.equal(
  (
    await request("/api/settings", {
      method: "POST",
      body: { name: "Attack" },
      headers: { origin: "https://attacker.example" },
    })
  ).status,
  403,
);
assert.equal(
  (await request("/api/cron/reminders", { method: "POST", body: {} })).status,
  401,
);
assert.equal(
  (await request("/api/telegram/webhook", { method: "POST", body: {} })).status,
  401,
);
checks.push("invalid input, URL, origin, cron and webhook rejected");
const device = await request("/api/devices", {
  method: "POST",
  body: { label: "Disposable HTTP QA" },
});
assert.equal(device.status, 200);
const deviceNow = await request("/api/device/now", {
  headers: { authorization: `Bearer ${device.token}` },
});
assert.equal(deviceNow.status, 200);
const devices = await request("/api/devices");
assert(devices.devices.some((item) => item.id === device.id));
assert(!JSON.stringify(devices).includes(device.token));
assert.equal((await request("/api/device/snapshot")).status, 401);
const bearer = { authorization: `Bearer ${device.token}` };
const snapshot = await request("/api/device/snapshot", { headers: bearer });
assert.equal(snapshot.status, 200);
assert.equal(snapshot.version, 1);
assert(snapshot.next.length <= 3);
checks.push("public device metadata and compact authenticated snapshot");
const deskTask = await request("/api/commitments", {
  method: "POST",
  body: { title: "Disposable desk HTTP task", estimated_minutes: 20 },
});
assert.equal(deskTask.status, 201);
const deskId = deskTask.commitment.id;
assert.equal(
  (
    await request(`/api/device/${deskId}/start`, {
      method: "POST",
      body: {},
      headers: bearer,
    })
  ).status,
  200,
);
const runningDesk = await request("/api/device/snapshot", { headers: bearer });
assert.equal(runningDesk.now.id, deskId);
assert.equal(runningDesk.timer.commitment_id, deskId);
assert.equal(
  (
    await request(`/api/device/${deskId}/pause`, {
      method: "POST",
      body: {},
      headers: bearer,
    })
  ).status,
  200,
);
assert.equal(
  (await request("/api/device/snapshot", { headers: bearer })).timer,
  null,
);
assert.equal(
  (
    await request(`/api/device/${deskId}/complete`, {
      method: "POST",
      body: {},
      headers: bearer,
    })
  ).status,
  200,
);
assert.notEqual(
  (await request("/api/device/snapshot", { headers: bearer })).now?.id,
  deskId,
);
checks.push("desk start, live timer, pause and completion");
assert.equal((await request("/desk")).status, 200);
checks.push("desk page served successfully");
assert.equal(
  (await request(`/api/devices/${device.id}`, { method: "DELETE" })).status,
  200,
);
assert.equal(
  (
    await request("/api/device/now", {
      headers: { authorization: `Bearer ${device.token}` },
    })
  ).status,
  401,
);
checks.push("device issue, authenticated read, revocation");
assert.equal(
  (await request("/api/device/snapshot", { headers: bearer })).status,
  401,
);
console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
