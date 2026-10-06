import { normalizeNaturalDate } from "../ai/parser";
import { briefRecordTitle, conversationalText } from "./title";
import type { Commitment } from "../types";
import type {
  CapturedRecord,
  DeadlineProgress,
  OrganizeContext,
  OrganizedCapture,
  OrganizedRecord,
  RecordKind,
} from "./types";

const actionStart = /^(?:(?:i|we)\s+)?(?:need\s+to|have\s+to|want\s+to|must|should|remember\s+to|todo\s*:|to[ -]?do\s*:|task\s*:|finish|complete|send|submit|write|draft|create|build|fix|get|review|read|pay|buy|book|call|email|message|text|remind|follow\s+up|prepare|update|upload|download|export|print|discuss|schedule|reply|check|cancel|renew|pick\s+up|bring|clean|organize|make|ship|publish|record|edit|learn|study|practice|water|feed|take|order|return|collect|apply|do)\b/i;
const labeledKind = /^(task|to[ -]?do|note|idea|event|reference|link|resource)\s*:/i;
const passiveTask = /^(?:the |my |our )?[^.!?;]+?\s+(?:needs? to be|has to be|must be|should be)\s+(?:submitted|sent|finished|completed|reviewed|paid|renewed|uploaded|written|prepared)\b/i;
const groupedKind = /^(task|to[ -]?do|note|idea|event|reference|link|resource)\s+for\s+(?:project\s+)?([^:\n]+)\s*:/i;
const reservedLabels = /^(?:task|to[ -]?do|note|notes|idea|event|reference|link|resource|project|collection|contact|deadline|remember|https?)$/i;
const collectionPrefix = /^([A-Z][\p{L}\p{N}'’&_-]*(?:\s+[A-Z][\p{L}\p{N}'’&_-]*){0,5}):\s*/u;
const temporalSurface = /\b(?:today|tomorrow|tonight|day after tomorrow|(?:this|next)\s+(?:week|weekend)|sunday|monday|tuesday|wednesday|thursday|friday|saturday|january|february|march|april|may|june|july|august|september|october|november|december|noon|midnight|morning|afternoon|evening|before (?:my |the )?class|soon|later|sometime|eventually|end of (?:the )?(?:week|month))\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b|\b(?:at|by|before|around|until|about)\s+(?:\d{1,2}(?::\d{2})?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b|\bin\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hours?|hrs?|minutes?|mins?)\b/i;
const uncertainDate = /\b(?:soon|later|next week|(?:this|next) weekend|end of (?:the )?(?:week|month)|sometime|eventually)\b/i;
const urlPattern = /https?:\/\/[^\s<>]+|www\.[^\s<>]+/gi;
const nameToken = "(?!(?:Today|Tomorrow|Tonight|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Next|AM|PM)\\b)[A-Z][\\p{L}\\p{N}'’-]*";
const recipientName = `(${nameToken}(?:\\s+${nameToken}){0,3})`;
const topicRules: [string, RegExp][] = [
  ["video", /\b(?:video|thumbnail|youtube|filming|editing|footage)\b/i],
  ["writing", /\b(?:write|writing|draft|article|essay|copy|script)\b/i],
  ["code", /\b(?:code|coding|bug|repository|api|database|deploy|software)\b/i],
  ["design", /\b(?:design|mockup|figma|logo|prototype)\b/i],
  ["study", /\b(?:study|exam|assignment|homework|lecture|course)\b/i],
  ["finance", /\b(?:invoice|payment|budget|tax|rent|bill)\b/i],
  ["health", /\b(?:doctor|dentist|medicine|workout|exercise)\b/i],
  ["travel", /\b(?:flight|hotel|trip|travel|passport|visa)\b/i],
  ["groceries", /\b(?:groceries|grocery|milk|bread|vegetables)\b/i],
];

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.trim().toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchRecordNames(text: string, names: string[] = []): string[] {
  return unique(names)
    .map((name) => ({
      name,
      index: text.search(
        new RegExp(`(?:^|[^\\p{L}\\p{N}])${name.split(/(?<=[a-z0-9])(?=[A-Z])|\s+/).map(escapeRegex).join("[\\s_-]*")}(?=$|[^\\p{L}\\p{N}])`, "iu"),
      ),
    }))
    .filter(({ index }) => index >= 0)
    .sort((a, b) => a.index - b.index || b.name.length - a.name.length)
    .map(({ name }) => name);
}

