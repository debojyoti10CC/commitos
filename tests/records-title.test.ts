import { describe, expect, it } from "vitest";
import { briefRecordTitle } from "../lib/records/title";

describe("semantic record headings", () => {
  it("extracts the nominal submission topic without its possible extension", () => {
    const text = "celo hackathon submission need to be one before 10 tmrw but can be streched to 12 noon";
    expect(briefRecordTitle(text, "task", text)).toBe("Submit Celo hackathon");
    expect(briefRecordTitle("membership renewal needs to be done by Friday", "task")).toBe("Renew Membership");
  });
  it("turns the actual IIT submission statement into its core action", () => {
    const text = "IIT submission assignment by 10th October 12 a.m. and I need to get an update";
    expect(briefRecordTitle(text, "task", text)).toBe("Submit IIT assignment");
  });

  it.each([
    "IIT assignment submission by October tenth at twelve a.m.",
    "Submission of the IIT assignment by 2026-10-10 at 12 AM",
  ])("removes spoken and written dates from %s", (text) => {
    expect(briefRecordTitle(text, "task", text)).toBe("Submit IIT assignment");
  });

  it("removes project prefixes, conversational filler, and follow-on requests", () => {
    const text = "HydraDB: Um, I need to finish the onboarding video tomorrow at 9 PM and I need to get an update";
    expect(briefRecordTitle(text, "task", text)).toBe("Finish the onboarding video");
    expect(briefRecordTitle("Project: Atlas\nTask: Send the draft by Friday", "task")).toBe("Send the draft");
  });

  it.each([
    ["Hey, could you please send Mira an update tomorrow evening?", "task", "Send Mira an update"],
    ["The IIT assignment needs to be submitted by the tenth of October at twelve a.m.", "task", "Submit IIT assignment"],
    ["Oh, I was thinking we could build a tiny desk terminal", "idea", "Build a tiny desk terminal"],
    ["Um, make a note that Rohan prefers email and not phone calls", "note", "Rohan prefers email and not phone calls"],
    ["I need an update from Rohan tomorrow at six p.m.", "task", "Get an update from Rohan"],
  ] as const)("extracts a brief topic from conversational speech: %s", (text, kind, expected) => {
    expect(briefRecordTitle(text, kind, text)).toBe(expected);
  });

  it("does not mistake a stripped auto-heading for a custom title", () => {
    expect(briefRecordTitle("Send draft tomorrow at 5 PM", "task", "HydraDB: Send draft tomorrow at 5 PM")).toBe("Send draft");
  });

  it("preserves concise custom headings and ordinary short headings", () => {
    expect(briefRecordTitle("My launch plan", "note", "We discussed all the options and agreed to continue later.")).toBe("My launch plan");
    expect(briefRecordTitle("Plan by Friday", "task", "I need to prepare the launch roadmap tomorrow.")).toBe("Plan by Friday");
    expect(briefRecordTitle("Finish the draft", "task")).toBe("Finish the draft");
    expect(briefRecordTitle("HydraDB research", "note")).toBe("HydraDB research");
  });

  it("keeps ordinary quantities and titles rather than treating every number as a date", () => {
    const text = "Um I need to buy 12 notebooks and 3 blue pens before Friday";
    expect(briefRecordTitle(text, "task", text)).toBe("Buy 12 notebooks and 3 blue pens");
    expect(briefRecordTitle("Review version 12 startup on 10 machines", "task")).toBe("Review version 12 startup on 10 machines");
    expect(briefRecordTitle("Read 1984 by George Orwell", "task")).toBe("Read 1984 by George Orwell");
  });

  it("keeps negated instructions and named recipients", () => {
    expect(briefRecordTitle("Don't send the draft to Rohan before Friday", "task")).toBe("Don't send the draft to Rohan");
    const title = briefRecordTitle("I need to review the launch roadmap, scope and design changes with Anita Rao tomorrow", "task");
    expect(title).toContain("Anita Rao");
    expect(title).toMatch(/^Review/);
    expect(title.split(/\s+/).length).toBeLessThanOrEqual(8);
  });

  it("preserves the meaningful negation in long notes", () => {
    const preference = briefRecordTitle("Note: Rohan prefers email updates and does not want phone calls or unexpected interruptions during work", "note");
    expect(preference).toContain("Rohan");
    expect(preference).toContain("not phone calls");
    const limitation = briefRecordTitle("The core API integration for the second mobile app does not support offline login at all", "note");
    expect(limitation).toContain("API");
    expect(limitation).toContain("not support offline login");
    expect(limitation.split(/\s+/).length).toBeLessThanOrEqual(8);
  });

  it("does not replace an existing task action just because payment or submission is mentioned", () => {
    expect(briefRecordTitle("Download payment statement tomorrow", "task")).toBe("Download payment statement");
    expect(briefRecordTitle("Review the IIT submission before Friday", "task")).toBe("Review the IIT submission");
    expect(briefRecordTitle("Discuss visa renewal with Rohan tomorrow", "task")).toBe("Discuss visa renewal with Rohan");
  });

  it("gives bookmarked links a useful path and host instead of a grouping caption", () => {
    expect(briefRecordTitle("Save https://example.com/guide for IIT Patna", "reference")).toBe("Guide · example.com");
    expect(briefRecordTitle("Bookmark API authentication guide https://example.com/docs", "reference")).toBe("API authentication guide");
  });

  it("keeps dated prose as a note topic when the date is not a deadline clause", () => {
    expect(briefRecordTitle("Note: October is the launch theme, not a deadline", "note")).toBe("October is the launch theme, not a deadline");
  });

  it("makes arbitrary notes and ideas brief without modifying their source", () => {
    for (const [kind, text] of [
      ["note", "The unusual sandstone window patterns around the old library reminded me of the sketches from our previous trip."],
      ["idea", "Idea: What if we could build a tiny offline capture tool with automatic organization and a compact desk display?"],
    ] as const) {
      const before = text;
      const title = briefRecordTitle(text, kind, text);
      expect(title.length).toBeLessThanOrEqual(60);
      expect(title.split(/\s+/).length).toBeLessThanOrEqual(8);
      expect(title).not.toContain("…");
      expect(text).toBe(before);
    }
  });
});
