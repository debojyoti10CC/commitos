import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isHostedRuntime, SupabaseConfigurationError } from "./supabase";

export const dataDirectory = () => {
  if (isHostedRuntime())
    throw new SupabaseConfigurationError("Local demo storage is unavailable in hosted functions. Configure Supabase for durable records.");
  const directory = process.env.DEMO_DATA_DIR || path.join(process.cwd(), ".data");
  return path.resolve(/* turbopackIgnore: true */ directory);
};
export function safeId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw new Error("Invalid storage identity");
  return value;
}
export async function atomicWrite(
  filename: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(/* turbopackIgnore: true */ temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(/* turbopackIgnore: true */ temporary, filename);
  } finally {
    await rm(/* turbopackIgnore: true */ temporary, { force: true });
  }
}
export async function withFileLock<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const directory = dataDirectory();
  await mkdir(/* turbopackIgnore: true */ directory, { recursive: true });
  const lockPath = path.join(directory, `${safeId(name)}.lock`);
  const start = Date.now();
  let sharingRetries = 0;
  for (;;) {
    let handle;
    try {
      handle = await open(/* turbopackIgnore: true */ lockPath, "wx", 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const sharingFailure = process.platform === "win32" &&
        (code === "EPERM" || code === "EACCES");
      if (code !== "EEXIST") {
        // Win32 can report sharing/pending-delete as permission errors while
        // the previous owner removes its lock. Retry briefly, then preserve
        // the filesystem error so a real access denial is never hidden.
        if (!sharingFailure || sharingRetries >= 8) throw error;
        sharingRetries++;
      } else sharingRetries = 0;
      // Never steal an active transaction. A crashed process leaves a lock requiring operator removal.
      if (Date.now() - start > 10000) {
        if (sharingFailure) throw error;
        throw new Error(
          "Storage is busy. Retry; a stale .data lock can be removed when the server is stopped.",
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 20 + Math.random() * 40),
      );
      continue;
    }
    try {
      return await fn();
    } finally {
      await handle.close();
      await rm(/* turbopackIgnore: true */ lockPath, { force: true });
    }
  }
}
export async function localSigningKey(): Promise<Buffer> {
  const supplied = process.env.SESSION_SECRET;
  if (supplied) {
    if (supplied.length < 32)
      throw new Error("SESSION_SECRET must contain at least 32 characters");
    return Buffer.from(supplied);
  }
  if (isHostedRuntime() || process.env.DEMO_MODE === "false")
    throw new SupabaseConfigurationError("SESSION_SECRET must be configured; hosted functions cannot create a file-backed signing key.");
  return withFileLock("session-key-init", async () => {
    const filename = path.join(dataDirectory(), "session-key");
    try {
      return Buffer.from(await readFile(/* turbopackIgnore: true */ filename, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const key = randomBytes(48).toString("base64url");
    const handle = await open(/* turbopackIgnore: true */ filename, "wx", 0o600);
    try {
      await handle.writeFile(key);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return Buffer.from(key);
  });
}
export async function readJson<T>(
  filename: string,
  fallback: () => T,
): Promise<T> {
  try {
    // Local runtime records are mutable user data, never deployment assets.
    return JSON.parse(await readFile(/* turbopackIgnore: true */ filename, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback();
    throw error;
  }
}
export async function localUserIds(): Promise<string[]> {
  const directory = dataDirectory();
  await mkdir(/* turbopackIgnore: true */ directory, { recursive: true });
  return (await readdir(/* turbopackIgnore: true */ directory))
    .filter((name) => /^state-[a-zA-Z0-9_-]+\.json$/.test(name))
    .map((name) => name.slice(6, -5));
}
