import { getEnv, isMockEnabled } from "@/lib/env";
import { MediaFetchError } from "@/server/media/fetch-error";
import { MAX_FILE_BYTES } from "@/server/media/file-policy";

/**
 * 018 (FR-808) — Descarga de un adjunto entrante de Messenger/Instagram desde
 * su `payload.url` (CDN de Meta). A diferencia de WhatsApp no hay media id ni
 * token: la URL ya viene firmada por Meta. Por eso mismo es una puerta de
 * SSRF — la URL la escribe quien manda el webhook — y solo se sigue si:
 *
 *   - es `https:` y el host es (o termina en) un dominio del CDN de Meta;
 *   - o, SOLO con los mocks encendidos y fuera de producción, es el origin
 *     exacto de `APP_BASE_URL` bajo `/api/dev/wa-mock/` (el CDN del mock).
 *
 * Las redirecciones NO se siguen solas (`redirect: "manual"`): cada salto se
 * vuelve a validar contra la misma lista antes de pedirlo.
 */

/** Dominios del CDN de Meta de los que se aceptan adjuntos entrantes. */
export const SOURCE_HOST_DOMAINS = ["fbsbx.com", "fbcdn.net", "cdninstagram.com"] as const;

const SOURCE_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
const MOCK_PATH_PREFIX = "/api/dev/wa-mock/";

function isMetaCdnHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return SOURCE_HOST_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

function isMockCdnUrl(url: URL): boolean {
  if (!isMockEnabled()) return false;
  let base: URL;
  try {
    base = new URL(getEnv().APP_BASE_URL);
  } catch {
    return false;
  }
  return url.origin === base.origin && url.pathname.startsWith(MOCK_PATH_PREFIX);
}

/**
 * ¿Se puede descargar esta URL? Pura salvo por el entorno (mock). Rechaza
 * credenciales embebidas (`user:pass@`) y puertos explícitos en el CDN real.
 */
export function isAllowedSourceUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (isMockCdnUrl(url)) return true;
  if (url.protocol !== "https:") return false;
  if (url.port && url.port !== "443") return false;
  return isMetaCdnHost(url.hostname);
}

/** Lee el cuerpo cortando en `maxBytes` (no se confía en content-length). */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new MediaFetchError("El adjunto excede el límite de tamaño", true);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new MediaFetchError("El adjunto excede el límite de tamaño", true);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Descarga un adjunto del CDN de Meta. Sin token, sin cookies, con timeout,
 * tope de tamaño y lista de hosts en CADA salto. Errores → MediaFetchError
 * (`gone` si la URL ya caducó: 403/404/410).
 */
export async function downloadSourceUrl(
  raw: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {}
): Promise<{ data: Buffer; mimeType: string | null; fileSize: number }> {
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? SOURCE_TIMEOUT_MS);

  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedSourceUrl(current)) {
      throw new MediaFetchError("Origen del adjunto no permitido", true);
    }
    let res: Response;
    try {
      res = await fetch(current, { redirect: "manual", signal });
    } catch {
      throw new MediaFetchError("No se pudo descargar el adjunto");
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!location) throw new MediaFetchError("Redirección sin destino");
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new MediaFetchError(
        `La descarga devolvió ${res.status}`,
        res.status === 403 || res.status === 404 || res.status === 410
      );
    }
    let data: Buffer;
    try {
      data = await readCapped(res, maxBytes);
    } catch (err) {
      if (err instanceof MediaFetchError) throw err;
      throw new MediaFetchError("No se pudo descargar el adjunto");
    }
    return {
      data,
      mimeType: res.headers.get("content-type"),
      fileSize: data.byteLength,
    };
  }
  throw new MediaFetchError("Demasiadas redirecciones");
}
