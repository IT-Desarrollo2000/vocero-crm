import {
  and,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { isOwner } from "@/lib/roles";
import { publish } from "@/server/events/bus";
import { isWindowOpen, windowRemainingMs } from "@/server/inbox/window";
import {
  capabilitiesFor,
  outboundFilesFor,
  replyModeFor,
  type InstagramSource,
} from "@/server/channels/capabilities";
import { getInstagramSourceByOrg } from "@/server/instagram/credentials";
import { conversationVisibleTo, type Viewer } from "@/server/inbox/visibility";
import { contactSearchSql } from "@/server/search";
import { closingBounds, closingWindowGroups } from "@/lib/closing-window";
import {
  IDS_MAX,
  encodeCursor,
  inboxOrderBy,
  keysetCondition,
  sortKeySql,
  type InboxQuery,
} from "@/server/inbox/list-query";
import type {
  AssignedFilter,
  ConversationCounts,
  ConversationDto,
  ConversationsPage,
  InboxFilter,
  InboxOrigin,
} from "@/lib/types";

/**
 * Opciones de `listConversations` (contrato 06-0, dev-tasks/06). Todo es
 * opcional: sin nada = lista completa visible (D-06-1). `since` = catch-up
 * legado (solo las actualizadas después de ese instante).
 */
export type ListConversationsOptions = Partial<InboxQuery> & {
  /**
   * 09 (RF-09-12): filtro de responsable, SIEMPRE dentro de lo visible.
   * `me` = asignadas a `viewer.userId`; `unassigned` = sin responsable;
   * `all` (default) = todo lo visible.
   */
  assigned?: AssignedFilter;
};

/** Responsable resuelto para el DTO (null = sin asignar). */
export type Assignee = { userId: string; name: string } | null;

function assignedCondition(
  viewer: Viewer,
  assigned: AssignedFilter | undefined
): SQL | undefined {
  if (assigned === "me") {
    return eq(schema.conversation.assignedUserId, viewer.userId);
  }
  if (assigned === "unassigned") return isNull(schema.conversation.assignedUserId);
  return undefined;
}

function assigneeOf(
  c: typeof schema.conversation.$inferSelect,
  name: string | null
): Assignee {
  return c.assignedUserId ? { userId: c.assignedUserId, name: name ?? "" } : null;
}

/** Tope de filas del catch-up legado `?since=` (RF-06-09). */
export const SINCE_MAX = 500;

/**
 * 05 — «Ventana por cerrar»: `now − ventana < last_inbound_at ≤ now − (ventana − 2 h)`
 * por grupo de canales con la misma ventana (`src/lib/closing-window.ts`).
 * Cortes calculados en Node (columnas `timestamp` sin zona, nunca `now()`).
 */
export function closingCondition(now: Date = new Date()): SQL {
  const c = schema.conversation;
  const parts = closingWindowGroups().map(({ windowMs, channels }) => {
    const { after, atOrBefore } = closingBounds(windowMs, now.getTime());
    return and(
      inArray(c.channel, channels),
      gt(c.lastInboundAt, after),
      lte(c.lastInboundAt, atOrBefore)
    );
  });
  return (parts.length > 0 ? or(...parts) : undefined) ?? sql`false`;
}

/**
 * Predicado de una pastilla (contrato 06-0). `mine`/`unassigned` son el mismo
 * predicado que `assigned=me|unassigned`; si llegan ambos, se intersectan.
 * `now` solo lo usa `closing` (05).
 */
export function inboxFilterCondition(
  viewer: Viewer,
  filter: InboxFilter | undefined,
  now: Date = new Date()
): SQL | undefined {
  const c = schema.conversation;
  switch (filter) {
    case "unread":
      return gt(c.unreadCount, 0);
    case "human":
      // Regla `needsHuman` de `src/components/inbox/helpers.ts`.
      return or(isNotNull(c.handoffAt), eq(c.aiEnabled, false));
    case "mine":
      return assignedCondition(viewer, "me");
    case "unassigned":
      return assignedCondition(viewer, "unassigned");
    case "closing":
      return closingCondition(now);
    default:
      return undefined;
  }
}

/**
 * 020 — Filtro Origen sobre el anuncio de ESTA conversación (LEFT JOIN de
 * `ad_attribution` por (org, conversación), UNIQUE: no multiplica filas).
 * `ad` = hay anuncio y no es una publicación (`source_type = 'post'`, que
 * no deduce la fuente "Anuncio" — `cuentaComoAnuncio`); `none` = el resto,
 * publicaciones incluidas. Exportado para el unit que fija su forma.
 */
export function originCondition(origin: InboxOrigin | undefined): SQL | undefined {
  const a = schema.adAttribution;
  if (origin === "ad") {
    return and(isNotNull(a.id), sql`${a.sourceType} is distinct from 'post'`);
  }
  if (origin === "none") return or(isNull(a.id), eq(a.sourceType, "post"));
  return undefined;
}

/** JOIN del anuncio de la conversación (lista, contadores y detalle). */
const adAttributionJoin = and(
  eq(schema.adAttribution.conversationId, schema.conversation.id),
  eq(schema.adAttribution.organizationId, schema.conversation.organizationId)
);

/** Filtros del panel que tienen contador propio (facetados, ver counts). */
type Facet = "channel" | "origin" | "unassigned" | "closing";

/**
 * 020 (rediseño 4.4) — Los filtros COMBINABLES del panel: canal, origen, sin
 * asignar y por cerrar (la etapa va en `baseFilters`). Se intersectan entre sí
 * y con la vista. `omit` quita uno para su propio contador facetado.
 */
function panelFilters(
  viewer: Viewer,
  opts: Pick<ListConversationsOptions, "channel" | "origin" | "unassigned" | "closing">,
  now: Date,
  omit?: Facet
): (SQL | undefined)[] {
  const c = schema.conversation;
  return [
    omit !== "channel" && opts.channel ? eq(c.channel, opts.channel) : undefined,
    omit !== "origin" ? originCondition(opts.origin) : undefined,
    omit !== "unassigned" && opts.unassigned
      ? assignedCondition(viewer, "unassigned")
      : undefined,
    omit !== "closing" && opts.closing ? closingCondition(now) : undefined,
  ];
}

/**
 * Filtros que no son de pastilla ni de canal: `q` (nombre/teléfono del
 * contacto), `stage` (por `lead.stage_id`, D-06-2; sin lead o id inexistente
 * → no entra) y `assigned`. Es la capa "base" de los contadores sin la
 * visibilidad (que siempre va en el WHERE).
 */
function baseFilters(
  viewer: Viewer,
  opts: Pick<ListConversationsOptions, "q" | "stageId" | "assigned">
): (SQL | undefined)[] {
  return [
    assignedCondition(viewer, opts.assigned),
    contactSearchSql(opts.q),
    opts.stageId ? eq(schema.lead.stageId, opts.stageId) : undefined,
  ];
}

/**
 * WHERE de la lista (modos lista y `since`): org ∧ `is_test = false` ∧
 * visibilidad (09) ∧ `assigned` ∧ `q` ∧ `stage` ∧ (020) filtros del panel
 * (`channel` ∧ `origin` ∧ `unassigned` ∧ `closing`) ∧ vista.
 * Exportado para el unit que fija su forma.
 */
export function inboxListWhere(
  organizationId: string,
  viewer: Viewer,
  opts: ListConversationsOptions,
  now: Date = new Date()
): SQL {
  const c = schema.conversation;
  return scoped(
    c.organizationId,
    organizationId,
    eq(c.isTest, false),
    conversationVisibleTo(viewer),
    ...baseFilters(viewer, opts),
    ...panelFilters(viewer, opts, now),
    inboxFilterCondition(viewer, opts.filter, now)
  );
}

/** Fila cruda de la lista (antes del preview y la serialización). */
type ListRow = {
  conversation: typeof schema.conversation.$inferSelect;
  contact: typeof schema.contact.$inferSelect;
  stageId: string | null;
  stageName: string | null;
  assigneeName: string | null;
  /** 020: anuncio de la conversación (LEFT JOIN); id null = no vino de uno. */
  adId: string | null;
  adHeadline: string | null;
  adSourceType: string | null;
  /** sort_at con µs (`sortKeySql`): la ÚNICA fuente del cursor. */
  sortKey: string;
};

/**
 * Página keyset a partir de `limit + 1` filas ya ordenadas: si sobra la
 * extra, el cursor sale de la ÚLTIMA fila DEVUELTA (no de la extra), con el
 * sort_at en µs que dio Postgres. Pura, para el unit de no-duplicados.
 */
export function toPage<T extends { sortKey: string; conversation: { id: string } }>(
  rows: T[],
  limit: number
): { rows: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { rows, nextCursor: null };
  const page = rows.slice(0, limit);
  const last = page[page.length - 1]!;
  return {
    rows: page,
    nextCursor: encodeCursor({ t: last.sortKey, i: last.conversation.id }),
  };
}

/**
 * Último mensaje de cada conversación de la página, en UN lote:
 * `DISTINCT ON (conversation_id)` por org (índice `message_org_conv_idx`),
 * desempate `created_at desc, id desc`. Reemplaza la subconsulta
 * correlacionada por fila.
 */
/** Ids por consulta de `previewsFor` (muy por debajo del tope de parámetros). */
export const PREVIEW_BATCH = 1000;

async function previewsFor(
  organizationId: string,
  conversationIds: string[]
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (conversationIds.length === 0) return out;
  const m = schema.message;
  // En lotes: la lista completa (sin `limit`, D-06-1) puede traer más ids de
  // los ~65k parámetros que admite una consulta de Postgres.
  for (let i = 0; i < conversationIds.length; i += PREVIEW_BATCH) {
    const batch = conversationIds.slice(i, i + PREVIEW_BATCH);
    const rows = await getDb()
      .selectDistinctOn([m.conversationId], {
        conversationId: m.conversationId,
        preview: sql<string | null>`coalesce(${m.text}, ${m.type})`,
      })
      .from(m)
      .where(scoped(m.organizationId, organizationId, inArray(m.conversationId, batch)))
      .orderBy(m.conversationId, desc(m.createdAt), desc(m.id));
    for (const r of rows) out.set(r.conversationId, r.preview);
  }
  return out;
}

/**
 * Lista de la Bandeja (sin `is_test`) para `viewer` (RF-09-02), según el
 * "Contrato 06-0" (dev-tasks/06). Modos, por precedencia:
 *
 *   `ids`     → esas conversaciones VISIBLES (máx. 50), ignorando cursor,
 *               limit, filtros y `assigned`: id ausente = ya no la ves.
 *   `contact` → la conversación real visible de ese contacto (0 o 1).
 *   `since`   → catch-up legado: filtros + `updated_at > since`, tope 500.
 *   lista     → filtros; con `limit`, keyset `(sort_at, id) < cursor` y
 *               `limit + 1` filas; sin `limit`, lista completa (D-06-1).
 *
 * Etapa por JOIN de `lead` (≤ 1 por contacto, `lead_contact_uq`) y preview en
 * un lote sobre la página: nada de subconsultas por fila.
 */
export async function listConversations(
  organizationId: string,
  viewer: Viewer,
  opts: ListConversationsOptions = {}
): Promise<ConversationsPage> {
  const c = schema.conversation;
  const db = getDb();
  const base = db
    .select({
      conversation: c,
      contact: schema.contact,
      stageId: schema.lead.stageId,
      stageName: schema.pipelineStage.name,
      assigneeName: schema.user.name,
      adId: schema.adAttribution.id,
      adHeadline: schema.adAttribution.headline,
      adSourceType: schema.adAttribution.sourceType,
      sortKey: sortKeySql,
    })
    .from(c)
    .innerJoin(schema.contact, eq(c.contactId, schema.contact.id))
    .leftJoin(schema.lead, eq(schema.lead.contactId, schema.contact.id))
    .leftJoin(schema.pipelineStage, eq(schema.pipelineStage.id, schema.lead.stageId))
    .leftJoin(schema.user, eq(schema.user.id, c.assignedUserId))
    .leftJoin(schema.adAttribution, adAttributionJoin);

  // Modos sueltos: solo visibilidad (+ is_test = false), nunca filtros.
  const loose = (extra: SQL) =>
    scoped(
      c.organizationId,
      organizationId,
      eq(c.isTest, false),
      conversationVisibleTo(viewer),
      extra
    );

  let rows: ListRow[];
  let nextCursor: string | null = null;
  if (opts.ids && opts.ids.length > 0) {
    rows = await base
      .where(loose(inArray(c.id, opts.ids.slice(0, IDS_MAX))))
      .orderBy(...inboxOrderBy);
  } else if (opts.contactId) {
    rows = await base
      .where(loose(eq(c.contactId, opts.contactId)))
      .orderBy(...inboxOrderBy)
      .limit(1);
  } else if (opts.since) {
    rows = await base
      .where(
        and(inboxListWhere(organizationId, viewer, opts), gt(c.updatedAt, opts.since))
      )
      .orderBy(...inboxOrderBy)
      .limit(SINCE_MAX);
  } else if (opts.limit !== undefined) {
    const fetched = await base
      .where(
        and(
          inboxListWhere(organizationId, viewer, opts),
          opts.cursor ? keysetCondition(opts.cursor) : undefined
        )
      )
      .orderBy(...inboxOrderBy)
      .limit(opts.limit + 1);
    ({ rows, nextCursor } = toPage(fetched, opts.limit));
  } else {
    // D-06-1: sin `limit` = lista completa (consumidores viejos y guiones).
    rows = await base
      .where(inboxListWhere(organizationId, viewer, opts))
      .orderBy(...inboxOrderBy);
  }

  const previews = await previewsFor(
    organizationId,
    rows.map((r) => r.conversation.id)
  );
  // 018: UNA consulta por petición (y solo si hay filas de Instagram) para
  // saber si esa conexión admite archivos; nunca una por fila.
  const igSource = rows.some((r) => r.conversation.channel === "instagram")
    ? await getInstagramSourceByOrg(organizationId)
    : null;
  const conversations = rows.map((r) =>
    serializeConversation(
      r.conversation,
      r.contact,
      previews.get(r.conversation.id) ?? null,
      r.stageName,
      assigneeOf(r.conversation, r.assigneeName),
      r.stageId,
      igSource,
      anuncioDeFila(r)
    )
  );
  return { conversations, nextCursor };
}

/** 020: lo que la fila pinta del anuncio de origen, o null. */
function anuncioDeFila(r: {
  adId: string | null;
  adHeadline: string | null;
  adSourceType: string | null;
}): ConversationDto["anuncio"] {
  return r.adId ? { headline: r.adHeadline, sourceType: r.adSourceType } : null;
}

/**
 * Contadores de la Bandeja (`ConversationCounts`). 020 — FACETADOS: cada
 * número es lo que verías al elegir esa opción dejando todo lo demás como
 * está (ver el tipo en `src/lib/types.ts`):
 *
 *   base          = org ∧ is_test = false ∧ visibilidad ∧ q ∧ stage ∧ assigned
 *   filtros       = channel ∧ origin ∧ unassigned ∧ closing (los del panel)
 *   vistas        = base ∧ filtros ∧ predicado de la vista (la pedida no cuenta)
 *   unassigned/closing = base ∧ vista ∧ filtros-sin-él ∧ su predicado
 *   origin.ad/none = base ∧ vista ∧ filtros-sin-origen ∧ ese origen
 *   byChannel[x]  = base ∧ vista ∧ filtros-sin-canal ∧ channel = x
 *   unreadConversations / unreadMessages = SOLO visibilidad (badge, D-05-1)
 *   teamMode      = !owner ∨ miembros > 1 ∨ alguna visible con responsable
 *
 * Sin vista ni filtros del panel, coincide con el contrato 06-0. Una sola
 * pasada: el WHERE lleva solo org ∧ is_test ∧ visibilidad y el resto de capas
 * va en `count(*) filter (where …)`. `limit`/`cursor` se ignoran. Postgres
 * devuelve count/sum como bigint/numeric (texto en postgres-js): todo se
 * castea a int y se mapea a Number.
 */
export async function countConversations(
  organizationId: string,
  viewer: Viewer,
  query: Pick<
    ListConversationsOptions,
    "q" | "stageId" | "channel" | "assigned" | "filter" | "origin" | "unassigned" | "closing"
  > = {}
): Promise<ConversationCounts> {
  const c = schema.conversation;
  const db = getDb();
  const always = sql`true`;
  const now = new Date();
  const base = and(...baseFilters(viewer, query));
  const view = inboxFilterCondition(viewer, query.filter, now);
  const panel = (omit?: Facet) => panelFilters(viewer, query, now, omit);
  const countWhere = (...conds: (SQL | undefined)[]) =>
    sql<number>`count(*) filter (where ${and(...conds) ?? always})::int`.mapWith(Number);

  const aggregates = db
    .select({
      all: countWhere(base, ...panel()),
      unread: countWhere(base, ...panel(), inboxFilterCondition(viewer, "unread")),
      human: countWhere(base, ...panel(), inboxFilterCondition(viewer, "human")),
      mine: countWhere(base, ...panel(), inboxFilterCondition(viewer, "mine")),
      unassigned: countWhere(
        base,
        view,
        ...panel("unassigned"),
        assignedCondition(viewer, "unassigned")
      ),
      closing: countWhere(base, view, ...panel("closing"), closingCondition(now)),
      whatsapp: countWhere(base, view, ...panel("channel"), eq(c.channel, "whatsapp")),
      instagram: countWhere(base, view, ...panel("channel"), eq(c.channel, "instagram")),
      messenger: countWhere(base, view, ...panel("channel"), eq(c.channel, "messenger")),
      originAd: countWhere(base, view, ...panel("origin"), originCondition("ad")),
      originNone: countWhere(base, view, ...panel("origin"), originCondition("none")),
      unreadConversations: countWhere(gt(c.unreadCount, 0)),
      unreadMessages: sql<number>`coalesce(sum(${c.unreadCount}), 0)::int`.mapWith(Number),
      anyAssigned: sql<boolean>`coalesce(bool_or(${c.assignedUserId} is not null), false)`,
    })
    .from(c)
    .innerJoin(schema.contact, eq(c.contactId, schema.contact.id))
    .leftJoin(schema.lead, eq(schema.lead.contactId, schema.contact.id))
    .leftJoin(schema.adAttribution, adAttributionJoin)
    .where(
      scoped(
        c.organizationId,
        organizationId,
        eq(c.isTest, false),
        conversationVisibleTo(viewer)
      )
    );
  // El Vendedor siempre está en modo equipo: no hace falta contar miembros.
  const members = isOwner(viewer)
    ? db
        .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
        .from(schema.member)
        .where(scoped(schema.member.organizationId, organizationId))
    : Promise.resolve([{ n: 0 }]);

  const [[agg], [memberRow]] = await Promise.all([aggregates, members]);
  const n = (v: number | undefined) => Number(v ?? 0);
  return {
    all: n(agg?.all),
    unread: n(agg?.unread),
    human: n(agg?.human),
    mine: n(agg?.mine),
    unassigned: n(agg?.unassigned),
    closing: n(agg?.closing),
    byChannel: {
      whatsapp: n(agg?.whatsapp),
      instagram: n(agg?.instagram),
      messenger: n(agg?.messenger),
    },
    origin: { ad: n(agg?.originAd), none: n(agg?.originNone) },
    unreadConversations: n(agg?.unreadConversations),
    unreadMessages: n(agg?.unreadMessages),
    teamMode:
      !isOwner(viewer) || n(memberRow?.n) > 1 || agg?.anyAssigned === true,
  };
}

/**
 * Conversación + contacto (+ responsable) por id.
 *
 * 09: `viewer` aplica la visibilidad en el WHERE (no visible → null → 404).
 * Obligatorio en rutas de sesión; los llamadores internos sin sesión (agente,
 * cerebro externo, mocks) lo omiten. 09-A lo cablea en messages/media/template
 * (y lo vigila `assignment-guard.test.ts`).
 */
/**
 * 018 — Fuente de Instagram para serializar UNA conversación: solo consulta
 * si la conversación es de Instagram.
 */
export async function instagramSourceFor(
  organizationId: string,
  channel: (typeof schema.conversation.$inferSelect)["channel"]
): Promise<InstagramSource | null> {
  return channel === "instagram" ? getInstagramSourceByOrg(organizationId) : null;
}

export async function getConversation(
  organizationId: string,
  conversationId: string,
  viewer?: Viewer
) {
  const db = getDb();
  const rows = await db
    .select({
      conversation: schema.conversation,
      contact: schema.contact,
      assigneeName: schema.user.name,
      adId: schema.adAttribution.id,
      adHeadline: schema.adAttribution.headline,
      adSourceType: schema.adAttribution.sourceType,
    })
    .from(schema.conversation)
    .innerJoin(
      schema.contact,
      eq(schema.conversation.contactId, schema.contact.id)
    )
    .leftJoin(
      schema.user,
      eq(schema.user.id, schema.conversation.assignedUserId)
    )
    .leftJoin(schema.adAttribution, adAttributionJoin)
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.id, conversationId),
        viewer ? conversationVisibleTo(viewer) : undefined
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    conversation: row.conversation,
    contact: row.contact,
    assignee: assigneeOf(row.conversation, row.assigneeName),
    /** 020: para `serializeConversation` (etiqueta de la fila). */
    anuncio: anuncioDeFila(row),
  };
}

