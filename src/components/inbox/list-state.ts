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

import { CHANNEL_ORDER, type Channel } from "@/lib/channels";
import type {
  AssignedFilter,
  ConversationCounts,
  ConversationDto,
  InboxFilter,
  InboxOrigin,
  InboxScope,
  InboxView,
} from "@/lib/types";
import { filterConversations, isMine } from "./helpers";

/** Tamaño de página que pide la UI (el servidor acepta [1, 200]). */
export const PAGE_SIZE = 50;

/**
 * Filtros activos de la Bandeja; todos viajan al servidor y viven en la URL
 * de la página (020: compartir/recargar conserva la vista y el panel).
 *
 * 020 (rediseño 4.4): `filter` es la VISTA (excluyente: Todas · No leídas ·
 * Por atender — 026: solo las que esperan respuesta — · Archivadas); canal,
 * etapa, origen y por cerrar son filtros COMBINABLES entre sí y con la vista.
 *
 * 027: `scope` es el ALCANCE (Buzón · Mis chats · Equipo), por ENCIMA de la
 * vista y de los filtros. En el estado es el ELEGIDO (pestaña activa, URL,
 * preferencia guardada); el que viaja al servidor sale de `effectiveFilters`
 * (null sin modo equipo o con búsqueda). No es un filtro del panel: no cuenta
 * en `panelFilterCount` ni en `hasActiveFilters`.
 */
export type InboxFilters = {
  /** 027: alcance; null = sin alcance (todo lo visible, como antes de 027). */
  scope: InboxScope | null;
  filter: InboxView;
  /** Etapa por id (D-06-2), o null = toda etapa. */
  stageId: string | null;
  /**
   * Nombre de esa etapa: solo para el espejo cliente cuando la fila no trae
   * `stageId` (servidor anterior a 06). Nunca viaja en la URL.
   */
  stageName: string | null;
  channel: Channel | null;
  q: string;
  /** 020: Origen — `ad` (de anuncio), `none` (sin anuncio) o null (todos). */
  origin: InboxOrigin | null;
  /** 020: solo las de ventana por cerrar (antes, pastilla). */
  closing: boolean;
};

export const DEFAULT_FILTERS: InboxFilters = {
  scope: null,
  filter: "all",
  stageId: null,
  stageName: null,
  channel: null,
  q: "",
  origin: null,
  closing: false,
};

/** Vistas de la URL: espejo de `INBOX_VIEWS` del servidor (un unit los compara). */
export const VIEWS: readonly InboxView[] = ["all", "unread", "human", "archived"];

/** 027: alcances válidos de `?scope=`. */
export const SCOPES: readonly InboxScope[] = ["mine", "inbox", "team"];

/** 027: alcance → `?assigned=` del servidor. */
export const SCOPE_ASSIGNED: Record<InboxScope, AssignedFilter> = {
  mine: "me",
  inbox: "unassigned",
  team: "others",
};

/**
 * 027 — Alcance con que abre la Bandeja la primera vez (sin `?scope=` ni
 * preferencia guardada). El Vendedor trabaja sus chats; el Propietario, el
 * Buzón (sus respuestas no le asignan chats, regla 09: su "Mis chats" suele
 * estar vacío).
 */
export function defaultScope(owner: boolean): InboxScope {
  return owner ? "inbox" : "mine";
}

/** 027: ¿en qué alcance cae esta conversación para quien mira? */
export function scopeOf(c: ConversationDto, viewerId: string | undefined): InboxScope {
  if (c.assignedTo === null) return "inbox";
  return isMine(c, viewerId) ? "mine" : "team";
}

/** 027: valor de `?scope=` (o de la preferencia guardada) → alcance, o null. */
export function parseScope(raw: string | null | undefined): InboxScope | null {
  return (SCOPES as readonly string[]).includes(raw ?? "") ? (raw as InboxScope) : null;
}

/**
 * 020 — Cuántos filtros del PANEL hay puestos (el número del botón
 * "Filtros"). La vista y la búsqueda no cuentan: tienen su propio control.
 */
export function panelFilterCount(f: InboxFilters): number {
  return (
    (f.channel ? 1 : 0) +
    (f.stageId ? 1 : 0) +
    (f.origin ? 1 : 0) +
    (f.closing ? 1 : 0)
  );
}

