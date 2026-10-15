import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AZURE_API_VERSION,
  azureRequest,
  buildStringToSign,
  createAzureBlobCatalogStorage,
  parseAzureConnectionString,
  signSharedKey,
} from "@/server/catalog/storage/azure-blob";
import { catalogStorageKey, StorageError } from "@/server/catalog/storage/types";
import { runStorageContract } from "./helpers/catalog-storage-contract";

/**
 * 019 — Conector Azure Blob (ADR-003): parseo de la cadena, firma SharedKey
 * con vectores fijos, saneado de errores y —si Azurite responde— la misma
 * suite de contrato que `local` más los caminos infelices reales.
 *
 * Azurite: `AZURITE_URL` (p. ej. http://127.0.0.1:10000) o, sin ella, una
 * sonda a 127.0.0.1:10000. Sin Azurite, esa parte se salta.
 */

/** Clave pública y estándar del emulador (no es un secreto). */
const AZURITE_KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const AZURITE_BASE = (process.env.AZURITE_URL || "http://127.0.0.1:10000").replace(/\/+$/, "");
const azuriteConn = (key = AZURITE_KEY, base = AZURITE_BASE) =>
  `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${key};BlobEndpoint=${base}/devstoreaccount1;`;

async function azuriteAlive(attempts: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      // Cualquier respuesta HTTP (incluido el 403 sin firma) = vivo.
      await fetch(`${AZURITE_BASE}/devstoreaccount1?comp=list`, {
        signal: AbortSignal.timeout(1500),
      });
      return true;
    } catch {
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

/**
 * Con `AZURITE_URL` puesta (CI `completo`) Azurite es OBLIGATORIO: si no
 * responde, la suite corre y falla en vez de saltarse en silencio. Sin ella,
 * se sondea el puerto por defecto y se salta si no hay nada.
 */
const AZURITE_REQUIRED = Boolean(process.env.AZURITE_URL);
const AZURITE = (await azuriteAlive(AZURITE_REQUIRED ? 10 : 1)) || AZURITE_REQUIRED;

describe("parseAzureConnectionString", () => {
  it("forma estándar del portal", () => {
    const c = parseAzureConnectionString(
      `DefaultEndpointsProtocol=https;AccountName=voceroprod;AccountKey=${AZURITE_KEY};EndpointSuffix=core.windows.net`
    );
    expect(c.accountName).toBe("voceroprod");
    expect(c.blobEndpoint).toBe("https://voceroprod.blob.core.windows.net");
    expect(c.accountKey.equals(Buffer.from(AZURITE_KEY, "base64"))).toBe(true);
  });

  it("forma de Azurite (BlobEndpoint con la cuenta en el path)", () => {
    const c = parseAzureConnectionString(azuriteConn(AZURITE_KEY, "http://127.0.0.1:10000"));
    expect(c.accountName).toBe("devstoreaccount1");
    expect(c.blobEndpoint).toBe("http://127.0.0.1:10000/devstoreaccount1");
    expect(c.accountKey.length).toBe(64);
  });

  it("sin EndpointSuffix usa core.windows.net; tolera espacios y `;` sobrantes", () => {
    const c = parseAzureConnectionString(
      ` AccountName=abc123 ; AccountKey=${AZURITE_KEY} ;; `
    );
    expect(c.blobEndpoint).toBe("https://abc123.blob.core.windows.net");
  });

  it("rechaza SAS, vacía, sin cuenta o sin clave — misconfigured y sin filtrar la cadena", () => {
    const bad = [
      undefined,
      "",
      "BlobEndpoint=https://x.blob.core.windows.net;SharedAccessSignature=sv=2021&sig=SECRETO",
      `AccountName=abc123;AccountKey=${AZURITE_KEY};SharedAccessSignature=sig=SECRETO`,
      `AccountKey=${AZURITE_KEY}`,
      "AccountName=abc123",
      "AccountName=abc123;AccountKey=no*es*base64",
      // base64 válido pero no de 512 bits: no es una clave de Azure.
      "AccountName=abc123;AccountKey=U0VDUkVUTw==",
      "AccountName=ABC;AccountKey=SECRETO==",
      "esto no es una cadena",
      `AccountName=abc123;AccountKey=${AZURITE_KEY};BlobEndpoint=ftp://x`,
    ];
    for (const s of bad) {
      let err: unknown = null;
      try {
        parseAzureConnectionString(s);
      } catch (e) {
        err = e;
      }
      expect(err, String(s)).toBeInstanceOf(StorageError);
      expect((err as StorageError).code).toBe("misconfigured");
      expect((err as StorageError).message).not.toContain("SECRETO");
      expect((err as StorageError).message).not.toContain(AZURITE_KEY);
    }
    expect(() => parseAzureConnectionString(bad[2])).toThrow(/SharedAccessSignature/);
  });
});

describe("firma SharedKey", () => {
  it("string-to-sign del ejemplo de la documentación de Microsoft (Get Container Metadata)", () => {
    // learn.microsoft.com/rest/api/storageservices/authorize-with-shared-key:
    // GET .../mycontainer?restype=container&comp=metadata&timeout=20
    expect(
      buildStringToSign({
        method: "GET",
        accountName: "myaccount",
        urlPath: "/mycontainer",
        query: { restype: "container", comp: "metadata", timeout: "20" },
        headers: { "x-ms-date": "Fri, 26 Jun 2015 23:39:12 GMT", "x-ms-version": "2015-02-21" },
      })
    ).toBe(
      "GET\n\n\n\n\n\n\n\n\n\n\n\n" +
        "x-ms-date:Fri, 26 Jun 2015 23:39:12 GMT\nx-ms-version:2015-02-21\n" +
        "/myaccount/mycontainer\ncomp:metadata\nrestype:container\ntimeout:20"
    );
  });

  it("Put Blob: Content-Length y Content-Type en su lugar, x-ms-* en minúsculas y ordenadas", () => {
    expect(
      buildStringToSign({
        method: "put",
        accountName: "devstoreaccount1",
        urlPath: "/devstoreaccount1/catalogo/org_1/catalog/pf_1",
        headers: {
          "X-Ms-Version": "2021-08-06",
          "x-ms-date": "Wed, 15 Oct 2026 12:00:00 GMT",
          "x-ms-blob-type": "BlockBlob",
          "Content-Type": "image/jpeg",
          "content-length": "5",
        },
      })
    ).toBe(
      "PUT\n\n\n5\n\nimage/jpeg\n\n\n\n\n\n\n" +
        "x-ms-blob-type:BlockBlob\nx-ms-date:Wed, 15 Oct 2026 12:00:00 GMT\nx-ms-version:2021-08-06\n" +
        "/devstoreaccount1/devstoreaccount1/catalogo/org_1/catalog/pf_1"
    );
  });

  it("Content-Length 0 se firma vacío", () => {
    const s = buildStringToSign({
      method: "PUT",
      accountName: "a",
      urlPath: "/c/b",
      headers: { "content-length": "0" },
    });
    expect(s.split("\n")[3]).toBe("");
  });

  it("HMAC-SHA256 contra un valor calculado aparte (openssl dgst -hmac)", () => {
    // printf '<stringToSign del ejemplo de Microsoft>' |
    //   openssl dgst -sha256 -mac HMAC -macopt hexkey:<clave de Azurite en hex> -binary | base64
    const sts =
      "GET\n\n\n\n\n\n\n\n\n\n\n\n" +
      "x-ms-date:Fri, 26 Jun 2015 23:39:12 GMT\nx-ms-version:2015-02-21\n" +
      "/myaccount/mycontainer\ncomp:metadata\nrestype:container\ntimeout:20";
    expect(signSharedKey(Buffer.from(AZURITE_KEY, "base64"), sts)).toBe(
      "1u9lui2jDxj0+fpbHjQ5m5NnastJRSYM+PSmfi8TXx4="
    );
  });
});

describe("saneado de errores", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const storage = () =>
    createAzureBlobCatalogStorage({
      connectionString: `DefaultEndpointsProtocol=https;AccountName=voceroprod;AccountKey=${AZURITE_KEY};EndpointSuffix=core.windows.net`,
      container: "catalogo",
    });
  const k = catalogStorageKey("org_1", "pf_1");

  async function caught(p: Promise<unknown>): Promise<StorageError> {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    return err as StorageError;
  }

  it("un 403 con el string-to-sign en el cuerpo no filtra nada: solo HTTP + x-ms-error-code", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          `<Error><AuthenticationErrorDetail>The MAC signature found in the HTTP request 'SIG' is not the same... ${AZURITE_KEY}</AuthenticationErrorDetail></Error>`,
          { status: 403, headers: { "x-ms-error-code": "AuthenticationFailed" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const err = await caught(storage().put(k, Buffer.from("x"), "text/plain"));
    expect(err.code).toBe("misconfigured");
    expect(err.message).toMatch(/clave inválida/);
    const all = [err.message, ...logs].join("\n");
    expect(all).not.toContain(AZURITE_KEY);
    expect(all).not.toContain("SharedKey");
    expect(all).not.toContain("MAC signature");
    expect(logs.join("\n")).toContain("HTTP 403 AuthenticationFailed");
  });

  it("la cabecera Authorization se envía pero nunca aparece en el error de red", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    let auth = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        auth = (init.headers as Record<string, string>).authorization ?? "";
        throw new TypeError(`fetch failed ${auth} https://voceroprod.blob.core.windows.net`);
      })
    );
    const err = await caught(storage().get(k));
    expect(auth).toMatch(/^SharedKey voceroprod:/);
    expect(err.code).toBe("unavailable");
    const all = [err.message, ...logs].join("\n");
    expect(all).not.toContain(auth);
    expect(all).not.toContain("blob.core.windows.net");
  });

  it("404 BlobNotFound → not_found; ContainerNotFound → misconfigured; 5xx → unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const respond = (status: number, code: string) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("<Error/>", { status, headers: { "x-ms-error-code": code } }))
      );
    respond(404, "BlobNotFound");
    expect((await caught(storage().get(k))).code).toBe("not_found");
    respond(404, "ContainerNotFound");
    const c = await caught(storage().get(k));
    expect(c.code).toBe("misconfigured");
    expect(c.message).toMatch(/el contenedor no existe/);
    respond(503, "ServerBusy");
    expect((await caught(storage().put(k, Buffer.from("x"), "text/plain"))).code).toBe(
      "unavailable"
    );
    respond(404, "BlobNotFound");
    await expect(storage().delete(k)).resolves.toBeUndefined();
  });

  it("config inválida: construir no lanza; cada operación → misconfigured sin la cadena", async () => {
    const s = createAzureBlobCatalogStorage({
      connectionString: "AccountName=abc123;SharedAccessSignature=sig=SECRETO",
      container: "catalogo",
    });
    expect(s.provider).toBe("azure-blob");
    // Perezosas: una promesa rechazada sin await todavía es un "unhandled".
    for (const op of [
      () => s.get(k),
      () => s.put(k, Buffer.from("x"), "text/plain"),
      () => s.delete(k),
      () => s.test(),
    ]) {
      const err = await caught(op());
      expect(err.code).toBe("misconfigured");
      expect(err.message).not.toContain("SECRETO");
    }
    const noContainer = createAzureBlobCatalogStorage({
      connectionString: azuriteConn(),
      container: "Mal_Nombre",
    });
    expect((await caught(noContainer.test())).code).toBe("misconfigured");
  });
});

