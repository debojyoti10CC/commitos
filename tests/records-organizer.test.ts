import { describe, expect, it } from "vitest";
import {
  deadlineProgress,
  legacyCommitmentToRecord,
  organizeCapture,
  projectCollections,
} from "../lib/records/organizer";
import { createSeedState } from "../lib/seed";

const now = new Date("2026-10-05T04:30:00Z"); // 10 AM in Kolkata.
const context = {
  now,
  timezone: "Asia/Kolkata",
  projects: ["HydraDB", "Atlas"],
  contacts: ["Rohan", "Anita Rao"],
};
const one = (text: string) => organizeCapture(text, context).entries[0];

describe("automatic record organization", () => {
  it("saves arbitrary prose as a note without inventing a deadline or effort", () => {
    const text = "The blue door in the old house looked lovely yesterday.";
    const record = one(text);
    expect(record.content).toBe(text);
    expect(record.kind).toBe("note");
    expect(record.collection).toBe("Personal");
    expect(record.deadline).toBeNull();
    expect(record).not.toHaveProperty("estimated_minutes");
    expect(record).not.toHaveProperty("status");
  });

  it("keeps undated tasks, explicit notes, ideas, events, and references distinct", () => {
    const output = organizeCapture(
      "Buy milk\nNote: the deployment meeting yesterday went well\nIdea: a tiny desk terminal\nMeeting with Rohan tomorrow at 4 PM\nhttps://example.com/2026-10-08/guide",
      context,
    );
    expect(output.entries.map((entry) => entry.kind)).toEqual(["task", "note", "idea", "event", "reference"]);
    expect(output.entries.map((entry) => entry.collection)).toEqual(["Personal", "Work", "Ideas", "Work", "Links"]);
    expect(output.entries[0].deadline).toBeNull();
    expect(output.entries[1].deadline).toBeNull();
    expect(output.entries[2].deadline).toBeNull();
    expect(output.entries[3].deadline).toBe("2026-10-06T10:30:00.000Z");
    expect(output.entries[4].deadline).toBeNull();
  });

  it("splits bullets and distinct intents without dropping qualifying text", () => {
    const output = organizeCapture(
      "- Finish HydraDB video tonight by 9. Send an update to Rohan at 6 PM. Keep the upload private.\n2. Idea: a weekly digest #content\n• https://example.com/a?q=1",
      context,
    );
    expect(output.entries).toHaveLength(4);
    expect(output.entries[0].content).toBe("Finish HydraDB video tonight by 9.");
    expect(output.entries[1].content).toBe("Send an update to Rohan at 6 PM. Keep the upload private.");
    expect(output.entries[2].tags).toContain("content");
    expect(output.entries[3].content).toBe("https://example.com/a?q=1");
  });

  it("uses stated project names and known names to group related captures", () => {
    const output = organizeCapture(
      "Project: Mercury - Write launch copy tomorrow\nFix the HydraDB API bug\nNote: Atlas customer research\nWrite proposal for project Orion",
      context,
    );
    expect(output.entries.map((entry) => entry.collection)).toEqual(["Mercury", "HydraDB", "Atlas", "Orion"]);
    expect(output.entries.map((entry) => entry.kind)).toEqual(["task", "task", "note", "task"]);
    expect(output.associations.collections).toEqual(["Mercury", "HydraDB", "Atlas", "Orion"]);
  });

  it("recognizes project prefixes, project ideas, and bookmarked resources", () => {
    const output = organizeCapture(
      "HydraDB: Send the onboarding video tomorrow at 9 PM\nIdea for HydraDB: simplify signup\nSave https://example.com/guide for HydraDB\nMercury: Finish the landing page tomorrow",
      context,
    );
    expect(output.entries.map((entry) => entry.kind)).toEqual(["task", "idea", "reference", "task"]);
    expect(output.entries.map((entry) => entry.collection)).toEqual(["HydraDB", "HydraDB", "HydraDB", "Mercury"]);
    expect(output.entries[0].deadline).toBe("2026-10-06T15:30:00.000Z");
    expect(output.entries[0].title).toBe("Send the onboarding video");
    expect(output.entries[0].content).toBe("HydraDB: Send the onboarding video tomorrow at 9 PM");
    expect(output.entries[1].title).toBe("Simplify signup");
    expect(output.entries[1].deadline).toBeNull();
    expect(output.entries[2].deadline).toBeNull();
    expect(output.associations.collections).toEqual(["HydraDB", "Mercury"]);
    expect(one("Rohan prefers email updates.").kind).toBe("note");
    expect(one("Rohan prefers email updates.").contacts).toEqual(["Rohan"]);
  });

  it("inherits a project header across a multiline batch while preserving the header", () => {
    const output = organizeCapture("Project: Mercury\nFinish the draft\nIdea: add offline search", context);
    expect(output.entries).toHaveLength(2);
    expect(output.entries.map((entry) => entry.collection)).toEqual(["Mercury", "Mercury"]);
    expect(output.entries[0].title).toBe("Finish the draft");
    expect(output.entries[0].content).toBe("Project: Mercury\nFinish the draft");
    expect(output.associations.collections).toEqual(["Mercury"]);
  });

  it("associates contacts by stated recipients and known names without creating common nouns", () => {
    const output = organizeCapture("Call Rohan tomorrow\nSend the document to Anita Rao\nEmail the team\nMeet with Mira Tomorrow at 2 PM", context);
    expect(output.entries.map((entry) => entry.contacts)).toEqual([["Rohan"], ["Anita Rao"], [], ["Mira"]]);
    expect(output.associations.contacts).toEqual(["Rohan", "Anita Rao", "Mira"]);
    expect(output.associations.collections).toEqual([]);
  });

  it("matches project names at word boundaries and preserves canonical spelling", () => {
    expect(one("Fix the hydrAdb migration").collection).toBe("HydraDB");
    expect(one("The atlasian company sent a nice letter").collection).toBe("Notes");
    expect(one("Note: HydraDB and Atlas share this research").interpretation.warnings).toContain("Several projects were mentioned. Grouped under HydraDB; all original text is retained.");
  });

  it("keeps fallback collections out of project-creation associations", () => {
    const output = organizeCapture("Study for the exam\nIdea: a new camera angle\nNote: useful thought\nhttps://example.com", context);
    expect(output.entries.map((entry) => entry.collection)).toEqual(["Study", "Ideas", "Notes", "Links"]);
    expect(output.associations.collections).toEqual([]);
  });

  it("treats a raw dated note as information while honoring an explicit deadline", () => {
    expect(one("Note: I saw Rohan tomorrow in the calendar at 4 PM").deadline).toBeNull();
    expect(one("Note: passport renewal deadline tomorrow at 4 PM").deadline).toBe("2026-10-06T10:30:00.000Z");
    expect(one("Read https://example.com/2026-10-08/guide").deadline).toBeNull();
  });

  it("resolves deadline expressions in the user timezone and marks inferred time", () => {
    const record = one("Finish the draft tonight by 9");
    expect(record.deadline).toBe("2026-10-05T15:30:00.000Z");
    expect(record.interpretation.inferred_fields).toContain("deadline");
    expect(record.interpretation.warnings.some((warning) => /AM\/PM/.test(warning))).toBe(true);
    const la = organizeCapture("Meeting tomorrow at 4 PM", { now: new Date("2026-10-05T23:30:00Z"), timezone: "America/Los_Angeles" }).entries[0];
    expect(la.deadline).toBe("2026-10-06T23:00:00.000Z");
  });

  it.each([
    "IIT submission assignment by 10th October 12 a.m. and I need to get an update",
    "Submit the IIT assignment by tenth October at twelve a.m.",
    "Submit the IIT assignment by October tenth at twelve a.m.",
  ])("saves the stated October 10 midnight deadline in %s", (text) => {
    const record = one(text);
    expect(record.content).toBe(text);
    expect(record.deadline).toBe("2026-10-09T18:30:00.000Z");
    expect(record.title).toBe(text.startsWith("IIT ") ? "Submit IIT assignment" : "Submit the IIT assignment");
  });

  it("saves vague timing with a warning and no fabricated deadline", () => {
    for (const text of ["Finish the report before class", "Call Rohan next week at 4 PM", "Send the update soon"]) {
      const record = one(text);
      expect(record.content).toBe(text);
      expect(record.deadline).toBeNull();
      expect(record.interpretation.warnings.length).toBeGreaterThan(0);
      expect(record).not.toHaveProperty("needs_review");
    }
  });

  it("preserves absolute instants and rejects invalid calendar dates", () => {
    expect(one("Submit by 2026-10-07T14:00:00+02:00").deadline).toBe("2026-10-07T12:00:00.000Z");
    const invalid = one("Submit by 2027-02-31T14:00:00Z");
    expect(invalid.deadline).toBeNull();
    expect(invalid.interpretation.warnings.length).toBeGreaterThan(0);
    expect(one("Submit by 2027-02-31 at 14:00").deadline).toBeNull();
  });

  it("does not silently move a nonexistent local clock time across daylight saving", () => {
    const record = organizeCapture("Meeting on 2027-03-14 at 02:30", { now, timezone: "America/New_York" }).entries[0];
    expect(record.deadline).toBeNull();
    expect(record.interpretation.warnings.some((warning) => /clock change/.test(warning))).toBe(true);
  });

  it("returns nothing for empty whitespace and is deterministic without mutating context", () => {
    expect(organizeCapture(" \n\t ", context).entries).toEqual([]);
    const before = JSON.stringify(context);
    expect(organizeCapture("Fix HydraDB tomorrow #Code #code", context)).toEqual(organizeCapture("Fix HydraDB tomorrow #Code #code", context));
    expect(JSON.stringify(context)).toBe(before);
    expect(one("Fix HydraDB tomorrow #Code #code").tags.filter((tag) => tag === "code")).toHaveLength(1);
  });

  it("bounds metadata without rejecting or discarding a long capture", () => {
    const project = "A".repeat(240);
    const tags = Array.from({ length: 60 }, (_, index) => `#tag${index}`);
    const text = `Project: ${project}\nNote: keep this exact detail ${tags.join(" ")} #${"x".repeat(240)}`;
    const result = organizeCapture(text, context);
    expect(result.entries).toHaveLength(1);
    const record = result.entries[0];
    expect(record.content).toBe(text);
    expect(record.collection).toHaveLength(200);
    expect(record.tags).toHaveLength(50);
    expect(record.tags.every((tag) => tag.length <= 200)).toBe(true);
    expect(result.associations.collections).toEqual([project.slice(0, 200)]);
    expect(record.interpretation.warnings.some((warning) => /shortened/.test(warning))).toBe(true);
    expect(record.interpretation.warnings.some((warning) => /first 50/.test(warning))).toBe(true);
  });

  it("retains the tail of a batch larger than 50 entries", () => {
    const lines = Array.from({ length: 55 }, (_, index) => `Note: detail ${index}`);
    const result = organizeCapture(lines.join("\n"), context);
    expect(result.entries).toHaveLength(50);
    expect(result.entries[49].content).toBe(lines.slice(49).join("\n"));
    expect(result.entries[49].interpretation.warnings.some((warning) => /remaining text/.test(warning))).toBe(true);
  });
});

