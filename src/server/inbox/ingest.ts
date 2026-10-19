import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Channel } from "@/lib/channels";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { UNARCHIVE_SET } from "@/server/inbox/archive";
import { normalizeMx } from "@/lib/meta/client";
import { publish } from "@/server/events/bus";
import { getCredentialsByPhoneNumberId } from "@/server/whatsapp/credentials";
import { ensureAssetAvailable } from "@/server/whatsapp/media";
import type {
  WebhookMediaPayload,
  WebhookMessage,
  WebhookReferral,
  WebhookValue,
} from "@/server/inbox/webhook";
import {
  getOrCreateContactByIdentity,
  resolveIdentity,
  type ResolvedIdentity,
} from "@/server/inbox/identity";
import { applyStatusUpdate } from "@/server/inbox/status";
import { markHandoff } from "@/server/inbox/handoff";
import {
  anuncioDeMeta,
  anuncioDeWhatsapp,
  type AnuncioDeOrigen,
} from "@/server/attribution/referral";
import { registrarAnuncioDeOrigen } from "@/server/attribution/store";
import { onLeadActivity } from "@/server/inbox/lead-activity";
import { maybeRunAgentTurn } from "@/server/ai/trigger";

/** Tipos de contenido soportados; el resto se ignora sin error. */
const SUPPORTED_TYPES = new Set([
  "text",
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "location",
  "contacts",
]);

/** Tipos con archivo binario en Graph (008). */
const BINARY_MEDIA_TYPES = new Set([
  "image",
  "video",
  "audio",
  "document",
  "sticker",
] as const);

export type MediaInput = {
  kind: (typeof schema.mediaAsset.$inferSelect)["kind"];
  waMediaId: string | null;
  /**
   * 018: URL del CDN de Meta de un adjunto de Messenger/Instagram (no hay
   * media id: se descarga directo, sin token, con lista de hosts). Jamás sale
   * en un DTO: lleva parámetros firmados del CDN.
   */
  sourceUrl?: string | null;
  mimeType: string | null;
  fileName: string | null;
  caption: string | null;
  payload: unknown;
  fetchStatus: "available" | "pending";
};

/**
 * 008 — Extrae el adjunto de un mensaje del webhook (entrante o echo).
 * Tolerante: payload incompleto → null (el mensaje se conserva sin adjunto).
 */
export function mediaInputFrom(msg: WebhookMessage): MediaInput | null {
  if (msg.type === "location" && msg.location) {
    const { latitude, longitude } = msg.location;
    if (typeof latitude !== "number" || typeof longitude !== "number") {
      return null;
    }
    return {
      kind: "location",
      waMediaId: null,
      mimeType: null,
      fileName: null,
      caption: null,
      payload: msg.location,
      fetchStatus: "available",
    };
  }
  if (msg.type === "contacts" && Array.isArray(msg.contacts) && msg.contacts.length) {
    return {
      kind: "contacts",
      waMediaId: null,
      mimeType: null,
      fileName: null,
      caption: null,
      payload: msg.contacts,
      fetchStatus: "available",
    };
  }
  if ((BINARY_MEDIA_TYPES as Set<string>).has(msg.type)) {
    const media = msg[msg.type as "image" | "video" | "audio" | "document" | "sticker"] as
      | WebhookMediaPayload
      | undefined;
    if (!media?.id) return null;
    return {
      kind: msg.type as MediaInput["kind"],
      waMediaId: media.id,
      mimeType: media.mime_type ?? null,
      fileName: media.filename ?? null,
      caption: media.caption ?? null,
      payload: null,
      fetchStatus: "pending",
    };
  }
  return null;
}

/**
 * Crea el media_asset de un mensaje recién insertado y dispara la descarga en
 * segundo plano si hay binario. Jamás lanza hacia el webhook (FR-013).
 */
