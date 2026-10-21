import { eq } from "drizzle-orm";
import type { AgentActionRecord } from "@/lib/agent-action";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { graphRequest, MetaApiError, normalizeRecipient } from "@/lib/meta/client";
import { publish } from "@/server/events/bus";
import { UNARCHIVE_SET } from "@/server/inbox/archive";
import { closeAwaitingByAiSql, closeAwaitingSql } from "@/server/inbox/awaiting";
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
import { sendInstagramAttachment, sendInstagramText } from "@/server/instagram/send";
import {
  getMessengerCredentialsByOrg,
  markMessengerReconnectRequired,
} from "@/server/messenger/credentials";
import {
  sendMessengerAttachment,
  sendMessengerAttachmentById,
  sendMessengerText,
  uploadMessengerAttachment,
} from "@/server/messenger/send";
import {
  forgetRemoteId,
  getReusableRemoteId,
  saveRemoteId,
  type RemoteChannel,
} from "@/server/catalog/remote-cache";
import {
  capabilitiesFor,
  outboundFilesFor,
  replyModeFor,
  textFits,
  textTooLongMessage,
  windowClosedMessage,
} from "@/server/channels/capabilities";
import { isChannelEnabled } from "@/server/channels/enabled";
import { serializeMessage } from "@/server/inbox/ingest";
import { saveMediaFile, uploadGraphMedia } from "@/server/whatsapp/media";
import { checkChannelFile, inspectOutgoing } from "@/server/media/file-policy";
import type { OutboundFileKind, OutboundFiles } from "@/lib/outbound-files";

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
 * 018 — Archivo saliente ya validado (firma + matriz del canal) y guardado en
 * la caché local. `mimeType` es el que se ENTREGA a la plataforma; `data`
 * son los bytes que Messenger e Instagram suben por multipart.
 */
export type OutboundAttachment = {
  organizationId: string;
  assetId: string;
  kind: OutboundFileKind;
  data: Buffer;
  mimeType: string;
  fileName: string | null;
  caption?: string;
};

/**
 * 017 — Transporte de un canal distinto de WhatsApp. Cada canal aporta el
 * suyo en `TEXT_TRANSPORTS`; el núcleo no sabe de hosts ni de ids.
 */
type TextTransport = {
  send(text: string, humanAgentTag: boolean): Promise<string>;
  /**
   * 018 — Punto de extensión de adjuntos (Messenger multipart en /messages,
   * Instagram subida + envío por attachment_id). Devuelve el id de
   * plataforma SIN prefijo.
   * Ausente → el envío de archivos responde `unsupported_channel`.
   */
  sendAttachment?(file: OutboundAttachment, humanAgentTag: boolean): Promise<string>;
  /**
   * 018 — Matriz de archivos de ESTA conexión cuando difiere de la del canal
   * (Instagram vía Zernio: ninguno → 415). Ausente = la de `capabilities.ts`.
   */
  outboundFiles?: OutboundFiles | null;
  /**
   * 019 fase B (FR-943) — Subida REUTILIZABLE para los archivos del catálogo
   * (Messenger: Attachment Upload API). Ausente = el canal no reutiliza y el
   * archivo del catálogo sale por `sendAttachment` como cualquier otro.
   */
  reusable?: ReusableTransport;
  markReconnectRequired(): Promise<void>;
};

