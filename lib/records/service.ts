import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { mutateState, readState } from "@/lib/db/repository";
import { ServiceError } from "@/lib/services";
import type { AppState } from "@/lib/types";
import { organizeWithProvider } from "./provider";
import type { CaptureSource, CapturedRecord, OrganizationProvider } from "./types";

const shortText = (max: number) => z.string().trim().min(1).max(max);
const labels = z.array(shortText(200)).max(50);
const deadline = z.iso.datetime({ offset: true }).nullable();
export const recordPatchSchema = z.object({
  title: shortText(500).optional(),
  content: shortText(20000).optional(),
  collection: shortText(200).optional(),
  kind: z.enum(["task", "note", "idea", "event", "reference"]).optional(),
  deadline: deadline.optional(),
  tags: labels.optional(),
  status: z.enum(["active", "archived"]).optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "Provide a correction");
export type RecordPatch = z.infer<typeof recordPatchSchema>;
const captureSchema = z.object({
  text: shortText(20000),
  source: z.enum(["text", "voice", "telegram", "legacy"]),
  request_id: z.uuid().optional(),
});
const organizedSchema = z.object({
  title: shortText(500), content: shortText(20000),
  kind: z.enum(["task", "note", "idea", "event", "reference"]),
  collection: shortText(200), tags: labels, contacts: labels, deadline,
  interpretation: z.object({
    provider: z.enum(["local", "gemini"]), confidence: z.number().min(0).max(1),
    warnings: z.array(z.string().max(1000)).max(50),
    inferred_fields: z.array(z.string().max(100)).max(50),
  }),
});
const distinct = (values: string[]) => [...new Set(values)];
const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

class AlreadyCaptured extends Error {
  constructor(public state: AppState, public records: CapturedRecord[]) {
    super("Capture already saved");
  }
}

function replay(state: AppState, key: string, captureId: string): CapturedRecord[] | null {
  const records = state.records.filter((record) => record.capture_id.startsWith(`${key}:`));
  if (!records.length) return null;
  if (records.some((record) => record.capture_id !== captureId))
    throw new ServiceError("This capture request was already used for different text. Start a new capture.", 409);
  return records;
}

export async function captureRecords(
  userId: string,
  text: string,
  options: { source?: CaptureSource; request_id?: string; now?: Date } = {},
): Promise<{ state: AppState; records: CapturedRecord[]; provider: OrganizationProvider }> {
  const input = captureSchema.parse({ text, source: options.source ?? "text", request_id: options.request_id });
  const key = input.request_id?.toLowerCase() ?? randomUUID();
  // The opaque batch identifier includes the payload digest, so replay checks
  // survive reloads without putting the original input in an extra registry.
  const digest = createHash("sha256").update(JSON.stringify([input.text, input.source])).digest("hex");
  const captureId = `${key}:${digest}`;
  const initial = await readState(userId);
  const previous = replay(initial, key, captureId);
  if (previous) return { state: initial, records: previous, provider: previous[0].interpretation.provider };
  const now = options.now ?? new Date();
  const stamp = now.toISOString();
  const organized = await organizeWithProvider(input.text, {
    now, timezone: initial.settings.timezone,
    projects: initial.projects.filter((project) => !project.archived).map((project) => project.name),
    contacts: initial.contacts.map((contact) => contact.name),
  });
  if (!organized.entries.length) throw new ServiceError("Nothing was found to save");
  const prepared: CapturedRecord[] = organized.entries.map((entry) => ({
    ...organizedSchema.parse(entry),
    id: randomUUID(), user_id: userId, created_at: stamp, updated_at: stamp,
    source: input.source, status: "active", capture_id: captureId,
  }));
  let state: AppState;
  try {
    state = await mutateState(userId, (current) => {
      const existing = replay(current, key, captureId);
      // Abort an unchanged mutation when another writer won this request. This
      // avoids version churn and further conflicts during a burst of replays.
      if (existing) throw new AlreadyCaptured(current, existing);
      current.records.push(...prepared);
      for (const rawName of distinct(organized.associations.collections)) {
        const name = shortText(200).parse(rawName);
        if (!current.projects.some((project) => sameName(project.name, name)))
          current.projects.push({
            id: randomUUID(), user_id: userId, name, description: "",
            color: "#111111", archived: false, created_at: stamp,
          });
      }
      for (const rawName of distinct(organized.associations.contacts)) {
        const name = shortText(200).parse(rawName);
        if (!current.contacts.some((contact) => sameName(contact.name, name)))
          current.contacts.push({
            id: randomUUID(), user_id: userId, name,
            organization: "", email: "", telegram: "", notes: "",
          });
      }
      current.activity.push({
        id: randomUUID(), user_id: userId, commitment_id: null,
        type: "records_captured",
        message: `Saved ${prepared.length} ${prepared.length === 1 ? "record" : "records"}`,
        created_at: stamp,
      });
    });
  } catch (error) {
    if (error instanceof AlreadyCaptured)
      return { state: error.state, records: error.records, provider: error.records[0].interpretation.provider };
    throw error;
  }
  return { state, records: prepared, provider: prepared[0].interpretation.provider };
}

export async function updateRecord(userId: string, id: string, correction: unknown): Promise<{ state: AppState; record: CapturedRecord }> {
  z.uuid().parse(id);
  const patch = recordPatchSchema.parse(correction);
  if (patch.deadline) patch.deadline = new Date(patch.deadline).toISOString();
  if (patch.tags) patch.tags = distinct(patch.tags);
  let record!: CapturedRecord;
  const state = await mutateState(userId, (current) => {
    const existing = current.records.find((entry) => entry.id === id && entry.user_id === userId);
    if (!existing) throw new ServiceError("Record not found", 404);
    Object.assign(existing, patch, { updated_at: new Date().toISOString() });
    existing.interpretation.inferred_fields = existing.interpretation.inferred_fields.filter((field) => !(field in patch));
    record = existing;
  });
  return { state, record };
}

export function archiveRecord(userId: string, id: string) {
  return updateRecord(userId, id, { status: "archived" });
}