describe.skipIf(!AZURITE)("azure-blob contra Azurite", () => {
  const container = `vocero-test-${Date.now()}`;

  beforeAll(async () => {
    const conn = parseAzureConnectionString(azuriteConn());
    const res = await azureRequest(conn, {
      method: "PUT",
      container,
      query: { restype: "container" },
      timeoutMs: 10_000,
    });
    // 201 creado; 409 ya existía.
    expect([201, 409]).toContain(res.status);
  });

  afterAll(async () => {
    // El Azurite de desarrollo vive mucho: no dejar un contenedor por corrida.
    const conn = parseAzureConnectionString(azuriteConn());
    await azureRequest(conn, {
      method: "DELETE",
      container,
      query: { restype: "container" },
      timeoutMs: 10_000,
    }).catch(() => {});
  });

  runStorageContract("azure-blob (Azurite)", () =>
    createAzureBlobCatalogStorage({ connectionString: azuriteConn(), container })
  );

  it("guarda el Content-Type y el blob es privado (sin firma → 4xx)", async () => {
    const s = createAzureBlobCatalogStorage({ connectionString: azuriteConn(), container });
    const k = catalogStorageKey("org_ct", `pf_ct${Date.now()}`);
    await s.put(k, Buffer.from("%PDF-1.4"), "application/pdf");
    const conn = parseAzureConnectionString(azuriteConn());
    const head = await azureRequest(conn, { method: "HEAD", container, blob: k, timeoutMs: 5000 });
    expect(head.headers.get("content-type")).toBe("application/pdf");
    const anon = await fetch(`${AZURITE_BASE}/devstoreaccount1/${container}/${k}`);
    expect(anon.status).toBeGreaterThanOrEqual(400);
    await s.delete(k);
  });

  it("clave equivocada → misconfigured (clave inválida)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const wrong = Buffer.alloc(64, 7).toString("base64");
    const s = createAzureBlobCatalogStorage({ connectionString: azuriteConn(wrong), container });
    const err = await s.test().then(() => null, (e: unknown) => e as StorageError);
    expect(err?.code).toBe("misconfigured");
    expect(err?.message).toMatch(/clave inválida/);
    expect(err?.message).not.toContain(wrong);
    vi.restoreAllMocks();
  });

  it("contenedor inexistente → misconfigured (el contenedor no existe), también al subir", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = createAzureBlobCatalogStorage({
      connectionString: azuriteConn(),
      container: "no-existe-este",
    });
    const t = await s.test().then(() => null, (e: unknown) => e as StorageError);
    expect(t?.code).toBe("misconfigured");
    expect(t?.message).toMatch(/el contenedor no existe/);
    const p = await s
      .put(catalogStorageKey("org_x", "pf_x"), Buffer.from("x"), "text/plain")
      .then(() => null, (e: unknown) => e as StorageError);
    expect(p?.code).toBe("misconfigured");
    vi.restoreAllMocks();
  });

  it(`x-ms-version ${AZURE_API_VERSION} aceptada`, async () => {
    const conn = parseAzureConnectionString(azuriteConn());
    const res = await azureRequest(conn, {
      method: "GET",
      container,
      query: { restype: "container" },
      timeoutMs: 5000,
    });
    // Azurite responde con SU versión en la cabecera; lo que prueba es el 200
    // (en CI corre sin --skipApiVersionCheck, así que también la valida).
    expect(res.status).toBe(200);
  });
});

describe("azure-blob sin servicio (puerto cerrado) → unavailable", () => {
  it("test/put/get rechazan con unavailable y mensaje claro", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = createAzureBlobCatalogStorage({
      connectionString: azuriteConn(AZURITE_KEY, "http://127.0.0.1:1"),
      container: "catalogo",
    });
    const k = catalogStorageKey("org_1", "pf_1");
    for (const op of [
      () => s.test(),
      () => s.put(k, Buffer.from("x"), "text/plain"),
      () => s.get(k),
      () => s.delete(k),
    ]) {
      const err = await op().then(() => null, (e: unknown) => e as StorageError);
      expect(err).toBeInstanceOf(StorageError);
      expect(err?.code).toBe("unavailable");
      expect(err?.message).toMatch(/no responde/);
    }
    vi.restoreAllMocks();
  });
});
