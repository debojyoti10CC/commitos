import { describe, expect, it } from "vitest";
import { MAX_VOICE_BYTES, parseVoiceResult, readVoiceBody } from "../lib/records/voice-server";

describe("recorded audio boundary", () => {
  it("accepts recorded WebM with codec parameters without rewriting bytes", async () => {
    const input = new Uint8Array([26, 69, 223, 163, 1, 2, 3]);
    const output = await readVoiceBody(new Request("http://localhost/api/transcribe", {
      method: "POST", headers: { "Content-Type": "audio/webm;codecs=opus" }, body: input,
    }));
    expect([...output]).toEqual([...input]);
  });
  it("rejects non-audio and empty recordings", async () => {
    await expect(readVoiceBody(new Request("http://localhost", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }))).rejects.toMatchObject({ status: 415 });
    await expect(readVoiceBody(new Request("http://localhost", {
      method: "POST", headers: { "Content-Type": "audio/mp4" }, body: new Uint8Array(),
    }))).rejects.toMatchObject({ status: 400 });
  });
  it("enforces the byte limit even when the supplied length lies", async () => {
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(MAX_VOICE_BYTES));
      controller.enqueue(new Uint8Array(1)); controller.close();
    } });
    const request = new Request("http://localhost", {
      method: "POST", headers: { "Content-Type": "audio/ogg", "Content-Length": "1" },
      body: stream, duplex: "half",
    } as RequestInit);
    await expect(readVoiceBody(request)).rejects.toMatchObject({ status: 413 });
  });
});

describe("local voice engine response", () => {
  it("retains spoken words and treats silence as an empty transcript", () => {
    expect(parseVoiceResult(JSON.stringify({ text: "  Submit the IIT assignment tomorrow. ", language: "en", duration: 8.2 })))
      .toEqual({ text: "Submit the IIT assignment tomorrow.", language: "en", duration: 8.2 });
    expect(parseVoiceResult(JSON.stringify({ text: "", language: "en", duration: 2 })).text).toBe("");
    expect(parseVoiceResult(JSON.stringify({ text: "", language: null, duration: 2 })).text).toBe("");
  });
  it("rejects malformed, oversized or incomplete transcripts", () => {
    for (const output of ["broken", "{}", JSON.stringify({ text: "hello", language: "en", duration: 121 }),
      JSON.stringify({ text: "x".repeat(20001), language: "en", duration: 10 })])
      expect(() => parseVoiceResult(output)).toThrow();
  });
  it("returns safe failures without leaking arbitrary worker output", () => {
    for (const [code, status] of [["MODEL_UNAVAILABLE", 503], ["INVALID_AUDIO", 422], ["AUDIO_TOO_LONG", 413], ["TRANSCRIPTION_FAILED", 502]] as const) {
      try { parseVoiceResult(JSON.stringify({ error: code, detail: "private audio or server path" })); }
      catch (error) {
        expect(error).toMatchObject({ status });
        expect((error as Error).message).not.toContain("private");
      }
    }
  });
});