function cleanName(value: string): string {
  return value.trim().replace(/^["“']|["”']$/g, "").trim();
}

function canonicalName(value: string, names: string[] = []): string {
  const key = value.replace(/[\s_-]+/g, "").toLocaleLowerCase();
  return names.find((name) => name.replace(/[\s_-]+/g, "").toLocaleLowerCase() === key) ?? value;
}

function explicitCollection(text: string): string | null {
  const grouped = groupedKind.exec(text);
  if (grouped) return cleanName(grouped[2]);
  const label = /\b(?:project|collection)\s*:\s*([^\n:;,.!?]+?)(?=\s+[-–—]\s+|[\n:;,.!?]|$)/i.exec(text);
  if (label) return cleanName(label[1]);
  const prefix = collectionPrefix.exec(text);
  if (prefix && !reservedLabels.test(prefix[1].trim())) return cleanName(prefix[1]);
  const namedProject = /\bfor\s+(?:the\s+)?project\s+([^\n:;,.!?]+?)(?=\s+(?:by|before|on|at|tomorrow|today|tonight|next)\b|[\n:;,.!?]|$)/i.exec(text);
  if (namedProject) return cleanName(namedProject[1]);
  const trailingProject = /\bfor\s+([^\n:;,.!?]+?)\s+project\b/i.exec(text);
  return trailingProject ? cleanName(trailingProject[1]) : null;
}

function explicitContacts(text: string): string[] {
  const names: string[] = [];
  const patterns = [
    new RegExp(`\\b(?:[Cc]all|[Ee]mail|[Mm]essage|[Tt]ext|[Aa]sk|[Rr]emind)\\s+${recipientName}`, "gu"),
    new RegExp(`\\b(?:[Mm]eet|[Mm]eeting|[Ll]unch|[Dd]inner|[Aa]ppointment|[Ff]ollow up|[Tt]alk)\\s+(?:with|to)\\s+${recipientName}`, "gu"),
    new RegExp(`\\b(?:[Ss]end|[Ss]hare|[Rr]eply|[Ww]rite)\\b[^.!?;\\n]*?\\bto\\s+${recipientName}`, "gu"),
    new RegExp(`\\b(?:[Ss]end|[Gg]ive|[Ss]hare)\\s+${recipientName}(?=\\s+(?:a|an|the|my|our|some)\\b)`, "gu"),
    new RegExp(`\\b[Cc]ontact\\s*:\\s*${recipientName}`, "gu"),
  ];
  for (const pattern of patterns) {
    // Capitalization distinguishes a stated name from "email the team".
    for (const match of text.matchAll(pattern)) names.push(cleanName(match[1]));
  }
  return unique(names);
}

function classification(text: string): { kind: RecordKind; explicit: boolean } {
  const explicitLabel = labeledKind.test(text);
  text = conversationalText(text);
  const labeled = labeledKind.exec(text);
  if (labeled) {
    const label = labeled[1].toLowerCase();
    return {
      kind: ["link", "resource", "reference"].includes(label)
        ? "reference"
        : /^to[ -]?do$/.test(label)
          ? "task"
          : (label as RecordKind),
      explicit: explicitLabel,
    };
  }
  if (/^(?:save|bookmark|keep|store)\b[^\n]*(?:https?:\/\/|www\.)/i.test(text))
    return { kind: "reference", explicit: false };
  if (/^(?:what if\b|(?:i |we )?could\b|maybe\b|brainstorm\b|concept\s*:|i have an idea\b)/i.test(text))
    return { kind: "idea", explicit: false };
  if (/^(?:meeting\b|meet\b|appointment\b|interview\b|class\b|lecture\b|workshop\b|conference\b|birthday\b|lunch with\b|dinner with\b)/i.test(text))
    return { kind: "event", explicit: false };
  if (/^(?:i|we)\s+(?:do not|don't|no longer)\s+(?:need|have|want) to\b/i.test(text))
    return { kind: "note", explicit: false };
  if (actionStart.test(text)) return { kind: "task", explicit: false };
  if (/^(?:don't|do not|never)\s+(?:send|share|submit|call|email|message|delete|publish|pay)\b/i.test(text))
    return { kind: "task", explicit: false };
  if (passiveTask.test(text))
    return { kind: "task", explicit: false };
  if (/^(?:https?:\/\/|www\.)/i.test(text) || /^\S*\s*(?:link|reference|resource)\s*:/i.test(text))
    return { kind: "reference", explicit: false };
  if (/\b(?:i|we) (?:need|have) to\b|\b(?:due|deadline)\s*:?\s*(?:today|tomorrow|tonight|\d|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(text))
    return { kind: "task", explicit: false };
  return { kind: "note", explicit: false };
}

interface Segment { content: string; collection: string | null }

function startsIntent(text: string): boolean {
  const body = conversationalText(bodyFor(text));
  if (/^(?:(?:i|we)\s+)?(?:need|have) to get (?:a|an|the) update[.!?]*$/i.test(body)) return false;
  return actionStart.test(body) || labeledKind.test(body) || passiveTask.test(body) || classification(body).kind === "event";
}

function sentencePieces(text: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/(?<=[.!?;])\s+/g)) {
    if (!startsIntent(text.slice(match.index + match[0].length))) continue;
    pieces.push(text.slice(start, match.index).trim());
    start = match.index + match[0].length;
  }
  pieces.push(text.slice(start).trim());
  return pieces.filter(Boolean);
}

function conversationalPieces(text: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/\s+(?=(?:(?:and|then|also|plus)[,.:]?|oh,?\s+and)\s+)/gi)) {
    const left = text.slice(start, match.index).trim();
    const right = conversationalText(text.slice(match.index).trim());
    const leftKind = classification(bodyFor(left)).kind;
    if (!["task", "event"].includes(leftKind) && !labeledKind.test(right)) continue;
    if (!startsIntent(right)) continue;
    if (conversationalText(bodyFor(left)).split(/\s+/).length < 2) continue;
    pieces.push(left);
    start = match.index + match[0].length;
  }
  pieces.push(text.slice(start).trim());
  return pieces.filter(Boolean);
}

function splitCapture(text: string): Segment[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const segments: Segment[] = [];
  let inherited: string | null = null;
  let pendingLabel = "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const header = /^(?:project|collection)\s*:\s*([^:;,.!?]+)$/i.exec(line);
    if (header && !actionStart.test(header[1]) && !/\s[-–—]\s/.test(header[1])) {
      if (pendingLabel) segments.push({ content: pendingLabel, collection: inherited });
      inherited = cleanName(header[1]);
      pendingLabel = line;
      continue;
    }
    const body = line.replace(/^(?:[-*•]|\d+[.)])\s+/, "");
    const pieces = sentencePieces(body).flatMap(conversationalPieces);
    for (const piece of pieces) {
      if (!piece.trim()) continue;
      const content = pendingLabel ? `${pendingLabel}\n${piece.trim()}` : piece.trim();
      segments.push({ content, collection: inherited });
      pendingLabel = "";
    }
  }
  if (pendingLabel) segments.push({ content: pendingLabel, collection: inherited });
  return segments;
}

function fallbackCollection(kind: RecordKind, text: string): string {
  if (kind === "idea") return "Ideas";
  if (kind === "reference") return "Links";
  if (/\b(?:school|study|exam|assignment|homework|lecture|course|class|university|college)\b/i.test(text)) return "Study";
  if (/\b(?:mom|dad|mother|father|home|house|family|groceries|grocery|milk|bread|doctor|dentist|birthday|gift|cat|dog|plants|rent|passport|visa)\b/i.test(text)) return "Personal";
  if (kind === "task" || /\b(?:work|client|sponsor|report|invoice|meeting|team|office|launch)\b/i.test(text)) return "Work";
  if (kind === "event") return "Personal";
  return "Notes";
}

function bodyFor(content: string): string {
  const grouped = groupedKind.exec(content);
  if (grouped) return `${grouped[1]}: ${content.slice(grouped[0].length).trim()}`;
  const prefix = collectionPrefix.exec(content);
  if (prefix && !reservedLabels.test(prefix[1].trim()))
    return content.slice(prefix[0].length).trim();
  return content
    .replace(/^(?:project|collection)\s*:[^\n]+\n/i, "")
    .replace(/^(?:project|collection)\s*:[^\n]+?\s+[-–—]\s+/i, "");
}

function recordDeadline(text: string, kind: RecordKind, context: OrganizeContext) {
  const withoutUrls = text.replace(urlPattern, "");
  const eligible = kind === "task" || kind === "event" || /\b(?:due|deadline)\b/i.test(withoutUrls);
  const instant = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})\b/i.exec(withoutUrls);
  if (!eligible || (!instant && !temporalSurface.test(withoutUrls))) return { deadline: null, inferred: false, warnings: [] as string[] };
  if (instant) {
    const day = instant[0].slice(0, 10);
    const validDay = Number.isFinite(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
    return validDay && Number.isFinite(Date.parse(instant[0]))
      ? { deadline: new Date(instant[0]).toISOString(), inferred: false, warnings: [] as string[] }
      : { deadline: null, inferred: false, warnings: ["The stated date or time is invalid. The record was saved with its original wording."] };
  }
  if (/\b(?:tonight|(?:today|tomorrow)\s+night)\s+(?:(?:at|around|by)\s+)?(?:12(?::[0-5]\d)?|twelve)\s*p\.?m\.?\b/i.test(withoutUrls))
    return { deadline: null, inferred: false, warnings: ["The stated time conflicts with night: 12 PM is noon. The record was saved with its original wording and no deadline."] };
  if (uncertainDate.test(withoutUrls))
    return { deadline: null, inferred: false, warnings: ["The date is not precise enough to place on a deadline. The record was saved with its original wording."] };
  const parsed = normalizeNaturalDate(withoutUrls, context);
  return { deadline: parsed.date, inferred: parsed.inferred, warnings: parsed.warnings };
}

