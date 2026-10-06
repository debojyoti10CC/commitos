import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import * as React from "react";
import { mkdir, open, rename } from "node:fs/promises";
import { proxy } from "../proxy";
import { readState, mutateState } from "@/lib/db/repository";
import { createDemoSession, validateDemoSession } from "@/lib/auth";
import { configuredSupabase, isDemoMode } from "@/lib/db/supabase";
import { dataDirectory, localSigningKey } from "@/lib/db/local";
import { emptyImportTarget } from "@/lib/records/local-import";
import { errorResponse } from "@/lib/http";
import { SupabaseConfigurationError } from "@/lib/db/supabase";
import { POST as authenticate } from "@/app/api/auth/[action]/route";

const stubs = vi.hoisted(() => ({
  getUser: vi.fn(async () => ({ data: { user: null as { id: string; email: string } | null }, error: null })),
  rpc: vi.fn(),
  createClient: vi.fn(),
  serverClient: vi.fn(),
}));
vi.mock("@supabase/ssr", () => ({ createServerClient: stubs.serverClient }));
vi.mock("@supabase/supabase-js", () => ({ createClient: stubs.createClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: vi.fn() }) }));
vi.mock("next/server", async (original) => ({ ...await original<typeof import("next/server")>(), connection: async () => {} }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const blocked = () => { throw Object.assign(new Error("ENOENT: mkdir '/var/task/.data'"), { code: "ENOENT" }); };
  return { ...actual, mkdir: vi.fn(blocked), open: vi.fn(blocked), rename: vi.fn(blocked) };
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ["DEMO_MODE", "DEMO_DATA_DIR", "SESSION_SECRET", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "VERCEL_ENV", "AWS_LAMBDA_FUNCTION_NAME"])
    vi.stubEnv(key, undefined);
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("APP_URL", "https://commitos.example");
  stubs.serverClient.mockReturnValue({ auth: { getUser: stubs.getUser } });
  stubs.createClient.mockReturnValue({ rpc: stubs.rpc });
  stubs.getUser.mockResolvedValue({ data: { user: null }, error: null });
  stubs.rpc.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function configureServer() {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-only-public-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-only-server-key");
}
function noFileWrites() {
  expect(mkdir).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(rename).not.toHaveBeenCalled();
}

describe("hosted storage cannot fall back to a writable local filesystem", () => {
  it("returns an actionable 503 on GET / instead of creating a demo session when env is absent", async () => {
    const response = await proxy(new NextRequest("https://commitos.example/"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Supabase") });
    expect(stubs.serverClient).not.toHaveBeenCalled();
    noFileWrites();
  });

  it("ignores explicit hosted DEMO_MODE=true rather than creating disposable records", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    expect(isDemoMode()).toBe(false);
    expect((await proxy(new NextRequest("https://commitos.example/"))).status).toBe(503);
    await expect(createDemoSession()).rejects.toMatchObject({ status: 503 });
    expect(await validateDemoSession("old-demo.signature")).toBeNull();
    noFileWrites();
  });

  it.each(["/login", "/register"])("renders public %s in unconfigured mode without filesystem or Auth writes", async (pathname) => {
    const response = await proxy(new NextRequest(`https://commitos.example${pathname}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.cookies.get("commitos_demo")).toBeUndefined();
    vi.stubGlobal("React", React);
    const page = pathname === "/login" ? await import("@/app/login/page") : await import("@/app/register/page");
    expect((await page.default()).props.mode).toBe("unconfigured");
    expect(stubs.serverClient).not.toHaveBeenCalled();
    noFileWrites();
  });

  it("requires the hosted server key even when public Auth values exist", async () => {
    configureServer();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(configuredSupabase()).toBe(false);
    const response = await proxy(new NextRequest("https://commitos.example/api/records"));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(body.error).not.toContain("test-only-public-key");
    noFileWrites();
  });

  it.each(["not-a-url", "file:///var/task", "https://user:password@example.com"])("rejects invalid Supabase URL configuration before initializing a client: %s", async (url) => {
    configureServer();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", url);
    expect(configuredSupabase()).toBe(false);
    expect((await proxy(new NextRequest("https://commitos.example/"))).status).toBe(503);
    expect(stubs.serverClient).not.toHaveBeenCalled();
    noFileWrites();
  });

  it("fails closed in repository reads/mutations and reports a safe configuration 503", async () => {
    const user = randomUUID(), mutator = vi.fn();
    await expect(readState(user)).rejects.toBeInstanceOf(SupabaseConfigurationError);
    await expect(mutateState(user, mutator)).rejects.toMatchObject({ status: 503 });
    expect(mutator).not.toHaveBeenCalled();
    const response = errorResponse(new SupabaseConfigurationError());
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await response.json()).error).toContain("NEXT_PUBLIC_SUPABASE_URL");
    noFileWrites();
  });

  it("keeps hosted sign-in available as a public route but returns a configuration error before Auth network access", async () => {
    const response = await authenticate(new Request("https://commitos.example/api/auth/login", {
      method: "POST", headers: { origin: "https://commitos.example", "content-type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", password: "test-only-password" }),
    }), { params: Promise.resolve({ action: "login" }) });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("Supabase");
    expect(stubs.serverClient).not.toHaveBeenCalled();
    noFileWrites();
  });

  it("preserves existing Supabase records and uses its versioned save with no local writes", async () => {
    configureServer();
    vi.stubEnv("DEMO_MODE", "true");
    const user = randomUUID(), original = emptyImportTarget(user);
    original.version = 7;
    original.records.push({
      id: randomUUID(), user_id: user, title: "Existing record", content: "Keep the original captured wording.",
      kind: "task", collection: "Work", tags: [], contacts: [], source: "voice", status: "active", capture_id: randomUUID(),
      created_at: "2026-10-05T12:00:00.000Z", updated_at: "2026-10-05T12:00:00.000Z", deadline: "2026-10-10T06:30:00.000Z",
      interpretation: { provider: "local", confidence: 1, warnings: [], inferred_fields: [] },
    });
    stubs.rpc.mockImplementation(async (name, args) => name === "load_commitos_state"
      ? { data: structuredClone(original), error: null }
      : { data: args.p_expected_version + 1, error: null });
    expect((await readState(user)).records).toEqual(original.records);
    const saved = await mutateState(user, state => { state.settings.name = "Updated account name"; });
    expect(saved.records).toEqual(original.records);
    expect(saved.version).toBe(8);
    expect(stubs.rpc).toHaveBeenCalledWith("save_commitos_state", expect.objectContaining({ p_user_id: user, p_expected_version: 7, p_state: expect.objectContaining({ records: original.records }) }));
    noFileWrites();
  });

  it("retains Supabase authentication protection and rejects old demo cookies", async () => {
    configureServer();
    const headers = { cookie: "commitos_demo=old-demo.signature" };
    const page = await proxy(new NextRequest("https://commitos.example/", { headers }));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("https://commitos.example/login");
    expect((await proxy(new NextRequest("https://commitos.example/api/records", { headers }))).status).toBe(401);
    expect(stubs.getUser).toHaveBeenCalledTimes(2);
    noFileWrites();
  });

  it("guards direct local storage and key fallback even when a temporary directory is configured", async () => {
    vi.stubEnv("DEMO_DATA_DIR", "/tmp/commitos");
    expect(() => dataDirectory()).toThrow("durable records");
    await expect(localSigningKey()).rejects.toMatchObject({ status: 503 });
    vi.stubEnv("SESSION_SECRET", "test-only-signing-secret-32-characters-long");
    expect(await localSigningKey()).toEqual(Buffer.from(process.env.SESSION_SECRET!));
    noFileWrites();
  });

  it.each(["VERCEL_ENV", "AWS_LAMBDA_FUNCTION_NAME"])("forbids hosted demo using %s when VERCEL is absent", (key) => {
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv(key, key === "VERCEL_ENV" ? "preview" : "test-function");
    vi.stubEnv("DEMO_MODE", "true");
    expect(isDemoMode()).toBe(false);
    expect(() => dataDirectory()).toThrow("hosted functions");
    noFileWrites();
  });

  it("recognizes /var/task when platform system variables are unavailable", async () => {
    vi.stubEnv("VERCEL", undefined);
    vi.spyOn(process, "cwd").mockReturnValue("/var/task");
    expect(isDemoMode()).toBe(false);
    expect((await proxy(new NextRequest("https://commitos.example/"))).status).toBe(503);
    noFileWrites();
  });

  it("preserves ordinary local development demo/session behavior", async () => {
    vi.stubEnv("VERCEL", undefined);
    expect(isDemoMode()).toBe(true);
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("SESSION_SECRET", "test-only-signing-secret-32-characters-long");
    const demo = await createDemoSession();
    expect(await validateDemoSession(demo.token)).toBe(demo.id);
    const response = await proxy(new NextRequest("http://localhost/"));
    expect(response.status).toBe(200);
    expect(response.cookies.get("commitos_demo")).toBeDefined();
    vi.stubEnv("DEMO_MODE", "false");
    expect(isDemoMode()).toBe(false);
    noFileWrites();
  });
});
