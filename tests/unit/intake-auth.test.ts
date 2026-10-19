import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const GOOD = "clave-buena";

vi.mock("@/server/bot/auth", () => ({
  resolveInstanceOrg: vi.fn(async () => "org_1"),
}));
vi.mock("@/server/intake/settings", () => ({
  verifyIntakeKey: vi.fn(async (_org: string, provided: string) => provided === GOOD),
}));

import { resetRateLimit } from "@/lib/rate-limit";
import {
  INTAKE_FAIL_RATE_LIMIT,
  INTAKE_RATE_LIMIT,
  clientIp,
  requireIntakeKey,
} from "@/server/intake/auth";
import { verifyIntakeKey } from "@/server/intake/settings";

/**
 * 011 (RF-2) — Límite de tasa de `POST /api/intake/lead`: los fallos cuentan
 * por IP (y la bloquean), el cupo global solo lo gastan los autenticados. Un
 * atacante sin clave no deja al ERP en 429.
 */

function req(key: string | null, ip?: string): Request {
  const headers: Record<string, string> = {};
  if (key !== null) headers["x-api-key"] = key;
  if (ip) headers["x-forwarded-for"] = `${ip}, 10.0.0.1`;
  return new Request("http://localhost/api/intake/lead", { method: "POST", headers });
}

async function status(r: Request): Promise<number> {
  const res = await requireIntakeKey(r);
  return res.ok ? 200 : res.response.status;
}

describe("011 — límite de tasa del intake", () => {
  const prev = process.env.LEADS_EXTERNOS;
  beforeEach(() => {
    process.env.LEADS_EXTERNOS = "on";
    resetRateLimit();
    vi.mocked(verifyIntakeKey).mockClear();
  });
  afterEach(() => {
    process.env.LEADS_EXTERNOS = prev;
  });

  it("la IP sale de x-forwarded-for (primera), luego x-real-ip, si no «local»", () => {
    expect(clientIp(req(null, "203.0.113.7"))).toBe("203.0.113.7");
    expect(
      clientIp(new Request("http://x", { headers: { "x-real-ip": "198.51.100.2" } }))
    ).toBe("198.51.100.2");
    expect(clientIp(req(null))).toBe("local");
  });

  it("bandera apagada → 404 antes que todo", async () => {
    process.env.LEADS_EXTERNOS = "off";
    expect(await status(req(GOOD))).toBe(404);
  });

  it("los fallos de una IP la bloquean (429) sin tocar la clave ni a otras IPs", async () => {
    for (let i = 0; i < INTAKE_FAIL_RATE_LIMIT.max; i++) {
      expect(await status(req(i % 2 ? "mala" : null, "203.0.113.7"))).toBe(401);
    }
    const calls = vi.mocked(verifyIntakeKey).mock.calls.length;
    // Bloqueada: ni con la clave buena, y sin llegar a verificarla.
    expect(await status(req("mala", "203.0.113.7"))).toBe(429);
    expect(await status(req(GOOD, "203.0.113.7"))).toBe(429);
    expect(vi.mocked(verifyIntakeKey).mock.calls.length).toBe(calls);
    // El ERP, desde otra IP, sigue pasando.
    expect(await status(req(GOOD, "198.51.100.2"))).toBe(200);
  });

  it("muchas peticiones con clave mala NO gastan el cupo global", async () => {
    for (let i = 0; i < INTAKE_RATE_LIMIT.max + 30; i++) {
      await status(req("mala", `203.0.113.${i % 250}`));
    }
    expect(await status(req(GOOD, "198.51.100.2"))).toBe(200);
  });

  it("las peticiones autenticadas no llenan la cubeta de fallos", async () => {
    for (let i = 0; i < INTAKE_FAIL_RATE_LIMIT.max + 5; i++) {
      expect(await status(req(GOOD, "198.51.100.2"))).toBe(200);
    }
    expect(await status(req("mala", "198.51.100.2"))).toBe(401);
  });

  it("el cupo global (solo autenticadas) → 429 al excederse", async () => {
    for (let i = 0; i < INTAKE_RATE_LIMIT.max; i++) {
      expect(await status(req(GOOD))).toBe(200);
    }
    const r = await requireIntakeKey(req(GOOD));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(429);
      expect(((await r.response.json()) as { error: { code: string } }).error.code).toBe(
        "rate_limited"
      );
    }
  });
});