describe("conversational English records", () => {
  const voiceContext = { ...context, now: new Date("2026-10-06T04:30:00Z"), projects: ["HydraDB", "IIT Patna", "Atlas"] };

  it("recognizes filler and polite requests without modifying the transcript", () => {
    const text = "Hey, can you remind me to send Mira an update for Hydra DB tomorrow at six p.m.?";
    const result = organizeCapture(text, voiceContext);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ content: text, title: "Send Mira an update for Hydra DB", kind: "task", collection: "HydraDB", contacts: ["Mira"], deadline: "2026-10-07T12:30:00.000Z" });
    expect(result.associations).toEqual({ collections: ["HydraDB"], contacts: ["Mira"] });
  });

  it("turns an implied passive obligation into its concise action", () => {
    const text = "The IIT assignment needs to be submitted by tenth October at twelve a.m.";
    const record = organizeCapture(text, voiceContext).entries[0];
    expect(record).toMatchObject({ content: text, title: "Submit IIT assignment", kind: "task", collection: "Study", deadline: "2026-10-09T18:30:00.000Z" });
    expect(record.interpretation.inferred_fields).toContain("kind");
  });

  it("separates spoken requests before interpreting their different deadlines", () => {
    const text = "Um, I need to submit my IIT assignment on the tenth of October at twelve a.m., and I also have to send Rohan an update tomorrow evening.";
    const result = organizeCapture(text, voiceContext);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((entry) => entry.content).join(" ")).toBe(text);
    expect(result.entries.map((entry) => entry.title)).toEqual(["Submit my IIT assignment", "Send Rohan an update"]);
    expect(result.entries.map((entry) => entry.deadline)).toEqual(["2026-10-09T18:30:00.000Z", "2026-10-07T12:30:00.000Z"]);
    expect(result.entries.map((entry) => entry.contacts)).toEqual([[], ["Rohan"]]);
    expect(result.entries[1].interpretation.warnings).toContain("Evening was inferred as 6 PM.");
  });

  it("handles a new sentence with spoken connectors and preserves each source chunk", () => {
    const text = "Finish Hydra DB video tomorrow. Also, I need to call Rohan tonight";
    const result = organizeCapture(text, voiceContext);
    expect(result.entries.map((entry) => entry.content).join(" ")).toBe(text);
    expect(result.entries.map((entry) => entry.title)).toEqual(["Finish Hydra DB video", "Call Rohan"]);
    expect(result.entries.map((entry) => entry.deadline)).toEqual(["2026-10-07T18:29:00.000Z", "2026-10-06T15:30:00.000Z"]);
  });

  it("organizes the actual local-transcription fixture into two independent tasks", () => {
    const text = "I need to submit my assignment for IIT Patna by 10 October at 12 a.m. Call Ravi tomorrow at 10 a.m.";
    const result = organizeCapture(text, { ...voiceContext, contacts: ["Ravi"] });
    expect(result.entries.map((entry) => entry.content).join(" ")).toBe(text);
    expect(result.entries.map((entry) => entry.kind)).toEqual(["task", "task"]);
    expect(result.entries.map((entry) => entry.title)).toEqual(["Submit my assignment for IIT Patna", "Call Ravi"]);
    expect(result.entries.map((entry) => entry.deadline)).toEqual(["2026-10-09T18:30:00.000Z", "2026-10-07T04:30:00.000Z"]);
    expect(result.entries.map((entry) => entry.collection)).toEqual(["IIT Patna", "Work"]);
    expect(result.entries.map((entry) => entry.contacts)).toEqual([[], ["Ravi"]]);
  });

  it("recognizes spoken ideas, note requests, events, and an implied recipient request", () => {
    const result = organizeCapture("Oh, I was thinking we could build a tiny desk terminal\nUm, make a note that Rohan prefers email and not phone calls.\nI've got a meeting with Rohan tomorrow morning\nI need an update from Rohan tomorrow at six p.m.", voiceContext);
    expect(result.entries.map((entry) => entry.kind)).toEqual(["idea", "note", "event", "task"]);
    expect(result.entries.map((entry) => entry.title)).toEqual(["Build a tiny desk terminal", "Rohan prefers email and not phone calls", "Meeting with Rohan", "Get an update from Rohan"]);
    expect(result.entries.map((entry) => entry.deadline)).toEqual([null, null, "2026-10-07T03:30:00.000Z", "2026-10-07T12:30:00.000Z"]);
    expect(result.entries[0].interpretation.inferred_fields).toContain("kind");
    expect(result.entries[2].interpretation.warnings).toContain("Morning was inferred as 9 AM.");
  });

  it("matches complete spoken names and canonicalizes grouping prefixes, without partial matches", () => {
    const result = organizeCapture("Hydra DB: Please send the draft to AnitaRao tomorrow\nReview IITPatna assignment\nNote: the hydra database and atlasian teams work near the mirage", voiceContext);
    expect(result.entries.map((entry) => entry.collection)).toEqual(["HydraDB", "IIT Patna", "Work"]);
    expect(result.entries[0].contacts).toEqual(["Anita Rao"]);
    expect(result.entries[2].contacts).toEqual([]);
    expect(result.associations.collections).toEqual(["HydraDB", "IIT Patna"]);
  });

  it("keeps compound objects/actions and ordinary prose together", () => {
    for (const text of ["Buy milk and bread tomorrow", "Read and review the article tomorrow", "Note: Rohan said send the draft and then review the comments tomorrow"]) {
      const result = organizeCapture(text, voiceContext);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].content).toBe(text);
    }
    expect(organizeCapture("Note: Rohan said send the draft and then review the comments tomorrow", voiceContext).entries[0].deadline).toBeNull();
  });

  it("preserves negative instructions while avoiding an obligation someone explicitly does not need", () => {
    const result = organizeCapture("Do not send the old invoice to Rohan tomorrow\nI do not need to send Rohan an update tomorrow", voiceContext);
    expect(result.entries.map((entry) => entry.kind)).toEqual(["task", "note"]);
    expect(result.entries[0].title).toBe("Do not send the old invoice to Rohan");
    expect(result.entries[1].title).toContain("not need");
    expect(result.entries[1].deadline).toBeNull();
  });

  it("saves vague timing instead of turning spoken hesitation into a precise deadline", () => {
    const text = "um finish that outline sometime maybe";
    const record = organizeCapture(text, voiceContext).entries[0];
    expect(record).toMatchObject({ title: "Finish that outline", content: text, kind: "task", deadline: null });
    expect(record.interpretation.warnings.some((warning) => /not precise/.test(warning))).toBe(true);
  });

  it("leaves unfinished fragments and historical time mentions as undated information", () => {
    const fragment = "and after that by today night and around 12:00 p.m. and I would I get a check around call before 10:00 p.m. so that I can see to the actual Hyderabad";
    const result = organizeCapture(fragment, voiceContext);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ content: fragment, kind: "note", deadline: null, collection: "Notes", contacts: [] });
    expect(result.associations.collections).toEqual([]);
    expect(organizeCapture("Note: Rohan sent the draft by Monday", voiceContext).entries[0].deadline).toBeNull();
  });

  it.each(["Submit the assignment tonight at 12 p.m.", "Call Rohan tomorrow night around twelve p.m."])("does not silently choose a conflicting noon/night clock in %s", (text) => {
    const record = organizeCapture(text, voiceContext).entries[0];
    expect(record.content).toBe(text);
    expect(record.deadline).toBeNull();
    expect(record.interpretation.warnings.some((warning) => /12 PM is noon/.test(warning))).toBe(true);
  });
});

