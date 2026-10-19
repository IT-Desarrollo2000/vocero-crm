/** Utilidades de presentación de la bandeja. */

import type { Channel } from "@/lib/channels";
import { matchesQuery } from "@/lib/search";
import { isClosingSoon } from "@/lib/closing-window";
import { tipoDeOrigen } from "@/lib/anuncios";
import type { ConversationDto, InboxFilter, InboxOrigin } from "@/lib/types";

/**
 * Pastillas de la bandeja: todas, no leídas, pidiendo atención humana, (09)
 * por responsable: las mías o las que nadie ha tomado, y (05) «Ventana por
 * cerrar». 06: mismos nombres que
 * `GET /api/conversations?filter=` (`human` = atención humana).
 */
export type ConversationFilter = InboxFilter;

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
 *  2. bandeja/canal elegido + (020) filtros combinables del panel (origen,
 *     sin asignar, por cerrar) → `inInbox` (base de las vistas);
 *  3. vista → `visible`.
 *
 * 022: la capa 1 excluye además las archivadas, salvo vista `archived` o
 * búsqueda con texto (`includeArchived`).
 *
 * Solo nombre y teléfono, como cualquier filtro de contactos. Antes también
 * miraba el preview, y como el agente nombra al dueño en sus propios
 * mensajes, buscar ese nombre devolvía media bandeja.
 *
 * 06: el filtro de verdad lo hace el servidor; esto queda como su ESPEJO en
 * el cliente (mismas reglas: `matchesQuery` ≡ `contactSearchSql`,
 * `needsHuman` ≡ `human`) para decidir si una fila que llega por SSE entra en
 * la lista activa y para los contadores de respaldo.
 */
export function filterConversations(
  conversations: readonly ConversationDto[],
  opts: {
    query: string;
    /** Nombre de la etapa, o "all". Respaldo cuando la fila no trae `stageId`. */
    stage: string;
    /** 06: etapa por id (D-06-2); manda sobre el nombre si la fila lo trae. */
    stageId?: string;
    inbox: Channel | "all";
    filter: ConversationFilter;
    /**
     * 020: filtros combinables del panel. Origen ≡ `originCondition` del
     * servidor (`tipoDeOrigen` sobre el anuncio de la fila).
     */
    origin?: InboxOrigin | null;
    unassigned?: boolean;
    closing?: boolean;
    /** 09: user id de quien mira, para "Mías". Sin él, "Mías" queda vacía. */
    viewerId?: string;
    /** 05: reloj de «Ventana por cerrar» (ms); por defecto, ahora. */
    now?: number;
    /**
     * 022: ¿entran las archivadas fuera de la vista `archived`? Por defecto,
     * solo con búsqueda (`query` no vacía), igual que `archiveLayer` del
     * servidor. Explícito cuando la búsqueda ya la resolvió el servidor y aquí
     * llega `query: ""` (ver `displayedConversations`).
     */
    includeArchived?: boolean;
  }
): {
  searched: ConversationDto[];
  inInbox: ConversationDto[];
  visible: ConversationDto[];
} {
  const { query, stage, stageId, filter, viewerId, origin } = opts;
  const now = opts.now ?? Date.now();
  // 022: capa de archivo, aparte de la vista (espejo de `archiveLayer`).
  const includeArchived =
    filter === "archived" || (opts.includeArchived ?? query.trim() !== "");
  const archiveOk = (c: ConversationDto): boolean =>
    includeArchived || c.archivedAt == null;
  // Los filtros combinables se aplican en la capa del canal: las vistas
  // cuentan dentro de ellos.
  const panelOk = (c: ConversationDto): boolean =>
    (origin == null || origin === tipoDeOrigen(c.anuncio)) &&
    (!opts.unassigned || c.assignedTo === null) &&
    (!opts.closing || isClosingSoon(c.channel, c.lastInboundAt, now));
  const inbox = opts.inbox;
  const stageOk = (c: ConversationDto): boolean => {
    if (!stageId) return stage === "all" || c.stageName === stage;
    if (c.stageId != null) return c.stageId === stageId;
    // Servidor anterior a 06 (DTO sin `stageId`): se compara por nombre.
    return stage !== "all" && c.stageName === stage;
  };
  const searched = conversations.filter(
    (c) =>
      matchesQuery(query, {
        // 022: también por el nombre de perfil (espejo de contactSearchSql).
        text: [c.contact.name, c.contact.profileName],
        phone: c.contact.phone,
      }) &&
      stageOk(c) &&
      archiveOk(c)
  );
  // La bandeja elegida es el filtro de AFUERA: las pastillas cuentan dentro
  // de ella, no sobre la suma de los canales.
  const inInbox = searched.filter(
    (c) => (inbox === "all" || c.channel === inbox) && panelOk(c)
  );
  const visible =
    filter === "unread"
      ? inInbox.filter((c) => c.unreadCount > 0)
      : filter === "human"
        ? inInbox.filter(needsHuman)
        : filter === "mine"
          ? inInbox.filter((c) => isMine(c, viewerId))
          : filter === "unassigned"
            ? inInbox.filter((c) => c.assignedTo === null)
            : filter === "closing"
              ? inInbox.filter((c) => isClosingSoon(c.channel, c.lastInboundAt, now))
              : filter === "archived"
                ? inInbox.filter((c) => c.archivedAt != null)
                : inInbox;
  return { searched, inInbox, visible };
}

/** 09: ¿la conversación es de quien mira? */
export function isMine(c: ConversationDto, viewerId: string | undefined): boolean {
  return viewerId != null && c.assignedTo?.userId === viewerId;
}

/**
 * 09: cómo se nombra al responsable en la fila y en el panel. El Vendedor
 * solo ve las suyas y las sin asignar ("Tuya" / "Sin asignar"); el
 * Propietario ve además el nombre de quien atiende las ajenas.
 */
export function assigneeLabel(
  c: ConversationDto,
  viewerId: string | undefined
): { kind: "none" | "mine" | "other"; label: string } {
  if (!c.assignedTo) return { kind: "none", label: "Sin asignar" };
  if (isMine(c, viewerId)) return { kind: "mine", label: "Tuya" };
  return { kind: "other", label: c.assignedTo.name || "Otro miembro" };
}

/** 09: iniciales para el distintivo del responsable ("Ana López" → "AL"). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
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
  lead_intake: "Lead externo",
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
