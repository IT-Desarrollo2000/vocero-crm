import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import type { ChatMessage } from "@/lib/ai";
import {
  sanitizeContextValue,
  sanitizeMessageText,
} from "@/server/ai/contact-context";

/**
 * 03 — El historial que ve el agente.
 *
 * Antes, todo mensaje sin `text` se descartaba en silencio: si el cliente
 * mandaba una foto, el modelo contestaba al mensaje ANTERIOR. Ahora cada
 * mensaje no-texto viaja como un marcador (`[imagen] «pie»`, `[audio — no
 * puedes escucharlo]`, `[ubicación: …]`) armado con `kind`/`caption`/`payload`
 * del adjunto — nunca con el binario, que puede seguir descargándose.
 *
 * Y cada saliente dice quién lo escribió: los turnos previos van en el MISMO
 * JSON que se le exige al modelo (con texto plano, MiniMax deja de responder
 * JSON desde el segundo turno), pero los que escribió un humano llevan
 * `"autor":"asesor"` y las plantillas `"autor":"plantilla"`.
 */

export const HISTORY_LIMIT = 20;

export type HistoryMedia = {
  kind: string;
  caption: string | null;
  fileName: string | null;
  payload: unknown;
  /** 018: `blocked`/`expired` cambian el marcador; ausente = como antes. */
  fetchStatus?: string | null;
};

export type HistoryRow = {
  direction: "in" | "out";
  type?: string | null;
  text: string | null;
  origin?: string | null;
  aiGenerated?: boolean | null;
  media?: HistoryMedia | null;
};

/**
 * Últimos `HISTORY_LIMIT` mensajes de la conversación con su adjunto, en orden
 * cronológico. Vive aparte de `toChatHistory` para que los tests del turno
 * puedan simular la BD sin `leftJoin`.
 */
export async function loadHistoryRows(
  organizationId: string,
  conversationId: string
): Promise<HistoryRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      direction: schema.message.direction,
      type: schema.message.type,
      text: schema.message.text,
      origin: schema.message.origin,
      aiGenerated: schema.message.aiGenerated,
      mediaKind: schema.mediaAsset.kind,
      mediaCaption: schema.mediaAsset.caption,
      mediaFileName: schema.mediaAsset.fileName,
      mediaPayload: schema.mediaAsset.payload,
      mediaFetchStatus: schema.mediaAsset.fetchStatus,
    })
    .from(schema.message)
    .leftJoin(
      schema.mediaAsset,
      eq(schema.message.mediaAssetId, schema.mediaAsset.id)
    )
    .where(
      scoped(
        schema.message.organizationId,
        organizationId,
        eq(schema.message.conversationId, conversationId)
      )
    )
    .orderBy(desc(schema.message.createdAt))
    .limit(HISTORY_LIMIT);
  return rows.reverse().map((r) => ({
    direction: r.direction,
    type: r.type,
    text: r.text,
    origin: r.origin,
    aiGenerated: r.aiGenerated,
    media: r.mediaKind
      ? {
          kind: r.mediaKind,
          caption: r.mediaCaption,
          fileName: r.mediaFileName,
          payload: r.mediaPayload,
          fetchStatus: r.mediaFetchStatus,
        }
      : null,
  }));
}

const CAPTION_MAX = 300;
const NAME_MAX = 120;

const KIND_LABEL: Record<string, string> = {
  image: "imagen",
  video: "video",
  audio: "audio",
  document: "documento",
  sticker: "sticker",
  location: "ubicación",
  contacts: "contacto",
};

