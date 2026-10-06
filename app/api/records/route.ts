import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { readState } from "@/lib/db/repository";
import { assertSafeMutation, errorResponse, jsonBody } from "@/lib/http";
import { captureRecords } from "@/lib/records/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const privateHeaders = { "Cache-Control": "private, no-store" };
const capture = z.object({
  text: z.string().trim().min(1).max(20000),
  source: z.enum(["text", "voice"]).optional(),
  request_id: z.uuid().optional(),
}).strict();

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const state = await readState(user.id);
    return NextResponse.json({ records: state.records }, { headers: privateHeaders });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    assertSafeMutation(request);
    const user = await requireUser(request);
    const input = capture.parse(await jsonBody(request));
    const result = await captureRecords(user.id, input.text, { source: input.source, request_id: input.request_id });
    return NextResponse.json(result, { headers: privateHeaders });
  } catch (error) { return errorResponse(error); }
}
