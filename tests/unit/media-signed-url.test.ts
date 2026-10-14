import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

/**
 * 018 (FR-812) — URL firmada de un saliente para Instagram: HMAC con clave
 * derivada de ENCRYPTION_KEY, 10 min, y null (→ 404) ante cualquier cosa
 * rara: adulterado, vencido, otra organización, formato basura.
 */

const KEY = Buffer.alloc(32, 7).toString("base64");
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ ENCRYPTION_KEY: KEY, APP_BASE_URL: "https://crm.example.com/" }),
}));

const { signMediaToken, signMediaUrl, verifyMediaToken, SIGNED_URL_TTL_MS } = await import(
  "@/server/media/signed-url"
);

const NOW = 1_800_000_000_000;

describe("URL firmada de medios salientes", () => {
  it("ida y vuelta: el token dice org y asset", () => {
    const t = signMediaToken("org_1", "ma_abc-1", SIGNED_URL_TTL_MS, NOW);
    expect(verifyMediaToken(t, NOW + 1000)).toEqual({ organizationId: "org_1", assetId: "ma_abc-1" });
  });

  it("URL absoluta bajo /api/media/out/ con APP_BASE_URL (sin doble barra)", () => {
    const url = signMediaUrl("org_1", "ma_1");
    expect(url).toMatch(/^https:\/\/crm\.example\.com\/api\/media\/out\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("vence a los 10 minutos", () => {
    const t = signMediaToken("org_1", "ma_1", SIGNED_URL_TTL_MS, NOW);
    expect(SIGNED_URL_TTL_MS).toBe(10 * 60 * 1000);
    expect(verifyMediaToken(t, NOW + SIGNED_URL_TTL_MS - 1)).not.toBeNull();
    expect(verifyMediaToken(t, NOW + SIGNED_URL_TTL_MS)).toBeNull();
  });

  it("adulterar el payload (otro asset u otra organización) invalida la firma", () => {
    const t = signMediaToken("org_1", "ma_1", SIGNED_URL_TTL_MS, NOW);
    const sig = t.split(".")[1]!;
    for (const forged of ["org_2.ma_1", "org_1.ma_2"]) {
      const payload = Buffer.from(`${forged}.${NOW + SIGNED_URL_TTL_MS}`).toString("base64url");
      expect(verifyMediaToken(`${payload}.${sig}`, NOW)).toBeNull();
    }
    // Alargar el vencimiento también rompe la firma.
    const later = Buffer.from(`org_1.ma_1.${NOW + 10 * SIGNED_URL_TTL_MS}`).toString("base64url");
    expect(verifyMediaToken(`${later}.${sig}`, NOW)).toBeNull();
  });

  it("cambiar CUALQUIER carácter de la firma (también el último) → null", () => {
    // El último carácter base64url de 32 bytes lleva bits de relleno: sin la
    // comprobación canónica, 3 de cada 4 cambios decodificaban igual.
    const t = signMediaToken("org_1", "ma_1", SIGNED_URL_TTL_MS, NOW);
    const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (const ch of ABC) {
      if (ch === t.at(-1)) continue;
      expect(verifyMediaToken(`${t.slice(0, -1)}${ch}`, NOW)).toBeNull();
    }
  });

  it("firma con la clave maestra SIN derivar → rechazada (la clave se deriva)", () => {
    const payload = `org_1.ma_1.${NOW + SIGNED_URL_TTL_MS}`;
    const raw = createHmac("sha256", Buffer.from(KEY, "base64")).update(payload).digest("base64url");
    expect(verifyMediaToken(`${Buffer.from(payload).toString("base64url")}.${raw}`, NOW)).toBeNull();
  });

  it("firma truncada o alterada → null (sin lanzar)", () => {
    const t = signMediaToken("org_1", "ma_1", SIGNED_URL_TTL_MS, NOW);
    expect(verifyMediaToken(t.slice(0, -2), NOW)).toBeNull();
    const last = t.at(-1) === "A" ? "B" : "A";
    expect(verifyMediaToken(t.slice(0, -1) + last, NOW)).toBeNull();
  });

  it.each([
    "",
    "solo-una-parte",
    "a.b.c",
    "%%%.###",
    `${"a".repeat(600)}.b`,
    `${Buffer.from("org_1.ma_1").toString("base64url")}.AAAA`,
    `${Buffer.from("org/1.ma_1.999999999999999").toString("base64url")}.AAAA`,
    `${Buffer.from("org_1.ma_1.-5").toString("base64url")}.AAAA`,
  ])("formato basura %j → null", (token) => {
    expect(verifyMediaToken(token, NOW)).toBeNull();
  });

  it("no firma ids con caracteres fuera de [A-Za-z0-9_-]", () => {
    expect(() => signMediaToken("org.1", "ma_1")).toThrow();
    expect(() => signMediaToken("org_1", "../x")).toThrow();
  });
});
