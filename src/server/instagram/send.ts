import { MetaApiError } from "@/lib/meta/client";
import type { OutboundFileKind } from "@/lib/outbound-files";
import type { InstagramCredentials } from "@/server/instagram/credentials";

/**
 * 014 — Frontera de salida del canal de Instagram (Constitución II: todo
 * request a una plataforma pasa por un único módulo).
 *
 * Dos transportes, misma firma: Zernio (API unificada) y Meta directo
 * (graph.instagram.com). Ambos devuelven el id del mensaje en la plataforma.
 */

const ZERNIO_BASE = process.env.ZERNIO_BASE_URL ?? "https://zernio.com/api/v1";
const IG_GRAPH_BASE =
  process.env.IG_GRAPH_BASE_URL ?? "https://graph.instagram.com";
const IG_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION ?? "v25.0";

/** Instagram corta el texto en 1000 BYTES (no caracteres): con acentos y
 * emojis el margen real es menor de lo que aparenta. */
export const IG_TEXT_MAX_BYTES = 1000;

export function fitsInstagramText(text: string): boolean {
  return Buffer.byteLength(text, "utf8") <= IG_TEXT_MAX_BYTES;
}

export type InstagramSendResult = { platformMessageId: string };

/**
 * Envía texto por el transporte que corresponda.
 *
 * `recipient` es el IGSID (sin el prefijo `ig:`); `threadRef` es el
 * conversationId opaco de Zernio, que solo hace falta en ese transporte.
 */
export async function sendInstagramText(input: {
  credentials: InstagramCredentials;
  recipient: string;
  threadRef: string | null;
  text: string;
  /** Fuera de la ventana de 24 h Instagram solo admite HUMAN_AGENT. */
  humanAgentTag?: boolean;
}): Promise<InstagramSendResult> {
  return input.credentials.source === "zernio"
    ? sendViaZernio(input)
    : sendViaMeta(input);
}

