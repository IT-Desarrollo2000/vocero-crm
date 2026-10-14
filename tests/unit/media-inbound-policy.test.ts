import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 018 (FR-806) — Entrante de WhatsApp: tras descargar, la firma decide. Un
 * bloqueado NO se guarda (`blocked` + razón); uno válido se guarda con el MIME
 * DETECTADO; `expired`/`blocked` no se re-descargan jamás.
 */

const { graphRequest, writeFile, updates, assetRow } = vi.hoisted(() => ({
  graphRequest: vi.fn(),
  writeFile: vi.fn(async () => {}),
  updates: [] as Record<string, unknown>[],
  assetRow: { current: {} as Record<string, unknown> },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, writeFile, mkdir: async () => undefined };
});
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ MEDIA_DIR: "/data/media", APP_BASE_URL: "http://localhost:3100" }),
  isMockEnabled: () => false,
}));
vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...original, graphRequest };
});
vi.mock("@/server/whatsapp/credentials", () => ({
  getCredentialsByOrg: async () => ({ token: "t", organizationId: "org_1" }),
}));
vi.mock("@/lib/db", () => {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => [assetRow.current],
  };
  return {
    getDb: () => ({
      select: () => selectChain,
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          const returning = async () => [{ ...assetRow.current, ...values }];
          return { where: () => Object.assign(Promise.resolve(), { returning }) };
        },
      }),
    }),
    schema: { mediaAsset: { id: "id" } },
  };
});

const { ensureAssetAvailable } = await import("@/server/whatsapp/media");

function serve(bytes: Uint8Array, declaredMime: string) {
  graphRequest.mockResolvedValue({ url: "https://cdn.example/x", mime_type: declaredMime });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array(bytes), { headers: { "content-type": declaredMime } }))
  );
}

describe("ensureAssetAvailable con la política de archivos", () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    graphRequest.mockReset();
    writeFile.mockClear();
    updates.length = 0;
    assetRow.current = {
      id: "ma_1",
      organizationId: "org_1",
      kind: "document",
      waMediaId: "media-1",
      mimeType: "application/pdf",
      fileName: "cotizacion.pdf",
      fetchStatus: "pending",
    };
  });

  it("HTML declarado como PDF → blocked con razón y SIN escribir en disco", async () => {
    serve(new TextEncoder().encode("<!doctype html><script>alert(1)</script>"), "application/pdf");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await ensureAssetAvailable("org_1", "ma_1");
    warn.mockRestore();
    expect(writeFile).not.toHaveBeenCalled();
    expect(r?.fetchStatus).toBe("blocked");
    expect(updates[0]).toMatchObject({ fetchStatus: "blocked", storagePath: null });
    expect(String(updates[0]?.fetchError)).toMatch(/HTML/);
  });

  it("JPEG declarado como PDF → se guarda con el MIME detectado; el kind no cambia", async () => {
    serve(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]), "application/pdf");
    const r = await ensureAssetAvailable("org_1", "ma_1");
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(updates[0]).toMatchObject({ fetchStatus: "available", mimeType: "image/jpeg" });
    expect(updates[0]).not.toHaveProperty("kind");
    expect(r?.kind).toBe("document");
  });

  it("Messenger/Instagram: asset con source_url → descarga directa del CDN, sin Graph ni token", async () => {
    assetRow.current = {
      ...assetRow.current,
      waMediaId: null,
      sourceUrl: "https://scontent.xx.fbcdn.net/v/foto.jpg?oh=1",
      kind: "image",
      mimeType: null,
      fileName: null,
    };
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9])));
    vi.stubGlobal("fetch", fetchMock);
    const r = await ensureAssetAvailable("org_1", "ma_1");
    expect(graphRequest).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://scontent.xx.fbcdn.net/v/foto.jpg?oh=1");
    expect(init.headers).toBeUndefined();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(r?.fetchStatus).toBe("available");
    expect(updates[0]).toMatchObject({ mimeType: "image/jpeg" });
  });

  it("source_url fuera de la lista de hosts → failed, sin petición ni disco", async () => {
    assetRow.current = {
      ...assetRow.current,
      waMediaId: null,
      sourceUrl: "https://evil.example.com/x.jpg",
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await ensureAssetAvailable("org_1", "ma_1");
    warn.mockRestore();
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ fetchStatus: "failed" });
  });

  it.each(["expired", "blocked"])("%s es final: no se re-descarga", async (status) => {
    assetRow.current.fetchStatus = status;
    const r = await ensureAssetAvailable("org_1", "ma_1");
    expect(r?.fetchStatus).toBe(status);
    expect(graphRequest).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});
