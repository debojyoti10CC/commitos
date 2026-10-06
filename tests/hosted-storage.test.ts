import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { mkdir, open, rename } from "node:fs/promises";
import { proxy } from "../proxy";
import { readState, mutateState } from "@/lib/db/repository";
import { createDemoSession, validateDemoSession } from "@/lib/auth";
import { configuredSupabase, isDemoMode } from "@/lib/db/supabase";

const stubs = vi.hoisted(() => ({
  getUser: vi.fn(async () => ({ data: { user: null as { id: string; email: string } | null }, error: null })),
  rpc: vi.fn(),
  createClient: vi.fn(),
  serverClient: vi.fn(),
}));
vi.mock("@supabase/ssr", () => ({ createServerClient: stubs.serverClient }));
vi.mock("@supabase/supabase-js", () => ({ createClient: stubs.createClient }));
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
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("hosted storage cannot fall back to a writable local filesystem", () => {
  it("returns an actionable 503 on GET / instead of creating a demo session when env is absent", async () => {
    const response = await proxy(new NextRequest("https://commitos.example/"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Supabase") });
    expect(mkdir).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
