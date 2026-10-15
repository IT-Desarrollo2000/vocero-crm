import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionContext } from "@/lib/auth/session";

/**
 * 019 — Ajustes → Almacenamiento (FR-913): 404 con el conector apagado,
 * solo Propietario, y la respuesta jamás lleva la clave ni la cadena.
 */

const sessionState: { current: SessionContext | null } = { current: null };

vi.mock("@/lib/auth/session", () => {
  class UnauthorizedError extends Error {}
  return {
    UnauthorizedError,
    requireSession: async () => {
      if (!sessionState.current) throw new UnauthorizedError();
      return sessionState.current;
    },
  };
});

const { GET } = await import("@/app/api/settings/catalog-storage/route");
const { POST } = await import("@/app/api/settings/catalog-storage/test/route");

const KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const CONN = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${KEY};BlobEndpoint=http://127.0.0.1:1/devstoreaccount1;`;
const VARS = ["CATALOG_STORAGE", "AZURE_STORAGE_CONNECTION_STRING", "AZURE_STORAGE_CONTAINER"];
const saved: Record<string, string | undefined> = {};

const OWNER: SessionContext = { userId: "u_o", organizationId: "org_1", role: "owner" };
const SELLER: SessionContext = { userId: "u_s", organizationId: "org_1", role: "member" };

beforeEach(() => {
  for (const v of VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
  sessionState.current = OWNER;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  vi.restoreAllMocks();
});

const call = (h: () => Promise<Response>) => h();

describe("/api/settings/catalog-storage", () => {
  it("apagado (config por defecto) → 404 en GET y en POST test", async () => {
    expect((await call(GET)).status).toBe(404);
    expect((await call(POST)).status).toBe(404);
    process.env.CATALOG_STORAGE = "local";
    expect((await call(GET)).status).toBe(404);
  });

  it("encendido: el Vendedor recibe 403", async () => {
    process.env.CATALOG_STORAGE = "azure-blob";
    sessionState.current = SELLER;
    expect((await call(GET)).status).toBe(403);
    expect((await call(POST)).status).toBe(403);
  });

  it("encendido: cuenta y contenedor, nunca la clave ni la cadena", async () => {
    process.env.CATALOG_STORAGE = "azure-blob";
    process.env.AZURE_STORAGE_CONNECTION_STRING = CONN;
    process.env.AZURE_STORAGE_CONTAINER = "catalogo";
    const res = await call(GET);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      provider: "azure-blob",
      accountName: "devstoreaccount1",
      container: "catalogo",
      error: null,
    });
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("AccountKey");
  });

  it("probar: config inválida → 422 saneado; sin servicio → 503", async () => {
    process.env.CATALOG_STORAGE = "azure-blob";
    process.env.AZURE_STORAGE_CONNECTION_STRING = "AccountName=abc123;SharedAccessSignature=sig=SECRETO";
    process.env.AZURE_STORAGE_CONTAINER = "catalogo";
    const bad = await call(POST);
    expect(bad.status).toBe(422);
    const badText = await bad.text();
    expect(badText).toContain("storage_misconfigured");
    expect(badText).not.toContain("SECRETO");

    process.env.AZURE_STORAGE_CONNECTION_STRING = CONN;
    const down = await call(POST);
    expect(down.status).toBe(503);
    const downText = await down.text();
    expect(downText).toContain("storage_unavailable");
    expect(downText).not.toContain(KEY);
  });
});
