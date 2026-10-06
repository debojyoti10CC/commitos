import { loadEnvFile } from "node:process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { adminSupabase, isDemoMode } from "../lib/db/supabase";
import { mutateState } from "../lib/db/repository";
import {
  emptyImportTarget, LocalImportError, mergeLocalRecordImport, prepareLocalRecordImport,
  type ImportSummary,
} from "../lib/records/local-import";
import type { AppState } from "../lib/types";

const usage = "Run from the CommitOS directory: npx tsx scripts/import-local-records.ts --source-owner UUID --target-user UUID [--source-dir DIRECTORY] [--apply]. Default: dry-run.";
class AlreadyImported extends Error {
  constructor(public summary: ImportSummary) { super("Already imported"); }
}
function argumentsFrom(argv: string[]) {
  const values: Record<string, string> = {};
  let apply = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--apply") {
      if (apply) throw new LocalImportError("Pass --apply only once");
      apply = true;
    } else if (["--source-owner", "--target-user", "--source-dir"].includes(flag)) {
      if (values[flag] || !argv[index + 1] || argv[index + 1].startsWith("--"))
        throw new LocalImportError("Each import option needs one explicit value");
      values[flag] = argv[++index];
    } else throw new LocalImportError("Unknown import option");
  }
  const parsed = z.object({ source: z.uuid(), target: z.uuid() }).safeParse({ source: values["--source-owner"], target: values["--target-user"] });
  if (!parsed.success) throw new LocalImportError("Both --source-owner and --target-user UUIDs are required");
  return { source: parsed.data.source.toLowerCase(), target: parsed.data.target.toLowerCase(), sourceDir: values["--source-dir"], apply };
}
async function main() {
  if (process.argv.slice(2).includes("--help")) { console.log(usage); return; }
  const args = argumentsFrom(process.argv.slice(2));
  if (typeof loadEnvFile !== "function")
    throw new LocalImportError("This import CLI requires Node.js 20.12 or newer");
  try { loadEnvFile(path.resolve(".env.local")); }
  catch { throw new LocalImportError("Create .env.local with the Supabase server configuration first"); }
  if (isDemoMode())
    throw new LocalImportError("Set effective DEMO_MODE=false before importing into an account");
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    throw new LocalImportError("The Supabase URL, public key and server admin key must be configured");
  const sourceDirectory = path.resolve(args.sourceDir || process.env.DEMO_DATA_DIR || ".data");
  let source: unknown;
  try { source = JSON.parse(await readFile(path.join(sourceDirectory, `state-${args.source}.json`), "utf8")); }
  catch { throw new LocalImportError("Could not read the explicitly selected local workspace"); }
  const plan = prepareLocalRecordImport(source, args.source, args.target);
  const client = adminSupabase();
  const verified = await client.auth.admin.getUserById(args.target);
  if (verified.error || !verified.data.user || verified.data.user.id !== args.target)
    throw new LocalImportError("Could not verify the target account through Supabase Auth admin API");
  const loaded = await client.rpc("load_commitos_state", { p_user_id: args.target });
  if (loaded.error)
    throw new LocalImportError("Could not load target workspace. Verify migrations and server credentials");
  const target = loaded.data ? loaded.data as AppState : emptyImportTarget(args.target);
  let summary = mergeLocalRecordImport(target, plan).summary;
  let wrote = false;
  if (args.apply && (summary.addedRecords || summary.addedProjects || summary.addedContacts)) {
    try {
      await mutateState(args.target, current => {
        const merged = mergeLocalRecordImport(current, plan);
        summary = merged.summary;
        if (!summary.addedRecords && !summary.addedProjects && !summary.addedContacts)
          throw new AlreadyImported(summary);
        Object.assign(current, merged.state);
      });
      wrote = true;
    } catch (error) {
      if (error instanceof AlreadyImported) summary = error.summary;
      else if (error instanceof LocalImportError) throw error;
      else throw new LocalImportError("The atomic database import failed; verify migrations, credentials or row-ID conflicts before retrying");
    }
  }
  console.log(JSON.stringify({ mode: args.apply ? "apply" : "dry-run", wrote, sourceOwner: args.source, targetUser: args.target, ...summary, localSourceUntouched: true }));
}
void main().catch(error => {
  console.error(error instanceof LocalImportError ? error.message : "Import stopped. Check configuration and retry; no credentials or source content are logged.");
  console.error(usage);
  process.exitCode = 1;
});
