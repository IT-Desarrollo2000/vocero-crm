import { resolveChannelProfileName } from "@/server/channels/profile";
import { FB_PREFIX } from "@/server/inbox/identity";
import { ingestInboundBatch, registrarOrigenSinMensaje } from "@/server/inbox/ingest";
import {
  anuncioDeMeta,
  referralDeEvento,
  type AnuncioDeOrigen,
} from "@/server/attribution/referral";
import {
  metaInboundItems,
  type MetaInboundItem,
} from "@/server/channels/meta-attachments";
import { getMessengerCredentialsByPageId } from "@/server/messenger/credentials";
import { fetchMessengerName } from "@/server/messenger/profile";

/**
 * 017 — Adaptador de entrada del canal de Messenger.
 *
 * Meta manda `object: "page"` con `entry[].messaging[]`. Se normaliza aquí y
 * de ahí en adelante corre el MISMO núcleo de ingesta que ya resuelve
 * contacto, conversación, idempotencia y bus de eventos.
 */

type MessagingEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    /** 018: `{type, payload:{url?}}` — ver `metaInboundItems`. */
    attachments?: unknown;
    /** 020 fase C: el anuncio, si el hilo NUEVO se abrió desde uno. */
    referral?: unknown;
  };
  /**
   * 020 fase C: `referral` suelto (sin `message`) cuando alguien que YA tenía
   * hilo con la Página vuelve desde un anuncio (campo `messaging_referrals`).
   */
  referral?: unknown;
  // Eventos que llegan por el mismo arreglo y que el 017 no atiende. Del
  // `postback` solo se lee su `referral` (botón "Empezar" de un anuncio).
  delivery?: unknown;
  read?: unknown;
  postback?: unknown;
  reaction?: unknown;
};

type MessengerPayload = {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    messaging?: MessagingEvent[];
    // Eventos del protocolo de traspaso (handover) cuando la Página tiene
    // otra app como receptor principal: no son mensajes para nosotros.
    standby?: unknown[];
  }>;
};

/**
 * Un evento que es un mensaje entrante del cliente (texto y/o adjuntos), o
 * null si es cualquier otra cosa (eco, entrega, lectura, postback…) o no
 * trae nada que ingerir. 018: los adjuntos ya no se descartan — cada uno es
 * un mensaje (`metaInboundItems`). Exportada para probar el filtro sin BD.
 */
export function toInboundMessage(m: MessagingEvent): {
  psid: string;
  mid: string;
  items: MetaInboundItem[];
  timestamp: number | null;
} | null {
  if (!m.message) return null; // delivery, read, postback, reaction
  // Los ecos son mensajes que la Página mandó (desde Meta Business Suite o
  // desde este mismo CRM): no son del cliente.
  if (m.message.is_echo) return null;
  const psid = m.sender?.id;
  const mid = m.message.mid;
  if (!psid || !mid) return null;
  const items = metaInboundItems(m.message);
  if (items.length === 0) return null;
  return {
    psid,
    mid,
    items,
    timestamp: typeof m.timestamp === "number" ? m.timestamp : null,
  };
}

/**
 * 020 fase C — Un anuncio que llega SIN mensaje que ingerir: el `referral`
 * suelto de un hilo existente, el `postback.referral` del botón "Empezar", o
 * un `message.referral` cuyo mensaje no trae nada que ingerir. Null si el
 * evento sí es un mensaje (su anuncio viaja con él), es un eco, o no viene de
 * un anuncio. Exportada para probar el filtro sin BD.
 */
export function toOriginOnly(
  m: MessagingEvent
): { psid: string; anuncio: AnuncioDeOrigen } | null {
  if (toInboundMessage(m)) return null;
  const psid = m.sender?.id;
  if (!psid) return null;
  const anuncio = anuncioDeMeta(referralDeEvento(m), "messenger");
  return anuncio ? { psid, anuncio } : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function processMessengerPayload(payload: unknown): Promise<void> {
  const body = payload as MessengerPayload;
  if (body.object !== "page") return;

  for (const entry of body.entry ?? []) {
    const pageId = entry.id;
    if (!pageId) continue;

    // Solo se mira la Página cuando hay algo que ingerir: una Página ajena
    // con puros acuses no debe llenar el log de avisos.
    const eventos = Array.isArray(entry.messaging) ? entry.messaging : [];
    const inbound = eventos
      .map((m) => {
        const msg = toInboundMessage(m);
        return msg ? { ...msg, referral: m.message?.referral } : null;
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);
    // 020 fase C: anuncios sin mensaje. Un evento raro no tumba el webhook.
    const origenes = eventos
      .map((m) => {
        try {
          return toOriginOnly(m);
        } catch {
          return null;
        }
      })
      .filter((o): o is NonNullable<typeof o> => o !== null);
    if (inbound.length === 0 && origenes.length === 0) continue;

    const creds = await getMessengerCredentialsByPageId(pageId);
    if (!creds) {
      console.warn(
        `[fb] evento para la Página desconocida (${pageId}): ` +
          "guarda la conexión en Configuración -> Messenger para recibir mensajes"
      );
      continue;
    }

    // El webhook no trae el nombre: se pide solo si aún no lo tenemos, por el
    // perfil o, sin Business Asset User Profile Access, por la conversación
    // de la Página (ver `fetchMessengerName`).
    const nombreDe = (psid: string, identity: string) =>
      resolveChannelProfileName({
        organizationId: creds.organizationId,
        channel: "messenger",
        identity,
        fetchName: () =>
          fetchMessengerName({ psid, pageId: creds.pageId, token: creds.token }),
      });

    // 020 fase C: el origen sin mensaje se registra sobre la conversación del
    // contacto, creándolos si aún no existen (ver `registrarOrigenSinMensaje`).
    // Un fallo aquí jamás impide que entren los mensajes del mismo lote.
    for (const o of origenes) {
      try {
        const identity = `${FB_PREFIX}${o.psid}`;
        await registrarOrigenSinMensaje({
          organizationId: creds.organizationId,
          identity: {
            identity,
            channel: "messenger",
            phone: null,
            waUserId: null,
            profileName: await nombreDe(o.psid, identity),
          },
          anuncio: o.anuncio,
        });
      } catch (err) {
        console.error("[020] no se pudo guardar el anuncio de origen (Messenger):", err);
      }
    }

    for (const m of inbound) {
      const identity = `${FB_PREFIX}${m.psid}`;
      const profileName = await nombreDe(m.psid, identity);
      const timestamp = String(
        m.timestamp ? Math.floor(m.timestamp / 1000) : Math.floor(Date.now() / 1000)
      );
      // 020 fase C: el anuncio viaja con el primer mensaje del lote (el
      // registro es idempotente y el primero gana); la ingesta lo normaliza
      // por canal y jamás deja que un referral raro impida la entrada.
      const referral = isRecord(m.referral) ? m.referral : null;
      // 018: un mensaje con varios adjuntos son varios mensajes en la BD y
      // UN solo turno del agente, disparado tras el último.
      await ingestInboundBatch(
        m.items.map((item, i) => ({
          organizationId: creds.organizationId,
          identity: {
            identity,
            channel: "messenger",
            phone: null,
            waUserId: null,
            profileName,
          },
          // Prefijado para que no colisione con un id de otro canal en el
          // índice único de mensajes; `#<i>` para el 2.º adjunto en adelante.
          waMessageId: `fb_${m.mid}${item.idSuffix}`,
          type: item.type,
          text: item.text,
          timestamp,
          media: item.media,
          threadRef: null,
          referral: i === 0 ? referral : null,
        }))
      );
    }
  }
}