export async function listMessages(
  organizationId: string,
  conversationId: string,
  since?: Date
) {
  const db = getDb();
  return db
    .select({ message: schema.message, media: schema.mediaAsset })
    .from(schema.message)
    .leftJoin(
      schema.mediaAsset,
      eq(schema.message.mediaAssetId, schema.mediaAsset.id)
    )
    .where(
      scoped(
        schema.message.organizationId,
        organizationId,
        eq(schema.message.conversationId, conversationId),
        since ? gt(schema.message.createdAt, since) : undefined
      )
    )
    .orderBy(schema.message.createdAt);
}

export function serializeConversation(
  c: typeof schema.conversation.$inferSelect,
  contact: typeof schema.contact.$inferSelect,
  preview: string | null = null,
  stageName: string | null = null,
  assignee: Assignee = null,
  /** 06: etapa del lead (JOIN con `lead`); null si no hay lead. */
  stageId: string | null = null,
  /** 018: fuente de Instagram de la org (Zernio → sin archivos). */
  instagramSource: InstagramSource | null = null,
  /** 020: anuncio de origen de la conversación (etiqueta de la fila). */
  anuncio: ConversationDto["anuncio"] = null
): ConversationDto {
  return {
    id: c.id,
    channel: c.channel,
    contact: { id: contact.id, name: contact.name, phone: contact.phone },
    stageName,
    aiEnabled: c.aiEnabled,
    handoffAt: c.handoffAt?.toISOString() ?? null,
    handoffReason: c.handoffReason,
    handoffNote: c.handoffNote,
    lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    unreadCount: c.unreadCount,
    windowOpen: isWindowOpen(c.lastInboundAt),
    windowRemainingMs: windowRemainingMs(c.lastInboundAt),
    replyMode: replyModeFor(c.channel, c.lastInboundAt),
    outboundFiles: outboundFilesFor(c.channel, instagramSource),
    outboundStructured: capabilitiesFor(c.channel).outboundStructured,
    templates: capabilitiesFor(c.channel).templates,
    preview,
    assignedTo: assignee,
    assignedAt: assignee ? (c.assignedAt?.toISOString() ?? null) : null,
    sortAt: (c.lastMessageAt ?? c.createdAt).toISOString(),
    stageId,
    anuncio,
  };
}

