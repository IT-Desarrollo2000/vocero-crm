import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { graphRequest, MetaApiError, normalizeRecipient } from "@/lib/meta/client";
import { publish } from "@/server/events/bus";
import {
  getCredentialsByOrg,
  markReconnectRequired,
  type Credentials,
} from "@/server/whatsapp/credentials";
import { CHANNEL_LABEL, type Channel } from "@/lib/channels";
import { FB_PREFIX, IG_PREFIX } from "@/server/inbox/identity";
import {
  getInstagramCredentialsByOrg,
  markInstagramReconnectRequired,
} from "@/server/instagram/credentials";
import { sendInstagramText } from "@/server/instagram/send";
import {
  getMessengerCredentialsByOrg,
  markMessengerReconnectRequired,
} from "@/server/messenger/credentials";
import { sendMessengerText } from "@/server/messenger/send";
import {
  capabilitiesFor,
  replyModeFor,
  textFits,
  textTooLongMessage,
  windowClosedMessage,
} from "@/server/channels/capabilities";
import { isChannelEnabled } from "@/server/channels/enabled";
import { serializeMessage } from "@/server/inbox/ingest";
import {
  saveMediaFile,
  uploadGraphMedia,
  validateOutgoing,
} from "@/server/whatsapp/media";

/** Error tipado del envío; `code` mapea a HTTP en la capa de API. */
export class SendError extends Error {
  code:
    | "sandbox_violation"
    | "not_connected"
    | "reconnect_required"
    | "window_closed"
    | "meta_error"
    | "meta_unavailable"
    | "upload_failed"
    /** 017: lo pedido no existe en el canal de la conversación. */
    | "unsupported_channel";
  /** 008: presente cuando el fallo ocurrió TRAS persistir el mensaje (failed). */
  messageId?: string;

  constructor(code: SendError["code"], message: string) {
    super(message);
    this.name = "SendError";
    this.code = code;
  }
}

type SendResult = { messageId: string };

type ConversationRow = typeof schema.conversation.$inferSelect;
type ContactRow = typeof schema.contact.$inferSelect;
type TextOnlyChannel = Exclude<Channel, "whatsapp">;

/**
 * 017 — Transporte de un canal que (por ahora) solo manda texto. Cada canal
 * aporta el suyo en `TEXT_TRANSPORTS`; el núcleo no sabe de hosts ni de ids.
 */
type TextTransport = {
  send(text: string, humanAgentTag: boolean): Promise<string>;
  markReconnectRequired(): Promise<void>;
};

type SendTarget =
  | {
      kind: "whatsapp";
      conversation: ConversationRow;
      credentials: Credentials;
      recipient: string;
    }
  | {
      kind: "text_only";
      conversation: ConversationRow;
      channel: TextOnlyChannel;
      transport: TextTransport;
      /** Ventana de 24 h cerrada pero dentro de los 7 días: sale etiquetado. */
      humanAgentTag: boolean;
    };

/** Qué decirle al operador cuando el token de un canal murió. */
const RECONNECT_MESSAGE: Record<Channel, string> = {
  whatsapp: "El token de WhatsApp expiró: reconecta el número en Configuración",
  instagram:
    "El token de Instagram expiró o fue revocado: reconecta la cuenta en Configuración",
  messenger:
    "El token de la Página de Facebook expiró o fue revocado: reconecta Messenger en Configuración",
};

/**
 * Id de plataforma con el que se guarda un saliente. Prefijado por canal,
 * igual que los entrantes (`ig_`, `fb_`): el indice unico de mensajes es
 * uno solo para todos los canales y los ids de Meta no son un espacio comun.
 */
const OUTBOUND_ID_PREFIX: Record<TextOnlyChannel, string> = {
  instagram: "ig_",
  messenger: "fb_",
};

function stripPrefix(identity: string, prefix: string): string {
  return identity.startsWith(prefix) ? identity.slice(prefix.length) : identity;
}

/**
 * 014/017 — Resolución del transporte por canal. Agregar un canal de solo
 * texto es agregar una entrada aquí (y sus capacidades), no otro `if`.
 */
