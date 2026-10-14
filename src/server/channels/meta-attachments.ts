import type { MediaInput } from "@/server/inbox/ingest";

/**
 * 018 (FR-807) — Adjuntos entrantes de Messenger e Instagram (Meta). Los dos
 * canales mandan la misma forma: `message.attachments[] = {type, payload}`.
 * Este módulo es PURO (sin BD ni red): convierte un mensaje del webhook en la
 * lista de mensajes que el CRM ingiere, para que la regla se pruebe sola.
 *
 * Reglas:
 *   - `image|video|audio|file` con `payload.url` → un mensaje por adjunto,
 *     con su `source_url` (la descarga corre en segundo plano). El primero
 *     usa el `mid` tal cual, los siguientes `mid#<i>`; el texto, si lo hay,
 *     es el pie del primero (como en WhatsApp: el mensaje de imagen no lleva
 *     `text`, el pie va en el adjunto).
 *   - Todo lo demás (share, story_mention, reel, post, fallback, sticker sin
 *     url, location, template…) → `[Adjunto no soportado: <tipo>]`, para que
 *     nunca entre un mensaje vacío ni se pierda en silencio.
 *     · Sin adjuntos soportados: UN mensaje de texto = texto (si hay) +
 *       marcadores al final.
 *     · Con adjuntos soportados (caso mixto, raro): los marcadores van en un
 *       mensaje de texto aparte, al final de la misma secuencia `mid#<i>`.
 *   - Sin texto ni adjuntos → nada (eventos vacíos, como antes).
 */

export type MetaAttachment = {
  type?: unknown;
  payload?: unknown;
};

export type MetaInboundItem = {
  /** Sufijo del id de plataforma: "" para el primero, `#<i>` para el resto. */
  idSuffix: string;
  /** Tipo del mensaje (`text` o el kind del adjunto). */
  type: string;
  text: string | null;
  media: MediaInput | null;
};

/** Tipo de adjunto de Meta → kind del media_asset. */
const SUPPORTED_KIND: Record<string, MediaInput["kind"]> = {
  image: "image",
  video: "video",
  audio: "audio",
  file: "document",
};

/**
 * Nombre legible (español) de un tipo de adjunto no soportado. Un tipo que no
 * está aquí sale como "tipo desconocido": jamás se refleja el string crudo del
 * webhook (llega al historial del agente).
 */
const UNSUPPORTED_LABEL: Record<string, string> = {
  share: "publicación compartida",
  story_mention: "mención en una historia",
  story: "historia",
  ig_story: "historia",
  reel: "reel",
  ig_reel: "reel",
  post: "publicación",
  ig_post: "publicación",
  media: "publicación",
  fallback: "enlace",
  sticker: "sticker",
  location: "ubicación",
  template: "plantilla",
  appointment_booking: "reserva de cita",
  // Tipos soportados que llegaron SIN url: no hay nada que descargar.
  image: "imagen sin enlace",
  video: "video sin enlace",
  audio: "audio sin enlace",
  file: "archivo sin enlace",
};

export function unsupportedAttachmentMarker(type: unknown): string {
  const label =
    typeof type === "string" && Object.hasOwn(UNSUPPORTED_LABEL, type)
      ? UNSUPPORTED_LABEL[type]
      : "tipo desconocido";
  return `[Adjunto no soportado: ${label}]`;
}

function payloadUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const url = (payload as { url?: unknown }).url;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

/**
 * Nombre del archivo de un `file`: Meta no lo manda aparte, pero la URL del
 * CDN suele terminar en él (`…/cotizacion.pdf?…`). Saneado; null si no hay
 * uno con extensión. Solo cosmético: el tipo lo decide la firma de los bytes.
 */
export function fileNameFromUrl(url: string): string | null {
  let last: string;
  try {
    last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    return null;
  }
  const clean = last.replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^[.\s]+/, "").slice(0, 120);
  return /\.[A-Za-z0-9]{1,8}$/.test(clean) ? clean : null;
}

export function metaInboundItems(message: {
  text?: unknown;
  attachments?: unknown;
}): MetaInboundItem[] {
  const text =
    typeof message.text === "string" && message.text.length > 0 ? message.text : null;
  const attachments: MetaAttachment[] = Array.isArray(message.attachments)
    ? (message.attachments.filter((a) => a && typeof a === "object") as MetaAttachment[])
    : [];

  const supported: MediaInput[] = [];
  const markers: string[] = [];
  for (const a of attachments) {
    const type = typeof a.type === "string" ? a.type : "";
    const kind = Object.hasOwn(SUPPORTED_KIND, type) ? SUPPORTED_KIND[type] : undefined;
    const url = payloadUrl(a.payload);
    if (kind && url) {
      supported.push({
        kind,
        waMediaId: null,
        sourceUrl: url,
        // Se conoce al descargar (por firma), no por lo que diga Meta.
        mimeType: null,
        fileName: kind === "document" ? fileNameFromUrl(url) : null,
        caption: null,
        payload: null,
        fetchStatus: "pending",
      });
    } else {
      markers.push(unsupportedAttachmentMarker(a.type));
    }
  }

  if (supported.length === 0) {
    const parts = [text, ...markers].filter((p): p is string => !!p);
    if (parts.length === 0) return [];
    return [{ idSuffix: "", type: "text", text: parts.join(" "), media: null }];
  }

  const items: MetaInboundItem[] = supported.map((media, i) => ({
    idSuffix: i === 0 ? "" : `#${i}`,
    type: media.kind,
    text: null,
    media: i === 0 && text ? { ...media, caption: text } : media,
  }));
  if (markers.length > 0) {
    items.push({
      idSuffix: `#${items.length}`,
      type: "text",
      text: markers.join(" "),
      media: null,
    });
  }
  return items;
}