async function attachMediaAsset(
  organizationId: string,
  messageId: string,
  media: MediaInput,
  /** 018: `out` para el echo de un saliente hecho desde el teléfono. */
  direction: "in" | "out" = "in"
): Promise<typeof schema.mediaAsset.$inferSelect | null> {
  try {
    const db = getDb();
    const inserted = await db
      .insert(schema.mediaAsset)
      .values({
        id: newId("mediaAsset"),
        organizationId,
        kind: media.kind,
        waMediaId: media.waMediaId,
        sourceUrl: media.sourceUrl ?? null,
        mimeType: media.mimeType,
        fileName: media.fileName,
        caption: media.caption,
        payload: media.payload ?? null,
        fetchStatus: media.fetchStatus,
        direction,
      })
      .returning();
    const asset = inserted[0];
    if (!asset) return null;
    await db
      .update(schema.message)
      .set({ mediaAssetId: asset.id })
      .where(eq(schema.message.id, messageId));
    if (asset.fetchStatus === "pending") {
      // Descarga in-process, sin bloquear la ingesta; on-demand reintenta.
      void ensureAssetAvailable(organizationId, asset.id).catch(() => {});
    }
    return asset;
  } catch (err) {
    console.warn(`[media] no se pudo registrar el adjunto de ${messageId}:`, err);
    return null;
  }
}

/**
 * Alta/resolución de contacto por teléfono (alta manual / seeds). La ingesta
 * del webhook usa `getOrCreateContactByIdentity` (003) — este helper deriva la
 * identidad del teléfono normalizado y delega ahí.
 */
export async function getOrCreateContact(
  organizationId: string,
  phone: string,
  name?: string | null
) {
  const normalized = normalizeMx(phone);
  return getOrCreateContactByIdentity(organizationId, {
    identity: normalized,
    phone: normalized,
    waUserId: null,
    profileName: name ?? null,
  });
}

export async function getOrCreateConversation(
  organizationId: string,
  contactId: string,
  opts?: { channel?: Channel; threadRef?: string | null }
) {
  const db = getDb();
  const inserted = await db
    .insert(schema.conversation)
    .values({
      id: newId("conversation"),
      organizationId,
      contactId,
      channel: opts?.channel ?? "whatsapp",
      channelThreadRef: opts?.threadRef ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];

  const rows = await db
    .select()
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.contactId, contactId),
        eq(schema.conversation.isTest, false)
      )
    )
    .limit(1);
  const existing = rows[0];
  if (!existing) throw new Error("conversación no encontrada tras upsert");
  // 014: el hilo de la plataforma puede aparecer despues (o cambiar); se
  // guarda en cuanto se conoce para poder responder.
  if (opts?.threadRef && existing.channelThreadRef !== opts.threadRef) {
    await db
      .update(schema.conversation)
      .set({ channelThreadRef: opts.threadRef, updatedAt: new Date() })
      .where(eq(schema.conversation.id, existing.id));
    existing.channelThreadRef = opts.threadRef;
  }
  return existing;
}

/**
 * Procesa el `value` de un cambio `messages` del webhook: mensajes entrantes
 * (idempotentes por wa_message_id) y actualizaciones de estado.
 */
export async function processMessagesValue(value: WebhookValue): Promise<void> {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return;

  const credentials = await getCredentialsByPhoneNumberId(phoneNumberId);
  if (!credentials) {
    // Caso típico: webhook/override configurado ANTES de guardar la conexión
    // en el wizard — el evento llega pero no hay a qué organización enrutarlo.
    console.warn(
      `[webhook] evento para phone_number_id desconocido (${phoneNumberId}): ` +
        "guarda la conexión en Configuración → WhatsApp para recibir mensajes"
    );
    return;
  }

  const organizationId = credentials.organizationId;

  for (const status of value.statuses ?? []) {
    await applyStatusUpdate(organizationId, status);
  }

  for (const msg of value.messages ?? []) {
    if (!SUPPORTED_TYPES.has(msg.type)) continue; // reacciones, etc.: ignorar
    const resolved = resolveIdentity(msg, value.contacts);
    if (!resolved) {
      // Mensaje sin NINGUNA identidad utilizable (ni teléfono ni BSUID):
      // registrar y descartar — jamás reventar el webhook (003).
      console.warn(
        `[webhook] mensaje ${msg.id} sin identidad utilizable (sin from ni from_user_id): descartado`
      );
      continue;
    }
    await ingestInboundMessage({
      organizationId,
      identity: resolved,
      waMessageId: msg.id,
      type: msg.type,
      text: msg.text?.body ?? null,
      timestamp: msg.timestamp,
      media: mediaInputFrom(msg),
      referral: msg.referral ?? null,
    });
  }
}

/**
 * 008 — Echoes de coexistence (`smb_message_echoes`): mensajes que el dueño
 * envió A MANO desde la app de WhatsApp Business del teléfono. Se registran
 * como salientes `origin='manual'` y pausan la IA (decisión del dueño
 * 2026-08-04). JAMÁS tocan la ventana de 24 h ni disparan al agente.
 */
