import { graphRequest } from "@/lib/meta/client";
import { resolveChannelProfileName } from "@/server/channels/profile";
import { FB_PREFIX } from "@/server/inbox/identity";
import { ingestInboundBatch } from "@/server/inbox/ingest";
import {
  metaInboundItems,
  type MetaInboundItem,
} from "@/server/channels/meta-attachments";
import { getMessengerCredentialsByPageId } from "@/server/messenger/credentials";

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
  };
  // Eventos que llegan por el mismo arreglo y que el 017 no atiende.
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

export async function processMessengerPayload(payload: unknown): Promise<void> {
  const body = payload as MessengerPayload;
  if (body.object !== "page") return;

  for (const entry of body.entry ?? []) {
    const pageId = entry.id;
    if (!pageId) continue;

    // Solo se mira la Página cuando hay algo que ingerir: una Página ajena
    // con puros acuses no debe llenar el log de avisos.
    const inbound = (entry.messaging ?? [])
      .map(toInboundMessage)
      .filter((m): m is NonNullable<typeof m> => m !== null);
    if (inbound.length === 0) continue;

    const creds = await getMessengerCredentialsByPageId(pageId);
    if (!creds) {
      console.warn(
        `[fb] evento para la Página desconocida (${pageId}): ` +
          "guarda la conexión en Configuración -> Messenger para recibir mensajes"
      );
      continue;
    }

    for (const m of inbound) {
      const identity = `${FB_PREFIX}${m.psid}`;
      // El webhook no trae el nombre: se pide al User Profile API (requiere
      // Business Asset User Profile Access) solo si aún no lo tenemos.
      const profileName = await resolveChannelProfileName({
        organizationId: creds.organizationId,
        channel: "messenger",
        identity,
        fetchName: async () => {
          const p = await graphRequest<{ first_name?: string; last_name?: string }>(
            `${m.psid}?fields=first_name,last_name`,
            { token: creds.token }
          );
          return [p.first_name, p.last_name].filter(Boolean).join(" ") || null;
        },
      });
      const timestamp = String(
        m.timestamp ? Math.floor(m.timestamp / 1000) : Math.floor(Date.now() / 1000)
      );
      // 018: un mensaje con varios adjuntos son varios mensajes en la BD y
      // UN solo turno del agente, disparado tras el último.
      await ingestInboundBatch(
        m.items.map((item) => ({
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
        }))
      );
    }
  }
}
