/**
 * 06 — Estado de la lista paginada de la Bandeja, en funciones PURAS (sin
 * React) para poder probarlas solas. El hook `use-inbox-list.ts` las usa.
 *
 * Reglas del "Contrato 06-0" (dev-tasks/06):
 * - el orden es `sortAt` desc y, a igualdad, `id` desc (mismo que el SQL);
 * - el cursor es OPACO: aquí solo se reenvía el `nextCursor` recibido;
 * - `?ids=`: id pedido y AUSENTE = ya no es visible (se retira); PRESENTE
 *   pero fuera del filtro activo = sale de la lista (el hilo abierto lo
 *   conserva quien llama); presente y dentro = upsert en su lugar.
 */

import type { Channel } from "@/lib/channels";
import type {
  ConversationCounts,
  ConversationDto,
  InboxFilter,
} from "@/lib/types";
import { filterConversations } from "./helpers";

/** Tamaño de página que pide la UI (el servidor acepta [1, 200]). */
export const PAGE_SIZE = 50;

/** Filtros activos de la Bandeja; todos viajan al servidor. */
export type InboxFilters = {
  filter: InboxFilter;
  /** Etapa por id (D-06-2), o null = toda etapa. */
  stageId: string | null;
  /**
   * Nombre de esa etapa: solo para el espejo cliente cuando la fila no trae
   * `stageId` (servidor anterior a 06). Nunca viaja en la URL.
   */
  stageName: string | null;
  channel: Channel | null;
  q: string;
};

export const DEFAULT_FILTERS: InboxFilters = {
  filter: "all",
  stageId: null,
  stageName: null,
  channel: null,
  q: "",
};

/** ¿Hay algún filtro puesto? (decide entre "Sin conversaciones" y "Sin resultados"). */
export function hasActiveFilters(f: InboxFilters): boolean {
  return f.filter !== "all" || f.stageId !== null || f.channel !== null || f.q.trim() !== "";
}

/**
 * Sin asignación a la vista (Propietario trabajando solo), una pastilla
 * "Mías"/"Sin asignar" ya elegida no debe seguir filtrando a escondidas.
 */
export function effectiveFilters(f: InboxFilters, teamMode: boolean): InboxFilters {
  if (teamMode || (f.filter !== "mine" && f.filter !== "unassigned")) return f;
  return { ...f, filter: "all" };
}

/** Parámetros compartidos por lista y contadores (sin `filter`). */
function baseParams(f: InboxFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.stageId) p.set("stage", f.stageId);
  if (f.channel) p.set("channel", f.channel);
  const q = f.q.trim();
  if (q) p.set("q", q);
  return p;
}

/**
 * Query string de `GET /api/conversations` (sin el `?`). Siempre con `limit`
 * (sin él, el servidor devuelve la lista completa, D-06-1). La UI NUNCA manda
 * `assigned` (es el único parámetro estricto: 422) ni `since` (RF-06-13): las
 * pastillas "Mías"/"Sin asignar" viajan como `filter`.
 */
export function buildListQuery(
  f: InboxFilters,
  opts: { limit?: number; cursor?: string | null } = {}
): string {
  const p = new URLSearchParams();
  p.set("limit", String(opts.limit ?? PAGE_SIZE));
  if (f.filter !== "all") p.set("filter", f.filter);
  for (const [k, v] of baseParams(f)) p.set(k, v);
  if (opts.cursor) p.set("cursor", opts.cursor);
  return p.toString();
}

/** Query string de `GET /api/conversations/counts`: los mismos filtros menos `filter`. */
export function buildCountsQuery(f: InboxFilters): string {
  return baseParams(f).toString();
}

/** Tope de ids por `?ids=` (contrato: los extra se descartan en el servidor). */
export const IDS_BATCH_MAX = 50;

/** Query string de `GET /api/conversations?ids=…` (dedup, en orden). */
export function buildIdsQuery(ids: readonly string[]): string {
  const unique = [...new Set(ids)].slice(0, IDS_BATCH_MAX);
  return new URLSearchParams({ ids: unique.join(",") }).toString();
}

function sortTime(c: ConversationDto): number {
  const t = Date.parse(c.sortAt ?? c.lastMessageAt ?? "");
  return Number.isFinite(t) ? t : 0;
}