/**
 * PATCH de la Bandeja (IA, reactivar, leído).
 *
 * 09: con `viewer`, el predicado de visibilidad va DENTRO del WHERE del
 * UPDATE; 0 filas afectadas → null → la ruta responde 404 (no existe o no la
 * ves). Nada de leer y luego actualizar. Sin `viewer` (llamadores internos)
 * solo filtra por org + id, como antes.
 */
export async function updateConversation(
  organizationId: string,
  conversationId: string,
  patch: { aiEnabled?: boolean; reactivate?: boolean; markRead?: boolean },
  viewer?: Viewer
) {
  const db = getDb();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.aiEnabled !== undefined) set.aiEnabled = patch.aiEnabled;
  if (patch.reactivate) {
    set.handoffAt = null;
    set.handoffReason = null;
    set.handoffNote = null;
    set.aiEnabled = patch.aiEnabled ?? true;
  }
  if (patch.markRead) set.unreadCount = 0;

  const updated = await db
    .update(schema.conversation)
    .set(set)
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.id, conversationId),
        viewer ? conversationVisibleTo(viewer) : undefined
      )
    )
    .returning();
  return updated[0] ?? null;
}

/* ------------------------------------------------------------------ *
 * 09 — Asignación (RF-09-04..07). Toda escritura es un UPDATE
 * condicional con RETURNING: la precondición vive en el WHERE, nunca en
 * un "leer y luego actualizar".
 * ------------------------------------------------------------------ */

