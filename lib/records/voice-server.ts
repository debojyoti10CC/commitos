import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ServiceError } from "../services";

export const MAX_VOICE_BYTES = 8 * 1024 * 1024;
const audioTypes = new Set(["audio/webm", "audio/mp4", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mpeg"]);
const resultSchema = z.object({
  text: z.string().max(20000), language: z.string().max(20).nullable(),
  duration: z.number().min(0).max(120),
});
let running = false;

function runtimePaths() {
  return {
    python: process.env.VOICE_PYTHON || path.resolve(".voice/venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
    script: path.resolve("scripts/transcribe-audio.py"),
    model: process.env.VOICE_MODEL_DIR || path.resolve(".voice/model"),
  };
}

export async function voiceReady() {
  const files = runtimePaths();
  try {
    await Promise.all([access(files.python), access(files.script), access(path.join(files.model, "model.bin"))]);
    return true;
  } catch { return false; }
}

/** Bound the stream itself; Content-Length alone is not a size guarantee. */
export async function readVoiceBody(request: Request): Promise<Buffer> {
  const type = (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!audioTypes.has(type)) throw new ServiceError("Send a microphone audio recording.", 415);
  if (Number(request.headers.get("content-length")) > MAX_VOICE_BYTES)
    throw new ServiceError("Recording is too large. Keep it under two minutes.", 413);
  if (!request.body) throw new ServiceError("The recording is empty.", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_VOICE_BYTES) {
        await reader.cancel();
        throw new ServiceError("Recording is too large. Keep it under two minutes.", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new ServiceError("The recording is empty.", 400);
  return Buffer.concat(chunks, size);
}

export function parseVoiceResult(output: string) {
  let value: unknown;
  try { value = JSON.parse(output); }
  catch { throw new ServiceError("The voice engine could not finish. Retry the recording.", 502); }
  if (value && typeof value === "object" && "error" in value) {
    const code = value.error;
    if (code === "AUDIO_TOO_LONG" || code === "AUDIO_TOO_LARGE")
      throw new ServiceError("Keep recordings under two minutes.", 413);
    if (code === "INVALID_AUDIO" || code === "INVALID_INPUT")
      throw new ServiceError("The recording could not be read. Please record again.", 422);
    if (code === "MODEL_UNAVAILABLE")
      throw new ServiceError("Voice transcription is not ready on the server.", 503);
    throw new ServiceError("Transcription failed. Your recording is available to retry.", 502);
  }
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) throw new ServiceError("The voice engine returned an incomplete transcript. Retry it.", 502);
  return { ...parsed.data, text: parsed.data.text.trim() };
}

/** Audio only goes to a local Python process; it is never saved or logged. */
export async function transcribeVoice(audio: Buffer, language: "en" | "hi" | null, vocabulary: string[]) {
  if (!audio.length || audio.length > MAX_VOICE_BYTES) throw new ServiceError("Recording is empty or too large.", 413);
  if (running) throw new ServiceError("Another recording is being transcribed. Retry in a moment.", 429);
  if (!await voiceReady()) throw new ServiceError("Voice transcription is not ready on the server.", 503);
  // Claim after asynchronous readiness so concurrent callers cannot both enter.
  if (running) throw new ServiceError("Another recording is being transcribed. Retry in a moment.", 429);
  running = true;
  const files = runtimePaths();
  try {
    const output = await new Promise<string>((resolve, reject) => {
      // Python/model are provisioned separately; trace the worker explicitly in Next config.
      const child = spawn(/* turbopackIgnore: true */ files.python, [files.script], {
        cwd: process.cwd(), windowsHide: true,
        env: { ...process.env, VOICE_MODEL_DIR: files.model, PYTHONIOENCODING: "utf-8" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let settled = false;
      let stdout = "";
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) { child.kill(); reject(error); }
        else resolve(stdout);
      };
      const timeout = setTimeout(() => finish(new ServiceError("Transcription took too long. Retry a shorter recording.", 504)), 180000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (part: string) => {
        stdout += part;
        if (stdout.length > 65536) finish(new ServiceError("The voice response was too large.", 502));
      });
      child.stderr.resume(); // Never log audio, transcripts, or runtime paths.
      child.on("error", () => finish(new ServiceError("The voice engine could not start.", 503)));
      child.stdin.on("error", () => finish(new ServiceError("The voice engine stopped before reading the recording.", 502)));
      child.on("close", code => code === 0 || stdout.trim() ? finish() : finish(new ServiceError("The voice engine stopped. Retry the recording.", 502)));
      child.stdin.end(JSON.stringify({
        audio: audio.toString("base64"), language,
        vocabulary: vocabulary.map(name => name.replace(/[\r\n]/g, " ")).join(", ").slice(0, 1000),
      }));
    });
    return parseVoiceResult(output);
  } finally { running = false; }
}
