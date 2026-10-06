import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ServiceError } from "./services";
import { assertRequestOrigin } from "./origin";
export function assertSafeMutation(request: Request) {
  try {
    assertRequestOrigin(request);
  } catch {
    throw new ServiceError("This request came from a different site", 403);
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 65536) throw new ServiceError("Request too large", 413);
  if (
    request.method !== "DELETE" &&
    !request.headers.get("content-type")?.includes("application/json")
  )
    throw new ServiceError("Send JSON", 415);
}
export async function jsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 65536) throw new ServiceError("Request too large", 413);
  if (!text) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ServiceError("Invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ServiceError("Expected an object");
  return value as Record<string, unknown>;
}
export function errorResponse(error: unknown) {
  if (error instanceof ZodError)
    return NextResponse.json(
      {
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
      { status: 400 },
    );
  if (error instanceof ServiceError)
    return NextResponse.json(
      { error: error.message },
      { status: error.status },
    );
  const v = error as { message?: string; status?: number; statusCode?: number };
  if (
    v.status === 401 ||
    v.statusCode === 401 ||
    v.message === "Unauthorized" ||
    v.message === "Authentication required"
  )
    return NextResponse.json({ error: "Please sign in" }, { status: 401 });
  if (
    v.message &&
    /^(Connect Google|Enable Gmail|Google (is not configured|authorization expired|request failed|authorization failed)|Enable .*Write focus blocks|Telegram (is not configured|request failed)|ENCRYPTION_KEY|SESSION_SECRET)/.test(
      v.message,
    )
  )
    return NextResponse.json({ error: v.message }, { status: 503 });
  console.error(
    JSON.stringify({
      level: "error",
      event: "api_failed",
      error: error instanceof Error ? error.name : "UnknownError",
    }),
  );
  return NextResponse.json(
    {
      error:
        "The request failed. Please retry. If this continues, check the server configuration.",
    },
    { status: 500 },
  );
}
