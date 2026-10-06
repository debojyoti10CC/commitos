import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { defaultSettings } from "@/lib/seed";
import type { AppState, Contact, Project } from "@/lib/types";
import type { CapturedRecord } from "./types";

export class LocalImportError extends Error {}
const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const recordSchema = z.object({
  id: uuid, user_id: uuid,
  title: z.string().min(1).max(500), content: z.string().min(1).max(20000),
  kind: z.enum(["task", "note", "idea", "event", "reference"]),
  collection: z.string().min(1).max(200),
  tags: z.array(z.string().min(1).max(200)).max(50),
  contacts: z.array(z.string().min(1).max(200)).max(50),
  deadline: instant.nullable(), created_at: instant, updated_at: instant,
  source: z.enum(["text", "voice", "telegram", "legacy"]),
  status: z.enum(["active", "archived"]), capture_id: z.string().min(1).max(200),
  interpretation: z.object({
    provider: z.enum(["local", "gemini"]), confidence: z.number().min(0).max(1),
    warnings: z.array(z.string()), inferred_fields: z.array(z.string()),
  }).strict(),
}).strict();
const projectSchema = z.object({
  id: uuid, user_id: uuid, name: z.string().min(1), description: z.string(),
  color: z.string(), archived: z.boolean(), created_at: instant,
}).strict();
const contactSchema = z.object({
  id: uuid, user_id: uuid, name: z.string().min(1), organization: z.string(),
  email: z.string(), telegram: z.string(), notes: z.string(),
}).strict();
const legacyRecordSchema = recordSchema.extend({
  id: z.string().refine(value => value.startsWith("legacy:") && uuid.safeParse(value.slice(7)).success),
  source: z.literal("legacy"),
});
const sourceSchema = z.object({
  user_id: uuid,
  records: z.array(z.union([recordSchema, legacyRecordSchema])).optional().default([]),
  projects: z.array(projectSchema).optional().default([]),
  contacts: z.array(contactSchema).optional().default([]),
});
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export interface LocalRecordImport {
  sourceOwner: string;
  targetUser: string;
  records: CapturedRecord[];
  projects: Project[];
  contacts: Contact[];
  skippedLegacyRecords: number;
}
export interface ImportSummary {
  addedRecords: number;
  existingRecords: number;
  addedProjects: number;
  addedContacts: number;
  skippedLegacyRecords: number;
}

/** Stable UUIDv8 prevents demo association IDs colliding across account owners. */
function associationId(source: string, target: string, kind: string, id: string): string {
  if (source === target) return id;
  const bytes = createHash("sha256").update(JSON.stringify(["commitos-local-import", source, target, kind, id])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Select one workspace's captured records; never import its legacy/sample state. */
export function prepareLocalRecordImport(value: unknown, sourceOwner: string, targetUser: string): LocalRecordImport {
  if (!uuid.safeParse(sourceOwner).success || !uuid.safeParse(targetUser).success)
    throw new LocalImportError("Provide valid explicit source and target UUIDs");
  const parsed = sourceSchema.safeParse(value);
  if (!parsed.success) throw new LocalImportError("Invalid local capture data; no import can be applied");
  const source = parsed.data;
  if (source.user_id !== sourceOwner)
    throw new LocalImportError("The selected local file belongs to another owner");
  if (source.records.some(record => record.user_id !== sourceOwner))
    throw new LocalImportError("The selected local file contains a foreign captured record");
  if (new Set(source.records.map(record => record.id)).size !== source.records.length)
    throw new LocalImportError("The local file contains duplicate record IDs");
  const selected = source.records.filter(record => record.source !== "legacy");
  const projects = source.projects.filter(project => selected.some(record => sameName(record.collection, project.name)));
  const contacts = source.contacts.filter(contact => selected.some(record => record.contacts.some(name => sameName(name, contact.name))));
  if ([...projects, ...contacts].some(row => row.user_id !== sourceOwner))
    throw new LocalImportError("A referenced local association belongs to another owner");
  return {
    sourceOwner, targetUser,
    records: selected.map(record => ({ ...record, user_id: targetUser })),
    projects: projects.map(project => ({ ...project, id: associationId(sourceOwner, targetUser, "project", project.id), user_id: targetUser })),
    contacts: contacts.map(contact => ({ ...contact, id: associationId(sourceOwner, targetUser, "contact", contact.id), user_id: targetUser })),
    skippedLegacyRecords: source.records.length - selected.length,
  };
}

/** A dry-run baseline; unlike repository.readState, this never initializes a DB row. */
export function emptyImportTarget(userId: string): AppState {
  return {
    version: 0, user_id: userId, records: [], commitments: [], projects: [], contacts: [],
    sessions: [], reminders: [], integrations: [], reviews: [], activity: [],
    calendar_events: [], candidates: [], settings: defaultSettings(),
  };
}

function comparableRecord(record: CapturedRecord) {
  // PostgreSQL formats timestamptz differently from JS ISO strings. Their
  // instants remain equal, so a successful import is still a replay after load.
  return {
    ...record, created_at: Date.parse(record.created_at), updated_at: Date.parse(record.updated_at),
    deadline: record.deadline === null ? null : Date.parse(record.deadline),
  };
}
function requestKey(captureId: string): string | null {
  const prefix = captureId.split(":", 1)[0];
  return uuid.safeParse(prefix).success ? prefix.toLowerCase() : null;
}

/** Pure merge: collision failures leave both snapshots intact. */
export function mergeLocalRecordImport(target: AppState, plan: LocalRecordImport): { state: AppState; summary: ImportSummary } {
  if (target.user_id !== plan.targetUser)
    throw new LocalImportError("Target workspace owner does not match the verified account");
  const state = structuredClone(target);
  state.records ??= [];
  const summary: ImportSummary = {
    addedRecords: 0, existingRecords: 0, addedProjects: 0, addedContacts: 0,
    skippedLegacyRecords: plan.skippedLegacyRecords,
  };
  for (const row of [...state.records, ...state.projects, ...state.contacts, ...plan.records, ...plan.projects, ...plan.contacts])
    if (row.user_id !== plan.targetUser)
      throw new LocalImportError("Target merge contains a record owned by another account");
  for (const record of plan.records) {
    const existing = state.records.find(row => row.id === record.id);
    if (existing) {
      if (!isDeepStrictEqual(comparableRecord(existing), comparableRecord(record)))
        throw new LocalImportError(`Record ID collision: ${record.id}. Existing account data was not overwritten`);
      summary.existingRecords++;
      continue;
    }
    const key = requestKey(record.capture_id);
    if (key && state.records.some(row => requestKey(row.capture_id) === key && row.capture_id !== record.capture_id))
      throw new LocalImportError(`Capture request collision for record ${record.id}`);
    state.records.push(structuredClone(record));
    summary.addedRecords++;
  }
  for (const project of plan.projects) {
    const collision = state.projects.find(row => row.id === project.id);
    if (collision && !sameName(collision.name, project.name))
      throw new LocalImportError(`Project ID collision: ${project.id}`);
    if (state.projects.some(row => sameName(row.name, project.name))) continue;
    state.projects.push(structuredClone(project));
    summary.addedProjects++;
  }
  for (const contact of plan.contacts) {
    const collision = state.contacts.find(row => row.id === contact.id);
    if (collision && !sameName(collision.name, contact.name))
      throw new LocalImportError(`Contact ID collision: ${contact.id}`);
    if (state.contacts.some(row => sameName(row.name, contact.name))) continue;
    state.contacts.push(structuredClone(contact));
    summary.addedContacts++;
  }
  return { state, summary };
}
