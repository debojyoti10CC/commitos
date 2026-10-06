import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  createDemoSession,
  requireUser,
  validateDemoSession,
  DEMO_COOKIE,
  assertSameOrigin,
} from "@/lib/auth";
import {
  createTelegramPairing,
  findUserByTelegramChat,
  getIntegrationSecret,
  mutateState,
  readState,
  redeemTelegramPairing,
  setIntegrationSecret,
} from "@/lib/db/repository";
import { decryptSecret, encryptSecret } from "@/lib/db/secrets";
import { withFileLock } from "@/lib/db/local";
import {
  issueDeviceToken,
  revokeDeviceToken,
  verifyDeviceToken,
} from "@/lib/db/device";
import { looksLikeCommitment } from "@/lib/integrations/gmail";
import {
  consumeGoogleOAuthState,
  googleConnectUrl,
  writeGooglePlan,
} from "@/lib/integrations/google";

// Keep real durable I/O; inject only the lock-open failures that Windows can
// produce during pending deletion/sharing so this race has deterministic proof.
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open) };
});

const scratch = path.resolve(process.cwd(), "..", "..", "work");
const directory = path.join(scratch, `storage-tests-${randomUUID()}`);
const first = randomUUID(),
  second = randomUUID();
beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  vi.stubEnv("DEMO_MODE", "true");
  vi.stubEnv("DEMO_DATA_DIR", directory);
  vi.stubEnv("SESSION_SECRET", "");
  vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("base64"));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (directory.startsWith(scratch + path.sep))
    await rm(directory, { recursive: true, force: true });
});

