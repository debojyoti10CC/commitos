import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), state: vi.fn(), ready: vi.fn(), read: vi.fn(), transcribe: vi.fn() }));
vi.mock("../lib/auth", () => ({ requireUser: mocks.user }));
vi.mock("../lib/db/repository", () => ({ readState: mocks.state }));
vi.mock("../lib/records/voice-server", () => ({ voiceReady: mocks.ready, readVoiceBody: mocks.read, transcribeVoice: mocks.transcribe }));
import { GET, POST } from "../app/api/transcribe/route";

beforeEach(() => {
  vi.resetAllMocks();
  process.env.APP_URL = "http://127.0.0.1:3000";
  mocks.user.mockResolvedValue({ id: "owner" });
  mocks.state.mockResolvedValue({ projects: [{ name: "IIT Patna" }], contacts: [{ name: "Mira" }] });
  mocks.ready.mockResolvedValue(true);
  mocks.read.mockResolvedValue(Buffer.from("audio"));
  mocks.transcribe.mockResolvedValue({ text: "Send Mira the update tomorrow.", language: "en", duration: 5 });
});
const recording = (query = "", origin = "http://127.0.0.1:3000") => new Request(`http://127.0.0.1:3000/api/transcribe${query}`, {
  method: "POST", headers: { "Content-Type": "audio/webm", Origin: origin }, body: "audio",
});
describe("private transcription API", () => {
  it("requires a signed-in owner before reading microphone data", async () => {
    mocks.user.mockRejectedValue(Object.assign(new Error("Sign in"), { status: 401 }));
    expect((await POST(recording())).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
    expect((await GET(new Request("http://127.0.0.1:3000/api/transcribe"))).status).toBe(401);
  });
  it("denies other origins without starting the model", async () => {
    expect((await POST(recording("", "https://other.example"))).status).toBe(403);
    expect(mocks.user).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
  it("uses only the account's named associations for recognition context", async () => {
    const response = await POST(recording());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.state).toHaveBeenCalledWith("owner");
    expect(mocks.transcribe).toHaveBeenCalledWith(Buffer.from("audio"), "en", ["IIT Patna", "Mira"]);
    expect(await response.json()).toMatchObject({ text: "Send Mira the update tomorrow." });
  });
  it("supports language detection and rejects unexpected language values", async () => {
    expect((await POST(recording("?language=auto"))).status).toBe(200);
    expect(mocks.transcribe.mock.calls[0][1]).toBeNull();
    expect((await POST(recording("?language=not-a-language"))).status).toBe(400);
  });
});