/**
 * ¿Hay algún filtro puesto? (decide entre "Sin conversaciones" y "Sin
 * resultados"). 027: el alcance no cuenta: tiene sus propios vacíos.
 */
export function hasActiveFilters(f: InboxFilters): boolean {
  return f.filter !== "all" || panelFilterCount(f) > 0 || f.q.trim() !== "";
}

/** 020: quita los filtros del panel (botón "Limpiar"); vista y búsqueda se quedan. */
export function clearPanelFilters(): Partial<InboxFilters> {
  return {
    stageId: null,
    stageName: null,
    channel: null,
    origin: null,
    closing: false,
  };
}

/**
 * 027 — El alcance que de veras filtra (lo que viaja como `assigned=`):
 * - sin modo equipo (Propietario trabajando solo) → ninguno: la Bandeja queda
 *   como antes de 027, sin filtrar a escondidas por lo elegido;
 * - con texto en la búsqueda → ninguno: se busca en TODOS los alcances, para
 *   que nadie crea perdido a un cliente que está en otro;
 * - Vendedor con `team` (enlace o preferencia de otro rol) → `mine`: no ve
 *   chats ajenos.
 */
export function effectiveFilters(
  f: InboxFilters,
  teamMode: boolean,
  owner = true
): InboxFilters {
  if (f.scope === null) return f;
  if (!teamMode || f.q.trim() !== "") return { ...f, scope: null };
  if (!owner && f.scope === "team") return { ...f, scope: "mine" };
  return f;
}

/** Parámetros compartidos por lista, contadores y URL de la página (sin `filter`). */
function baseParams(f: InboxFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.stageId) p.set("stage", f.stageId);
  if (f.channel) p.set("channel", f.channel);
  if (f.origin) p.set("origin", f.origin);
  if (f.closing) p.set("closing", "1");
  const q = f.q.trim();
  if (q) p.set("q", q);
  return p;
}

/**
 * Claves de la URL de la página que son de filtros (las demás, p. ej.
 * `contact`, se respetan). 027: `unassigned` ya no se escribe, pero sigue
 * aquí para que un `?unassigned=1` viejo se retire al reescribir la URL.
 */
export const FILTER_URL_KEYS = [
  "scope",
  "filter",
  "stage",
  "channel",
  "origin",
  "unassigned",
  "closing",
  "q",
] as const;

const FLAG_ON = new Set(["1", "true", "on", "si", "sí", "yes"]);

/**
 * 020 — Filtros desde la URL de la página (`/inbox?filter=unread&origin=ad…`),
 * con el mismo parseo tolerante que el servidor: valor desconocido = sin
 * filtro. Compatibles con los enlaces viejos: `filter=closing` era pastilla y
 * hoy es el filtro `closing`.
 *
 * 027 — Alcance: `?scope=` manda; si no viene, los enlaces viejos dicen el
 * equivalente (`filter=mine` → Mis chats; `filter=unassigned` o
 * `unassigned=1` → Buzón); si tampoco, `fallbackScope` (el default del rol;
 * la preferencia guardada la aplica quien llama, tras montar).
 */
export function filtersFromSearchParams(
  params: Pick<URLSearchParams, "get">,
  fallbackScope: InboxScope | null = null
): InboxFilters {
  const raw = params.get("filter") ?? "";
  const flag = (k: string) => FLAG_ON.has((params.get(k) ?? "").trim().toLowerCase());
  const channel = params.get("channel") ?? "";
  const origin = params.get("origin") ?? "";
  const stage = (params.get("stage") ?? "").trim();
  return {
    scope: scopeFromSearchParams(params) ?? fallbackScope,
    filter: (VIEWS as readonly string[]).includes(raw) ? (raw as InboxView) : "all",
    stageId: stage && stage.length <= 64 ? stage : null,
    stageName: null,
    channel: (CHANNEL_ORDER as readonly string[]).includes(channel)
      ? (channel as Channel)
      : null,
    q: (params.get("q") ?? "").slice(0, 200),
    origin: origin === "ad" || origin === "post" || origin === "none" ? origin : null,
    closing: raw === "closing" || flag("closing"),
  };
}

/**
 * 027 — El alcance que dice la URL (`?scope=` o un enlace viejo), o null si
 * no dice ninguno. Quien llama lo usa para saber si aplicar la preferencia
 * guardada (solo cuando la URL calla).
 */
