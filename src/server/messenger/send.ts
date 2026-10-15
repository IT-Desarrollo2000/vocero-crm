import { graphRequest, graphRequestForm, MetaApiError } from "@/lib/meta/client";
import type { OutboundFileKind } from "@/lib/outbound-files";
import type { MessengerCredentials } from "@/server/messenger/credentials";

/**
 * 017 — Frontera de salida del canal de Messenger (Constitución II: todo
 * request a una plataforma pasa por un único módulo).
 *
 * Va por graph.facebook.com — el mismo host que WhatsApp, así que reusa el
 * cliente de Graph (y con él el mock del self-test). El remitente es la
 * Página: `POST /{page-id}/messages` con el token de la Página.
 */

export type MessengerSendResult = { platformMessageId: string };

/**
 * Envía texto a un PSID. Dentro de la ventana de 24 h va como `RESPONSE`;
 * fuera, como `MESSAGE_TAG` + `HUMAN_AGENT` (válida 7 días y solo con la
 * función Human Agent aprobada por Meta). Los errores salen como
 * MetaApiError: el núcleo de envío los traduce.
 */
export async function sendMessengerText(input: {
  credentials: MessengerCredentials;
  recipient: string;
  text: string;
  humanAgentTag?: boolean;
}): Promise<MessengerSendResult> {
  const { credentials } = input;
  const body: Record<string, unknown> = {
    recipient: { id: input.recipient },
    message: { text: input.text },
    messaging_type: input.humanAgentTag ? "MESSAGE_TAG" : "RESPONSE",
  };
  if (input.humanAgentTag) body.tag = "HUMAN_AGENT";

  const res = await graphRequest<{ message_id?: string }>(
    `${credentials.pageId}/messages`,
    { method: "POST", token: credentials.token, body }
  );
  return { platformMessageId: String(res.message_id ?? Date.now()) };
}

/** 018: kind del CRM → `attachment.type` de la Send API. */
const MESSENGER_ATTACHMENT_TYPE: Record<OutboundFileKind, string> = {
  image: "image",
  audio: "audio",
  video: "video",
  document: "file",
};

/**
 * 018 (FR-810) — Envía un archivo a un PSID subiéndolo en la misma petición
 * (multipart con `filedata`, hasta 25 MB). `is_reusable: false`: el archivo
 * es de una conversación, no un recurso de la Página. Mismas reglas de
 * `messaging_type`/etiqueta que el texto. Messenger NO tiene pie en los
 * adjuntos: el núcleo manda el caption como texto aparte.
 */
export async function sendMessengerAttachment(input: {
  credentials: MessengerCredentials;
  recipient: string;
  file: {
    kind: OutboundFileKind;
    data: Buffer | Uint8Array;
    mimeType: string;
    fileName: string | null;
  };
  humanAgentTag?: boolean;
}): Promise<MessengerSendResult> {
  const { credentials, file } = input;
  const form = new FormData();
  form.set("recipient", JSON.stringify({ id: input.recipient }));
  form.set(
    "message",
    JSON.stringify({
      attachment: {
        type: MESSENGER_ATTACHMENT_TYPE[file.kind],
        payload: { is_reusable: false },
      },
    })
  );
  form.set("messaging_type", input.humanAgentTag ? "MESSAGE_TAG" : "RESPONSE");
  if (input.humanAgentTag) form.set("tag", "HUMAN_AGENT");
  form.set(
    "filedata",
    new Blob([new Uint8Array(file.data)], { type: file.mimeType }),
    file.fileName ?? "adjunto"
  );

  const res = await graphRequestForm<{ message_id?: string }>(
    `${credentials.pageId}/messages`,
    { token: credentials.token, form }
  );
  if (!res?.message_id) {
    throw new MetaApiError("Meta no devolvió ID del mensaje con adjunto", {
      status: 200,
    });
  }
  return { platformMessageId: String(res.message_id) };
}

/**
 * 019 fase B (FR-943) — Attachment Upload API: sube un archivo del CATÁLOGO
 * como recurso reutilizable de la Página (`is_reusable: true`) y devuelve su
 * `attachment_id`, que luego se manda las veces que haga falta sin volver a
 * subir los bytes. Los adjuntos sueltos siguen por `sendMessengerAttachment`.
 *
 * `POST /{page-id}/message_attachments` multipart con `message` + `filedata`
 * → `{ attachment_id }`.
 */
export async function uploadMessengerAttachment(input: {
  credentials: MessengerCredentials;
  file: {
    kind: OutboundFileKind;
    data: Buffer | Uint8Array;
    mimeType: string;
    fileName: string | null;
  };
}): Promise<string> {
  const { credentials, file } = input;
  const form = new FormData();
  form.set(
    "message",
    JSON.stringify({
      attachment: {
        type: MESSENGER_ATTACHMENT_TYPE[file.kind],
        payload: { is_reusable: true },
      },
    })
  );
  form.set(
    "filedata",
    new Blob([new Uint8Array(file.data)], { type: file.mimeType }),
    file.fileName ?? "adjunto"
  );

  const res = await graphRequestForm<{ attachment_id?: string }>(
    `${credentials.pageId}/message_attachments`,
    { token: credentials.token, form }
  );
  if (!res?.attachment_id) {
    throw new MetaApiError("Meta no devolvió attachment_id del adjunto subido", {
      status: 200,
    });
  }
  return String(res.attachment_id);
}

/**
 * 019 fase B — Envía a un PSID un adjunto ya subido (`attachment_id`). Mismas
 * reglas de `messaging_type`/etiqueta que el texto y el multipart.
 */
export async function sendMessengerAttachmentById(input: {
  credentials: MessengerCredentials;
  recipient: string;
  kind: OutboundFileKind;
  attachmentId: string;
  humanAgentTag?: boolean;
}): Promise<MessengerSendResult> {
  const { credentials } = input;
  const body: Record<string, unknown> = {
    recipient: { id: input.recipient },
    message: {
      attachment: {
        type: MESSENGER_ATTACHMENT_TYPE[input.kind],
        payload: { attachment_id: input.attachmentId },
      },
    },
    messaging_type: input.humanAgentTag ? "MESSAGE_TAG" : "RESPONSE",
  };
  if (input.humanAgentTag) body.tag = "HUMAN_AGENT";

  const res = await graphRequest<{ message_id?: string }>(
    `${credentials.pageId}/messages`,
    { method: "POST", token: credentials.token, body }
  );
  if (!res?.message_id) {
    throw new MetaApiError("Meta no devolvió ID del mensaje con adjunto", {
      status: 200,
    });
  }
  return { platformMessageId: String(res.message_id) };
}