const TEXT_TRANSPORTS: Record<
  TextOnlyChannel,
  (
    organizationId: string,
    contact: ContactRow,
    conversation: ConversationRow
  ) => Promise<TextTransport>
> = {
  instagram: async (organizationId, contact, conversation) => {
    const creds = await getInstagramCredentialsByOrg(organizationId);
    if (!creds) {
      throw new SendError("not_connected", "No hay cuenta de Instagram conectada");
    }
    if (creds.status === "reconnect_required") {
      throw new SendError("reconnect_required", RECONNECT_MESSAGE.instagram);
    }
    const recipient = stripPrefix(contact.waIdentity, IG_PREFIX);
    return {
      send: async (text, humanAgentTag) =>
        (
          await sendInstagramText({
            credentials: creds,
            recipient,
            threadRef: conversation.channelThreadRef,
            text,
            humanAgentTag,
          })
        ).platformMessageId,
      markReconnectRequired: () => markInstagramReconnectRequired(organizationId),
    };
  },
  messenger: async (organizationId, contact) => {
    const creds = await getMessengerCredentialsByOrg(organizationId);
    if (!creds) {
      throw new SendError(
        "not_connected",
        "No hay Página de Facebook conectada a Messenger"
      );
    }
    if (creds.status === "reconnect_required") {
      throw new SendError("reconnect_required", RECONNECT_MESSAGE.messenger);
    }
    const recipient = stripPrefix(contact.waIdentity, FB_PREFIX);
    return {
      send: async (text, humanAgentTag) =>
        (
          await sendMessengerText({
            credentials: creds,
            recipient,
            text,
            humanAgentTag,
          })
        ).platformMessageId,
      markReconnectRequired: () => markMessengerReconnectRequired(organizationId),
    };
  },
};

/**
 * Pre-flight común de todo envío por la conversación (008): existencia +
 * tenant, sandbox del Laboratorio (ASERCIÓN DURA, FR-031: jamás toca la API
 * real), ventana del canal, credenciales y destinatario.
 */
async function prepareSend(
  conversationId: string,
  organizationId: string
): Promise<SendTarget> {
  const db = getDb();
  const rows = await db
    .select({
      conversation: schema.conversation,
      contact: schema.contact,
    })
    .from(schema.conversation)
    .innerJoin(
      schema.contact,
      eq(schema.conversation.contactId, schema.contact.id)
    )
    .where(eq(schema.conversation.id, conversationId))
    .limit(1);
  const row = rows[0];
  if (!row || row.conversation.organizationId !== organizationId) {
    throw new SendError("meta_error", "Conversación no encontrada");
  }

  // ANTES de cualquier bifurcación por canal: ningún transporte, de ningún
  // canal, se alcanza desde una conversación del Laboratorio.
  if (row.conversation.isTest) {
    throw new SendError(
      "sandbox_violation",
      "Conversación de prueba del Laboratorio: el envío real está prohibido"
    );
  }

  const channel = row.conversation.channel;

  // Una conversacion de un canal apagado puede existir (se apago despues de
  // recibirla): falla claro en vez de intentar un transporte que no aplica.
  if (channel !== "whatsapp" && !isChannelEnabled(channel)) {
    throw new SendError(
      "not_connected",
      `El canal de ${CHANNEL_LABEL[channel]} está desactivado en esta instancia`
    );
  }

  // El nucleo no decide la politica: la consulta. WhatsApp exige plantilla
  // fuera de ventana; Instagram y Messenger etiquetan hasta los 7 dias y
  // despues no hay forma.
  const mode = replyModeFor(channel, row.conversation.lastInboundAt);
  if (mode === "template" || mode === "closed") {
    throw new SendError("window_closed", windowClosedMessage(channel));
  }

  if (channel !== "whatsapp") {
    const transport = await TEXT_TRANSPORTS[channel](
      organizationId,
      row.contact,
      row.conversation
    );
    return {
      kind: "text_only",
      conversation: row.conversation,
      channel,
      transport,
      humanAgentTag: mode === "human_agent",
    };
  }

  const credentials = await getCredentialsByOrg(organizationId);
  if (!credentials) {
    throw new SendError("not_connected", "No hay número de WhatsApp conectado");
  }
  if (credentials.status === "reconnect_required") {
    throw new SendError("reconnect_required", RECONNECT_MESSAGE.whatsapp);
  }

  // 003: el destinatario es el teléfono normalizado o, si el contacto llegó
  // por BSUID sin teléfono, su Business-Scoped User ID.
  const recipient = row.contact.phone
    ? normalizeRecipient(row.contact.phone)
    : row.contact.waUserId;
  if (!recipient) {
    throw new SendError(
      "meta_error",
      "El contacto no tiene teléfono ni identidad de WhatsApp utilizable"
    );
  }

  return {
    kind: "whatsapp",
    conversation: row.conversation,
    credentials,
    recipient,
  };
}