export function scopeFromSearchParams(
  params: Pick<URLSearchParams, "get">
): InboxScope | null {
  const explicit = parseScope(params.get("scope"));
  if (explicit) return explicit;
  const raw = params.get("filter") ?? "";
  if (raw === "mine") return "mine";
  const unassigned = FLAG_ON.has((params.get("unassigned") ?? "").trim().toLowerCase());
  if (raw === "unassigned" || unassigned) return "inbox";
  return null;
}

/**
 * 020 — Query string de la página para estos filtros (con `?`, o "" si no hay
 * nada), conservando las claves ajenas a los filtros de `current` (el enlace
 * `?contact=`). 027: en modo equipo el alcance elegido va SIEMPRE (`scope=`),
 * aunque sea el default del rol; sin modo equipo, nunca.
 */
export function filtersToSearch(
  f: InboxFilters,
  current: URLSearchParams,
  opts: { teamMode?: boolean } = {}
): string {
  const p = new URLSearchParams();
  for (const [k, v] of current) {
    if (!(FILTER_URL_KEYS as readonly string[]).includes(k)) p.append(k, v);
  }
  if (opts.teamMode && f.scope) p.set("scope", f.scope);
  if (f.filter !== "all") p.set("filter", f.filter);
  for (const [k, v] of baseParams(f)) p.set(k, v);
  const out = p.toString();
  return out ? "?" + out : "";
}

/**
 * Query string de `GET /api/conversations` (sin el `?`). Siempre con `limit`
 * (sin él, el servidor devuelve la lista completa, D-06-1). Nunca `since`
 * (RF-06-13). 027: el alcance EFECTIVO viaja como `assigned=` (el único
 * parámetro estricto: un valor fuera del catálogo es 422; aquí sale siempre
 * de `SCOPE_ASSIGNED`).
 */
export function buildListQuery(
  f: InboxFilters,
  opts: { limit?: number; cursor?: string | null } = {}
): string {
  const p = new URLSearchParams();
  p.set("limit", String(opts.limit ?? PAGE_SIZE));
  if (f.scope) p.set("assigned", SCOPE_ASSIGNED[f.scope]);
  if (f.filter !== "all") p.set("filter", f.filter);
  for (const [k, v] of baseParams(f)) p.set(k, v);
  if (opts.cursor) p.set("cursor", opts.cursor);
  return p.toString();
}

/**
 * Query string de `GET /api/conversations/counts`: los mismos filtros que la
 * lista. 020: la vista también viaja — los contadores del panel (origen, canal,
 * por cerrar) se cuentan DENTRO de ella (facetados). 027: y el alcance, salvo
 * `counts.scopes`, que no depende de él.
 */
