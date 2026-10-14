import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 018 (FR-808) — Descarga de adjuntos entrantes de Messenger/Instagram desde
 * la URL del CDN. La URL la escribe quien manda el webhook: solo https y
 * hosts de Meta, cada redirección revalidada, sin token, con tope de tamaño.
 * El CDN del mock solo vale con los mocks encendidos.
 */

const { mockEnabled } = vi.hoisted(() => ({ mockEnabled: { on: false } }));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ APP_BASE_URL: "http://localhost:3100" }),
  isMockEnabled: () => mockEnabled.on,
}));

const { downloadSourceUrl, isAllowedSourceUrl } = await import("@/server/media/source-fetch");
const { MediaFetchError } = await import("@/server/media/fetch-error");

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);

describe("isAllowedSourceUrl — lista de hosts", () => {
  beforeEach(() => {
    mockEnabled.on = false;
  });

  it.each([
    "https://scontent.xx.fbcdn.net/v/t1/a.jpg?oh=1",
    "https://cdn.fbsbx.com/v/t59/f.pdf",
    "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1",
    "https://scontent-lax3-1.cdninstagram.com/v/x.jpg",
    "https://fbcdn.net/x",
  ])("acepta %s", (url) => {
    expect(isAllowedSourceUrl(url)).toBe(true);
  });

  it.each([
    ["http (no https)", "http://scontent.xx.fbcdn.net/a.jpg"],
    ["host ajeno", "https://evil.example.com/a.jpg"],
    ["sufijo engañoso", "https://fbcdn.net.evil.com/a.jpg"],
    ["sin punto antes del dominio", "https://evilfbcdn.net/a.jpg"],
    ["credenciales embebidas", "https://user:pw@scontent.xx.fbcdn.net/a.jpg"],
    ["puerto raro", "https://scontent.xx.fbcdn.net:8443/a.jpg"],
    ["IP interna", "https://169.254.169.254/latest/meta-data"],
    ["file:", "file:///etc/passwd"],
    ["basura", "no es una url"],
    ["mock con flag apagado", "http://localhost:3100/api/dev/wa-mock/cdn/foto"],
  ])("rechaza %s", (_label, url) => {
    expect(isAllowedSourceUrl(url)).toBe(false);
  });

  it("CDN del mock: SOLO con el flag, el origin exacto y bajo /api/dev/wa-mock/", () => {
    mockEnabled.on = true;
    expect(isAllowedSourceUrl("http://localhost:3100/api/dev/wa-mock/cdn/foto")).toBe(true);
    expect(isAllowedSourceUrl("http://localhost:3100/api/media/ma_1")).toBe(false);
    expect(isAllowedSourceUrl("http://localhost:3101/api/dev/wa-mock/cdn/foto")).toBe(false);
    expect(isAllowedSourceUrl("http://127.0.0.1:3100/api/dev/wa-mock/cdn/foto")).toBe(false);
  });
});

describe("downloadSourceUrl", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    mockEnabled.on = false;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("descarga sin token ni cookies y con redirect manual", async () => {
    fetchMock.mockResolvedValue(
      new Response(JPEG, { headers: { "content-type": "image/jpeg" } })
    );
    const r = await downloadSourceUrl("https://scontent.xx.fbcdn.net/a.jpg");
    expect(r.fileSize).toBe(JPEG.byteLength);
    expect(r.mimeType).toBe("image/jpeg");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.redirect).toBe("manual");
    expect(init.headers).toBeUndefined();
  });

  it("host fuera de lista → error final SIN hacer la petición", async () => {
    await expect(downloadSourceUrl("https://evil.example.com/a.jpg")).rejects.toMatchObject({
      gone: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redirección a un host ajeno → se corta antes de seguirla", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      })
    );
    await expect(downloadSourceUrl("https://cdn.fbsbx.com/a.jpg")).rejects.toBeInstanceOf(
      MediaFetchError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("redirección dentro del CDN de Meta → se sigue", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://scontent.xx.fbcdn.net/b.jpg" },
        })
      )
      .mockResolvedValueOnce(new Response(JPEG));
    const r = await downloadSourceUrl("https://lookaside.fbsbx.com/a");
    expect(r.fileSize).toBe(JPEG.byteLength);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://scontent.xx.fbcdn.net/b.jpg");
  });

  it("URL caducada (403/404/410) → gone; 500 → reintentable", async () => {
    for (const status of [403, 404, 410]) {
      fetchMock.mockResolvedValueOnce(new Response("x", { status }));
      await expect(downloadSourceUrl("https://cdn.fbsbx.com/a")).rejects.toMatchObject({
        gone: true,
      });
    }
    fetchMock.mockResolvedValueOnce(new Response("x", { status: 500 }));
    await expect(downloadSourceUrl("https://cdn.fbsbx.com/a")).rejects.toMatchObject({
      gone: false,
    });
  });

  it("tope de tamaño leyendo el stream (aunque no haya content-length)", async () => {
    const big = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(10));
        c.close();
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(big));
    await expect(
      downloadSourceUrl("https://cdn.fbsbx.com/a", { maxBytes: 25 })
    ).rejects.toThrow(/límite/);

    fetchMock.mockResolvedValueOnce(
      new Response("x", { headers: { "content-length": "999999999" } })
    );
    await expect(
      downloadSourceUrl("https://cdn.fbsbx.com/a", { maxBytes: 25 })
    ).rejects.toThrow(/límite/);
  });

  it("el CDN del mock solo se descarga con el flag encendido", async () => {
    const url = "http://localhost:3100/api/dev/wa-mock/cdn/foto";
    await expect(downloadSourceUrl(url)).rejects.toBeInstanceOf(MediaFetchError);
    expect(fetchMock).not.toHaveBeenCalled();

    mockEnabled.on = true;
    fetchMock.mockResolvedValueOnce(new Response(JPEG));
    await expect(downloadSourceUrl(url)).resolves.toMatchObject({ fileSize: JPEG.byteLength });
  });
});