/**
 * Predicado de `claimForSend`: no es de prueba y está sin asignar o ya es de
 * `userId`. Exportado para el unit que fija su forma.
 */
export function claimCondition(
  organizationId: string,
  conversationId: string,
  userId: string
): SQL {
  const c = schema.conversation;
  return scoped(
    c.organizationId,
    organizationId,
    eq(c.id, conversationId),
    eq(c.isTest, false),
    or(isNull(c.assignedUserId), eq(c.assignedUserId, userId))
  );
}

/**
 * Compuerta de envío del Vendedor ("responder = tomar", RF-09-07): asigna la
 * conversación a `userId` si está sin asignar, o confirma que ya es suya, en
 * UNA sentencia atómica. `false` = otro la tomó (o no existe / es `is_test`):
 * la ruta responde 404 y NO llama al sender. Idempotente si ya era suya
 * (`assigned_at` se conserva).
 *
 * Solo para rutas de sesión con rol Vendedor: el Propietario no se
 * auto-asigna (D-09-3) y los caminos sin sesión (agente in-process, ingest,
 * `/api/bot/*`) no pasan por aquí.
 */
export async function claimForSend(
  organizationId: string,
  conversationId: string,
  userId: string
): Promise<boolean> {
  const c = schema.conversation;
  const rows = await getDb()
    .update(c)
    .set({
      assignedUserId: userId,
      assignedAt: sql`coalesce(${c.assignedAt}, now())`,
      updatedAt: new Date(),
    })
    .where(claimCondition(organizationId, conversationId, userId))
    .returning({ id: c.id });
  return rows.length > 0;
}