/** 019 fase B — Lo que un canal aporta para reutilizar lo ya subido a Meta. */
type ReusableTransport = {
  channel: RemoteChannel;
  /** Cuenta dueña del id remoto (page id en Messenger). */
  accountId: string;
  /** Sube los bytes y devuelve el id remoto reutilizable. */
  upload(file: OutboundAttachment): Promise<string>;
  /** Envía por id remoto; devuelve el id de plataforma SIN prefijo. */
  sendById(kind: OutboundFileKind, remoteId: string, humanAgentTag: boolean): Promise<string>;
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
    const transport: TextTransport = {
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
      // 018: el mismo criterio que el DTO (`outboundFilesFor`).
      outboundFiles: outboundFilesFor("instagram", creds.source),
      markReconnectRequired: () => markInstagramReconnectRequired(organizationId),
    };
    if (creds.source === "meta") {
      // Igual que Messenger: se suben los bytes (message_attachments) y se
      // envía por attachment_id. Meta no logra descargar URLs de nuestro
      // dominio, así que la URL firmada ya no se usa para enviar.
      transport.sendAttachment = async (file, humanAgentTag) =>
        (
          await sendInstagramAttachment({
            credentials: creds,
            recipient,
            file,
            humanAgentTag,
          })
        ).platformMessageId;
    }
    return transport;
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
    const reusable: ReusableTransport = {
      channel: "messenger",
      accountId: creds.pageId,
      upload: (file) => uploadMessengerAttachment({ credentials: creds, file }),
      sendById: async (kind, attachmentId, humanAgentTag) =>
        (
          await sendMessengerAttachmentById({
            credentials: creds,
            recipient,
            kind,
            attachmentId,
            humanAgentTag,
          })
        ).platformMessageId,
    };
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
      // 018: multipart con `filedata` (FR-810).
      sendAttachment: async (file, humanAgentTag) =>
        (
          await sendMessengerAttachment({
            credentials: creds,
            recipient,
            file,
            humanAgentTag,
          })
        ).platformMessageId,
      // 019 fase B: los archivos del catálogo se suben una vez y se reutilizan.
      reusable,
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
 * 017 — Lo que solo existe en WhatsApp (ubicación, contactos; 018: los
 * archivos ya van por la matriz del canal) falla con un 4xx claro en los
 * demás canales, en vez de un 500 por credenciales que no existen.
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
  /** 025 — La acción de agenda que produjo el texto (solo el agente). */
  agentAction?: AgentActionRecord | null;
  /**
   * 026 — Cuándo empezó el envío: un entrante posterior a este instante
   * sigue sin contestar y deja la espera abierta (`closeAwaitingSql`).
   */
  startedAt: Date;
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
      agentAction: input.agentAction ?? null,
    })
    .returning();
  const message = inserted[0]!;

  // 022: un saliente aceptado (operador, agente, bot API, catálogo) desarchiva;
  // uno que ya falló, no. Aceptado: si WhatsApp lo marca `failed` después
  // (webhook `pending` → `failed`), la conversación queda desarchivada.
  // 026: misma convención para la espera: un saliente aceptado (operador,
  // agente, bot externo) atiende al cliente y la cierra; uno fallido, no. La
  // IA o el bot, solo sin escalamiento abierto (ver closeAwaitingByAiSql).
  await db
    .update(schema.conversation)
    .set({
      lastMessageAt: new Date(),
      updatedAt: new Date(),
      ...(input.status !== "failed"
        ? {
            ...UNARCHIVE_SET,
            awaitingSince: input.aiGenerated
              ? closeAwaitingByAiSql(input.startedAt)
              : closeAwaitingSql(input.startedAt),
          }
        : {}),
    })
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
  /**
   * 025 — La acción de agenda del motor que produjo el texto. El historial
   * del agente la muestra en vez del texto con horas (A6).
   */
  agentAction?: AgentActionRecord | null;
}): Promise<SendResult> {
  const startedAt = new Date();
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
    agentAction: input.agentAction ?? null,
    startedAt,
  });

  return { messageId };
}

/**
 * 008 — Envía un adjunto de archivo (imagen/video/audio/documento).
 * El archivo queda ANTES en el volumen local (caché de la preview, 30 días);
 * si la plataforma falla tras eso, el mensaje se persiste `failed` (visible
 * en el hilo, nunca se pierde en silencio) y el SendError lleva `messageId`.
 *
 * 018 (FR-803) — Orden de validación: tope global → firma y lista blanca
 * (415 con la razón) → matriz del canal: tipo (415 con la frase del canal) y
 * tamaño (413). Lo guardado es el MIME DETECTADO, nunca el del navegador.
 * El sandbox del Laboratorio (`prepareSend`) sigue antes de cualquier red.
 *
 * 019 fase B — Con `productFileId` (archivo del catálogo), WhatsApp y
 * Messenger reutilizan el id remoto ya subido (`sendWithReuse`); Instagram
 * sube los bytes en cada envío (`sendAttachment`). La copia en `media_asset` se crea igual en todos los
 * casos: el hilo se ve idéntico se reutilice o no.
 */
