import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableColumns, is, Table } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";

/**
 * 06-A (contrato 06-0): `listConversations` y `countConversations` contra
 * una BD SIMULADA. drizzle corre sobre un cliente postgres-js falso que anota
 * cada sentencia (SQL + parámetros) y responde filas posicionales, así se
 * fija la forma de las consultas (keyset, JOIN de etapa, preview en lote,
 * visibilidad, capas de los contadores) sin Postgres. El plan real (`EXPLAIN`)
 * y el recorrido completo los ejercita `scripts/e2e-bandeja-paginacion.mjs`.
 */

type Call = { sql: string; params: unknown[] };
const calls: Call[] = [];
let responder: (call: Call) => unknown[][] = () => [];

const fakeClient = {
  options: { parsers: {}, serializers: {} },
  unsafe(query: string, params: unknown[]) {
    const call = { sql: query, params };
    calls.push(call);
    const rows = responder(call);
    const p = Promise.resolve(rows) as Promise<unknown[][]> & {
      values: () => Promise<unknown[][]>;
    };
    p.values = () => Promise.resolve(rows);
    return p;
  },
};

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  const db = drizzle(fakeClient as never, { schema: original.schema });
  return { ...original, getDb: () => db };
});

const { schema } = await import("@/lib/db");
const { countConversations, listConversations, toPage } = await import(
  "@/server/inbox/queries"
);
const { decodeCursor, encodeCursor, parseAssigned } = await import(
  "@/server/inbox/list-query"
);

const owner = { userId: "usr_owner", role: "owner" as const };
const seller = { userId: "usr_a", role: "member" as const };

/* ---------------- fixtures de filas (formato del driver) ---------------- */

const ts = (iso: string) => iso.replace("T", " ").replace("Z", "");

function conversationRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    organizationId: "org_1",
    contactId: `ct_${id}`,
    isTest: false,
    channel: "whatsapp",
    channelThreadRef: null,
    aiEnabled: true,
    handoffAt: null,
    handoffReason: null,
    handoffNote: null,
    lastInboundAt: null,
    lastMessageAt: ts("2026-10-01T10:00:00.000Z"),
    unreadCount: 0,
    assignedUserId: null,
    assignedAt: null,
    createdAt: ts("2026-09-01T10:00:00.000Z"),
    updatedAt: ts("2026-10-01T10:00:00.000Z"),
    ...over,
  };
}

function contactRow(id: string) {
  const cols = getTableColumns(schema.contact);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(cols)) out[k] = null;
  return { ...out, id, organizationId: "org_1", name: `Nombre ${id}`, waIdentity: id };
}

/** Fila posicional en el ORDEN del select (como la entrega postgres-js). */
function positional(selection: Record<string, unknown>, data: Record<string, unknown>) {
  const out: unknown[] = [];
  for (const [key, field] of Object.entries(selection)) {
    if (is(field, Table)) {
      const obj = (data[key] ?? {}) as Record<string, unknown>;
      for (const col of Object.keys(getTableColumns(field))) out.push(obj[col] ?? null);
    } else {
      out.push(data[key] ?? null);
    }
  }
  return out;
}

const LIST_SELECTION = {
  conversation: schema.conversation,
  contact: schema.contact,
  stageId: 1,
  stageName: 1,
  assigneeName: 1,
  // 020: anuncio de la conversación (LEFT JOIN de ad_attribution).
  adId: 1,
  adHeadline: 1,
  adSourceType: 1,
  sortKey: 1,
};

function listRow(id: string, sortKey: string, extra: Record<string, unknown> = {}) {
  return positional(LIST_SELECTION, {
    conversation: conversationRow(id),
    contact: contactRow(`ct_${id}`),
    sortKey,
    ...extra,
  });
}

const isPreview = (c: Call) => /select distinct on/i.test(c.sql);
const isList = (c: Call) => c.sql.includes('from "conversation"') && !isPreview(c);

beforeEach(() => {
  calls.length = 0;
  responder = () => [];
});

/* --------------------------------- lista -------------------------------- */

