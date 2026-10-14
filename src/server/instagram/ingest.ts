import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveChannelProfileName } from "@/server/channels/profile";
import { IG_PREFIX } from "@/server/inbox/identity";
import { fetchInstagramProfileName } from "@/server/instagram/send";
import { ingestInboundBatch, ingestInboundMessage } from "@/server/inbox/ingest";
import { metaInboundItems } from "@/server/channels/meta-attachments";
import {
  getInstagramCredentialsByAccountRef,
  getInstagramCredentialsByIgUserId,
} from "@/server/instagram/credentials";

/**
 * 014 — Adaptadores de entrada del canal de Instagram.
 *
 * Dos fuentes con formatos que no se parecen en nada: Zernio manda un evento
 * plano y Meta manda `entry[].messaging[]` al estilo Messenger. Cada una se
 * normaliza aquí y de ahí en adelante corre el MISMO núcleo de ingesta que ya
 * resuelve contacto, conversación, idempotencia y bus de eventos.
 */

/** Firma de Zernio: HMAC-SHA256 hex del cuerpo CRUDO, con el secreto. */
export function isValidZernioSignature(
  rawBody: string,
  signature: string | null,
  secret: string | null
): boolean {
  if (!secret) return true; // sin secreto configurado, protege la URL secreta
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.trim().toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

type ZernioEvent = {
  id?: string;
  event?: string;
  message?: {
    id?: string;
    conversationId?: string;
    direction?: string;
    text?: string | null;
    sender?: { id?: string; name?: string | null; username?: string | null };
    /** 018: forma no documentada; solo importa si viene y no está vacía. */
    attachments?: unknown;
    media?: unknown;
  };
  account?: { id?: string; platform?: string };
};

/** 018 (FR-809): Zernio no trae adjuntos al CRM (fuera de alcance). */
export const ZERNIO_UNSUPPORTED_MARKER = "[Adjunto no soportado]";

function isNonEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/**
 * Texto con el que entra un evento de Zernio. Un DM con adjunto (foto,
 * historia…) llegaría vacío: se marca para que el hilo y el agente sepan que
 * hubo algo. Con texto, el marcador va al final. Sin texto ni adjuntos, el
 * comportamiento de siempre (null).
 */
export function zernioInboundText(message: ZernioEvent["message"]): string | null {
  const text = message?.text ?? null;
  const hasAttachment = isNonEmpty(message?.attachments) || isNonEmpty(message?.media);
  if (!hasAttachment) return text;
  return text ? `${text} ${ZERNIO_UNSUPPORTED_MARKER}` : ZERNIO_UNSUPPORTED_MARKER;
}

/**
 * Evento de Zernio. Devuelve el secreto esperado para poder validar la firma
 * ANTES de procesar: el enrutado por `account.id` necesita leer el cuerpo, así
 * que la validación ocurre en dos tiempos (resolver cuenta, luego firmar).
 */
export async function resolveZernioSecret(
  rawBody: string
): Promise<{ secret: string | null; accountRef: string | null }> {
  let parsed: ZernioEvent | null = null;
  try {
    parsed = JSON.parse(rawBody) as ZernioEvent;
  } catch {
    return { secret: null, accountRef: null };
  }
  const accountRef = parsed.account?.id ?? null;
  if (!accountRef) return { secret: null, accountRef: null };
  const creds = await getInstagramCredentialsByAccountRef(accountRef);
  return { secret: creds?.webhookSecret ?? null, accountRef };
}

export async function processZernioEvent(payload: unknown): Promise<void> {
  const evt = payload as ZernioEvent;

  // El mismo webhook trae WhatsApp, Facebook y X si esas cuentas estan
  // conectadas: sin este filtro acabariamos ingiriendo otra plataforma como
  // si fueran DMs de Instagram.
  if (evt.account?.platform !== "instagram") return;
  if (evt.event !== "message.received") return;
  if (evt.message?.direction && evt.message.direction !== "incoming") return;

  const accountRef = evt.account?.id;
  if (!accountRef) return;

  const creds = await getInstagramCredentialsByAccountRef(accountRef);
  if (!creds) {
    console.warn(
      `[ig] evento para accountId desconocido (${accountRef}): ` +
        "guarda la conexion en Configuracion -> Instagram para recibir mensajes"
    );
    return;
  }
  if (creds.source !== "zernio") {
    // Defensa en profundidad: esta instancia no habla con Zernio, asi que un
    // payload con su forma no puede ser legitimo aunque llegue por la URL
    // correcta. Sin esto, la unica barrera de la forma ajena es la URL.
    console.warn(
      `[ig] payload de Zernio en una instancia configurada como '${creds.source}': descartado`
    );
    return;
  }

  const igsid = evt.message?.sender?.id;
  if (!igsid) {
    console.warn(`[ig] evento ${evt.id ?? "?"} sin sender.id: descartado`);
    return;
  }

  const text = zernioInboundText(evt.message);
  const platformMessageId = evt.message?.id;
  if (!platformMessageId) {
    console.warn(`[ig] evento ${evt.id ?? "?"} sin id de mensaje: descartado`);
    return;
  }

  await ingestInboundMessage({
    organizationId: creds.organizationId,
    identity: {
      identity: `${IG_PREFIX}${igsid}`,
      channel: "instagram",
      phone: null,
      waUserId: null,
      profileName:
        evt.message?.sender?.name ??
        (evt.message?.sender?.username
          ? `@${evt.message.sender.username}`
          : null),
    },
    // Prefijado para que no colisione jamas con un id de WhatsApp en el
    // indice unico de mensajes.
    waMessageId: `ig_${platformMessageId}`,
    type: "text",
    text,
    timestamp: String(Math.floor(Date.now() / 1000)),
    threadRef: evt.message?.conversationId ?? null,
  });
}

type MetaIgPayload = {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    messaging?: Array<{
      sender?: { id?: string };
      recipient?: { id?: string };
      timestamp?: number;
      message?: {
        mid?: string;
        text?: string;
        is_echo?: boolean;
        /** 018: `{type, payload:{url?}}` — ver `metaInboundItems`. */
        attachments?: unknown;
      };
    }>;
  }>;
};

