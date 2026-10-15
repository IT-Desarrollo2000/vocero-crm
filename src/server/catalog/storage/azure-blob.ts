import { createHmac } from "node:crypto";
import { assertCatalogKey, type CatalogStorage, StorageError } from "./types";

/**
 * 019 — Conector opcional: almacenamiento del catálogo en Azure Blob (ADR-003).
 *
 * Sin SDK: cuatro llamadas REST firmadas a mano con SharedKey (`fetch` +
 * `node:crypto`). El SDK oficial arrastra decenas de dependencias para usar
 * Put/Get/Delete Blob y Get Container Properties; la firma son ~40 líneas y
 * quedan cubiertas por vectores fijos y por la suite de contrato contra
 * Azurite.
 *
 * Seguridad (Principio I): la `AccountKey` y la cabecera `Authorization`
 * jamás salen en un mensaje de error ni en un log. El CUERPO de una respuesta
 * de error de Azure tampoco se lee: Azure (y Azurite) devuelven ahí la URL y
 * el string-to-sign. Del error solo se conserva el código HTTP y
 * `x-ms-error-code`.
 */

/** Versión de la API REST de Blob. Estable, aceptada por Azure y Azurite 3.34. */
export const AZURE_API_VERSION = "2021-08-06";

const PUT_GET_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 10_000;

export type AzureConnection = {
  accountName: string;
  accountKey: Buffer;
  /** Sin `/` final. En Azure `https://{cuenta}.blob.{sufijo}`; en Azurite lleva la cuenta en el path. */
  blobEndpoint: string;
};

function misconfigured(message: string): StorageError {
  return new StorageError("misconfigured", message);
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Parsea la cadena de conexión del portal ("Claves de acceso → Cadena de
 * conexión") o la de Azurite. v1 solo acepta la forma con `AccountKey`: la de
 * `SharedAccessSignature` se rechaza. Los mensajes de error nunca incluyen la
 * cadena ni partes de ella.
 */
export function parseAzureConnectionString(raw: string | undefined): AzureConnection {
  if (!raw || !raw.trim()) {
    throw misconfigured("Falta AZURE_STORAGE_CONNECTION_STRING");
  }
  const fields = new Map<string, string>();
  for (const part of raw.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq <= 0) {
      throw misconfigured("AZURE_STORAGE_CONNECTION_STRING no tiene la forma clave=valor");
    }
    // El valor de AccountKey termina en `=`: solo se corta en el PRIMER `=`.
    fields.set(p.slice(0, eq).trim().toLowerCase(), p.slice(eq + 1).trim());
  }

  if (fields.has("sharedaccesssignature")) {
    throw misconfigured(
      "AZURE_STORAGE_CONNECTION_STRING con SharedAccessSignature no está soportada: usa la cadena con AccountKey"
    );
  }
  const accountName = fields.get("accountname") ?? "";
  if (!/^[a-z0-9]{3,24}$/.test(accountName)) {
    throw misconfigured("AZURE_STORAGE_CONNECTION_STRING no trae un AccountName válido");
  }
  const keyText = fields.get("accountkey") ?? "";
  const accountKey = BASE64.test(keyText) ? Buffer.from(keyText, "base64") : Buffer.alloc(0);
  // Las claves de Azure (y la de Azurite) son de 512 bits: 88 caracteres base64.
  if (accountKey.length !== 64) {
    throw misconfigured("AZURE_STORAGE_CONNECTION_STRING no trae una AccountKey válida");
  }

  let blobEndpoint = fields.get("blobendpoint");
  if (!blobEndpoint) {
    const protocol = (fields.get("defaultendpointsprotocol") ?? "https").toLowerCase();
    const suffix = fields.get("endpointsuffix") ?? "core.windows.net";
    if (protocol !== "https" && protocol !== "http") {
      throw misconfigured("AZURE_STORAGE_CONNECTION_STRING tiene un DefaultEndpointsProtocol inválido");
    }
    blobEndpoint = `${protocol}://${accountName}.blob.${suffix}`;
  }
  let url: URL;
  try {
    url = new URL(blobEndpoint);
  } catch {
    throw misconfigured("AZURE_STORAGE_CONNECTION_STRING tiene un BlobEndpoint inválido");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.search || url.hash) {
    throw misconfigured("AZURE_STORAGE_CONNECTION_STRING tiene un BlobEndpoint inválido");
  }
  return {
    accountName,
    accountKey,
    blobEndpoint: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
  };
}

/** Reglas de Azure para un nombre de contenedor. */
export function isValidContainerName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/.test(name);
}