/**
 * Compuerta de envío de una ruta de sesión: Propietario → pasa sin tocar
 * nada (D-09-3); Vendedor → `claimForSend`. Si el Vendedor acaba de tomar una
 * conversación que estaba sin asignar (según la lectura previa de la ruta),
 * avisa por SSE para que los demás vendedores refresquen su lista: ellos ya no
 * recibirán el `message.new` de una conversación que dejaron de ver.
 */
export async function gateSend(
  session: Viewer & { organizationId: string },
  conversationId: string,
  previousAssigneeId: string | null
): Promise<boolean> {
  if (isOwner(session)) return true;
  const claimed = await claimForSend(
    session.organizationId,
    conversationId,
    session.userId
  );
  if (claimed && previousAssigneeId === null) {
    publish(session.organizationId, {
      type: "conversation.updated",
      data: { conversation: { id: conversationId } },
    });
  }
  return claimed;
}

export type AssignResult =
  /** `changed: false` = ya estaba así (idempotente: sin evento). */
  | { kind: "ok"; changed: boolean }
  | { kind: "not_found" }
  /** Otro la tiene (carrera de "tomar"); `assignee` = responsable actual. */
  | { kind: "conflict"; assignee: Assignee }
  | { kind: "invalid_assignee" };

/**
 * Asigna (`to` = user id), reasigna o libera (`to = null`) — RF-09-04..06.
 *
 * UN UPDATE condicional cuyo WHERE lleva: tenant + id, `is_test = false`
 * (nunca se asignan), la visibilidad del `viewer` si se pasa (Vendedor: suya o
 * sin asignar), `expect: "unassigned"` (sin asignar o ya de `to`), que `to`
 * sea miembro de la org (EXISTS sobre `member`) y que de verdad cambie algo.
 * 1 fila → `{ ok, changed: true }` (quien llama publica tras el commit).
 *
 * 0 filas → una lectura SOLO para clasificar el error (404/422/409) o el
 * no-op idempotente. Esa lectura nunca decide escribir: la escritura ya
 * ocurrió o no en el UPDATE — no es check-then-update.
 *
 * Las reglas por rol (el Vendedor solo se toma a sí mismo o libera) las aplica
 * la ruta antes de llamar; aquí `viewer` aporta su visibilidad.
 */