describe("listConversations — lista paginada (keyset)", () => {
  it("ORDER BY sort_at DESC, id DESC + to_char con µs + LIMIT limit+1", async () => {
    await listConversations("org_1", owner, { limit: 50, filter: "all" });
    const q = calls.find(isList)!;
    expect(q.sql).toContain(
      'order by coalesce("conversation"."last_message_at", "conversation"."created_at") DESC, "conversation"."id" DESC'
    );
    expect(q.sql).toContain("to_char(coalesce(");
    expect(q.sql).toMatch(/limit \$\d+$/);
    expect(q.params.at(-1)).toBe(51);
    expect(q.params.slice(0, 2)).toEqual(["org_1", false]);
  });

  it("etapa por LEFT JOIN de lead + pipeline_stage, sin subconsultas por fila", async () => {
    await listConversations("org_1", owner, { limit: 10 });
    const q = calls.find(isList)!;
    expect(q.sql).toContain('left join "lead" on "lead"."contact_id" = "contact"."id"');
    expect(q.sql).toContain('left join "pipeline_stage" on "pipeline_stage"."id" = "lead"."stage_id"');
    expect(q.sql).not.toMatch(/\(\s*select/i);
    // Página vacía → no hay lote de preview.
    expect(calls.some(isPreview)).toBe(false);
  });

  it("con cursor: (sort_at, id) < ($t::timestamp, $i) en el WHERE", async () => {
    const cursor = { t: "2026-10-01 10:00:00.123456", i: "cv_9" };
    await listConversations("org_1", owner, { limit: 20, cursor });
    const q = calls.find(isList)!;
    expect(q.sql).toMatch(
      /\(coalesce\("conversation"\."last_message_at", "conversation"\."created_at"\), "conversation"\."id"\) < \(\$\d+::timestamp, \$\d+\)/
    );
    expect(q.params).toContain(cursor.t);
    expect(q.params).toContain(cursor.i);
  });

  it("sin limit: lista completa, sin LIMIT, ignora el cursor, nextCursor null (D-06-1)", async () => {
    responder = (c) => (isList(c) ? [listRow("cv_1", "2026-10-01 10:00:00.000000")] : []);
    const page = await listConversations("org_1", owner, {
      cursor: { t: "2026-10-01 10:00:00.000000", i: "cv_x" },
    });
    const q = calls.find(isList)!;
    expect(q.sql).not.toMatch(/limit \$/);
    expect(q.sql).not.toContain("::timestamp");
    expect(page.nextCursor).toBeNull();
    expect(page.conversations).toHaveLength(1);
  });

  it("Vendedor: visibilidad en el WHERE (is_test=false ∧ suya o sin asignar)", async () => {
    await listConversations("org_1", seller, { limit: 10 });
    const q = calls.find(isList)!;
    expect(q.sql).toMatch(
      /\("conversation"\."assigned_user_id" = \$\d+ or "conversation"\."assigned_user_id" is null\)/
    );
    expect(q.params).toContain("usr_a");
  });

  it("filtros combinados: filter ∧ channel ∧ q ∧ stage ∧ assigned (se intersectan)", async () => {
    await listConversations("org_1", seller, {
      limit: 10,
      filter: "mine",
      channel: "whatsapp",
      q: "José 462",
      stageId: "stg_1",
      assigned: "unassigned",
    });
    const q = calls.find(isList)!;
    expect(q.sql).toContain('"conversation"."channel" = $');
    expect(q.sql).toContain('"lead"."stage_id" = $');
    expect(q.sql).toContain("lower(translate(");
    expect(q.sql).toContain("regexp_replace(");
    // assigned=unassigned ∧ filter=mine: ambos predicados presentes (AND).
    expect(q.sql).toMatch(/"conversation"\."assigned_user_id" is null and .*"conversation"\."assigned_user_id" = \$\d+/s);
    expect(q.params).toEqual(
      expect.arrayContaining(["org_1", "whatsapp", "stg_1", "%jose 462%", "%462%"])
    );
  });

  it("filter=unread y filter=human", async () => {
    await listConversations("org_1", owner, { limit: 10, filter: "unread" });
    expect(calls.find(isList)!.sql).toContain('"conversation"."unread_count" > $');
    calls.length = 0;
    await listConversations("org_1", owner, { limit: 10, filter: "human" });
    expect(calls.find(isList)!.sql).toContain(
      '("conversation"."handoff_at" is not null or "conversation"."ai_enabled" = $'
    );
  });

  it("022: capa de archivo — fuera salvo vista archived o búsqueda con texto", async () => {
    const listSql = async (opts: Parameters<typeof listConversations>[2]) => {
      calls.length = 0;
      await listConversations("org_1", owner, { limit: 10, ...opts });
      return calls.find(isList)!.sql;
    };
    // Vistas normales (y sin vista): excluyen archivadas.
    for (const filter of ["all", "unread", "human", "mine"] as const) {
      const s = await listSql({ filter });
      expect(s, filter).toContain('"conversation"."archived_at" is null');
      expect(s, filter).not.toContain('"archived_at" is not null');
    }
    expect(await listSql({})).toContain('"conversation"."archived_at" is null');
    // Vista Archivadas: solo ellas, sin la capa.
    const archived = await listSql({ filter: "archived" });
    expect(archived).toContain('"conversation"."archived_at" is not null');
    expect(archived).not.toContain('"archived_at" is null');
    // Con búsqueda: ambas (ni IS NULL ni IS NOT NULL).
    const searched = await listSql({ q: "ana" });
    expect(searched).toContain("like");
    expect(searched).not.toMatch(/"conversation"."archived_at" is/);
    // Búsqueda dentro de Archivadas: sigue siendo solo archivadas.
    expect(await listSql({ filter: "archived", q: "ana" })).toContain(
      '"archived_at" is not null'
    );
    // Una q en blanco no cuenta como búsqueda.
    expect(await listSql({ q: "   " })).toContain('"archived_at" is null');
    // `since` usa el mismo WHERE.
    expect(await listSql({ since: new Date("2026-10-01T00:00:00.000Z") })).toContain(
      '"archived_at" is null'
    );
  });

  it("022: modos sueltos (?ids=, ?contact=) no filtran por archivo", async () => {
    await listConversations("org_1", owner, { ids: ["cv_1"] });
    expect(calls.find(isList)!.sql).not.toMatch(/"conversation"."archived_at" is/);
    calls.length = 0;
    await listConversations("org_1", owner, { contactId: "ct_1" });
    expect(calls.find(isList)!.sql).not.toMatch(/"conversation"."archived_at" is/);
  });

  it("022: el DTO lleva archivedAt (ISO) y archivedReason", async () => {
    responder = (c) =>
      isList(c)
        ? [
            positional(LIST_SELECTION, {
              conversation: conversationRow("cv_a", {
                archivedAt: ts("2026-10-05T12:00:00.000Z"),
                archivedReason: "bulk",
              }),
              contact: contactRow("ct_cv_a"),
              sortKey: "2026-10-01 10:00:00.000000",
            }),
            listRow("cv_b", "2026-10-01 09:00:00.000000"),
          ]
        : [];
    const page = await listConversations("org_1", owner, { q: "nombre" });
    const [a, b] = page.conversations;
    expect(a?.archivedAt).toBe("2026-10-05T12:00:00.000Z");
    expect(a?.archivedReason).toBe("bulk");
    expect(b?.archivedAt).toBeNull();
    expect(b?.archivedReason).toBeNull();
  });

  it("nextCursor = la última fila DEVUELTA (sortKey con µs), no la extra", async () => {
    responder = (c) =>
      isList(c)
        ? [
            listRow("cv_3", "2026-10-01 10:00:00.000003"),
            listRow("cv_2", "2026-10-01 10:00:00.000002"),
            listRow("cv_1", "2026-10-01 10:00:00.000001"),
          ]
        : [];
    const page = await listConversations("org_1", owner, { limit: 2 });
    expect(page.conversations.map((c) => c.id)).toEqual(["cv_3", "cv_2"]);
    expect(decodeCursor(page.nextCursor)).toEqual({
      t: "2026-10-01 10:00:00.000002",
      i: "cv_2",
    });
  });
});

describe("listConversations — preview en lote y DTO", () => {
  it("UN DISTINCT ON por org sobre los ids de la página; stageId/stageName en el DTO", async () => {
    responder = (c) => {
      if (isPreview(c)) return [["cv_1", "último"]];
      if (isList(c))
        return [
          listRow("cv_1", "2026-10-01 10:00:00.000000", {
            stageId: "stg_1",
            stageName: "Nuevo",
          }),
          listRow("cv_2", "2026-09-01 10:00:00.000000"),
        ];
      return [];
    };
    const page = await listConversations("org_1", owner, { limit: 10 });
    const previews = calls.filter(isPreview);
    expect(previews).toHaveLength(1);
    const p = previews[0]!;
    expect(p.sql).toContain('select distinct on ("message"."conversation_id")');
    expect(p.sql).toContain('"message"."organization_id" = $1');
    expect(p.sql).toContain('"message"."conversation_id" in ($2, $3)');
    expect(p.sql).toContain(
      'order by "message"."conversation_id", "message"."created_at" desc, "message"."id" desc'
    );
    expect(p.params).toEqual(["org_1", "cv_1", "cv_2"]);

    const [a, b] = page.conversations;
    expect(a).toMatchObject({ id: "cv_1", preview: "último", stageId: "stg_1", stageName: "Nuevo" });
    expect(b).toMatchObject({ id: "cv_2", preview: null, stageId: null, stageName: null });
    expect(a!.sortAt).toBe("2026-10-01T10:00:00.000Z");
  });
});

describe("listConversations — modos sueltos", () => {
  it("?ids=: visibilidad + is_test=false, IGNORA filtros/assigned/limit/cursor", async () => {
    await listConversations("org_1", seller, {
      ids: ["cv_1", "cv_2"],
      filter: "unread",
      channel: "instagram",
      q: "ana",
      stageId: "stg_1",
      assigned: "me",
      limit: 5,
      cursor: { t: "2026-10-01 10:00:00.000000", i: "cv_9" },
    });
    const q = calls.find(isList)!;
    expect(q.sql).toContain('"conversation"."id" in ($');
    expect(q.sql).toMatch(/or "conversation"\."assigned_user_id" is null\)/);
    expect(q.sql).not.toContain('"channel" = $');
    expect(q.sql).not.toContain("like");
    expect(q.sql).not.toContain('"unread_count" >');
    expect(q.sql).not.toContain('"lead"."stage_id" = $');
    expect(q.sql).not.toContain("::timestamp");
    expect(q.sql).not.toMatch(/limit \$/);
    // org, is_test, (visibilidad: is_test, yo), ids — nada de assigned=me.
    expect(q.params).toEqual(["org_1", false, false, "usr_a", "cv_1", "cv_2"]);
  });

  it("?ids=: los ausentes (no visibles / is_test / inexistentes) simplemente no vienen", async () => {
    responder = (c) => (isList(c) ? [listRow("cv_2", "2026-10-01 10:00:00.000000")] : []);
    const page = await listConversations("org_1", seller, { ids: ["cv_1", "cv_2", "cv_3"] });
    expect(page.conversations.map((c) => c.id)).toEqual(["cv_2"]);
    expect(page.nextCursor).toBeNull();
  });

  it("?ids= se recorta a 50", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `cv_${i}`);
    await listConversations("org_1", owner, { ids });
    const q = calls.find(isList)!;
    expect(q.params.filter((p) => String(p).startsWith("cv_"))).toHaveLength(50);
  });

  it("?contact=: esa conversación real, LIMIT 1, sin filtros", async () => {
    await listConversations("org_1", owner, { contactId: "ct_7", filter: "unread" });
    const q = calls.find(isList)!;
    expect(q.sql).toContain('"conversation"."contact_id" = $');
    expect(q.sql).not.toContain('"unread_count" >');
    expect(q.params).toContain("ct_7");
    expect(q.params.at(-1)).toBe(1);
  });

  it("?since=: filtros + updated_at > since, tope 500, sin cursor", async () => {
    const since = new Date("2026-10-01T00:00:00.000Z");
    await listConversations("org_1", owner, {
      since,
      filter: "unread",
      limit: 10,
      cursor: { t: "2026-10-01 10:00:00.000000", i: "cv_9" },
    });
    const q = calls.find(isList)!;
    expect(q.sql).toContain('"conversation"."updated_at" > $');
    expect(q.sql).toContain('"conversation"."unread_count" > $');
    expect(q.sql).not.toContain("::timestamp");
    expect(q.params.at(-1)).toBe(500);
  });

  it("precedencia: ids > contact > since > lista", async () => {
    await listConversations("org_1", owner, {
      ids: ["cv_1"],
      contactId: "ct_1",
      since: new Date(),
    });
    const q = calls.find(isList)!;
    expect(q.sql).toContain('"conversation"."id" in (');
    expect(q.sql).not.toContain('"contact_id" = $');
    expect(q.sql).not.toContain('"updated_at" >');
  });
});

