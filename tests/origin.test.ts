import { afterEach, describe, expect, it, vi } from "vitest";
import { assertRequestOrigin } from "@/lib/origin";
afterEach(() => vi.unstubAllEnvs());
describe("trusted request origins", () => {
  it("accepts equivalent local development names but rejects another port", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_URL", "");
    expect(() =>
      assertRequestOrigin(
        new Request("http://localhost:3000/api/state", {
          headers: { origin: "http://127.0.0.1:3000" },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertRequestOrigin(
        new Request("http://localhost:3000/api/state", {
          headers: { origin: "http://localhost:4000" },
        }),
      ),
    ).toThrow();
  });
  it("uses only the explicit production origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "https://commitos.example");
    expect(() =>
      assertRequestOrigin(
        new Request("http://localhost:3000/api/state", {
          headers: { origin: "https://commitos.example" },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertRequestOrigin(
        new Request("http://localhost:3000/api/state", {
          headers: { origin: "http://localhost:3000" },
        }),
      ),
    ).toThrow();
  });
  it("rejects cross-site requests without an origin", () => {
    expect(() =>
      assertRequestOrigin(
        new Request("http://localhost:3000/api/state", {
          headers: { "sec-fetch-site": "cross-site" },
        }),
      ),
    ).toThrow();
  });
});
