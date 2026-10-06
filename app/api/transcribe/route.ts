import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { readState } from "@/lib/db/repository";
import { errorResponse } from "@/lib/http";
import { assertRequestOrigin } from "@/lib/origin";
import { ServiceError } from "@/lib/services";
import { readVoiceBody, transcribeVoice, voiceReady } from "@/lib/records/voice-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
const privateHeaders = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  try {
    await requireUser(request);
    return NextResponse.json({ ready: await voiceReady() }, { headers: privateHeaders });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    try { assertRequestOrigin(request); }
    catch { throw new ServiceError("This recording came from a different site.", 403); }
    const user = await requireUser(request);
    const requested = new URL(request.url).searchParams.get("language") || "en";
    if (!["en", "hi", "auto"].includes(requested)) throw new ServiceError("Choose English, Hindi, or automatic language detection.", 400);
    const audio = await readVoiceBody(request);
    const state = await readState(user.id);
    const vocabulary = [...state.projects.map(p => p.name), ...state.contacts.map(p => p.name)];
    const transcript = await transcribeVoice(audio, requested === "auto" ? null : requested as "en" | "hi", vocabulary);
    return NextResponse.json(transcript, { headers: privateHeaders });
  } catch (error) { return errorResponse(error); }
}