export async function assignConversation(
  organizationId: string,
  conversationId: string,
  opts: { to: string | null; expect?: "unassigned" },
  viewer?: Viewer
): Promise<AssignResult> {
  const { to, expect } = opts;
  const c = schema.conversation;
  const m = schema.member;
  const db = getDb();

  const updated = await db
    .update(c)
    .set({
      assignedUserId: to,
      assignedAt: to ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(
      scoped(
        c.organizationId,
        organizationId,
        eq(c.id, conversationId),
        eq(c.isTest, false),
        viewer ? conversationVisibleTo(viewer) : undefined,
        expect === "unassigned" && to
          ? or(isNull(c.assignedUserId), eq(c.assignedUserId, to))
          : undefined,
        to
          ? exists(
              db
                .select({ one: sql`1` })
                .from(m)
                .where(scoped(m.organizationId, organizationId, eq(m.userId, to)))
            )
          : undefined,
        // Solo si cambia: repetir la misma operación es un no-op sin evento.
        to
          ? or(isNull(c.assignedUserId), ne(c.assignedUserId, to))
          : isNotNull(c.assignedUserId)
      )
    )
    .returning({ id: c.id });
  if (updated.length > 0) return { kind: "ok", changed: true };

  // Clasificación del 0 filas (solo lectura; ver arriba).
  const rows = await db
    .select({
      isTest: c.isTest,
      assignedUserId: c.assignedUserId,
      assigneeName: schema.user.name,
    })
    .from(c)
    .leftJoin(schema.user, eq(schema.user.id, c.assignedUserId))
    .where(scoped(c.organizationId, organizationId, eq(c.id, conversationId)))
    .limit(1);
  const row = rows[0];
  if (!row || row.isTest) return { kind: "not_found" };

  if (to) {
    const member = await db
      .select({ id: m.id })
      .from(m)
      .where(scoped(m.organizationId, organizationId, eq(m.userId, to)))
      .limit(1);
    if (member.length === 0) return { kind: "invalid_assignee" };
  }

  const current = row.assignedUserId;
  const visible =
    !viewer || isOwner(viewer) || current === null || current === viewer.userId;
  if (current === to && visible) return { kind: "ok", changed: false };

  const assignee: Assignee = current
    ? { userId: current, name: row.assigneeName ?? "" }
    : null;
  // "Tomar" (con expect, o el Vendedor asignándose) que perdió la carrera.
  if (to && (expect === "unassigned" || (viewer && !isOwner(viewer)))) {
    return { kind: "conflict", assignee };
  }
  // Vendedor liberando una ajena: no la ve → 404 (no revela existencia).
  if (!visible) return { kind: "not_found" };
  // El estado cambió entre el UPDATE y la lectura (escritura concurrente).
  return { kind: "conflict", assignee };
}
