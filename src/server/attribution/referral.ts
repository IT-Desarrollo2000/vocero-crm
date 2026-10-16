import type { WebhookReferral } from "@/server/inbox/webhook";

/**
 * 020 — Del `referral` de Meta a UN anuncio de origen (adaptado de upstream
 * 018, `src/server/attribution/referral.ts`).
 *
 * Puro a propósito: se prueba sin base de datos, y es la única puerta por la
 * que un payload externo llega a una columna. Tiene que aguantar entradas
 * hostiles, no solo las bonitas de la documentación de Meta: lista blanca de
 * claves, topes de tamaño y solo enlaces http(s).
 *
 * WhatsApp (fase A, `anuncioDeWhatsapp`) y Messenger/Instagram (fase C,
 * `anuncioDeMeta`) mandan formas distintas con la MISMA salida:
 *   `ad_id` → `sourceId`, `ads_context_data.ad_title` → `headline`,
 *   `ads_context_data.photo_url` → `imageUrl`, `video_url` → `mediaType:
 *   "video"`, `post_id` → `sourceUrl` cuando se pueda armar; `ref` y el resto
 *   del payload, recortados, a `raw`. Por eso el tipo no nombra campos de
 *   WhatsApp: nadie aguas abajo (store, creativo, DTO) sabe de qué canal vino.
 */

export type AnuncioDeOrigen = {
  /** Id del anuncio (o de la publicación) en Meta. */
  sourceId: string | null;
  /** `ad` | `post` en WhatsApp; texto libre recortado. */
  sourceType: string | null;
  sourceUrl: string | null;
  headline: string | null;
  body: string | null;
  /** `image` | `video` cuando Meta lo dice. */
  mediaType: string | null;
  /** Identificador del clic (solo WhatsApp). Lo guarda solo `ATRIBUCION`. */
  ctwaClid: string | null;
  /** De dónde bajar la miniatura; `creativo.ts` la vuelve a validar. */
  imageUrl: string | null;
  /** El referral recortado, para no perder campos que Meta añada después. */
  raw: Record<string, unknown>;
};

/**
 * Cotas de lo que se guarda. El payload de Meta es corto, pero nada impide que
 * un webhook traiga un titular de un megabyte, y no tiene por qué acabar en la
 * base.
 */
export const COTAS = {
  id: 128,
  titular: 300,
  texto: 2000,
  url: 2048,
  /** Tamaño máximo del `raw` serializado. */
  raw: 8_000,
} as const;

/** Claves de primer nivel que se conservan en `raw` (lista blanca). */
const CLAVES_WHATSAPP = [
  "source_url",
  "source_id",
  "source_type",
  "headline",
  "body",
  "media_type",
  "image_url",
  "video_url",
  "thumbnail_url",
  "ctwa_clid",
] as const;

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Texto útil recortado, o null. Cualquier cosa que no sea texto no cuenta. */
function texto(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const limpio = v.trim();
  if (!limpio) return null;
  return limpio.length > max ? limpio.slice(0, max) : limpio;
}

/**
 * Solo URLs http(s) completas: un `javascript:` jamás llega a un href. El http
 * pasa aquí porque el wa-mock sirve sus creativos así; la descarga y la tarjeta
 * vuelven a filtrar (https y hosts de Meta).
 */
