import { describe, expect, it } from "vitest";
import {
  defaultVoiceLanguage,
  readSpeechTranscript,
  voiceTranscriptDraft,
} from "../lib/records/transcription";

const final = (transcript: string) => ({ isFinal: true, 0: { transcript } });
const interim = (transcript: string) => ({ isFinal: false, 0: { transcript } });

describe("voice transcript review", () => {
  it("separates final phrases with spaces when the browser omits boundary spaces", () => {
    expect(
      readSpeechTranscript([final("submit this"), final("tomorrow at ten")]),
    ).toEqual({
      final: "submit this tomorrow at ten",
      interim: "",
      transcript: "submit this tomorrow at ten",
    });
  });

  it("replaces revised interim wording while retaining all final phrases once", () => {
    readSpeechTranscript([final("send the invoice"), interim("to mall")]);
    const revised = readSpeechTranscript([
      final("send the invoice"),
      final("to Maya"),
      interim("on Friday"),
    ]);
    expect(revised.transcript).toBe("send the invoice to Maya on Friday");
    expect(revised.final).toBe("send the invoice to Maya");
    expect(revised.interim).toBe("on Friday");
  });

  it("keeps the latest interim transcript available for review if recording ends", () => {
    const lastResult = readSpeechTranscript([
      final("Meeting with Maya"),
      interim("tomorrow at ten thirty"),
    ]);
    expect(voiceTranscriptDraft("", lastResult.transcript)).toBe(
      "Meeting with Maya tomorrow at ten thirty",
    );
  });

  it("keeps a typed draft when adding voice and receiving an empty result", () => {
    expect(voiceTranscriptDraft("Existing note", "A second thought")).toBe(
      "Existing note\nA second thought",
    );
    expect(
      voiceTranscriptDraft(
        "Existing note",
        readSpeechTranscript([]).transcript,
      ),
    ).toBe("Existing note");
  });

  it("supports spaced Hindi results and defaults to the browser language when offered", () => {
    expect(
      readSpeechTranscript([final("कल"), final("दस बजे बैठक")]).transcript,
    ).toBe("कल दस बजे बैठक");
    expect(defaultVoiceLanguage("hi")).toBe("hi-IN");
    expect(defaultVoiceLanguage("en-US")).toBe("en-US");
    expect(defaultVoiceLanguage("en-IN")).toBe("en-IN");
    expect(defaultVoiceLanguage("fr-FR")).toBe("en-IN");
  });
});