/* ------------------- propiedad: keyset sin duplicados ------------------- */

describe("toPage + keyset — sin duplicados ni huecos con empates de sort_at", () => {
  type Row = { sortKey: string; conversation: { id: string } };

  /** Lo que haría Postgres: orden (sort_at, id) DESC y `(t, i) < cursor`. */
  function serverPage(all: Row[], limit: number, cursor: string | null) {
    const cur = decodeCursor(cursor);
    const ordered = [...all].sort((a, b) =>
      a.sortKey === b.sortKey
        ? b.conversation.id.localeCompare(a.conversation.id)
        : b.sortKey.localeCompare(a.sortKey)
    );
    const after = cur
      ? ordered.filter(
          (r) =>
            r.sortKey < cur.t || (r.sortKey === cur.t && r.conversation.id < cur.i)
        )
      : ordered;
    return toPage(after.slice(0, limit + 1), limit);
  }

  it.each([1, 2, 3, 7, 50])("limit=%i recorre todo exactamente una vez", (limit) => {
    // 130 filas con MUCHOS empates de sort_at (13 instantes distintos).
    const all: Row[] = Array.from({ length: 130 }, (_, i) => ({
      sortKey: `2026-10-01 10:00:${String(i % 13).padStart(2, "0")}.000000`,
      conversation: { id: `cv_${String((i * 37) % 130).padStart(3, "0")}` },
    }));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = serverPage(all, limit, cursor);
      seen.push(...page.rows.map((r) => r.conversation.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 1000);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(130);
    expect(pages).toBe(Math.ceil(130 / limit));
  });

  it("sin fila extra → nextCursor null; con extra → cursor de la última devuelta", () => {
    const rows = [
      { sortKey: "2026-10-01 10:00:00.000002", conversation: { id: "b" } },
      { sortKey: "2026-10-01 10:00:00.000002", conversation: { id: "a" } },
    ];
    expect(toPage(rows, 2).nextCursor).toBeNull();
    const p = toPage(rows, 1);
    expect(p.rows).toHaveLength(1);
    expect(p.nextCursor).toBe(encodeCursor({ t: "2026-10-01 10:00:00.000002", i: "b" }));
  });
});

/* ------------------------------ contadores ------------------------------ */

describe("countConversations — capas del contrato 06-0", () => {
  const isCounts = (c: Call) => c.sql.includes("filter (where");
  const isMembers = (c: Call) => c.sql.includes('from "member"');

  /** Segmentos `count(*) filter (where …)` en el orden del select. */
  function segments(sqlText: string) {
    const [, ...rest] = sqlText.split("count(*) filter (where ");
    return rest.map((s) => s.slice(0, s.indexOf(")::int")));
  }
  const KEYS = [
    "all",
    "unread",
    "human",
    "mine",
    "archived",
    "unassigned",
    "closing",
    "whatsapp",
    "instagram",
    "messenger",
    "originAd",
    "originPost",
    "originNone",
    "unreadConversations",
  ] as const;

  it("WHERE solo org ∧ is_test ∧ visibilidad; base en cada FILTER; badge sin filtros", async () => {
    await countConversations("org_1", seller, {
      q: "ana",
      stageId: "stg_1",
      channel: "instagram",
      assigned: "me",
    });
    const q = calls.find(isCounts)!;
    const where = q.sql.slice(q.sql.lastIndexOf(" where "));
    expect(where).toContain('"conversation"."organization_id" = $');
    expect(where).toContain('"conversation"."is_test" = $');
    expect(where).not.toContain("like");
    expect(where).not.toContain('"stage_id"');

    const seg = Object.fromEntries(KEYS.map((k, i) => [k, segments(q.sql)[i]!]));
    // Pastillas = base ∧ channel ∧ predicado.
    for (const k of ["all", "unread", "human", "mine", "unassigned", "closing"] as const) {
      expect(seg[k]).toContain("like");
      expect(seg[k]).toContain('"lead"."stage_id" = $');
      expect(seg[k]).toContain('"conversation"."channel" = $');
    }
    expect(seg.unread).toContain('"unread_count" > $');
    expect(seg.human).toContain('"handoff_at" is not null');
    expect(seg.unassigned).toContain('"assigned_user_id" is null');
    // 05: «Ventana por cerrar» con cortes enlazados (calculados en Node).
    expect(seg.closing).toMatch(/"last_inbound_at" > \$\d+/);
    expect(seg.closing).toMatch(/"last_inbound_at" <= \$\d+/);
    expect(seg.closing).not.toContain("now()");
    // byChannel = base ∧ channel = x (un solo predicado de canal: el suyo).
    for (const k of ["whatsapp", "instagram", "messenger"] as const) {
      expect(seg[k]).toContain("like");
      expect(seg[k]?.match(/"channel" = \$/g)).toHaveLength(1);
    }
    // 022: con búsqueda, ninguna vista lleva la capa de archivo (entran ambas);
    // `archived` = base ∧ filtros ∧ IS NOT NULL.
    for (const k of ["all", "unread", "human", "mine", "unassigned", "closing"] as const) {
      expect(seg[k]).not.toContain('"archived_at" is null');
    }
    expect(seg.archived).toContain('"conversation"."archived_at" is not null');
    expect(seg.archived).toContain("like");
    expect(seg.archived).toContain('"conversation"."channel" = $');
    // Badge: solo visibilidad (sin q/stage/channel/assigned) ∧ no archivada.
    expect(seg.unreadConversations).toMatch(
      /^\("conversation"\."unread_count" > \$\d+ and "conversation"\."archived_at" is null\)$/
    );
    expect(q.sql).toContain(
      'coalesce(sum("conversation"."unread_count") filter (where "conversation"."archived_at" is null), 0)::int'
    );
    // El vendedor no cuenta miembros (teamMode siempre true).
    expect(calls.some(isMembers)).toBe(false);
  });

  it("020: facetado — vista y filtros del panel; cada faceta sin su propio filtro", async () => {
    await countConversations("org_1", owner, {
      filter: "unread",
      channel: "instagram",
      origin: "ad",
      closing: true,
    });
    const q = calls.find(isCounts)!;
    const seg = Object.fromEntries(KEYS.map((k, i) => [k, segments(q.sql)[i]!]));
    // El anuncio llega por LEFT JOIN (UNIQUE por conversación: no multiplica).
    expect(q.sql).toContain('left join "ad_attribution" on');
    // Vistas: con todos los filtros del panel, sin la vista pedida.
    expect(seg.all).toContain('"conversation"."channel" = $');
    expect(seg.all).toContain('"ad_attribution"."id" is not null');
    expect(seg.all).toMatch(/"last_inbound_at" > \$\d+/);
    expect(seg.all).not.toContain('"unread_count" > $');
    expect(seg.human).toContain('"handoff_at" is not null');
    expect(seg.human).not.toContain('"unread_count" > $');
    // Facetas: con la vista, sin su propio filtro.
    expect(seg.originAd).toContain('"unread_count" > $');
    expect(seg.originAd?.match(/"ad_attribution"\."id" is not null/g)).toHaveLength(1);
    expect(seg.originNone).toContain('"ad_attribution"."id" is null');
    expect(seg.originNone).not.toContain('"ad_attribution"."id" is not null');
    expect(seg.originPost).toContain('"ad_attribution"."id" is not null');
    expect(seg.originPost).toContain('"source_type" = $');
    expect(seg.whatsapp?.match(/"channel" = \$/g)).toHaveLength(1);
    expect(seg.whatsapp).toContain('"unread_count" > $');
    // Una publicación no cuenta como anuncio.
    expect(seg.originAd).toContain("is distinct from 'post'");
  });

  it("sin filtros → solo la capa de archivo y el canal pedido no toca byChannel", async () => {
    await countConversations("org_1", owner, {});
    const seg = segments(calls.find(isCounts)!.sql);
    // 022: sin q ni vista `archived`, todo número excluye las archivadas.
    expect(seg[0]).toBe('"conversation"."archived_at" is null');
    expect(seg[4]).toBe('"conversation"."archived_at" is not null');
    expect(seg[7]).toMatch(
      /^\("conversation"\."archived_at" is null and "conversation"\."channel" = \$\d+\)$/
    );
  });

  it("022: vista archived — las vistas llevan su propia capa; las facetas, la de archived", async () => {
    await countConversations("org_1", owner, { filter: "archived", origin: "ad" });
    const q = calls.find(isCounts)!;
    const seg = Object.fromEntries(KEYS.map((k, i) => [k, segments(q.sql)[i]!]));
    // Las otras vistas (lo que verías al elegirlas) siguen sin archivadas.
    for (const k of ["all", "unread", "human", "mine"] as const) {
      expect(seg[k]).toContain('"archived_at" is null');
      expect(seg[k]).not.toContain('"archived_at" is not null');
    }
    expect(seg.archived).toContain('"archived_at" is not null');
    expect(seg.archived).not.toContain('"archived_at" is null');
    // Facetas dentro de la vista activa (archived): IS NOT NULL, sin capa.
    for (const k of ["unassigned", "closing", "whatsapp", "originAd", "originNone"] as const) {
      expect(seg[k]).toContain('"archived_at" is not null');
      expect(seg[k]).not.toContain('"archived_at" is null');
    }
    // El badge excluye archivadas siempre.
    expect(seg.unreadConversations).toContain('"archived_at" is null');
    expect(q.sql).not.toContain("now()");
  });

  it("los números vuelven como Number aunque el driver mande texto", async () => {
    responder = (c) => {
      if (isCounts(c)) return [["9", "2", "3", "1", "8", "4", "2", "7", "1", "1", "3", "2", "6", "5", "12", false]];
      if (isMembers(c)) return [["1"]];
      return [];
    };
    const counts = await countConversations("org_1", owner, {});
    expect(counts).toEqual({
      all: 9,
      unread: 2,
      human: 3,
      mine: 1,
      archived: 8,
      unassigned: 4,
      closing: 2,
      byChannel: { whatsapp: 7, instagram: 1, messenger: 1 },
      origin: { ad: 3, post: 2, none: 6 },
      unreadConversations: 5,
      unreadMessages: 12,
      teamMode: false,
    });
  });

  it("teamMode: owner solo y sin asignadas → false; con 2 miembros o una asignada → true; vendedor → true", async () => {
    const run = async (viewer: typeof owner | typeof seller, members: string, any: boolean) => {
      responder = (c) => {
        if (isCounts(c)) return [["0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", any]];
        if (isMembers(c)) return [[members]];
        return [];
      };
      return (await countConversations("org_1", viewer, {})).teamMode;
    };
    expect(await run(owner, "1", false)).toBe(false);
    expect(await run(owner, "2", false)).toBe(true);
    expect(await run(owner, "1", true)).toBe(true);
    expect(await run(seller, "1", false)).toBe(true);
  });
});

describe("parseAssigned — estricto (422 en lista y counts)", () => {
  it("ausente → all; catálogo → tal cual; otro → null", () => {
    expect(parseAssigned(null)).toBe("all");
    expect(parseAssigned("me")).toBe("me");
    expect(parseAssigned("unassigned")).toBe("unassigned");
    expect(parseAssigned("all")).toBe("all");
    expect(parseAssigned("todas")).toBeNull();
    expect(parseAssigned("")).toBeNull();
  });
});
