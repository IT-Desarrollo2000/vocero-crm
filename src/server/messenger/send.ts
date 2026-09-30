import { graphRequest } from "@/lib/meta/client";
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