export async function processEchoesValue(value: WebhookValue): Promise<void> {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return;

  const credentials = await getCredentialsByPhoneNumberId(phoneNumberId);
  if (!credentials) {
    console.warn(
      `[webhook] echo para phone_number_id desconocido (${phoneNumberId}): descartado`
    );
    return;
  }

  // Meta documenta `message_echoes`; parser tolerante a `messages` (R1).
  const echoes = value.message_echoes ?? value.messages ?? [];
  for (const echo of echoes) {
    if (!SUPPORTED_TYPES.has(echo.type)) continue;
    if (!echo.to) {
      console.warn(`[webhook] echo ${echo.id} sin destinatario: descartado`);
      continue;
    }
    try {
      await ingestManualEcho(credentials.organizationId, echo);
    } catch (err) {
      // Un echo malformado jamás tumba el webhook (edge case del spec).
      console.error(`[webhook] error procesando echo ${echo.id}:`, err);
    }
  }
}

async function ingestManualEcho(
  organizationId: string,
  echo: WebhookMessage
): Promise<void> {
  const db = getDb();
  const identity = normalizeMx(echo.to!);

  const { contact } = await getOrCreateContactByIdentity(organizationId, {
    identity,
    phone: identity,
    waUserId: null,
    profileName: null,
  });
  const conversation = await getOrCreateConversation(organizationId, contact.id);

  const waTimestamp = toDate(echo.timestamp);

  // Idempotencia dura: los mensajes ya registrados (o echoes repetidos) no
  // duplican efectos — mismo wa_message_id → sin inserción ni handoff extra.
  const inserted = await db
    .insert(schema.message)
    .values({
      id: newId("message"),
      organizationId,
      conversationId: conversation.id,
      waMessageId: echo.id,
      direction: "out",
      type: echo.type,
      text: echo.text?.body ?? null,
      status: "sent",
      origin: "manual",
      waTimestamp,
    })
    .onConflictDoNothing({ target: [schema.message.waMessageId] })
    .returning();
  const message = inserted[0];
  if (!message) return; // duplicado

  const mediaInput = mediaInputFrom(echo);
  const asset = mediaInput
    ? await attachMediaAsset(organizationId, message.id, mediaInput, "out")
    : null;

  // Solo lastMessageAt: un mensaje del negocio NUNCA abre la ventana de 24 h.
  // 022: el eco del teléfono es un saliente exitoso → desarchiva.
  await db
    .update(schema.conversation)
    .set({ lastMessageAt: waTimestamp, updatedAt: new Date(), ...UNARCHIVE_SET })
    .where(eq(schema.conversation.id, conversation.id));

  // Pausa automática de la IA, idempotente y atómica (solo si no hay handoff):
  // puerta única `markHandoff` (05/02-0), que además registra el evento y
  // publica `conversation.handoff` + `conversation.updated` en la transición.
  // El `conversation.updated` de abajo se publica igual (el cliente solo
  // refetchea: un aviso repetido es inocuo).
  const paused = await markHandoff({
    organizationId,
    conversationId: conversation.id,
    reason: "manual_reply",
    // Sin nota: la pausa la provocó el dueño, no hay porqué que explicar.
    note: null,
    source: "telefono",
    pauseAi: true,
  });
  if (paused.applied) {
    console.log(
      `[webhook] respuesta manual del dueño en ${conversation.id} — IA pausada (manual_reply)`
    );
  }

  publish(organizationId, {
    type: "message.new",
    data: {
      conversationId: conversation.id,
      message: serializeMessage(message, asset),
    },
  });
  publish(organizationId, {
    type: "conversation.updated",
    data: { conversation: { id: conversation.id } },
  });
}

/**
 * 020 fase C — El `referral` de un webhook a anuncio de origen según el canal:
 * WhatsApp manda `messages[].referral`; Messenger e Instagram, la forma de
 * Messenger (`ad_id` + `ads_context_data`). Jamás lanza: un payload raro no
 * puede tumbar la entrada del mensaje.
 */
export function normalizarReferral(
  referral: unknown,
  channel: Channel | undefined
): AnuncioDeOrigen | null {
  if (!referral) return null;
  try {
    return channel === "messenger" || channel === "instagram"
      ? anuncioDeMeta(referral, channel)
      : anuncioDeWhatsapp(referral);
  } catch (err) {
    console.warn("[020] referral ilegible, se ignora:", err);
    return null;
  }
}