/**
 * 017 — Lo que solo existe en WhatsApp (adjuntos, ubicación, contactos) falla
 * con un 4xx claro en los demás canales, en vez de un 500 por credenciales
 * que no existen.
 */
function requireWhatsApp(
  target: SendTarget,
  what: string
): asserts target is Extract<SendTarget, { kind: "whatsapp" }> {
  if (target.kind !== "whatsapp") {
    throw new SendError(
      "unsupported_channel",
      `Todavía no se pueden enviar ${what} por ${CHANNEL_LABEL[target.channel]}; manda el texto`
    );
  }
}

async function persistOutbound(input: {
  organizationId: string;
  conversationId: string;
  waMessageId: string | null;
  type: string;
  text: string | null;
  /**
   * 014: 'sent' existe porque no todos los canales confirman por webhook.
   * WhatsApp entra como 'pending' y avanza con los `statuses` de Meta;
   * Instagram no manda ese evento salvo que se suscriba aparte, asi que la
   * aceptacion de la plataforma ES la confirmacion. Sin esto el mensaje se
   * queda con el reloj puesto para siempre aunque ya se haya entregado.
   */
  status: "pending" | "sent" | "failed";
  error?: string | null;
  aiGenerated?: boolean;
  origin: "ai" | "operator";
  mediaAssetId?: string | null;
  media?: typeof schema.mediaAsset.$inferSelect | null;
}): Promise<string> {
  const db = getDb();
  const inserted = await db
    .insert(schema.message)
    .values({
      id: newId("message"),
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      waMessageId: input.waMessageId,
      direction: "out",
      type: input.type,
      text: input.text,
      status: input.status,
      error: input.error ?? null,
      aiGenerated: input.aiGenerated ?? false,
      origin: input.origin,
      mediaAssetId: input.mediaAssetId ?? null,
    })
    .returning();
  const message = inserted[0]!;

  await db
    .update(schema.conversation)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.conversation.id, input.conversationId));

  publish(input.organizationId, {
    type: "message.new",
    data: {
      conversationId: input.conversationId,
      message: serializeMessage(message, input.media ?? null),
    },
  });

  return message.id;
}

/** Envía un mensaje de texto libre por WhatsApp. */
export async function sendText(input: {
  conversationId: string;
  organizationId: string;
  text: string;
  aiGenerated?: boolean;
}): Promise<SendResult> {
  const target = await prepareSend(input.conversationId, input.organizationId);

  // FR-210: la etiqueta de agente humano es, por politica de Meta, solo para
  // humanos. El pipeline ya hace handoff al cerrarse las 24 h; esto cubre la
  // carrera de una ventana que se cierra a mitad del turno del agente.
  if (input.aiGenerated && target.kind === "text_only" && target.humanAgentTag) {
    throw new SendError(
      "window_closed",
      "La ventana de 24 horas se cerró: el agente no puede responder fuera de ella"
    );
  }

  const waMessageId =
    target.kind === "whatsapp"
      ? await callGraphSend(target.credentials, {
          messaging_product: "whatsapp",
          to: target.recipient,
          type: "text",
          text: { body: input.text },
        })
      : await callChannelSend(target, input.text);

  const messageId = await persistOutbound({
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    waMessageId,
    type: "text",
    text: input.text,
    // Un canal sin acuses de entrega confirma al aceptar; uno con acuses
    // avanza despues por webhook. Sin esta distincion el mensaje se queda
    // con el reloj puesto para siempre.
    status: capabilitiesFor(target.conversation.channel).deliveryReceipts
      ? "pending"
      : "sent",
    aiGenerated: input.aiGenerated,
    origin: input.aiGenerated ? "ai" : "operator",
  });

  return { messageId };
}