export async function sendMediaMessage(input: {
  conversationId: string;
  organizationId: string;
  file: { data: Buffer; mimeType: string; fileName?: string };
  caption?: string;
  /** 019 (FR-940): el archivo viene del catálogo; procedencia de la copia. */
  productFileId?: string;
}): Promise<SendResult> {
  const startedAt = new Date();
  // Puro: ni disco ni red. Lanza MediaValidationError (413/415).
  const inspection = inspectOutgoing(input.file.data, {
    fileName: input.file.fileName,
    mime: input.file.mimeType,
  });

  const target = await prepareSend(input.conversationId, input.organizationId);
  const channel = target.conversation.channel;
  const caps = capabilitiesFor(channel);
  // 018: la conexión puede restringir la matriz del canal (Instagram vía
  // Zernio no envía archivos → 415 antes de tocar disco).
  const outboundFiles =
    target.kind === "text_only" && target.transport.outboundFiles !== undefined
      ? target.transport.outboundFiles
      : caps.outboundFiles;
  const { rule, sendMime } = checkChannelFile(
    outboundFiles,
    inspection,
    input.file.data.byteLength,
    caps.label
  );
  const kind = rule.kind;

  // 018: el canal declara su matriz, pero el transporte puede no saber
  // mandar archivos todavía (Bloque 2). Falla claro ANTES de tocar disco.
  if (target.kind === "text_only" && !target.transport.sendAttachment) {
    throw new SendError(
      "unsupported_channel",
      `Todavía no se pueden enviar archivos por ${CHANNEL_LABEL[target.channel]}; manda el texto`
    );
  }

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
      mimeType: inspection.mime,
      fileName: input.file.fileName ?? null,
      fileSize: input.file.data.byteLength,
      // Instagram y Messenger no tienen pie en los adjuntos: ahí el caption
      // viaja como un mensaje de texto aparte (ver abajo), así que la tarjeta
      // no lo repite. Si el envío falla, se le devuelve para no perderlo.
      caption: target.kind === "whatsapp" ? (input.caption ?? null) : null,
      storagePath,
      fetchStatus: "available",
      direction: "out",
      productFileId: input.productFileId ?? null,
    })
    .returning();
  const asset = assetRows[0]!;

  let messageId: string;
  try {
    let waMessageId: string;
    if (target.kind === "whatsapp") {
      const { credentials, recipient } = target;
      // csv sale como text/plain (WhatsApp no acepta text/csv); el nombre
      // `.csv` se conserva y es lo que ve el cliente.
      const upload = () =>
        uploadGraphMedia(credentials, {
          data: input.file.data,
          mimeType: sendMime,
          fileName: input.file.fileName,
        });
      const sendById = async (waMediaId: string) => {
        // El hilo registra el id con el que salió, subido o reutilizado.
        await db
          .update(schema.mediaAsset)
          .set({ waMediaId, updatedAt: new Date() })
          .where(eq(schema.mediaAsset.id, assetId));

        const mediaPayload: Record<string, unknown> = { id: waMediaId };
        if (input.caption && kind !== "audio") mediaPayload.caption = input.caption;
        if (kind === "document" && input.file.fileName) {
          mediaPayload.filename = input.file.fileName;
        }
        return callGraphSend(credentials, {
          messaging_product: "whatsapp",
          to: recipient,
          type: kind,
          [kind]: mediaPayload,
        });
      };
      waMessageId = input.productFileId
        ? await sendWithReuse(
            {
              organizationId: input.organizationId,
              productFileId: input.productFileId,
              channel: "whatsapp",
              accountId: credentials.phoneNumberId,
            },
            upload,
            sendById
          )
        : await sendById(await upload());
    } else {
      const file: OutboundAttachment = {
        organizationId: input.organizationId,
        assetId,
        kind,
        data: input.file.data,
        mimeType: sendMime,
        fileName: input.file.fileName ?? null,
        caption: input.caption,
      };
      const reusable = input.productFileId ? target.transport.reusable : undefined;
      if (input.productFileId && reusable) {
        waMessageId = await sendWithReuse(
          {
            organizationId: input.organizationId,
            productFileId: input.productFileId,
            channel: reusable.channel,
            accountId: reusable.accountId,
          },
          () => callChannelRaw(target, () => reusable.upload(file)),
          (remoteId) =>
            callChannelTransport(target, () =>
              reusable.sendById(kind, remoteId, target.humanAgentTag)
            )
        );
      } else {
        const sendAttachment = target.transport.sendAttachment!;
        waMessageId = await callChannelTransport(target, () =>
          sendAttachment(file, target.humanAgentTag)
        );
      }
    }

    messageId = await persistOutbound({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      waMessageId,
      type: kind,
      text: null,
      status: caps.deliveryReceipts ? "pending" : "sent",
      origin: "operator",
      mediaAssetId: assetId,
      media: asset,
      startedAt,
    });
  } catch (err) {
    let sendErr: SendError;
    if (err instanceof SendError) {
      sendErr = err;
    } else if (
      target.kind === "whatsapp" &&
      err instanceof MetaApiError &&
      err.isAuthError
    ) {
      // Mismo criterio que el texto: SOLO 401/código 190 (fix 2026-08-04).
      await markReconnectRequired(input.organizationId);
      sendErr = new SendError("reconnect_required", RECONNECT_MESSAGE.whatsapp);
    } else {
      sendErr = new SendError(
        "upload_failed",
        `No se pudo subir el adjunto a ${CHANNEL_LABEL[channel]}`
      );
    }
    // El contenido NO se pierde: mensaje failed con el asset ya en disco
    // (y, en Instagram/Messenger, con el pie que no llegó a salir).
    if (target.kind === "text_only" && input.caption) {
      await db
        .update(schema.mediaAsset)
        .set({ caption: input.caption, updatedAt: new Date() })
        .where(eq(schema.mediaAsset.id, assetId));
      asset.caption = input.caption;
    }
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
      startedAt,
    });
    throw sendErr;
  }

  // 018 — Pie en Instagram/Messenger: la plataforma no lo admite en un
  // adjunto, así que sale DESPUÉS como un mensaje de texto normal (persistido
  // como el suyo propio, origin operator). Va fuera del try de arriba a
  // propósito: si el texto falla, el adjunto YA llegó — se devuelve su éxito.
  // `sendText` no persiste nada cuando la plataforma lo rechaza (lanza antes),
  // así que el pie se guarda aquí como su propio mensaje `failed`, con el
  // motivo: visible en el hilo, nunca se pierde en silencio.
  if (target.kind === "text_only" && input.caption?.trim()) {
    try {
      await sendText({
        conversationId: input.conversationId,
        organizationId: input.organizationId,
        text: input.caption,
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.message
          ? err.message
          : `No se pudo enviar el texto a ${CHANNEL_LABEL[channel]}`;
      console.warn(
        `[media] el adjunto salió por ${CHANNEL_LABEL[channel]} pero su pie no:`,
        reason
      );
      try {
        await persistOutbound({
          organizationId: input.organizationId,
          conversationId: input.conversationId,
          waMessageId: null,
          type: "text",
          text: input.caption,
          status: "failed",
          error: `El archivo sí se envió, pero su texto no: ${reason}`,
          origin: "operator",
          startedAt,
        });
      } catch (persistErr) {
        // El éxito del adjunto no se convierte en error por esto.
        console.error("[media] no se pudo registrar el pie fallido:", persistErr);
      }
    }
  }
  return { messageId };
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
  const startedAt = new Date();
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
      direction: "out",
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
    startedAt,
  });
  return { messageId };
}

