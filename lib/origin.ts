/** Explicit production origin; development permits equivalent loopback names on the same port. */
export function assertRequestOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const expected = new URL(process.env.APP_URL || request.url);
  const allowed = new Set([expected.origin]);
  if (
    !process.env.APP_URL &&
    process.env.NODE_ENV !== "production" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(expected.hostname)
  )
    for (const host of ["localhost", "127.0.0.1", "[::1]"])
      allowed.add(
        `${expected.protocol}//${host}${expected.port ? `:${expected.port}` : ""}`,
      );
  if (
    (origin && !allowed.has(origin)) ||
    (!origin && request.headers.get("sec-fetch-site") === "cross-site")
  )
    throw Object.assign(new Error("Cross-origin requests are not allowed"), {
      status: 403,
    });
}
