import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 018 (FR-812) — `GET /api/media/out/[token]`: pública, pero solo entrega un
 * asset SALIENTE disponible de la organización del token, con cabeceras
 * seguras y `no-store`. Todo lo demás es el mismo 404 sin cuerpo.
 * También: la matriz de archivos depende de la conexión (Zernio → ninguno).
 */

const KEY = Buffer.alloc(32, 9).toString("base64");
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  whereArgs: [] as unknown[],
  readMediaFile: vi.fn(),
}));

vi.mock("@/lib/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...original,
    getEnv: () => ({ ENCRYPTION_KEY: KEY, APP_BASE_URL: "https://crm.example.com" }),
  };
});
vi.mock("@/server/whatsapp/media", () => ({ readMediaFile: h.readMediaFile }));
vi.mock("@/lib/db/tenant", () => ({
  scoped: (...args: unknown[]) => {
    h.whereArgs = args;
    return "where";
  },
}));
vi.mock("drizzle-orm", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm")>();
  return { ...original, eq: (col: unknown, val: unknown) => ({ col, val }) };
});
vi.mock("@/lib/db", () => {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = async () => h.rows;
  return {
    getDb: () => ({ select: () => chain }),
    schema: {
      mediaAsset: { organizationId: "organizationId", id: "id", direction: "direction" },
    },
  };
});

const { GET } = await import("@/app/api/media/out/[token]/route");
const { signMediaToken } = await import("@/server/media/signed-url");
const { outboundFilesFor, capabilitiesFor } = await import("@/server/channels/capabilities");

const call = (token: string) =>
  GET(new Request(`https://crm.example.com/api/media/out/${token}`), {
    params: Promise.resolve({ token }),
  });

const outAsset = {
  id: "ma_1",
  organizationId: "org_1",
  direction: "out",
  fetchStatus: "available",
  storagePath: "org_1/ma_1",
  fileName: "cotizacion.pdf",
  mimeType: "application/pdf",
};

describe("GET /api/media/out/[token]", () => {
  beforeEach(() => {
    h.rows = [outAsset];
    h.whereArgs = [];
    h.readMediaFile.mockReset();
    h.readMediaFile.mockResolvedValue(PDF);
  });

  it("token válido → bytes con cabeceras seguras y no-store; filtra por org, id y direction=out", async () => {
    const res = await call(signMediaToken("org_1", "ma_1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);
    expect(h.whereArgs.slice(0, 2)).toEqual(["organizationId", "org_1"]);
    expect(h.whereArgs).toContainEqual({ col: "id", val: "ma_1" });
    expect(h.whereArgs).toContainEqual({ col: "direction", val: "out" });
  });

  it.each([
    ["token basura", () => "basura"],
    ["token vencido", () => signMediaToken("org_1", "ma_1", 1_000, Date.now() - 60_000)],
  ])("%s → 404 sin consultar la BD", async (_l, token) => {
    const res = await call(token());
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(h.whereArgs).toEqual([]);
  });

  it("asset ausente (otra org / entrante), no disponible o sin archivo → 404", async () => {
    h.rows = [];
    expect((await call(signMediaToken("org_2", "ma_1"))).status).toBe(404);
    h.rows = [{ ...outAsset, fetchStatus: "expired", storagePath: null }];
    expect((await call(signMediaToken("org_1", "ma_1"))).status).toBe(404);
    h.rows = [outAsset];
    h.readMediaFile.mockRejectedValue(new Error("ENOENT"));
    expect((await call(signMediaToken("org_1", "ma_1"))).status).toBe(404);
  });

  it("bytes que ya no pasan la política → 404 (no 415: no se distingue)", async () => {
    h.readMediaFile.mockResolvedValue(Buffer.from("<!doctype html><script>x</script>"));
    expect((await call(signMediaToken("org_1", "ma_1"))).status).toBe(404);
  });
});

describe("outboundFilesFor — la conexión manda", () => {
  it("Instagram vía Zernio → null; vía Meta o sin conexión → la matriz del canal", () => {
    expect(outboundFilesFor("instagram", "zernio")).toBeNull();
    expect(outboundFilesFor("instagram", "meta")).toBe(capabilitiesFor("instagram").outboundFiles);
    expect(outboundFilesFor("instagram", null)).toBe(capabilitiesFor("instagram").outboundFiles);
    expect(outboundFilesFor("messenger", "zernio")).toBe(capabilitiesFor("messenger").outboundFiles);
    expect(outboundFilesFor("whatsapp")).toBe(capabilitiesFor("whatsapp").outboundFiles);
  });
});