function url(v: unknown): string | null {
  const t = texto(v, COTAS.url);
  if (!t) return null;
  try {
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function recortarCampos(
  origen: Record<string, unknown>,
  claves: readonly string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of claves) {
    const v = texto(origen[k], k.endsWith("_url") ? COTAS.url : COTAS.texto);
    if (v) out[k] = v;
  }
  return out;
}

/**
 * Si aun recortado el `raw` excede la cota, se queda con lo que identifica al
 * anuncio. Con cotas por campo no debería pasar, pero la cota total es la que
 * se promete.
 */
function acotarRaw(
  raw: Record<string, unknown>,
  esencial: Record<string, unknown>
): Record<string, unknown> {
  return JSON.stringify(raw).length <= COTAS.raw ? raw : esencial;
}

/** WhatsApp Cloud API: `messages[].referral`. */
export function anuncioDeWhatsapp(referral: unknown): AnuncioDeOrigen | null {
  if (!esObjeto(referral)) return null;
  const r = referral as WebhookReferral & Record<string, unknown>;

  const sourceId = texto(r.source_id, COTAS.id);
  const ctwaClid = texto(r.ctwa_clid, COTAS.texto);
  const headline = texto(r.headline, COTAS.titular);
  const sourceUrl = url(r.source_url);
  // Sin nada que identifique el anuncio no hay nada que enseñar.
  if (!sourceId && !ctwaClid && !headline && !sourceUrl) return null;

  const raw = recortarCampos(r, CLAVES_WHATSAPP);
  return {
    sourceId,
    sourceType: texto(r.source_type, COTAS.id),
    sourceUrl,
    headline,
    body: texto(r.body, COTAS.texto),
    mediaType: texto(r.media_type, COTAS.id),
    ctwaClid,
    // La miniatura pesa menos; `image_url` es el creativo completo.
    imageUrl: url(r.thumbnail_url) ?? url(r.image_url),
    raw: acotarRaw(raw, { source_id: sourceId, headline }),
  };
}

/**
 * Sin la bandera `ATRIBUCION`, el anuncio se guarda sin su identificador de
 * clic: ni en la columna ni dentro del `raw`. Una instancia que no atribuye no
 * acumula identificadores de Meta "por si acaso" (016, ADR-001).
 */
export function sinIdentificadorDeClic(anuncio: AnuncioDeOrigen): AnuncioDeOrigen {
  const raw = { ...anuncio.raw };
  delete raw.ctwa_clid;
  return { ...anuncio, ctwaClid: null, raw };
}

/* ------------------------------------------------------------------------
 * 020 fase C — Messenger (Click-to-Messenger) e Instagram (Click-to-Direct)
 * ---------------------------------------------------------------------- */

/** Canales cuyo `referral` tiene la forma de Messenger. */
export type CanalMeta = "messenger" | "instagram";

/** Claves de primer nivel del referral de Messenger/Instagram que se guardan. */
const CLAVES_META = ["ref", "ad_id", "source", "type", "referer_uri"] as const;
/** Claves de `ads_context_data` que se guardan (anidadas, como las manda Meta). */
const CLAVES_CONTEXTO = [
  "ad_title",
  "photo_url",
  "video_url",
  "post_id",
  "product_id",
] as const;

/**
 * `post_id` de Messenger: `<página>_<publicación>` o solo dígitos. Cualquier
 * otra cosa no se pega en una URL.
 */
const POST_ID = /^\d+(?:_\d+)?$/;

/**
 * Messenger e Instagram: el `referral` de `message.referral`,
 * `postback.referral` o el `referral` suelto de un hilo existente (misma forma
 * en los tres):
 *   `{ ref?, ad_id, source: "ADS", type: "OPEN_THREAD",
 *      ads_context_data: { ad_title, photo_url?, video_url?, post_id?, product_id? } }`
 *
 * Solo es un anuncio si `source === "ADS"` o trae `ad_id`: un enlace m.me o
 * ig.me (`SHORTLINK`, el `messaging_referral` de Instagram) no es un anuncio y
 * no se guarda. Un postback de anuncio sin `ad_id` ni contexto se guarda
 * igual: lo que se sabe —que llegó de un anuncio— ya sirve para la etiqueta y
 * el filtro (sin miniatura: la copia necesita el id del anuncio).
 *
 * Ninguno trae `ctwa_clid`: la Conversions API de esas filas queda `skipped`.
 * El `raw` conserva `ads_context_data` ANIDADO, como lo manda Meta: la
 * reparación de la miniatura (`imagenDeOrigen`) lo vuelve a leer de ahí.
 */
export function anuncioDeMeta(referral: unknown, canal: CanalMeta): AnuncioDeOrigen | null {
  if (!esObjeto(referral)) return null;
  const sourceId = texto(referral.ad_id, COTAS.id);
  const source = texto(referral.source, COTAS.id);
  if (source?.toUpperCase() !== "ADS" && !sourceId) return null;

  const contexto = esObjeto(referral.ads_context_data) ? referral.ads_context_data : {};
  const headline = texto(contexto.ad_title, COTAS.titular);
  const photo = url(contexto.photo_url);
  // En Instagram `video_url` es la miniatura del video; en Messenger puede ser
  // el video mismo (la copia lo rechaza por firma y tamaño: queda sin imagen).
  const video = url(contexto.video_url);
  const postId = texto(contexto.post_id, COTAS.id);
  const sourceUrl =
    canal === "messenger" && postId && POST_ID.test(postId)
      ? `https://www.facebook.com/${postId}`
      : null;

  const raw: Record<string, unknown> = recortarCampos(referral, CLAVES_META);
  const ctx = recortarCampos(contexto, CLAVES_CONTEXTO);
  // Al `raw` solo llegan enlaces http(s) (la reparación los vuelve a leer).
  if (photo) ctx.photo_url = photo;
  else delete ctx.photo_url;
  if (video) ctx.video_url = video;
  else delete ctx.video_url;
  if (Object.keys(ctx).length > 0) raw.ads_context_data = ctx;

  return {
    sourceId,
    sourceType: "ad",
    sourceUrl,
    headline,
    body: null,
    mediaType: video ? "video" : photo ? "image" : null,
    ctwaClid: null,
    imageUrl: photo ?? video,
    raw: acotarRaw(raw, { ad_id: sourceId, source, ads_context_data: { ad_title: headline } }),
  };
}

/**
 * El `referral` de un evento de `messaging[]` de Messenger/Instagram, venga
 * con el mensaje (`message.referral`), con el botón "Empezar"
 * (`postback.referral`) o suelto en un hilo existente (`referral`). Un eco no
 * cuenta: lo mandó la propia cuenta. Puro y tolerante: cualquier forma rara
 * devuelve undefined.
 */
export function referralDeEvento(evento: unknown): unknown {
  if (!esObjeto(evento)) return undefined;
  const message = esObjeto(evento.message) ? evento.message : null;
  if (message?.is_echo) return undefined;
  const postback = esObjeto(evento.postback) ? evento.postback : null;
  return message?.referral ?? postback?.referral ?? evento.referral;
}

/**
 * De dónde bajar otra vez la miniatura de una fila ya guardada, venga del
 * canal que venga (su `raw` conserva las claves de imagen). Para la imagen el
 * canal de Meta da igual.
 */
export function imagenDeOrigen(raw: unknown): string | null {
  return (
    anuncioDeWhatsapp(raw)?.imageUrl ?? anuncioDeMeta(raw, "instagram")?.imageUrl ?? null
  );
}