describe("isolated durable local storage and authenticated identities", () => {
  it("uses separate signed sessions and rejects tampering", async () => {
    const [a, b] = await Promise.all([
      createDemoSession(),
      createDemoSession(),
    ]);
    expect(a.id).not.toBe(b.id);
    expect(await validateDemoSession(a.token)).toBe(a.id);
    const [payload, signature] = a.token.split(".");
    const replacement = Buffer.from(
      JSON.stringify({ id: b.id, expires: Date.now() + 86400000 }),
    ).toString("base64url");
    expect(await validateDemoSession(`${replacement}.${signature}`)).toBeNull();
    expect(await validateDemoSession(`${payload}.wrong`)).toBeNull();
    const user = await requireUser(
      new Request("http://localhost/api/state", {
        headers: { cookie: `${DEMO_COOKIE}=${a.token}` },
      }),
    );
    expect(user.id).toBe(a.id);
  });
  it("serializes concurrent writers and persists across repeated reads", async () => {
    const base = await readState(first);
    await readState(second);
    await Promise.all(
      Array.from({ length: 12 }, () =>
        mutateState(first, (s) => {
          s.settings.default_task_minutes += 1;
        }),
      ),
    );
    const result = await readState(first);
    expect(result.settings.default_task_minutes).toBe(
      base.settings.default_task_minutes + 12,
    );
    expect(result.version).toBe(base.version + 12);
    const stored = JSON.parse(
      await readFile(path.join(directory, `state-${first}.json`), "utf8"),
    ) as { version: number };
    expect(stored.version).toBe(result.version);
    expect((await readState(second)).settings.default_task_minutes).toBe(
      base.settings.default_task_minutes,
    );
  });
  it.skipIf(process.platform !== "win32")("recovers transient Windows lock-open sharing failures", async () => {
    const name = `sharing-${randomUUID()}`;
    const lockPath = path.join(directory, `${name}.lock`);
    const realOpen = vi.mocked(open).getMockImplementation()!;
    const failures = ["EPERM", "EACCES"];
    const transaction = vi.fn(async () => "committed");
    vi.mocked(open).mockImplementation(async (...args) => {
      if (String(args[0]) === lockPath && failures.length) {
        throw Object.assign(new Error("temporary Windows sharing failure"), {
          code: failures.shift(), syscall: "open", path: lockPath,
        });
      }
      return realOpen(...args);
    });
    try {
      await expect(withFileLock(name, transaction)).resolves.toBe("committed");
      expect(failures).toHaveLength(0);
      expect(transaction).toHaveBeenCalledOnce();
      await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.mocked(open).mockImplementation(realOpen);
    }
  });
  it.each(["EPERM", "EACCES"])("preserves persistent %s without removing another owner's lock", async (code) => {
    const name = `permission-${randomUUID()}`;
    const lockPath = path.join(directory, `${name}.lock`);
    const realOpen = vi.mocked(open).getMockImplementation()!;
    const owner = await open(lockPath, "wx", 0o600);
    await owner.writeFile("owned transaction");
    const denied = Object.assign(new Error("permission denied"), {
      code, syscall: "open", path: lockPath,
    });
    const transaction = vi.fn(async () => "must not run");
    let attempts = 0;
    vi.mocked(open).mockImplementation(async (...args) => {
      if (String(args[0]) === lockPath) { attempts++; throw denied; }
      return realOpen(...args);
    });
    try {
      await expect(withFileLock(name, transaction)).rejects.toBe(denied);
      expect(transaction).not.toHaveBeenCalled();
      expect(await readFile(lockPath, "utf8")).toBe("owned transaction");
      expect(attempts).toBeGreaterThanOrEqual(process.platform === "win32" ? 2 : 1);
      expect(attempts).toBeLessThanOrEqual(20);
    } finally {
      vi.mocked(open).mockImplementation(realOpen);
      await owner.close();
      await rm(lockPath, { force: true });
    }
  });
  it("waits for the owner to release an active lock before executing", async () => {
    const name = `active-${randomUUID()}`;
    const lockPath = path.join(directory, `${name}.lock`);
    let acquired!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const owner = withFileLock(name, async () => { acquired(); await held; });
    await ready;
    const transaction = vi.fn(async () => "second owner");
    const contender = withFileLock(name, transaction);
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(transaction).not.toHaveBeenCalled();
      expect(await readFile(lockPath, "utf8")).toBe("");
    } finally {
      release();
      await owner;
    }
    await expect(contender).resolves.toBe("second owner");
    expect(transaction).toHaveBeenCalledOnce();
  });
  it("rejects foreign-owned records before persisting", async () => {
    const before = await readState(first);
    await expect(
      mutateState(first, (s) => {
        s.commitments[0].user_id = second;
      }),
    ).rejects.toThrow("another user");
    expect((await readState(first)).version).toBe(before.version);
    expect((await readState(first)).commitments[0].user_id).toBe(first);
  });
  it("fails closed when production database is unavailable", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    await expect(readState(first)).rejects.toThrow(
      "Supabase is not configured",
    );
    vi.stubEnv("DEMO_MODE", "true");
  });
  it("rejects cross-site mutation requests", () => {
    expect(() =>
      assertSameOrigin(
        new Request("http://localhost/api", {
          headers: { origin: "https://evil.example" },
        }),
      ),
    ).toThrow("Cross-origin");
  });
});

describe("integration credentials, pairing and device tokens", () => {
  it("encrypts credentials separately from public state with owner binding", async () => {
    await setIntegrationSecret(first, "google", {
      access_token: "sensitive-access-token",
      refresh_token: "refresh-secret",
    });
    expect((await getIntegrationSecret(first, "google"))?.access_token).toBe(
      "sensitive-access-token",
    );
    expect(await getIntegrationSecret(second, "google")).toBeNull();
    const disk = await readFile(
      path.join(directory, `secrets-${first}.json`),
      "utf8",
    );
    expect(disk).not.toContain("sensitive-access-token");
    expect(JSON.stringify(await readState(first))).not.toContain(
      "refresh-secret",
    );
    const encrypted = encryptSecret({ token: "private" }, `${first}:google`);
    expect(() => decryptSecret(encrypted, `${second}:google`)).toThrow();
  });
  it("requires a valid encryption key and never stores plaintext fallbacks", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    await expect(
      setIntegrationSecret(first, "unsafe", { token: "must-not-store" }),
    ).rejects.toThrow("ENCRYPTION_KEY");
    vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  });
  it("pairs private Telegram chats once and rejects group chats and replay", async () => {
    const token = await createTelegramPairing(first);
    expect(await redeemTelegramPairing(token, "-12345")).toBeNull();
    expect(await redeemTelegramPairing(token, "12345")).toBe(first);
    expect(await findUserByTelegramChat("12345")).toBe(first);
    expect(await redeemTelegramPairing(token, "56789")).toBeNull();
    const other = await createTelegramPairing(second);
    expect(await redeemTelegramPairing(other, "12345")).toBeNull();
  });
  it("stores only device hashes, verifies ownership and revokes tokens", async () => {
    const device = await issueDeviceToken(first, "Desk");
    expect(await verifyDeviceToken(device.token)).toBe(first);
    expect(await verifyDeviceToken(device.token + "x")).toBeNull();
    const disk = await readFile(
      path.join(directory, `devices-${first}.json`),
      "utf8",
    );
    expect(disk).not.toContain(device.token);
    await revokeDeviceToken(first, device.id);
    expect(await verifyDeviceToken(device.token)).toBeNull();
  });
});

