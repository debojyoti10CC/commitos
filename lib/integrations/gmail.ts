import { randomUUID } from "node:crypto";
import type { Candidate } from "@/lib/types";
import { googleRequest } from "./google";
import { readState } from "@/lib/db/repository";
import { parseCommitment } from "@/lib/ai/provider";

export function looksLikeCommitment(subject: string, body: string): boolean {
  const text = `${subject} ${body}`;
  const action =
    /\b(?:please|kindly|need you to|can you|could you|submit|deadline|due by|confirm|rsvp|send us|send me|follow[- ]?up|action required|complete the|fill out|assignment|deliverable)\b/i;
  const noise =
    /\b(?:unsubscribe|limited time offer|flash sale|discount code|buy now|newsletter)\b/i;
  return (
    action.test(text) &&
    (!noise.test(text) ||
      /\b(?:action required|assignment|due by|deadline)\b/i.test(subject))
  );
}
type Part = {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
  headers?: { name: string; value: string }[];
};
function plainBody(part: Part): string {
  if (part.mimeType === "text/plain" && part.body?.data)
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const child of part.parts || []) {
    const text = plainBody(child);
    if (text) return text;
  }
  return "";
}
export async function scanGmail(userId: string): Promise<Candidate[]> {
  const state = await readState(userId);
  if (!state.settings.gmail_mining_enabled)
    throw new Error("Enable Gmail commitment mining in Settings first.");
  const base = "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    query = new URLSearchParams({
      q: "newer_than:14d -category:promotions -category:social",
      maxResults: "30",
    });
  const result = (await (
    await googleRequest(userId, `${base}?${query}`)
  ).json()) as { messages?: { id: string }[] };
  const candidates: Candidate[] = [];
  const seen = new Set(state.candidates.map((c) => c.email_id));
  // Fetch metadata first; only plausible messages get full body processing and optional AI.
  for (const message of result.messages || []) {
    if (seen.has(message.id)) continue;
    const metadata = (await (
      await googleRequest(
        userId,
        `${base}/${message.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
      )
    ).json()) as { snippet?: string; payload?: Part };
    const header = (name: string) =>
      metadata.payload?.headers?.find(
        (h) => h.name.toLowerCase() === name.toLowerCase(),
      )?.value || "";
    const subject = header("Subject"),
      sender = header("From");
    if (!looksLikeCommitment(subject, metadata.snippet || "")) continue;
    const full = (await (
      await googleRequest(userId, `${base}/${message.id}?format=full`)
    ).json()) as { snippet?: string; payload?: Part };
    const body =
      (full.payload ? plainBody(full.payload) : "").slice(0, 12000) ||
      full.snippet ||
      "";
    if (!looksLikeCommitment(subject, body)) continue;
    const { parsed } = await parseCommitment(
      `Email subject: ${subject}\nFrom: ${sender}\n${body}`,
      {
        timezone: state.settings.timezone,
        projects: state.projects.map((p) => p.name),
        defaultMinutes: state.settings.default_task_minutes,
      },
    );
    candidates.push({
      id: randomUUID(),
      user_id: userId,
      email_id: message.id,
      subject,
      sender,
      body,
      parsed,
      status: "pending",
      created_at: new Date().toISOString(),
    });
    if (candidates.length >= 10) break; // Bound latency and free-tier AI usage per scan.
  }
  return candidates;
}