async function sendViaZernio(input: {
  credentials: InstagramCredentials;
  recipient: string;
  threadRef: string | null;
  text: string;
  humanAgentTag?: boolean;
}): Promise<InstagramSendResult> {
  const { credentials, threadRef } = input;
  if (!threadRef) {
    throw new MetaApiError(
      "La conversacion no tiene referencia de hilo en Zernio",
      { status: 400 }
    );
  }
  const body: Record<string, unknown> = {
    accountId: credentials.accountRef,
    message: input.text,
  };
  if (input.humanAgentTag) {
    body.messagingType = "MESSAGE_TAG";
    body.messageTag = "HUMAN_AGENT";
  }

  const res = await fetchJson(
    `${ZERNIO_BASE}/inbox/conversations/${encodeURIComponent(threadRef)}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  const id =
    (res as { message?: { id?: string }; id?: string }).message?.id ??
    (res as { id?: string }).id ??
    `zernio_${Date.now()}`;
  return { platformMessageId: String(id) };
}

async function sendViaMeta(input: {
  credentials: InstagramCredentials;
  recipient: string;
  text: string;
  humanAgentTag?: boolean;
}): Promise<InstagramSendResult> {
  const { credentials } = input;
  const body: Record<string, unknown> = {
    recipient: { id: input.recipient },
    message: { text: input.text },
  };
  if (input.humanAgentTag) {
    body.messaging_type = "MESSAGE_TAG";
    body.tag = "HUMAN_AGENT";
  }

  // El host es graph.instagram.com, NO graph.facebook.com: es el error mas
  // comun de esta integracion y devuelve un fallo de permisos que despista.
  const res = await fetchJson(
    `${IG_GRAPH_BASE}/${IG_GRAPH_VERSION}/${credentials.igUserId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  const id = (res as { message_id?: string }).message_id ?? String(Date.now());
  return { platformMessageId: String(id) };
}

/** 018: kind del CRM → `attachment.type` de la API de Instagram. */
const IG_ATTACHMENT_TYPE: Record<OutboundFileKind, string> = {
  image: "image",
  audio: "audio",
  video: "video",
  document: "file",
};

/**
 * 018 (FR-811) — Envía un archivo por Instagram (SOLO Meta directo; Zernio no
 * lleva adjuntos) SUBIENDO los bytes, en dos pasos:
 *
 *   1. `POST /{igUserId}/message_attachments` multipart (`platform`,
 *      `message`, `filedata`) → `{ attachment_id }`.
 *   2. `POST /{igUserId}/messages` con ese `attachment_id`.
 *
 * Antes se mandaba una URL firmada del CRM para que Meta la descargara, pero
 * el descargador de Instagram no logra bajar nada de nuestro dominio (code
 * 100, subcode 2018007, confirmado en producción); la subida binaria sí
 * funciona. Instagram no tiene pie en los adjuntos: el núcleo manda el
 * caption aparte. La matriz del canal ya filtró tipo y tamaño.
 */
export async function sendInstagramAttachment(input: {
  credentials: InstagramCredentials;
  recipient: string;
  file: {
    kind: OutboundFileKind;
    data: Buffer | Uint8Array;
    mimeType: string;
    fileName: string | null;
  };
  humanAgentTag?: boolean;
}): Promise<InstagramSendResult> {
  const { credentials, file } = input;
  if (credentials.source !== "meta") {
    throw new MetaApiError("Instagram vía Zernio no envía archivos", { status: 400 });
  }
  const type = IG_ATTACHMENT_TYPE[file.kind];
  const base = `${IG_GRAPH_BASE}/${IG_GRAPH_VERSION}/${credentials.igUserId}`;

  // (1) Subida. Sin Content-Type a mano: fetch pone el boundary del multipart.
  const form = new FormData();
  form.set("platform", "instagram");
  form.set(
    "message",
    JSON.stringify({ attachment: { type, payload: { is_reusable: false } } })
  );
  form.set(
    "filedata",
    new Blob([new Uint8Array(file.data)], { type: file.mimeType }),
    file.fileName ?? "adjunto"
  );
  const uploaded = (await fetchJson(`${base}/message_attachments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credentials.token}` },
    body: form,
  })) as { attachment_id?: string } | null;
  const attachmentId = uploaded?.attachment_id;
  if (!attachmentId) {
    throw new MetaApiError("Instagram no devolvió attachment_id del archivo subido", {
      status: 200,
    });
  }

  // (2) Envío por id. Según la doc de Instagram, la imagen va en
  // `attachments` (arreglo) y lo demás en `attachment` (singular).
  const payload = { type, payload: { attachment_id: String(attachmentId) } };
  const send = (message: Record<string, unknown>) => {
    const body: Record<string, unknown> = {
      recipient: { id: input.recipient },
      message,
    };
    if (input.humanAgentTag) {
      body.messaging_type = "MESSAGE_TAG";
      body.tag = "HUMAN_AGENT";
    }
    return fetchJson(`${base}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  };

  let res: unknown;
  if (file.kind === "image") {
    try {
      res = await send({ attachments: [payload] });
    } catch (err) {
      // Un formato inesperado no tumba el envío: si Meta rechaza el arreglo
      // como parámetro inválido (400/100, no de auth), UNA vez en singular.
      if (
        !(err instanceof MetaApiError) ||
        err.status !== 400 ||
        err.code !== 100 ||
        err.isAuthError
      ) {
        throw err;
      }
      console.warn(
        "[instagram] Meta rechazó la imagen en `attachments`; se reintenta con `attachment`:",
        err.message
      );
      res = await send({ attachment: payload });
    }
  } else {
    res = await send({ attachment: payload });
  }

  const id = (res as { message_id?: string } | null)?.message_id;
  if (!id) {
    throw new MetaApiError("Instagram no devolvió ID del mensaje con adjunto", {
      status: 200,
    });
  }
  return { platformMessageId: String(id) };
}

/**
 * Nombre de quien escribe por Instagram (Meta directo). El webhook no lo trae;
 * graph.instagram.com lo da con instagram_business_manage_messages.
 */
export async function fetchInstagramProfileName(input: {
  credentials: InstagramCredentials;
  igsid: string;
}): Promise<string | null> {
  const res = (await fetchJson(
    `${IG_GRAPH_BASE}/${IG_GRAPH_VERSION}/${input.igsid}?fields=name,username`,
    { headers: { Authorization: `Bearer ${input.credentials.token}` } }
  )) as { name?: string; username?: string };
  return res.name?.trim() || (res.username ? `@${res.username}` : null);
}

/**
 * Traduce los fallos de ambas plataformas al MetaApiError que el resto del
 * CRM ya sabe interpretar (incluido `isAuthError`, que distingue token muerto
 * de hipo transitorio y costó un incidente aprender).
 */
async function fetchJson(
  url: string,
  init: RequestInit
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (cause) {
    throw new MetaApiError("No se pudo contactar la API de Instagram", {
      status: 0,
      details: cause,
    });
  }

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // respuesta no-JSON: se conserva el texto crudo
  }

  if (!res.ok) {
    const err = json as
      | { error?: { message?: string; code?: number } | string }
      | null;
    const message =
      typeof err?.error === "string"
        ? err.error
        : err?.error?.message ?? `HTTP ${res.status}`;
    const code = typeof err?.error === "object" ? err.error?.code ?? null : null;
    throw new MetaApiError(message, {
      status: res.status,
      code,
      details: json ?? text,
    });
  }
  return json;
}