function boundLabels(values: string[], field: string, warnings: string[]): string[] {
  if (values.some((value) => value.length > 200))
    warnings.push(`Some ${field} metadata was shortened; the original wording is retained in the record.`);
  if (values.length > 50)
    warnings.push(`Only the first 50 ${field} labels were indexed; the original wording is retained in the record.`);
  return unique(values.map((value) => value.slice(0, 200))).slice(0, 50);
}

/** Deterministic and portable: every non-empty capture becomes saved record input. */
export function organizeCapture(text: string, context: OrganizeContext): OrganizedCapture {
  const associations: OrganizedCapture["associations"] = { collections: [], contacts: [] };
  const segments = splitCapture(text);
  const combined = segments.length > 50;
  if (combined) segments.splice(49, segments.length - 49, { content: segments.slice(49).map((segment) => segment.content).join("\n"), collection: null });
  const entries: OrganizedRecord[] = segments.map((segment, index) => {
    const content = segment.content;
    const originalBody = bodyFor(content);
    const body = conversationalText(originalBody);
    const classified = classification(originalBody);
    const knownProjects = matchRecordNames(content, context.projects);
    const contactNames = unique([...matchRecordNames(content, context.contacts), ...explicitContacts(body).map((name) => canonicalName(name, context.contacts))]);
    const statedCollection = explicitCollection(content) ?? segment.collection;
    const explicit = statedCollection ? canonicalName(statedCollection, context.projects) : null;
    // A capitalized "for Atlas" is a stated grouping; a named recipient stays a contact.
    const forName = /\bfor\s+([A-Z][\p{L}\p{N}'’_-]*(?:\s+[A-Z][\p{L}\p{N}'’_-]*){0,3})(?=\s*(?:[.,;:!?]|$|\b(?:by|on|before|tomorrow|today|tonight|next)\b))/u.exec(body)?.[1];
    const namedFor = forName && !contactNames.some((name) => name.toLowerCase() === forName.toLowerCase()) && !/\b(?:gift|birthday|call|email|message|send|reply|update)\b/i.test(body) ? forName : null;
    const associated = explicit ?? knownProjects[0] ?? namedFor;
    const deadline = recordDeadline(body, classified.kind, context);
    const explicitTags = [...content.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)].map((match) => match[1].toLowerCase());
    const inferredTags = topicRules.filter(([, pattern]) => pattern.test(body)).map(([tag]) => tag);
    const warnings = [...deadline.warnings];
    const collection = boundLabels([associated ?? fallbackCollection(classified.kind, body)], "collection", warnings)[0];
    const contacts = boundLabels(contactNames, "contact", warnings);
    const tags = boundLabels(unique([...explicitTags, ...inferredTags]), "tag", warnings);
    if (associated) associations.collections.push(collection);
    associations.contacts.push(...contacts);
    if (combined && index === 49)
      warnings.push("More than 50 entries were captured. The remaining text was saved together in this record.");
    if (knownProjects.length > 1 && !explicit)
      warnings.push(`Several projects were mentioned. Grouped under ${collection}; all original text is retained.`);
    const inferred_fields = [
      ...(!classified.explicit ? ["kind"] : []),
      ...(!explicit ? ["collection"] : []),
      ...(inferredTags.length ? ["tags"] : []),
      ...(deadline.inferred ? ["deadline"] : []),
    ];
    return {
      title: briefRecordTitle(content, classified.kind, content), content, kind: classified.kind, collection,
      tags, contacts, deadline: deadline.deadline, source: "text",
      interpretation: {
        provider: "local", confidence: warnings.length ? 0.65 : classified.explicit ? 0.98 : classified.kind === "note" ? 0.76 : 0.88,
        warnings: unique(warnings), inferred_fields,
      },
    };
  });
  return { entries, provider: "local", associations: { collections: unique(associations.collections).slice(0, 50), contacts: unique(associations.contacts).slice(0, 50) } };
}

