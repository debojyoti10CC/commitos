/** Explicit production origin; development permits equivalent loopback names on the same port. */
export function assertRequestOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const expected = new URL(process.env.APP_URL || request.url);
  const allowed = new Set([expected.origin]);
  if (
    process.env.NODE_ENV !== "production" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(expected.hostname)
  )
    for (const host of ["localhost", "127.0.0.1", "[::1]"])
      allowed.add(
        `${expected.protocol}//${host}${expected.port ? `:${expected.port}` : ""}`,
      );
  // Vercel's own immutable deployment hostname is safe for same-deployment
  // requests such as signup on a preview URL. Keep the public canonical origin
  // above as the redirect/cookie origin, and never trust an arbitrary Host header.
  const deploymentHost = process.env.VERCEL === "1" ? process.env.VERCEL_URL : undefined;
  if (deploymentHost && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app$/i.test(deploymentHost))
    allowed.add(`https://${deploymentHost}`);
  if (
    (origin && !allowed.has(origin)) ||
    (!origin && request.headers.get("sec-fetch-site") === "cross-site")
  )
    throw Object.assign(new Error("Cross-origin requests are not allowed"), {
      status: 403,
    });
}