export async function processMetaInstagramPayload(
  payload: unknown
): Promise<void> {
  const body = payload as MetaIgPayload;
  if (body.object !== "instagram") return;

  for (const entry of body.entry ?? []) {
    const igUserId = entry.id;
    if (!igUserId) continue;

    const creds = await getInstagramCredentialsByIgUserId(igUserId);
    if (!creds) {
      console.warn(
        `[ig] evento para IG_ID desconocido (${igUserId}): ` +
          "guarda la conexion en Configuracion -> Instagram para recibir mensajes"
      );
      continue;
    }
    if (creds.source !== "meta") {
      // Idem: sin app propia de Meta, un payload con su forma no puede venir
      // de Meta. Cierra la inyeccion en instancias que solo usan Zernio, donde
      // META_APP_SECRET no existe y la firma no se puede verificar.
      console.warn(
        `[ig] payload de Meta en una instancia configurada como '${creds.source}': descartado`
      );
      continue;
    }

    for (const m of entry.messaging ?? []) {
      // Los echos son mensajes que el dueno mando desde la app de Instagram.
      // Fuera del alcance del 014: se ignoran sin ruido.
      if (m.message?.is_echo) continue;

      const igsid = m.sender?.id;
      const mid = m.message?.mid;
      if (!igsid || !mid || !m.message) continue;
      // 018: texto y/o adjuntos; nada que ingerir → se ignora como antes.
      const items = metaInboundItems(m.message);
      if (items.length === 0) continue;

      const identity = `${IG_PREFIX}${igsid}`;
      // Meta no manda nombre ni usuario en el webhook: se piden solo si aún
      // no los tenemos.
      const profileName = await resolveChannelProfileName({
        organizationId: creds.organizationId,
        channel: "instagram",
        identity,
        fetchName: () => fetchInstagramProfileName({ credentials: creds, igsid }),
      });
      const timestamp = String(
        m.timestamp ? Math.floor(m.timestamp / 1000) : Math.floor(Date.now() / 1000)
      );
      // 018: un mensaje con varios adjuntos son varios mensajes en la BD y
      // UN solo turno del agente, disparado tras el último.
      await ingestInboundBatch(
        items.map((item) => ({
          organizationId: creds.organizationId,
          identity: {
            identity,
            channel: "instagram",
            phone: null,
            waUserId: null,
            profileName,
          },
          // `#<i>` para el 2.º adjunto en adelante (mismo mid en Meta).
          waMessageId: `ig_${mid}${item.idSuffix}`,
          type: item.type,
          text: item.text,
          timestamp,
          media: item.media,
          threadRef: null,
        }))
      );
    }
  }
}
