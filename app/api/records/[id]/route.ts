import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { assertSafeMutation, errorResponse, jsonBody } from "@/lib/http";
import { archiveRecord, updateRecord } from "@/lib/records/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const privateHeaders = { "Cache-Control": "private, no-store" };

export async function PATCH(request: Request, context: Context) {
  try {
    assertSafeMutation(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    const result = await updateRecord(user.id, id, await jsonBody(request));
    return NextResponse.json(result, { headers: privateHeaders });
  } catch (error) { return errorResponse(error); }
}

/** DELETE is reversible archival; records remain available to replay and restore. */
export async function DELETE(request: Request, context: Context) {
  try {
    assertSafeMutation(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    return NextResponse.json(await archiveRecord(user.id, id), { headers: privateHeaders });
  } catch (error) { return errorResponse(error); }
}