/**
 * String-to-sign de SharedKey para el servicio Blob (versión 2009-09-19 en
 * adelante):
 *
 *   VERB\n Content-Encoding\n Content-Language\n Content-Length\n
 *   Content-MD5\n Content-Type\n Date\n If-Modified-Since\n If-Match\n
 *   If-None-Match\n If-Unmodified-Since\n Range\n
 *   x-ms-*:valor\n   (minúsculas, ordenadas)
 *   /{cuenta}{path de la URL}   (+ \nparam:valor por cada query, ordenados)
 *
 * `Content-Length` va VACÍO cuando es 0. `Date` va vacío: se firma `x-ms-date`.
 * `urlPath` es el path codificado tal como viaja (en Azurite incluye la
 * cuenta: `/devstoreaccount1/{contenedor}/{blob}`).
 */
export function buildStringToSign(input: {
  method: string;
  accountName: string;
  urlPath: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
}): string {
  const h = new Map<string, string>();
  for (const [k, v] of Object.entries(input.headers)) h.set(k.toLowerCase(), v);
  const std = (name: string) => h.get(name) ?? "";
  const contentLength = std("content-length");

  const msHeaders = [...h.entries()]
    .filter(([k]) => k.startsWith("x-ms-"))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}:${v.replace(/\s+/g, " ").trim()}\n`)
    .join("");

  const query = Object.entries(input.query ?? {})
    .map(([k, v]) => [k.toLowerCase(), v] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `\n${k}:${v}`)
    .join("");

  return [
    input.method.toUpperCase(),
    std("content-encoding"),
    std("content-language"),
    contentLength === "0" ? "" : contentLength,
    std("content-md5"),
    std("content-type"),
    std("date"),
    std("if-modified-since"),
    std("if-match"),
    std("if-none-match"),
    std("if-unmodified-since"),
    std("range"),
  ].join("\n") + `\n${msHeaders}/${input.accountName}${input.urlPath}${query}`;
}

/** HMAC-SHA256 en base64 del string-to-sign con la clave de la cuenta. */
export function signSharedKey(accountKey: Buffer, stringToSign: string): string {
  return createHmac("sha256", accountKey).update(stringToSign, "utf8").digest("base64");
}

type AzureRequest = {
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  container: string;
  /** Nombre del blob SIN codificar; se codifica por segmento. */
  blob?: string;
  query?: Record<string, string>;
  body?: Buffer;
  headers?: Record<string, string>;
  timeoutMs: number;
};

/**
 * Una petición firmada. Lanza `StorageError("unavailable")` si no hay
 * respuesta (red, DNS, timeout); los códigos HTTP los interpreta quien llama.
 * Exportada para el setup de las pruebas (crear el contenedor en Azurite).
 */
export async function azureRequest(conn: AzureConnection, req: AzureRequest): Promise<Response> {
  const endpoint = new URL(conn.blobEndpoint);
  const blobPath = req.blob
    ? "/" + req.blob.split("/").map(encodeURIComponent).join("/")
    : "";
  const urlPath = `${endpoint.pathname.replace(/\/+$/, "")}/${encodeURIComponent(req.container)}${blobPath}`;
  const qs = new URLSearchParams(req.query ?? {}).toString();

  const headers: Record<string, string> = {
    "x-ms-date": new Date().toUTCString(),
    "x-ms-version": AZURE_API_VERSION,
    ...(req.headers ?? {}),
  };
  if (req.body) headers["content-length"] = String(req.body.length);
  const stringToSign = buildStringToSign({
    method: req.method,
    accountName: conn.accountName,
    urlPath,
    query: req.query,
    headers,
  });
  headers.authorization = `SharedKey ${conn.accountName}:${signSharedKey(conn.accountKey, stringToSign)}`;

  try {
    return await fetch(`${endpoint.origin}${urlPath}${qs ? `?${qs}` : ""}`, {
      method: req.method,
      headers,
      body: req.body ? new Uint8Array(req.body) : undefined,
      signal: AbortSignal.timeout(req.timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    // Ni el mensaje ni la causa: pueden llevar la URL. Solo el tipo.
    const kind = (err as { name?: string })?.name === "TimeoutError" ? "timeout" : "red";
    console.error(`[catalog/azure-blob] ${req.method} sin respuesta (${kind})`);
    throw new StorageError("unavailable", "Azure Blob no responde; intenta de nuevo en un momento");
  }
}

/** `x-ms-error-code` saneado (solo letras); nunca el cuerpo. */
function errorCodeOf(res: Response): string {
  const code = res.headers.get("x-ms-error-code") ?? "";
  return /^[A-Za-z]{1,64}$/.test(code) ? code : "";
}

/** Traduce una respuesta no-2xx a un `StorageError` saneado y la registra. */
async function failure(op: string, res: Response): Promise<StorageError> {
  await res.body?.cancel().catch(() => {});
  const code = errorCodeOf(res);
  console.error(`[catalog/azure-blob] ${op} falló: HTTP ${res.status}${code ? ` ${code}` : ""}`);
  if (code === "ContainerNotFound" || (op === "test" && res.status === 404)) {
    return misconfigured("Azure Blob: el contenedor no existe");
  }
  if (res.status === 403 || res.status === 401) {
    return misconfigured("Azure Blob rechazó la conexión: clave inválida");
  }
  if (res.status === 404 && (code === "BlobNotFound" || code === "")) {
    return new StorageError("not_found", "El archivo no existe en el almacenamiento");
  }
  return new StorageError(
    "unavailable",
    `Azure Blob respondió con un error (HTTP ${res.status}${code ? ` ${code}` : ""})`
  );
}

export type AzureBlobConfig = {
  connectionString: string | undefined;
  container: string | undefined;
};

/** Config validada; lanza `misconfigured` con un mensaje saneado. */
export function resolveAzureBlobConfig(config: AzureBlobConfig): {
  conn: AzureConnection;
  container: string;
} {
  const conn = parseAzureConnectionString(config.connectionString);
  const container = (config.container ?? "").trim();
  if (!container) throw misconfigured("Falta AZURE_STORAGE_CONTAINER");
  if (!isValidContainerName(container)) {
    throw misconfigured(
      "AZURE_STORAGE_CONTAINER no es un nombre válido (3-63 caracteres: minúsculas, números y guiones)"
    );
  }
  return { conn, container };
}

/**
 * El adaptador. Con config inválida NO lanza al construirse: devuelve uno
 * cuyas operaciones rechazan con `misconfigured` (→ 503 en el catálogo), para
 * que una variable mal puesta no tumbe el arranque ni la vista del catálogo.
 */
export function createAzureBlobCatalogStorage(config: AzureBlobConfig): CatalogStorage {
  let resolved: ReturnType<typeof resolveAzureBlobConfig> | null = null;
  let configError: StorageError | null = null;
  try {
    resolved = resolveAzureBlobConfig(config);
  } catch (err) {
    configError =
      err instanceof StorageError ? err : misconfigured("Configuración de Azure Blob inválida");
  }

  function ready(key?: string): { conn: AzureConnection; container: string } {
    if (key !== undefined) assertCatalogKey(key);
    if (!resolved) throw configError!;
    return resolved;
  }

  return {
    provider: "azure-blob",

    async put(key, data, mimeType) {
      const { conn, container } = ready(key);
      const res = await azureRequest(conn, {
        method: "PUT",
        container,
        blob: key,
        body: data,
        headers: {
          "x-ms-blob-type": "BlockBlob",
          "content-type": mimeType || "application/octet-stream",
        },
        timeoutMs: PUT_GET_TIMEOUT_MS,
      });
      if (!res.ok) throw await failure("put", res);
      await res.body?.cancel().catch(() => {});
    },

    async get(key) {
      const { conn, container } = ready(key);
      const res = await azureRequest(conn, {
        method: "GET",
        container,
        blob: key,
        timeoutMs: PUT_GET_TIMEOUT_MS,
      });
      if (!res.ok) throw await failure("get", res);
      try {
        return Buffer.from(await res.arrayBuffer());
      } catch {
        console.error("[catalog/azure-blob] get: la descarga se cortó");
        throw new StorageError("unavailable", "Azure Blob cortó la descarga del archivo");
      }
    },

    async delete(key) {
      const { conn, container } = ready(key);
      const res = await azureRequest(conn, {
        method: "DELETE",
        container,
        blob: key,
        timeoutMs: PUT_GET_TIMEOUT_MS,
      });
      // Idempotente: un blob que ya no está no es error.
      if (res.status === 404 && errorCodeOf(res) !== "ContainerNotFound") {
        await res.body?.cancel().catch(() => {});
        return;
      }
      if (!res.ok) throw await failure("delete", res);
      await res.body?.cancel().catch(() => {});
    },

    async test() {
      const { conn, container } = ready();
      const res = await azureRequest(conn, {
        method: "GET",
        container,
        query: { restype: "container" },
        timeoutMs: TEST_TIMEOUT_MS,
      });
      if (!res.ok) throw await failure("test", res);
      await res.body?.cancel().catch(() => {});
    },
  };
}
