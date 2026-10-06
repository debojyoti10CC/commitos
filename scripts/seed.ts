import { randomUUID } from "node:crypto";
import { readState } from "../lib/db/repository";
async function main() {
  if (process.env.DEMO_MODE === "false")
    throw new Error(
      "This script only seeds local demo data. Production users start empty.",
    );
  const userId = process.argv[2] ?? randomUUID();
  const state = await readState(userId);
  console.log(
    JSON.stringify({
      event: "demo_seeded",
      userId,
      commitments: state.commitments.length,
      directory: process.env.DEMO_DATA_DIR ?? ".data",
    }),
  );
  console.log(
    "Open the application to create a signed browser demo session. This seed ID is for local test fixtures.",
  );
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Seed failed");
  process.exitCode = 1;
});
