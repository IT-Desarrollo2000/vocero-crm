import { createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "@/server/inbox/webhook";

/**
 * Callback de eliminación de datos de Meta ("Data Deletion Callback URL" en
 * Configuración → Básica). Meta envía un POST con `signed_request` firmado
 * con el App Secret y espera `{ url, confirmation_code }`.
 * Módulo puro (sin BD) para poder testearse unitariamente.
 */

export type SignedRequestPayload = {
  algorithm: string;
  user_id?: string;
  issued_at?: number;
  expires?: number;
};

function base64UrlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Verifica la firma HMAC-SHA256 y devuelve el payload, o null si no es válido. */
export function parseSignedRequest(
  signedRequest: string,
  appSecret: string
): SignedRequestPayload | null {
  const [encodedSig, payload] = signedRequest.split(".", 2);
  if (!encodedSig || !payload) return null;
  const expected = createHmac("sha256", appSecret).update(payload).digest();
  if (!safeEqual(base64UrlDecode(encodedSig).toString("hex"), expected.toString("hex"))) {
    return null;
  }
  try {
    const data = JSON.parse(base64UrlDecode(payload).toString("utf8")) as SignedRequestPayload;
    if (data.algorithm?.toUpperCase() !== "HMAC-SHA256") return null;
    return data;
  } catch {
    return null;
  }
}

/** Código alfanumérico con el que la persona puede dar seguimiento. */
export function newConfirmationCode(): string {
  return `DEL${randomBytes(5).toString("hex").toUpperCase()}`;
}

export const CONFIRMATION_CODE_RE = /^DEL[0-9A-F]{10}$/;