describe("deadline time remaining", () => {
  const created = "2026-10-05T10:00:00Z";
  const due = "2026-10-05T14:00:00Z";

  it("runs from 100 at capture through 50 halfway to 0 at the deadline", () => {
    expect(deadlineProgress(created, due, new Date(created))).toEqual({ remaining_percent: 100, remaining_ms: 4 * 60 * 60 * 1000, overdue: false, has_deadline: true });
    expect(deadlineProgress(created, due, new Date("2026-10-05T12:00:00Z")).remaining_percent).toBe(50);
    expect(deadlineProgress(created, due, new Date(due))).toEqual({ remaining_percent: 0, remaining_ms: 0, overdue: false, has_deadline: true });
  });

  it("clamps future captures and overdue deadlines and handles zero baselines", () => {
    expect(deadlineProgress(created, due, new Date("2026-10-05T09:00:00Z")).remaining_percent).toBe(100);
    expect(deadlineProgress(created, due, new Date("2026-10-05T15:00:00Z"))).toEqual({ remaining_percent: 0, remaining_ms: 0, overdue: true, has_deadline: true });
    expect(deadlineProgress(due, due, new Date(due)).remaining_percent).toBe(0);
    expect(deadlineProgress("2026-10-06T10:00:00Z", due, new Date("2026-10-06T11:00:00Z")).remaining_percent).toBe(0);
  });

  it("makes no-deadline and invalid inputs explicit without NaN percentages", () => {
    expect(deadlineProgress(created, null, now)).toEqual({ remaining_percent: null, remaining_ms: null, overdue: false, has_deadline: false });
    expect(deadlineProgress(created, "not a date", now).has_deadline).toBe(false);
    expect(deadlineProgress("not a date", due, now).remaining_percent).toBeNull();
  });
});

describe("legacy record projection", () => {
  it("projects legacy tasks without storing work progress in the deadline bar", () => {
    const commitment = createSeedState("user", now).commitments[0];
    const record = legacyCommitmentToRecord({ ...commitment, completed_minutes: 70, remaining_minutes: 10, status: "done" });
    expect(record.id).toBe(`legacy:${commitment.id}`);
    expect(record.source).toBe("legacy");
    expect(record.status).toBe("archived");
    expect(record.deadline).toBe(commitment.deadline);
    expect(record.created_at).toBe(commitment.created_at);
    expect(record).not.toHaveProperty("completed_minutes");
    expect(projectCollections([{ ...record, collection: "HydraDB" }, { ...record, collection: "hydrAdb" }, { ...record, collection: "Ideas" }])).toEqual(["HydraDB", "Ideas"]);
  });
});
