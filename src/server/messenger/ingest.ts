import { FB_PREFIX } from "@/server/inbox/identity";
import { ingestInboundMessage } from "@/server/inbox/ingest";
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
 * Un evento que es un mensaje de texto entrante del cliente, o null si es
 * cualquier otra cosa (eco, entrega, lectura, postback, adjunto…). Exportada
 * para poder probar el filtro sin base de datos.
 */
export function toInboundText(
  m: MessagingEvent
): { psid: string; mid: string; text: string; timestamp: number | null } | null {
  if (!m.message) return null; // delivery, read, postback, reaction
  // Los ecos son mensajes que la Página mandó (desde Meta Business Suite o
  // desde este mismo CRM): no son del cliente.
  if (m.message.is_echo) return null;
  const psid = m.sender?.id;
  const mid = m.message.mid;
  if (!psid || !mid) return null;
  if (typeof m.message.text !== "string") return null; // solo texto (017)
  return {
    psid,
    mid,
    text: m.message.text,
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
      .map(toInboundText)
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
      await ingestInboundMessage({
        organizationId: creds.organizationId,
        identity: {
          identity: `${FB_PREFIX}${m.psid}`,
          channel: "messenger",
          phone: null,
          waUserId: null,
          // El webhook no trae el nombre; pedirlo exige otro permiso y otra
          // llamada. Queda el respaldo hasta que alguien edite el contacto.
          profileName: null,
        },
        // Prefijado para que no colisione con un id de otro canal en el
        // índice único de mensajes.
        waMessageId: `fb_${m.mid}`,
        type: "text",
        text: m.text,
        timestamp: String(
          m.timestamp
            ? Math.floor(m.timestamp / 1000)
            : Math.floor(Date.now() / 1000)
        ),
        threadRef: null,
      });
    }
  }
}