function withCaption(base: string, caption: string | null | undefined): string {
  const c = sanitizeContextValue(caption, CAPTION_MAX);
  return c ? `${base} «${c}»` : base;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function locationMarker(payload: unknown): string {
  const p = asRecord(payload);
  if (!p) return "[ubicación]";
  const parts: string[] = [];
  const name = sanitizeContextValue(p.name, NAME_MAX);
  const address = sanitizeContextValue(p.address, NAME_MAX);
  if (name) parts.push(`«${name}»`);
  if (address) parts.push(`«${address}»`);
  const lat = typeof p.latitude === "number" ? p.latitude : null;
  const lng = typeof p.longitude === "number" ? p.longitude : null;
  const coords = lat !== null && lng !== null ? `(${lat}, ${lng})` : "";
  const desc = [parts.join(", "), coords].filter(Boolean).join(" ");
  return desc ? `[ubicación: ${desc}]` : "[ubicación]";
}

function contactsMarker(payload: unknown): string {
  const first = Array.isArray(payload) ? asRecord(payload[0]) : asRecord(payload);
  const nameObj = asRecord(first?.name);
  const name = sanitizeContextValue(
    nameObj?.formatted_name ?? nameObj?.first_name ?? first?.name,
    NAME_MAX
  );
  return name ? `[contacto compartido: «${name}»]` : "[contacto compartido]";
}

/**
 * Marcador de un mensaje ENTRANTE sin texto (RF-03-08).
 *
 * 018: un archivo bloqueado por la política no dice qué era (el tipo que
 * declaró el remitente es justo lo que no se cree); uno que la caché de 30
 * días ya borró conserva su marcador con ` (expirado)`, para que el agente
 * no prometa abrir algo que ya no existe.
 */
export function inboundMarker(row: HistoryRow): string {
  const m = row.media;
  if (m?.fetchStatus === "blocked") {
    return withCaption("[archivo bloqueado por seguridad]", m.caption);
  }
  const marker = mediaMarker(row);
  return m?.fetchStatus === "expired" ? `${marker} (expirado)` : marker;
}

function mediaMarker(row: HistoryRow): string {
  const m = row.media;
  if (!m) {
    const type = sanitizeContextValue(row.type ?? "desconocido", 40) || "desconocido";
    return `[mensaje de tipo «${type}» sin texto]`;
  }
  switch (m.kind) {
    case "image":
      return withCaption("[imagen]", m.caption);
    case "video":
      return withCaption("[video]", m.caption);
    case "audio":
      return "[audio — no puedes escucharlo]";
    case "document": {
      const name = sanitizeContextValue(m.fileName, NAME_MAX);
      return withCaption(name ? `[documento: «${name}»]` : "[documento]", m.caption);
    }
    case "sticker":
      return "[sticker]";
    case "location":
      return locationMarker(m.payload);
    case "contacts":
      return contactsMarker(m.payload);
    default: {
      const type = sanitizeContextValue(m.kind, 40) || "desconocido";
      return `[mensaje de tipo «${type}» sin texto]`;
    }
  }
}

/** ¿Quién escribió el saliente? `undefined` = el propio agente. */
export function outboundAuthor(row: HistoryRow): "asesor" | "plantilla" | undefined {
  if (row.aiGenerated) return undefined;
  if (row.origin === "template") return "plantilla";
  if (row.origin === "operator" || row.origin === "manual") return "asesor";
  return undefined;
}

function outboundText(row: HistoryRow): string {
  if (row.text) return sanitizeMessageText(row.text);
  if (row.origin === "template") return "[plantilla enviada]";
  if (row.media) {
    const label = KIND_LABEL[row.media.kind] ?? "archivo";
    return withCaption(`[archivo enviado: ${label}]`, row.media.caption);
  }
  return "[mensaje enviado sin texto]";
}

/**
 * Convierte el historial al formato de chat del proveedor. Ningún mensaje se
 * descarta. `lastInboundText` es el texto (o, si no hay, el pie de foto/
 * video/documento) del último entrante, CRUDO, para el regex de respaldo de
 * handoff (RF-03-10).
 */
export function toChatHistory(rows: HistoryRow[]): {
  messages: ChatMessage[];
  lastInboundText: string | null;
} {
  const messages: ChatMessage[] = rows.map((row) => {
    if (row.direction === "in") {
      return {
        role: "user" as const,
        content: row.text ? sanitizeMessageText(row.text) : inboundMarker(row),
      };
    }
    const autor = outboundAuthor(row);
    return {
      role: "assistant" as const,
      content: JSON.stringify({
        action: "reply",
        text: outboundText(row),
        ...(autor ? { autor } : {}),
      }),
    };
  });

  const lastIn = [...rows].reverse().find((r) => r.direction === "in");
  const lastInboundText = lastIn
    ? lastIn.text || lastIn.media?.caption || null
    : null;

  return { messages, lastInboundText };
}