/** Orden de la lista: `sortAt` desc, luego `id` desc (igual que el servidor). */
export function compareConversations(a: ConversationDto, b: ConversationDto): number {
  const dt = sortTime(b) - sortTime(a);
  if (dt !== 0) return dt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Une `incoming` sobre `items` deduplicando por id (gana la versión que
 * llega) y reordena. Sirve igual para la página siguiente que para un upsert.
 */
export function mergeConversations(
  items: readonly ConversationDto[],
  incoming: readonly ConversationDto[]
): ConversationDto[] {
  const byId = new Map<string, ConversationDto>();
  for (const c of items) byId.set(c.id, c);
  for (const c of incoming) byId.set(c.id, c);
  return [...byId.values()].sort(compareConversations);
}

export function removeConversations(
  items: readonly ConversationDto[],
  ids: Iterable<string>
): ConversationDto[] {
  const drop = new Set(ids);
  return items.filter((c) => !drop.has(c.id));
}

/** Espejo cliente del filtro del servidor, para una fila suelta. */
export function matchesFilters(
  c: ConversationDto,
  f: InboxFilters,
  viewerId: string | undefined
): boolean {
  return visibleConversations([c], f, viewerId).length === 1;
}

/**
 * Lo cargado pasado por el espejo COMPLETO del filtro (búsqueda incluida).
 * Lo usan el upsert por SSE (`matchesFilters`) y el pintado mientras llega
 * la primera página de unos filtros nuevos (ver `displayedConversations`).
 */
export function visibleConversations(
  items: readonly ConversationDto[],
  f: InboxFilters,
  viewerId: string | undefined
): ConversationDto[] {
  return filterConversations(items, {
    query: f.q,
    stage: f.stageName ?? "all",
    stageId: f.stageId ?? undefined,
    inbox: f.channel ?? "all",
    filter: f.filter,
    viewerId,
  }).visible;
}

/**
 * Lo que se pinta. `loadedKey` = `buildListQuery` de los filtros con que se
 * pidió la primera página que está en `items`:
 * - si coincide con los filtros activos, la búsqueda `q` ya la resolvió el
 *   servidor y NO se vuelve a aplicar (el servidor manda: el espejo nunca
 *   esconde una fila que el servidor devolvió). Lo que entró después por SSE
 *   ya pasó por el espejo en `applyResolvedIds`, y el enlace `?contact=` se
 *   inserta a propósito aunque no cumpla la búsqueda;
 * - si no coincide (filtros recién cambiados, la página nueva aún no llega),
 *   se aplica el espejo completo para no pintar filas que ya no aplican.
 */
export function displayedConversations(
  items: readonly ConversationDto[],
  loadedKey: string | null,
  f: InboxFilters,
  viewerId: string | undefined
): ConversationDto[] {
  const serverFiltered = loadedKey !== null && loadedKey === buildListQuery(f);
  return visibleConversations(items, serverFiltered ? { ...f, q: "" } : f, viewerId);
}

/**
 * Enlace `/inbox?contact=` (CA-06-05): la conversación abierta por el enlace
 * se pinta ARRIBA de la lista aunque por su `sortAt` le toque el fondo de lo
 * cargado. Si no, el scroll infinito la empuja hacia abajo con cada página
 * que entra y "seleccionada" deja de ser "a la vista". Solo mueve la fila si
 * está en la lista; el orden del resto no cambia.
 */
export function pinFirst(
  list: readonly ConversationDto[],
  pinnedId: string | null
): ConversationDto[] {
  const i = pinnedId ? list.findIndex((c) => c.id === pinnedId) : -1;
  if (i <= 0) return [...list];
  return [list[i]!, ...list.slice(0, i), ...list.slice(i + 1)];
}

export type ResolvedIds = {
  items: ConversationDto[];
  /** Pedidos que NO volvieron: ya no son visibles para quien mira. */
  gone: string[];
  /** Pedidos que volvieron (cumplan o no el filtro activo). */
  present: Map<string, ConversationDto>;
};

/**
 * Aplica la respuesta de `?ids=` a la lista. Solo cuentan los ids PEDIDOS:
 * cualquier otra fila de la respuesta se ignora (así un servidor que aún no
 * implementa `ids` y devuelve la lista completa no altera nada más).
 */
export function applyResolvedIds(
  items: readonly ConversationDto[],
  requested: readonly string[],
  returned: readonly ConversationDto[],
  f: InboxFilters,
  viewerId: string | undefined
): ResolvedIds {
  const asked = new Set(requested);
  const present = new Map<string, ConversationDto>();
  for (const c of returned) if (asked.has(c.id)) present.set(c.id, c);
  const gone = [...asked].filter((id) => !present.has(id));

  const keep: ConversationDto[] = [];
  const leave = new Set(gone);
  for (const c of present.values()) {
    if (matchesFilters(c, f, viewerId)) keep.push(c);
    else leave.add(c.id);
  }
  return {
    items: mergeConversations(removeConversations(items, leave), keep),
    gone,
    present,
  };
}

/**
 * Contadores de respaldo cuando `/counts` no responde (servidor anterior a
 * 06, o error): se calculan sobre lo cargado, con las mismas capas que el
 * contrato. `teamMode` aquí solo mira si hay alguna asignada; quien llama le
 * suma la regla de rol/equipo.
 */
export function countsFromLoaded(
  items: readonly ConversationDto[],
  f: InboxFilters,
  viewerId: string | undefined
): ConversationCounts {
  const { searched, inInbox } = filterConversations(items, {
    query: f.q,
    stage: f.stageName ?? "all",
    stageId: f.stageId ?? undefined,
    inbox: f.channel ?? "all",
    filter: "all",
    viewerId,
  });
  const byChannel = { whatsapp: 0, instagram: 0, messenger: 0 };
  for (const c of searched) byChannel[c.channel] += 1;
  const count = (filter: InboxFilter) =>
    filterConversations(inInbox, {
      query: "",
      stage: "all",
      inbox: "all",
      filter,
      viewerId,
    }).visible.length;
  return {
    all: inInbox.length,
    unread: count("unread"),
    human: count("human"),
    mine: count("mine"),
    unassigned: count("unassigned"),
    byChannel,
    unreadConversations: items.filter((c) => c.unreadCount > 0).length,
    unreadMessages: items.reduce((a, c) => a + c.unreadCount, 0),
    teamMode: items.some((c) => c.assignedTo !== null),
  };
}