/**
 * 020 fase C — Un anuncio que llega SIN mensaje: el `referral` suelto de un
 * hilo de Messenger que ya existía (campo `messaging_referrals`) o el botón
 * "Empezar" de un hilo nuevo (`postback.referral`, campo
 * `messaging_postbacks`, que el CRM no ingiere como mensaje).
 *
 * Decisión: se registra el origen sobre la conversación del contacto y, si el
 * CRM aún no conoce a esa persona, se crean contacto y conversación SIN
 * mensaje (no hay tabla de "pendientes"): su primer mensaje cae en esa misma
 * conversación con el origen ya puesto, y el first-touch sigue intacto. Coste
 * aceptado: mientras no escriba, la conversación aparece vacía en la Bandeja
 * (ordenada por su alta).
 *
 * Nada más: sin mensaje, sin tocar `lastMessageAt`/no leídos/ventana de 24 h,
 * sin actividad del lead y sin turno del agente.
 */
export async function registrarOrigenSinMensaje(input: {
  organizationId: string;
  identity: ResolvedIdentity;
  anuncio: AnuncioDeOrigen;
}): Promise<{ conversationId: string }> {
  const { organizationId } = input;
  const { contact } = await getOrCreateContactByIdentity(
    organizationId,
    input.identity
  );
  const conversation = await getOrCreateConversation(organizationId, contact.id, {
    channel: contact.channel,
  });
  await registrarAnuncioDeOrigen({
    organizationId,
    contactId: contact.id,
    conversationId: conversation.id,
    anuncio: input.anuncio,
  });
  // 022: el anuncio cuenta como entrante → desarchiva. UPDATE explícito (este
  // camino no toca la conversación) y solo si estaba archivada: así no sube
  // `updated_at` en balde.
  await getDb()
    .update(schema.conversation)
    .set({ ...UNARCHIVE_SET, updatedAt: new Date() })
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.id, conversation.id),
        isNotNull(schema.conversation.archivedAt)
      )
    );
  // La Bandeja repinta la fila (y su etiqueta de origen) por `?ids=`.
  publish(organizationId, {
    type: "conversation.updated",
    data: { conversation: { id: conversation.id } },
  });
  return { conversationId: conversation.id };
}

/** Resultado de ingerir un entrante (para disparar el agente una sola vez). */
export type IngestResult = {
  conversationId: string;
  /** false = duplicado (mismo id de plataforma): no tuvo efectos. */
  inserted: boolean;
};

/**
 * 018 — Ingiere los mensajes en que se partió UN mensaje de la plataforma
 * (texto + varios adjuntos de Messenger/Instagram) y dispara UN solo turno
 * del agente al final, si alguno era nuevo.
 */
export async function ingestInboundBatch(
  items: Parameters<typeof ingestInboundMessage>[0][],
  deps: {
    ingest?: typeof ingestInboundMessage;
    runAgent?: (conversationId: string) => Promise<void>;
  } = {}
): Promise<void> {
  const ingest = deps.ingest ?? ingestInboundMessage;
  const runAgent = deps.runAgent ?? maybeRunAgentTurn;
  const fresh = new Set<string>();
  for (const item of items) {
    const r = await ingest({ ...item, skipAgentTurn: true });
    if (r.inserted) fresh.add(r.conversationId);
  }
  for (const conversationId of fresh) await runAgent(conversationId);
}