type RemoteKey = Parameters<typeof getReusableRemoteId>[0];

/**
 * 019 fase B (FR-942/943) — Envío de un archivo del catálogo reutilizando lo
 * que Meta ya tiene subido para (archivo, canal, cuenta).
 *
 *   - Hay id vigente → `send(id)` sin subir nada. Si Meta lo rechaza con un
 *     4xx que no es de autenticación (`meta_error`), el id se olvida y se
 *     re-sube UNA vez. Auth (`reconnect_required`), Meta caída
 *     (`meta_unavailable`) y ventana (`window_closed`) se propagan tal cual:
 *     re-subir no los arregla.
 *   - Sin id (o tras olvidarlo) → `upload()` → se guarda → `send(id)`.
 *
 * `upload` y `send` ya traducen sus errores (callGraphSend / transporte del
 * canal); esto solo decide cuándo reintentar. Solo se llega aquí DESPUÉS de
 * `prepareSend` (FR-944): `is_test` jamás consulta ni escribe la caché. Un
 * fallo de la caché (BD) degrada a subir como siempre: nunca bloquea el envío.
 */
async function sendWithReuse(
  key: RemoteKey,
  upload: () => Promise<string>,
  send: (remoteId: string) => Promise<string>
): Promise<string> {
  const cached = await cacheStep("leer", () => getReusableRemoteId(key), null);
  if (cached) {
    try {
      return await send(cached);
    } catch (err) {
      if (!(err instanceof SendError && err.code === "meta_error")) throw err;
      console.warn(
        `[catalog] ${key.channel} rechazó el id reutilizado del archivo ${key.productFileId}; se re-sube:`,
        err.message
      );
      await cacheStep("olvidar", () => forgetRemoteId(key), undefined);
    }
  }
  const remoteId = await upload();
  await cacheStep("guardar", () => saveRemoteId({ ...key, remoteId }), undefined);
  return send(remoteId);
}

async function cacheStep<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[catalog] no se pudo ${what} el id remoto (se sigue sin caché):`, err);
    return fallback;
  }
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

  if (!textFits(channel, text)) {
    throw new SendError("meta_error", textTooLongMessage(channel));
  }
  return callChannelTransport(target, () => transport.send(text, humanAgentTag));
}

/**
 * Ejecuta una llamada del transporte de un canal (texto o adjunto, 018) y
 * traduce sus errores de Meta a SendError con las reglas del canal.
 */
async function callChannelTransport(
  target: Extract<SendTarget, { kind: "text_only" }>,
  call: () => Promise<string>
): Promise<string> {
  const platformId = await callChannelRaw(target, call);
  return `${OUTBOUND_ID_PREFIX[target.channel]}${platformId}`;
}

/**
 * Igual que `callChannelTransport` pero devuelve lo que devuelva la llamada,
 * sin prefijo (019 fase B: la subida reutilizable devuelve un id remoto, no
 * un id de mensaje).
 */
async function callChannelRaw(
  target: Extract<SendTarget, { kind: "text_only" }>,
  call: () => Promise<string>
): Promise<string> {
  const { channel, transport, humanAgentTag } = target;
  const label = CHANNEL_LABEL[channel];

  try {
    return await call();
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
