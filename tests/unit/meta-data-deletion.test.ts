import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONFIRMATION_CODE_RE,
  parseSignedRequest,
} from "@/server/meta/data-deletion";

const SECRET = "app-secret-de-test";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Arma un signed_request como lo hace Meta. */
function signedRequest(payload: object, secret = SECRET): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac("sha256", secret).update(body).digest());
  return `${sig}.${body}`;
}

const PAYLOAD = { algorithm: "HMAC-SHA256", user_id: "123", issued_at: 1, expires: 2 };

describe("parseSignedRequest", () => {
  it("firma válida → payload", () => {
    expect(parseSignedRequest(signedRequest(PAYLOAD), SECRET)).toMatchObject({ user_id: "123" });
  });

  it("firmado con otro secreto → null", () => {
    expect(parseSignedRequest(signedRequest(PAYLOAD, "otro"), SECRET)).toBeNull();
  });

  it("algoritmo distinto o formato roto → null", () => {
    expect(parseSignedRequest(signedRequest({ ...PAYLOAD, algorithm: "none" }), SECRET)).toBeNull();
    expect(parseSignedRequest("sin-punto", SECRET)).toBeNull();
  });
});

describe("POST /api/meta/data-deletion", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("APP_BASE_URL", "https://crm.example.com");
    vi.stubEnv("DATABASE_URL", "postgresql://t:t@localhost:5432/t");
    vi.stubEnv("BETTER_AUTH_SECRET", "secret-de-test-suficiente");
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 3).toString("base64"));
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "verify-test");
    vi.stubEnv("META_APP_SECRET", SECRET);
  });

  afterEach(() => vi.unstubAllEnvs());

  function post(body: string) {
    return new Request("https://crm.example.com/api/meta/data-deletion", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  it("solicitud firmada → { url, confirmation_code } con la página de estado", async () => {
    const { POST } = await import("@/app/api/meta/data-deletion/route");
    const res = await POST(post(`signed_request=${encodeURIComponent(signedRequest(PAYLOAD))}`));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { url: string; confirmation_code: string };
    expect(json.confirmation_code).toMatch(CONFIRMATION_CODE_RE);
    expect(json.url).toBe(
      `https://crm.example.com/eliminacion-datos?codigo=${json.confirmation_code}`
    );
  });

  it("firma inválida → 400", async () => {
    const { POST } = await import("@/app/api/meta/data-deletion/route");
    const res = await POST(post(`signed_request=${encodeURIComponent(signedRequest(PAYLOAD, "otro"))}`));
    expect(res.status).toBe(400);
  });
});