/**
 * 008 — Envía un adjunto de archivo (imagen/video/audio/documento).
 * El archivo queda ANTES en el volumen local (fuente durable de la preview);
 * si Graph falla tras eso, el mensaje se persiste `failed` (visible en el
 * hilo, nunca se pierde en silencio) y el SendError lleva `messageId`.
 */
export async function sendMediaMessage(input: {
  conversationId: string;
  organizationId: string;
  file: { data: Buffer; mimeType: string; fileName?: string };
  caption?: string;
}): Promise<SendResult> {
  // Validación previa (FR-007): tipo y tamaño antes de tocar disco o red.
  const kind = validateOutgoing(input.file.mimeType, input.file.data.byteLength);

  const target = await prepareSend(input.conversationId, input.organizationId);
  requireWhatsApp(target, "adjuntos");
  const { credentials, recipient } = target;

  const db = getDb();
  const assetId = newId("mediaAsset");
  const storagePath = await saveMediaFile(
    input.organizationId,
    assetId,
    input.file.data
  );
  const assetRows = await db
    .insert(schema.mediaAsset)
    .values({
      id: assetId,
      organizationId: input.organizationId,
      kind,
      mimeType: input.file.mimeType,
      fileName: input.file.fileName ?? null,
      fileSize: input.file.data.byteLength,
      caption: input.caption ?? null,
      storagePath,
      fetchStatus: "available",
    })
    .returning();
  const asset = assetRows[0]!;

  try {
    const waMediaId = await uploadGraphMedia(credentials, input.file);
    await db
      .update(schema.mediaAsset)
      .set({ waMediaId, updatedAt: new Date() })
      .where(eq(schema.mediaAsset.id, assetId));

    const mediaPayload: Record<string, unknown> = { id: waMediaId };
    if (input.caption && kind !== "audio") mediaPayload.caption = input.caption;
    if (kind === "document" && input.file.fileName) {
      mediaPayload.filename = input.file.fileName;
    }
    const waMessageId = await callGraphSend(credentials, {
      messaging_product: "whatsapp",
      to: recipient,
      type: kind,
      [kind]: mediaPayload,
    });

    const messageId = await persistOutbound({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      waMessageId,
      type: kind,
      text: null,
      status: "pending",
      origin: "operator",
      mediaAssetId: assetId,
      media: asset,
    });
    return { messageId };
  } catch (err) {
    let sendErr: SendError;
    if (err instanceof SendError) {
      sendErr = err;
    } else if (err instanceof MetaApiError && err.isAuthError) {
      // Mismo criterio que el texto: SOLO 401/código 190 (fix 2026-08-04).
      await markReconnectRequired(input.organizationId);
      sendErr = new SendError(
        "reconnect_required",
        "El token de WhatsApp expiró: reconecta el número en Configuración"
      );
    } else {
      sendErr = new SendError(
        "upload_failed",
        "No se pudo subir el adjunto a WhatsApp"
      );
    }
    // El contenido NO se pierde: mensaje failed con el asset ya en disco.
    sendErr.messageId = await persistOutbound({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      waMessageId: null,
      type: kind,
      text: null,
      status: "failed",
      error: sendErr.message,
      origin: "operator",
      mediaAssetId: assetId,
      media: asset,
    });
    throw sendErr;
  }
}

export type LocationInput = {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
};

export type ContactInput = { name: string; phone: string };