export function buildCountsQuery(f: InboxFilters): string {
  const p = new URLSearchParams();
  if (f.scope) p.set("assigned", SCOPE_ASSIGNED[f.scope]);
  if (f.filter !== "all") p.set("filter", f.filter);
  for (const [k, v] of baseParams(f)) p.set(k, v);
  return p.toString();
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

/**
 * 06/05 — Refresco SIN perder la posición (alt-tab, reconexión del SSE): la
 * página 1 recién pedida manda en SU tramo del orden (de su primera a su
 * última fila); lo cargado más abajo se conserva tal cual (y el cursor con
 * él), así el scroll infinito sigue desde donde iba. `complete` = la página
 * no trae `nextCursor`: es TODA la lista y la reemplaza.
 *
 * Una fila del tramo que no volvió ya no cumple el filtro (o se movió): sale.
 * Una de más abajo que cambió sin moverse se queda como estaba hasta que un
 * evento la resuelva con `?ids=` (`sortAt` solo crece: lo nuevo sube al tramo).
 */
export function mergeFirstPage(
  items: readonly ConversationDto[],
  page: readonly ConversationDto[],
  complete: boolean
): ConversationDto[] {
  const fresh = mergeConversations([], page);
  if (complete || fresh.length === 0) return fresh;
  const boundary = fresh[fresh.length - 1]!;
  const inPage = new Set(fresh.map((c) => c.id));
  const below = items.filter(
    (c) => !inPage.has(c.id) && compareConversations(boundary, c) < 0
  );
  return mergeConversations(below, fresh);
}

/** Espejo cliente del filtro del servidor, para una fila suelta. */
export function matchesFilters(
  c: ConversationDto,
  f: InboxFilters,
  viewerId: string | undefined,
  now: number = Date.now()
): boolean {
  return visibleConversations([c], f, viewerId, now).length === 1;
}

/**
 * Lo cargado pasado por el espejo COMPLETO del filtro (búsqueda incluida).
 * Lo usan el upsert por SSE (`matchesFilters`) y el pintado mientras llega
 * la primera página de unos filtros nuevos (ver `displayedConversations`).
 */
export function visibleConversations(
  items: readonly ConversationDto[],
  f: InboxFilters,
  viewerId: string | undefined,
  now: number = Date.now(),
  /** 022: ver `filterConversations`; por defecto, según `f.q`. */
  includeArchived?: boolean
): ConversationDto[] {
  return filterConversations(items, {
    query: f.q,
    stage: f.stageName ?? "all",
    stageId: f.stageId ?? undefined,
    inbox: f.channel ?? "all",
    filter: f.filter,
    scope: f.scope,
    origin: f.origin,
    closing: f.closing,
    viewerId,
    now,
    includeArchived,
  }).visible;
}

/** 022: ¿estos filtros traen archivadas fuera de su vista? (búsqueda con texto). */
export function searchIncludesArchived(f: InboxFilters): boolean {
  return f.q.trim() !== "";
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
  viewerId: string | undefined,
  now: number = Date.now()
): ConversationDto[] {
  const serverFiltered = loadedKey !== null && loadedKey === buildListQuery(f);
  // 022: la regla de archivo se decide con la búsqueda ORIGINAL: con `q: ""`
  // el espejo tiraría las archivadas que el servidor devolvió por la búsqueda.
  return visibleConversations(
    items,
    serverFiltered ? { ...f, q: "" } : f,
    viewerId,
    now,
    searchIncludesArchived(f)
  );
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
 * 06, o error): se calculan sobre lo cargado, con la misma regla facetada del
 * contrato (020): cada número = lo que verías al elegir esa opción dejando lo
 * demás fijo. `teamMode` aquí solo mira si hay alguna asignada; quien llama le
 * suma la regla de rol/equipo. 027: `scopes` = lo cargado no archivado por
 * alcance (lo cargado suele ser de UN alcance: es un respaldo, no la verdad).
 */
export function countsFromLoaded(
  items: readonly ConversationDto[],
  f: InboxFilters,
  viewerId: string | undefined,
  now: number = Date.now()
): ConversationCounts {
  const count = (
    over: Partial<Omit<InboxFilters, "filter">> & {
      filter?: InboxFilter;
      unassigned?: boolean;
    }
  ) =>
    filterConversations(items, {
      query: f.q,
      stage: f.stageName ?? "all",
      stageId: f.stageId ?? undefined,
      inbox: ("channel" in over ? over.channel : f.channel) ?? "all",
      filter: over.filter ?? f.filter,
      scope: f.scope,
      origin: "origin" in over ? over.origin : f.origin,
      unassigned: over.unassigned ?? false,
      closing: over.closing ?? f.closing,
      viewerId,
      now,
    }).visible.length;
  const live = items.filter((c) => c.archivedAt == null);
  const scopeCount = (s: InboxScope) => {
    const inScope = live.filter((c) => scopeOf(c, viewerId) === s);
    return { all: inScope.length, unread: inScope.filter((c) => c.unreadCount > 0).length };
  };
  return {
    all: count({ filter: "all" }),
    unread: count({ filter: "unread" }),
    human: count({ filter: "human" }),
    mine: count({ filter: "mine" }),
    archived: count({ filter: "archived" }),
    unassigned: count({ unassigned: true }),
    closing: count({ closing: true }),
    byChannel: {
      whatsapp: count({ channel: "whatsapp" }),
      instagram: count({ channel: "instagram" }),
      messenger: count({ channel: "messenger" }),
    },
    origin: {
      ad: count({ origin: "ad" }),
      post: count({ origin: "post" }),
      none: count({ origin: "none" }),
    },
    // 022: el badge no cuenta archivadas (espejo del servidor).
    unreadConversations: items.filter((c) => c.unreadCount > 0 && c.archivedAt == null)
      .length,
    unreadMessages: items.reduce(
      (a, c) => a + (c.archivedAt == null ? c.unreadCount : 0),
      0
    ),
    teamMode: items.some((c) => c.assignedTo !== null),
    scopes: { mine: scopeCount("mine"), inbox: scopeCount("inbox"), team: scopeCount("team") },
  };
}