/** Calendar time remaining, deliberately independent of work estimates and timers. */
export function deadlineProgress(createdAt: string, deadline: string | null, now = new Date()): DeadlineProgress {
  const due = deadline ? Date.parse(deadline) : NaN;
  if (!Number.isFinite(due)) return { remaining_percent: null, remaining_ms: null, overdue: false, has_deadline: false };
  const remaining = Math.max(0, due - now.getTime());
  const created = Date.parse(createdAt);
  const baseline = due - created;
  const percent = !Number.isFinite(created) ? null : baseline <= 0 ? (remaining > 0 ? 100 : 0) : Math.min(100, Math.max(0, (remaining / baseline) * 100));
  return { remaining_percent: percent === null ? null : Math.round(percent * 100) / 100, remaining_ms: remaining, overdue: now.getTime() > due, has_deadline: true };
}

/** Existing commitments can appear beside records without persisting duplicate captures. */
export function legacyCommitmentToRecord(commitment: Commitment): CapturedRecord {
  const kind: RecordKind = commitment.commitment_type === "meeting" ? "event" : "task";
  const content = commitment.description || commitment.title;
  return {
    id: `legacy:${commitment.id}`, user_id: commitment.user_id,
    title: commitment.title, content, kind,
    collection: commitment.project || (commitment.commitment_type === "academic" ? "Study" : commitment.commitment_type === "personal" ? "Personal" : "Work"),
    tags: [], contacts: commitment.contact_name ? [commitment.contact_name] : [],
    deadline: commitment.deadline, created_at: commitment.created_at, updated_at: commitment.updated_at,
    source: "legacy", status: ["done", "cancelled"].includes(commitment.status) ? "archived" : "active",
    capture_id: `legacy:${commitment.id}`,
    interpretation: { provider: "local", confidence: 1, warnings: [], inferred_fields: [] },
  };
}

export function projectCollections(records: CapturedRecord[]): string[] {
  return unique(records.map((record) => record.collection.trim())).sort((a, b) => a.localeCompare(b));
}