/** 008 — Envía una ubicación o contactos (payload estructurado, sin archivo). */
export async function sendStructured(
  input: {
    conversationId: string;
    organizationId: string;
  } & (
    | { kind: "location"; location: LocationInput }
    | { kind: "contacts"; contacts: ContactInput[] }
  )
): Promise<SendResult> {
  const target = await prepareSend(input.conversationId, input.organizationId);
  requireWhatsApp(
    target,
    input.kind === "location" ? "ubicaciones" : "contactos"
  );
  const { credentials, recipient } = target;

  const payload =
    input.kind === "location"
      ? { type: "location", location: input.location }
      : {
          type: "contacts",
          contacts: input.contacts.map((c) => ({
            name: { formatted_name: c.name, first_name: c.name },
            phones: [{ phone: c.phone, type: "CELL" }],
          })),
        };

  const waMessageId = await callGraphSend(credentials, {
    messaging_product: "whatsapp",
    to: recipient,
    ...payload,
  });

  const db = getDb();
  const assetRows = await db
    .insert(schema.mediaAsset)
    .values({
      id: newId("mediaAsset"),
      organizationId: input.organizationId,
      kind: input.kind,
      payload: input.kind === "location" ? input.location : input.contacts,
      fetchStatus: "available",
    })
    .returning();
  const asset = assetRows[0]!;

  const messageId = await persistOutbound({
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    waMessageId,
    type: input.kind,
    text: null,
    status: "pending",
    origin: "operator",
    mediaAssetId: asset.id,
    media: asset,
  });
  return { messageId };
}

/** Llama a Graph /messages y traduce errores de Meta a SendError. */
export async function callGraphSend(
  credentials: Credentials,
  payload: unknown
): Promise<string> {
  try {
    const res = await graphRequest<{ messages?: { id: string }[] }>(
      `${credentials.phoneNumberId}/messages`,
      { method: "POST", token: credentials.token, body: payload }
    );
    const id = res.messages?.[0]?.id;
    if (!id) throw new SendError("meta_error", "Meta no devolvió ID de mensaje");
    return id;
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await markReconnectRequired(credentials.organizationId);
        throw new SendError(
          "reconnect_required",
          "El token de WhatsApp expiró: reconecta el número en Configuración"
        );
      }
      if (err.status === 0 || err.status >= 500) {
        throw new SendError("meta_unavailable", "Meta no está disponible ahora");
      }
      throw new SendError("meta_error", err.message);
    }
    throw err;
  }
}


/**
 * 014/017 — Envío por un canal de solo texto (Instagram, Messenger). Traduce
 * los fallos al mismo vocabulario de SendError que ya usa WhatsApp, para que
 * la bandeja no tenga que aprender un idioma por plataforma.
 */
async function callChannelSend(
  target: Extract<SendTarget, { kind: "text_only" }>,
  text: string
): Promise<string> {
  const { channel, transport, humanAgentTag } = target;
  const label = CHANNEL_LABEL[channel];

  if (!textFits(channel, text)) {
    throw new SendError("meta_error", textTooLongMessage(channel));
  }

  try {
    const platformId = await transport.send(text, humanAgentTag);
    return `${OUTBOUND_ID_PREFIX[channel]}${platformId}`;
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await transport.markReconnectRequired();
        throw new SendError("reconnect_required", RECONNECT_MESSAGE[channel]);
      }
      if (err.status === 0 || err.status >= 500) {
        throw new SendError(
          "meta_unavailable",
          `${label} no está disponible en este momento; intenta de nuevo`
        );
      }
      // FR-207: sin la funcion Human Agent aprobada en App Review, Meta
      // rechaza la etiqueta con un error de permiso (10 o 200). Decirlo tal
      // cual: un "meta_error" generico manda al operador a buscar en otro lado.
      if (humanAgentTag && (err.code === 10 || err.code === 200)) {
        throw new SendError(
          "window_closed",
          `${label} rechazó la respuesta fuera de las 24 horas: la app necesita la función "Human Agent" aprobada por Meta (App Review) para responder después de ese plazo`
        );
      }
      throw new SendError("meta_error", err.message);
    }
    throw err;
  }
}
