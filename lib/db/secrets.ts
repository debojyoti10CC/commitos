import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
function encryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw)
    throw new Error(
      "Configure ENCRYPTION_KEY before connecting an integration (32 random bytes, base64 or 64 hex characters).",
    );
  const key = Buffer.from(raw, /^[a-f0-9]{64}$/i.test(raw) ? "hex" : "base64");
  if (key.length !== 32)
    throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}
export function encryptSecret(
  value: Record<string, unknown>,
  context: string,
): string {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    data.toString("base64url"),
  ].join(".");
}
export function decryptSecret(
  value: string,
  context: string,
): Record<string, unknown> {
  const [version, iv, tag, data] = value.split(".");
  if (version !== "v1" || !iv || !tag || !data)
    throw new Error("Invalid encrypted integration record");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(data, "base64url")),
      decipher.final(),
    ]).toString("utf8"),
  ) as Record<string, unknown>;
}
