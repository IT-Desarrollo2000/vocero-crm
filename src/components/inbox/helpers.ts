/** Utilidades de presentación de la bandeja. */

import type { Channel } from "@/lib/channels";
import { matchesQuery } from "@/lib/search";
import type { ConversationDto } from "@/lib/types";

/** Pastillas de la bandeja: todas, no leídas o pidiendo atención humana. */
export type ConversationFilter = "all" | "unread" | "handoff";

/**
 * Atención humana = nadie automático va a contestar: la conversación tiene
 * handoff abierto O la IA se apagó a mano. Cada caso lleva su distintivo en
 * el renglón ("Atención humana" / "IA pausada"), así que toda fila del filtro
 * muestra uno de los dos — nunca ambos.
 */
export function needsHuman(c: ConversationDto): boolean {
  return c.handoffAt != null || c.aiEnabled === false;
}

/**
 * Filtrado de la bandeja, en capas y en este orden:
 *  1. búsqueda (solo NOMBRE y TELÉFONO) + etapa del embudo → `searched`
 *     (base de los contadores por canal);
 *  2. bandeja/canal elegido → `inInbox` (base de las pastillas);
 *  3. pastilla → `visible`.
 *
 * Solo nombre y teléfono, como cualquier filtro de contactos. Antes también
 * miraba el preview, y como el agente nombra al dueño en sus propios
 * mensajes, buscar ese nombre devolvía media bandeja.
 */
export function filterConversations(
  conversations: readonly ConversationDto[],
  opts: {
    query: string;
    stage: string;
    inbox: Channel | "all";
    filter: ConversationFilter;
  }
): {
  searched: ConversationDto[];
  inInbox: ConversationDto[];
  visible: ConversationDto[];
} {
  const { query, stage, inbox, filter } = opts;
  const searched = conversations.filter(
    (c) =>
      matchesQuery(query, {
        text: [c.contact.name],
        phone: c.contact.phone,
      }) && (stage === "all" || c.stageName === stage)
  );
  // La bandeja elegida es el filtro de AFUERA: las pastillas cuentan dentro
  // de ella, no sobre la suma de los canales.
  const inInbox =
    inbox === "all" ? searched : searched.filter((c) => c.channel === inbox);
  const visible =
    filter === "unread"
      ? inInbox.filter((c) => c.unreadCount > 0)
      : filter === "handoff"
        ? inInbox.filter(needsHuman)
        : inInbox;
  return { searched, inInbox, visible };
}

export function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString("es-MX", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleDateString("es-MX", { day: "numeric", month: "short" });
}

export function formatRemaining(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const MEDIA_LABELS: Record<string, string> = {
  image: "Imagen",
  audio: "Audio",
  video: "Video",
  document: "Documento",
  sticker: "Sticker",
  location: "Ubicación",
  contacts: "Contacto compartido",
  template: "Plantilla",
};

export function mediaLabel(type: string): string {
  return MEDIA_LABELS[type] ?? "Contenido";
}

/** 008 — Tamaño humano de un adjunto. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function previewText(preview: string | null): string {
  if (!preview) return "";
  return MEDIA_LABELS[preview] ? `📎 ${MEDIA_LABELS[preview]}` : preview;
}