export async function ingestInboundMessage(input: {
  organizationId: string;
  identity: ResolvedIdentity;
  waMessageId: string;
  type: string;
  text: string | null;
  timestamp: string;
  media?: MediaInput | null;
  /** 014: hilo en la plataforma de origen (Zernio); null en WhatsApp. */
  threadRef?: string | null;
  /**
   * 016: origen del anuncio, si el mensaje vino de uno. 020 fase C: en
   * Messenger/Instagram es su `message.referral`, con otra forma; se
   * normaliza según el canal de la identidad (`normalizarReferral`).
   */
  referral?: WebhookReferral | Record<string, unknown> | null;
  /**
   * 018: no disparar el turno del agente. Un mensaje de Messenger/Instagram
   * con varios adjuntos se ingiere como varios mensajes: quien llama dispara
   * UN solo turno al terminar el último (`maybeRunAgentTurn`), con todos ya en
   * la BD. Sin esto, con un debounce corto salían dos respuestas.
   */
  skipAgentTurn?: boolean;
}): Promise<IngestResult> {
  const db = getDb();
  const { organizationId } = input;

  const { contact } = await getOrCreateContactByIdentity(
    organizationId,
    input.identity
  );
  const conversation = await getOrCreateConversation(
    organizationId,
    contact.id,
    { channel: contact.channel, threadRef: input.threadRef ?? null }
  );

  // 016 — Si el mensaje viene de un anuncio, capturar su origen ANTES del
  // dedup de mensaje: es idempotente por sí mismo (el primer referral gana) y
  // así un reintento de Meta que llegue con el referral no lo pierde por
  // haberse cortado antes en el dedup.
  //
  // 020 — SIEMPRE, sin la bandera: de qué anuncio llegó un lead es dato
  // interno del negocio (tarjeta, etiqueta, filtro). La bandera `ATRIBUCION`
  // solo decide el `ctwa_clid` (columna y `raw`) y el reporte a Meta: una
  // instancia que no atribuye no guarda identificadores de clic (ADR-001).
  // Ver `anuncioParaGuardar` en `src/server/attribution/store.ts`.
  const anuncio = normalizarReferral(input.referral, input.identity.channel);
  if (anuncio) {
    // Ahora corre en TODA instancia: un fallo al guardar el origen jamás
    // puede impedir que el mensaje del cliente entre.
    try {
      await registrarAnuncioDeOrigen({
        organizationId,
        contactId: contact.id,
        conversationId: conversation.id,
        anuncio,
      });
    } catch (err) {
      console.error("[020] no se pudo guardar el anuncio de origen:", err);
    }
  }

  const waTimestamp = toDate(input.timestamp);

  // Idempotencia dura: mismo wa_message_id → sin efectos adicionales.
  const inserted = await db
    .insert(schema.message)
    .values({
      id: newId("message"),
      organizationId,
      conversationId: conversation.id,
      waMessageId: input.waMessageId,
      direction: "in",
      type: input.type,
      text: input.text,
      status: "delivered",
      waTimestamp,
    })
    .onConflictDoNothing({ target: [schema.message.waMessageId] })
    .returning();
  const message = inserted[0];
  if (!message) return { conversationId: conversation.id, inserted: false }; // duplicado

  const asset = input.media
    ? await attachMediaAsset(organizationId, message.id, input.media)
    : null;

  await db
    .update(schema.conversation)
    .set({
      lastInboundAt: waTimestamp,
      lastMessageAt: waTimestamp,
      unreadCount: sql`${schema.conversation.unreadCount} + 1`,
      updatedAt: new Date(),
      // 022: un entrante devuelve la conversación a la Bandeja (tras el
      // dedupe: un duplicado no desarchiva).
      ...UNARCHIVE_SET,
    })
    .where(eq(schema.conversation.id, conversation.id));

  await onLeadActivity(organizationId, contact.id, waTimestamp);

  publish(organizationId, {
    type: "message.new",
    data: {
      conversationId: conversation.id,
      message: serializeMessage(message, asset),
    },
  });
  publish(organizationId, {
    type: "conversation.updated",
    data: { conversation: { id: conversation.id } },
  });

  if (!input.skipAgentTurn) await maybeRunAgentTurn(conversation.id);
  return { conversationId: conversation.id, inserted: true };
}

function toDate(timestamp: string): Date {
  const n = Number(timestamp);
  if (Number.isFinite(n) && n > 0) return new Date(n * 1000);
  return new Date();
}

export function serializeMessage(
  m: typeof schema.message.$inferSelect,
  media: typeof schema.mediaAsset.$inferSelect | null = null
) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    direction: m.direction,
    type: m.type,
    text: m.text,
    status: m.status,
    /** Motivo del fallo, ya traducido a algo accionable (`describeSendError`). */
    error: m.error,
    aiGenerated: m.aiGenerated,
    origin: m.origin,
    media: media
      ? {
          assetId: media.id,
          kind: media.kind,
          mimeType: media.mimeType,
          fileName: media.fileName,
          fileSize: media.fileSize,
          caption: media.caption,
          fetchStatus: media.fetchStatus,
          blockedReason:
            media.fetchStatus === "blocked" ? media.fetchError : null,
          payload: media.payload,
        }
      : null,
    createdAt: (m.waTimestamp ?? m.createdAt).toISOString(),
  };
}
