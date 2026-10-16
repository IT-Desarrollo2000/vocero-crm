import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";

/**
 * 018 (FR-812) — URL temporal y firmada de un archivo SALIENTE.
 *
 * Se creó para que Instagram descargara el adjunto de una URL pública, pero
 * su descargador no logra bajar nada de nuestro dominio: desde el arreglo de
 * adjuntos de Instagram el envío SUBE los bytes (`message_attachments`) y esta
 * URL ya no se usa para enviar. Se conserva (con sus pruebas) como utilidad.
 * Es la única puerta sin sesión a la caché de archivos, así que vale solo
 * para UN asset de UNA organización y por pocos minutos:
 *
 *   token = base64url("<orgId>.<assetId>.<expMs>") + "." + base64url(HMAC)
 *
 * HMAC-SHA256 con una clave DERIVADA de `ENCRYPTION_KEY` (etiqueta
 * `vocero:media-url:v1`): la clave de cifrado nunca firma nada directamente,
 * y rotar el formato es cambiar la etiqueta. La ruta que la sirve exige
 * además `direction = "out"` (un entrante de un cliente jamás sale por aquí).
 */

const KEY_LABEL = "vocero:media-url:v1";
export const SIGNED_URL_TTL_MS = 10 * 60 * 1000;

const B64URL = /^[A-Za-z0-9_-]+$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Tope del token completo: evita trabajo con basura enorme. */
const TOKEN_MAX = 512;

function signingKey(): Buffer {
  const master = Buffer.from(getEnv().ENCRYPTION_KEY, "base64");
  return createHmac("sha256", master).update(KEY_LABEL).digest();
}

function mac(payload: string): Buffer {
  return createHmac("sha256", signingKey()).update(payload).digest();
}

/** Token firmado para un asset saliente; `now` inyectable para pruebas. */
export function signMediaToken(
  organizationId: string,
  assetId: string,
  ttlMs: number = SIGNED_URL_TTL_MS,
  now: number = Date.now()
): string {
  if (!ID.test(organizationId) || !ID.test(assetId)) {
    throw new Error("id inválido para firmar");
  }
  const payload = `${organizationId}.${assetId}.${now + ttlMs}`;
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${mac(payload).toString("base64url")}`;
}

/** URL absoluta (`${APP_BASE_URL}/api/media/out/<token>`). */
export function signMediaUrl(
  organizationId: string,
  assetId: string,
  ttlMs: number = SIGNED_URL_TTL_MS
): string {
  const base = getEnv().APP_BASE_URL.replace(/\/+$/, "");
  return `${base}/api/media/out/${signMediaToken(organizationId, assetId, ttlMs)}`;
}

/**
 * Verifica un token. null ante CUALQUIER problema (formato, firma, vencido):
 * la ruta responde el mismo 404 sin distinguir. El formato se valida antes de
 * calcular nada; la firma se compara en tiempo constante.
 */
export function verifyMediaToken(
  token: string,
  now: number = Date.now()
): { organizationId: string; assetId: string } | null {
  if (typeof token !== "string" || token.length === 0 || token.length > TOKEN_MAX) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, encodedSig] = parts as [string, string];
  if (!B64URL.test(encodedPayload) || !B64URL.test(encodedSig)) return null;

  const payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
  // Re-codificar debe dar lo mismo: descarta variantes no canónicas.
  if (Buffer.from(payload, "utf8").toString("base64url") !== encodedPayload) return null;
  const fields = payload.split(".");
  if (fields.length !== 3) return null;
  const [organizationId, assetId, expRaw] = fields as [string, string, string];
  if (!ID.test(organizationId) || !ID.test(assetId) || !/^\d{1,15}$/.test(expRaw)) {
    return null;
  }

  const given = Buffer.from(encodedSig, "base64url");
  // También la firma debe ser canónica: el último carácter base64url de 32
  // bytes lleva bits de relleno, y sin esto varias cadenas distintas
  // decodificarían a la misma firma (un token "adulterado" seguiría valiendo).
  if (given.toString("base64url") !== encodedSig) return null;
  const expected = mac(payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  if (Number(expRaw) <= now) return null;
  return { organizationId, assetId };
}
