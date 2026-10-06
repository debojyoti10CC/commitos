import { describe, expect, it } from "vitest";
import { deadlinePatchFromInput, inputDate } from "../components/format";

describe("record date corrections", () => {
  it("omits an unchanged deadline so heading edits retain seconds and milliseconds", () => {
    const original = "2026-10-10T06:30:37.456Z";
    const displayed = inputDate(original, "Asia/Kolkata");
    expect(displayed).toBe("2026-10-10T12:00");
    expect(deadlinePatchFromInput(displayed, displayed, "Asia/Kolkata")).toEqual({});
  });

  it.each([
    "2026-11-01T05:30:00.000Z",
    "2026-11-01T06:30:00.000Z",
    "2026-11-01T01:30:00-04:00",
  ])("does not rewrite either occurrence of an ambiguous local time: %s", (original) => {
    const displayed = inputDate(original, "America/New_York");
    expect(displayed).toBe("2026-11-01T01:30");
    expect(deadlinePatchFromInput(displayed, displayed, "America/New_York")).not.toHaveProperty("deadline");
  });

  it("omits a blank unchanged date rather than clearing a concurrent date change", () => {
    expect(deadlinePatchFromInput("", "", "Asia/Kolkata")).toEqual({});
  });

  it("includes only an explicitly changed date resolved in the selected timezone", () => {
    expect(deadlinePatchFromInput("2026-10-10T13:00", "2026-10-10T12:00", "Asia/Kolkata"))
      .toEqual({ deadline: "2026-10-10T07:30:00.000Z" });
    expect(deadlinePatchFromInput("2026-10-10T13:00", "", "Asia/Kolkata"))
      .toEqual({ deadline: "2026-10-10T07:30:00.000Z" });
  });

  it("clears the stored date only when the user empties an existing date input", () => {
    expect(deadlinePatchFromInput("", "2026-10-10T12:00", "Asia/Kolkata"))
      .toEqual({ deadline: null });
  });

  it("compares with the opening snapshot instead of a newly formatted source date", () => {
    const opened = inputDate("2026-10-10T06:30:37.456Z", "Asia/Kolkata");
    const newerDate = inputDate("2026-10-10T07:30:37.456Z", "Asia/Kolkata");
    expect(newerDate).not.toBe(opened);
    expect(deadlinePatchFromInput(opened, opened, "Asia/Kolkata")).toEqual({});
  });
});