describe("Google OAuth and staged Gmail mining", () => {
  it("binds signed OAuth state to the user and consumes it once", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-secret");
    vi.stubEnv(
      "GOOGLE_REDIRECT_URI",
      "http://localhost/api/integrations/google/callback",
    );
    const url = new URL(await googleConnectUrl(first, "//evil.example"));
    const state = url.searchParams.get("state")!;
    await expect(consumeGoogleOAuthState(state, second)).rejects.toThrow();
    expect(await consumeGoogleOAuthState(state, first)).toBe("/settings");
    await expect(consumeGoogleOAuthState(state, first)).rejects.toThrow(
      "expired",
    );
  });
  it("deletes only future owned calendar blocks even when the plan is empty", async () => {
    const { createHash } = await import("node:crypto");
    const owner = createHash("sha256").update(first).digest("hex").slice(0, 32);
    await setIntegrationSecret(first, "google", {
      access_token: "test",
      expires_at: Date.now() + 3600000,
    });
    await mutateState(first, (s) => {
      s.settings.calendar_write_enabled = true;
    });
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input),
          method = init?.method || "GET";
        calls.push({ url, method });
        if (method === "DELETE") return new Response(null, { status: 204 });
        return Response.json({
          items: [
            {
              id: "future-owned",
              start: { dateTime: "2099-01-01T05:00:00Z" },
              end: { dateTime: "2099-01-01T06:00:00Z" },
              extendedProperties: { private: { commitosOwner: owner } },
            },
            {
              id: "past-owned",
              end: { dateTime: "2000-01-01T06:00:00Z" },
              extendedProperties: { private: { commitosOwner: owner } },
            },
            { id: "external", end: { dateTime: "2099-01-01T06:00:00Z" } },
          ],
        });
      },
    );
    await writeGooglePlan(first, []);
    expect(
      calls
        .filter((c) => c.method === "DELETE")
        .map((c) => c.url.split("/").pop()),
    ).toEqual(["future-owned"]);
    vi.unstubAllGlobals();
  });
  it("rejects concurrent OAuth-state replay", async () => {
    const url = new URL(await googleConnectUrl(first));
    const state = url.searchParams.get("state")!;
    const attempts = await Promise.allSettled([
      consumeGoogleOAuthState(state, first),
      consumeGoogleOAuthState(state, first),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
  });
  it("keeps actionable emails and drops promotion noise before AI processing", () => {
    expect(
      looksLikeCommitment(
        "Action required: speaker bio",
        "Please send your bio by Friday.",
      ),
    ).toBe(true);
    expect(
      looksLikeCommitment("Flash sale", "Please buy now. Unsubscribe below."),
    ).toBe(false);
    expect(
      looksLikeCommitment("Project update", "The release went well."),
    ).toBe(false);
    expect(
      looksLikeCommitment(
        "Assignment deadline",
        "Submit by tonight. Unsubscribe from announcements.",
      ),
    ).toBe(true);
  });
});
