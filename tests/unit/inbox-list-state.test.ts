import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS,
  applyResolvedIds,
  buildCountsQuery,
  buildIdsQuery,
  buildListQuery,
  compareConversations,
  countsFromLoaded,
  displayedConversations,
  effectiveFilters,
  hasActiveFilters,
  matchesFilters,
  mergeConversations,
  pinFirst,
  removeConversations,
  visibleConversations,
  clearPanelFilters,
  filtersFromSearchParams,
  filtersToSearch,
  panelFilterCount,
  type InboxFilters,
} from "@/components/inbox/list-state";
import type { ConversationDto } from "@/lib/types";

let seq = 0;
function mk(
  overrides: Partial<ConversationDto> & { name?: string; phone?: string | null } = {}
): ConversationDto {
  const { name, phone, ...rest } = overrides;
  seq++;
  return {
    id: `cv_${String(seq).padStart(3, "0")}`,
    channel: "whatsapp",
    contact: { id: `ct_${seq}`, name: name ?? `Contacto ${seq}`, phone: phone ?? null, profileName: null },
    stageName: null,
    aiEnabled: true,
    handoffAt: null,
    handoffReason: null,
    handoffNote: null,
    lastInboundAt: null,
    lastMessageAt: null,
    unreadCount: 0,
    windowOpen: false,
    windowRemainingMs: 0,
    replyMode: "free",
    outboundFiles: null,
    outboundStructured: true,
    templates: true,
    preview: null,
    assignedTo: null,
    assignedAt: null,
    sortAt: "2026-01-01T00:00:00.000Z",
    stageId: null,
    anuncio: null,
    archivedAt: null,
    archivedReason: null,
    awaitingSince: null,
    ...rest,
  } satisfies ConversationDto;
}

const f = (patch: Partial<InboxFilters> = {}): InboxFilters => ({
  ...DEFAULT_FILTERS,
  ...patch,
});
const ids = (list: ConversationDto[]) => list.map((c) => c.id);
const params = (qs: string) => Object.fromEntries(new URLSearchParams(qs));

describe("query strings (contrato 06-0)", () => {
  it("la lista siempre lleva limit y solo los filtros puestos", () => {
    expect(params(buildListQuery(f()))).toEqual({ limit: "50" });
    expect(
      params(
        buildListQuery(
          f({ filter: "human", stageId: "stg_1", stageName: "Nuevo", channel: "instagram", q: "  José " }),
          { cursor: "abc" }
        )
      )
    ).toEqual({
      limit: "50",
      filter: "human",
      stage: "stg_1",
      channel: "instagram",
      q: "José",
      cursor: "abc",
    });
  });

  it("nunca manda assigned ni since; el nombre de etapa no viaja", () => {
    const qs = buildListQuery(f({ filter: "mine", stageName: "Nuevo" }));
    expect(qs).not.toMatch(/assigned=|since=|Nuevo/);
    expect(params(qs).filter).toBe("mine");
  });

  it("counts: mismos filtros que la lista (020: la vista también), sin limit/cursor", () => {
    expect(
      params(buildCountsQuery(f({ filter: "unread", stageId: "stg_2", channel: "whatsapp", q: "ana" })))
    ).toEqual({ filter: "unread", stage: "stg_2", channel: "whatsapp", q: "ana" });
    expect(
      params(buildCountsQuery(f({ origin: "ad", unassigned: true, closing: true })))
    ).toEqual({ origin: "ad", unassigned: "1", closing: "1" });
    expect(buildCountsQuery(f())).toBe("");
  });

  it("ids: dedup, máximo 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => `cv_${i}`);
    const got = params(buildIdsQuery(["a", "b", "a", ...many])).ids!.split(",");
    expect(got.slice(0, 2)).toEqual(["a", "b"]);
    expect(got).toHaveLength(50);
  });

  it("sin equipo, Mías/Sin asignar no filtran a escondidas", () => {
    expect(effectiveFilters(f({ filter: "mine" }), false).filter).toBe("all");
    expect(effectiveFilters(f({ unassigned: true }), true).unassigned).toBe(true);
    expect(effectiveFilters(f({ unassigned: true }), false).unassigned).toBe(false);
    expect(effectiveFilters(f({ filter: "unread" }), false).filter).toBe("unread");
  });

  it("hasActiveFilters", () => {
    expect(hasActiveFilters(f())).toBe(false);
    expect(hasActiveFilters(f({ q: "   " }))).toBe(false);
    expect(hasActiveFilters(f({ channel: "messenger" }))).toBe(true);
  });
});

describe("orden, upsert y dedup", () => {
  const a = mk({ sortAt: "2026-10-01T10:00:00.000Z" });
  const b = mk({ sortAt: "2026-10-01T09:00:00.000Z" });
  const c = mk({ sortAt: "2026-10-01T08:00:00.000Z" });

  it("ordena por sortAt desc y desempata por id desc", () => {
    const x = mk({ id: "cv_x", sortAt: "2026-10-01T09:00:00.000Z" });
    const y = mk({ id: "cv_y", sortAt: "2026-10-01T09:00:00.000Z" });
    expect(ids([b, x, c, y, a].sort(compareConversations))).toEqual([
      a.id,
      "cv_y",
      "cv_x",
      b.id,
      c.id,
    ]);
  });

  it("la página siguiente se une sin duplicar", () => {
    const merged = mergeConversations([a, b], [b, c]);
    expect(ids(merged)).toEqual([a.id, b.id, c.id]);
  });

  it("un upsert sube la fila al tope sin mover a las demás", () => {
    const fresh = { ...c, sortAt: "2026-10-02T00:00:00.000Z", unreadCount: 1 };
    const merged = mergeConversations([a, b, c], [fresh]);
    expect(ids(merged)).toEqual([c.id, a.id, b.id]);
    expect(merged[0]!.unreadCount).toBe(1);
  });

  it("retira por id", () => {
    expect(ids(removeConversations([a, b, c], [b.id]))).toEqual([a.id, c.id]);
  });
});

describe("applyResolvedIds — ausente vs presente fuera del filtro", () => {
  const leida = mk({ sortAt: "2026-10-01T10:00:00.000Z", unreadCount: 2 });
  const otra = mk({ sortAt: "2026-10-01T09:00:00.000Z", unreadCount: 1 });
  const items = [leida, otra];

  it("id pedido y ausente = ya no visible: se retira y se reporta", () => {
    const r = applyResolvedIds(items, [otra.id], [], f(), undefined);
    expect(ids(r.items)).toEqual([leida.id]);
    expect(r.gone).toEqual([otra.id]);
    expect(r.present.size).toBe(0);
  });

  it("presente pero fuera del filtro: sale de la lista, NO es gone", () => {
    const yaLeida = { ...leida, unreadCount: 0 };
    const r = applyResolvedIds(items, [leida.id], [yaLeida], f({ filter: "unread" }), undefined);
    expect(ids(r.items)).toEqual([otra.id]);
    expect(r.gone).toEqual([]);
    expect(r.present.get(leida.id)?.unreadCount).toBe(0);
  });

  it("presente y dentro: upsert y reordena", () => {
    const nueva = mk({ sortAt: "2026-10-03T00:00:00.000Z" });
    const r = applyResolvedIds(items, [nueva.id], [nueva], f(), undefined);
    expect(ids(r.items)).toEqual([nueva.id, leida.id, otra.id]);
  });

  it("filas NO pedidas de la respuesta se ignoran (servidor que devuelve todo)", () => {
    const extra = mk({ sortAt: "2026-10-05T00:00:00.000Z" });
    const r = applyResolvedIds(items, [otra.id], [extra, otra], f(), undefined);
    expect(ids(r.items)).toEqual([leida.id, otra.id]);
    expect(r.gone).toEqual([]);
    expect(r.present.has(extra.id)).toBe(false);
  });

  it("una ráfaga con varios ids se resuelve de una vez", () => {
    const r = applyResolvedIds(items, [leida.id, otra.id, "cv_test"], [leida, otra], f(), undefined);
    expect(r.gone).toEqual(["cv_test"]);
    expect(ids(r.items)).toEqual([leida.id, otra.id]);
  });
});

describe("espejo del filtro", () => {
  it("etapa por id; si la fila no trae stageId, por nombre", () => {
    const conId = mk({ stageId: "stg_1", stageName: "Nuevo" });
    const sinId = mk({ stageId: null, stageName: "Nuevo" });
    const otra = mk({ stageId: "stg_2", stageName: "Nuevo" });
    const filtro = f({ stageId: "stg_1", stageName: "Nuevo" });
    expect(matchesFilters(conId, filtro, undefined)).toBe(true);
    expect(matchesFilters(sinId, filtro, undefined)).toBe(true);
    expect(matchesFilters(otra, filtro, undefined)).toBe(false);
  });

  it("búsqueda tolerante a acentos y teléfono por dígitos", () => {
    const jose = mk({ name: "José Pérez", phone: "524621349768" });
    expect(matchesFilters(jose, f({ q: "jose" }), undefined)).toBe(true);
    expect(matchesFilters(jose, f({ q: "+52 462 134" }), undefined)).toBe(true);
    expect(matchesFilters(jose, f({ q: "zzz" }), undefined)).toBe(false);
  });

  it("canal y pastillas de asignación", () => {
    const mia = mk({ channel: "instagram", assignedTo: { userId: "u1", name: "Yo" } });
    expect(matchesFilters(mia, f({ channel: "instagram", filter: "mine" }), "u1")).toBe(true);
    expect(matchesFilters(mia, f({ unassigned: true }), "u1")).toBe(false);
    expect(visibleConversations([mia], f({ channel: "whatsapp" }), "u1")).toHaveLength(0);
  });
});

describe("displayedConversations — el servidor manda en la búsqueda", () => {
  // Una fila que el servidor devolvió para `q` aunque el espejo no la
  // reconociera (p. ej. un servidor con otra regla de plegado).
  const devuelta = mk({ name: "Zoe", unreadCount: 1 });
  const otra = mk({ name: "Ana", unreadCount: 0 });
  const activos = f({ q: "jose", filter: "unread" });

  it("página pedida con los MISMOS filtros: no se vuelve a filtrar por q", () => {
    const shown = displayedConversations([devuelta], buildListQuery(activos), activos, undefined);
    expect(ids(shown)).toEqual([devuelta.id]);
  });

  it("…pero las demás pastillas siguen aplicando (son reglas idénticas)", () => {
    const shown = displayedConversations([devuelta, otra], buildListQuery(activos), activos, undefined);
    expect(ids(shown)).toEqual([devuelta.id]);
  });

  it("filtros recién cambiados (la página nueva aún no llega): espejo completo", () => {
    const viejos = buildListQuery(f({ filter: "unread" }));
    expect(displayedConversations([devuelta], viejos, activos, undefined)).toEqual([]);
    expect(displayedConversations([devuelta], null, activos, undefined)).toEqual([]);
  });
});

describe("pinFirst — enlace ?contact= anclado arriba (CA-06-05)", () => {
  const a = mk();
  const b = mk();
  const vieja = mk();

  it("sube la anclada al tope sin cambiar el orden del resto", () => {
    expect(ids(pinFirst([a, b, vieja], vieja.id))).toEqual([vieja.id, a.id, b.id]);
  });

  it("sin ancla, ya arriba o ausente: la lista no cambia", () => {
    expect(ids(pinFirst([a, b], null))).toEqual([a.id, b.id]);
    expect(ids(pinFirst([a, b], a.id))).toEqual([a.id, b.id]);
    expect(ids(pinFirst([a, b], "cv_otra"))).toEqual([a.id, b.id]);
  });
});

describe("countsFromLoaded — respaldo si /counts no responde", () => {
  const items = [
    mk({ unreadCount: 3 }),
    mk({
      unreadCount: 1,
      handoffAt: "2026-10-01T00:00:00Z",
      awaitingSince: "2026-10-01T00:00:00Z",
      channel: "instagram",
    }),
    // 026: IA en pausa pero ya atendida (sin espera): no cuenta en "Por atender".
    mk({ aiEnabled: false, assignedTo: { userId: "u1", name: "Yo" } }),
    mk({ name: "Zoe" }),
  ];

  it("cuenta pastillas, canales y badge por conversaciones", () => {
    const c = countsFromLoaded(items, f(), "u1");
    expect(c).toMatchObject({
      all: 4,
      unread: 2,
      human: 1,
      mine: 1,
      unassigned: 3,
      byChannel: { whatsapp: 3, instagram: 1, messenger: 0 },
      unreadConversations: 2,
      unreadMessages: 4,
      teamMode: true,
    });
  });

  it("facetado (020): byChannel ignora el canal elegido pero respeta la vista", () => {
    const c = countsFromLoaded(items, f({ channel: "instagram", filter: "unread" }), "u1");
    expect(c.all).toBe(1);
    expect(c.unread).toBe(1);
    expect(c.byChannel).toEqual({ whatsapp: 1, instagram: 1, messenger: 0 });
  });

  it("facetado (020): origen cuenta dentro de la vista y los demás filtros", () => {
    const conAnuncio = [
      mk({ unreadCount: 1, anuncio: { headline: "Promo", sourceType: "ad" } }),
      mk({ unreadCount: 1, anuncio: { headline: "Post", sourceType: "post" } }),
      mk({ unreadCount: 0, anuncio: { headline: "Promo", sourceType: "ad" } }),
      mk({ unreadCount: 1 }),
    ];
    const c = countsFromLoaded(conAnuncio, f({ filter: "unread", origin: "ad" }), "u1");
    // Anuncio, publicación y sin origen son tres cubetas aparte.
    expect(c.origin).toEqual({ ad: 1, post: 1, none: 1 });
    // Las vistas cuentan con el origen puesto.
    expect(c.all).toBe(2);
    expect(c.unread).toBe(1);
  });

  it("la búsqueda acota pastillas y canales, no el badge", () => {
    const c = countsFromLoaded(items, f({ q: "zoe" }), "u1");
    expect(c.all).toBe(1);
    expect(c.byChannel.whatsapp).toBe(1);
    expect(c.unreadConversations).toBe(2);
  });

  it("sin asignadas, teamMode del respaldo es false", () => {
    expect(countsFromLoaded([mk()], f(), "u1").teamMode).toBe(false);
  });
});

/* 020 (rediseño 4.4): vistas + filtros combinables, con estado en la URL. */
describe("filtros combinables y URL de la página (020)", () => {
  const sp = (qs: string) => new URLSearchParams(qs);

  it("la URL se lee con el mismo parseo tolerante que el servidor", () => {
    expect(
      filtersFromSearchParams(sp("filter=unread&channel=instagram&stage=stg_1&origin=ad&unassigned=1&closing=true&q=ana"))
    ).toEqual({
      ...DEFAULT_FILTERS,
      filter: "unread",
      channel: "instagram",
      stageId: "stg_1",
      origin: "ad",
      unassigned: true,
      closing: true,
      q: "ana",
    });
    expect(filtersFromSearchParams(sp(""))).toEqual(DEFAULT_FILTERS);
    // Valores desconocidos = sin filtro.
    expect(filtersFromSearchParams(sp("filter=x&channel=fax&origin=tv&unassigned=no"))).toEqual(
      DEFAULT_FILTERS
    );
  });

  it("enlaces viejos: las pastillas Sin asignar / Ventana por cerrar son hoy filtros", () => {
    expect(filtersFromSearchParams(sp("filter=unassigned"))).toMatchObject({
      filter: "all",
      unassigned: true,
    });
    expect(filtersFromSearchParams(sp("filter=closing"))).toMatchObject({
      filter: "all",
      closing: true,
    });
  });

  it("ida y vuelta por la URL sin perder nada, conservando ?contact=", () => {
    const filtros = f({ filter: "mine", origin: "none", stageId: "stg_9", closing: true });
    const search = filtersToSearch(filtros, sp("contact=ct_1&origin=ad&filter=human"));
    const back = new URLSearchParams(search);
    expect(back.get("contact")).toBe("ct_1");
    expect(back.getAll("origin")).toEqual(["none"]);
    expect(filtersFromSearchParams(back)).toEqual({ ...filtros, stageName: null });
    expect(filtersToSearch(f(), sp(""))).toBe("");
    expect(filtersToSearch(f(), sp("contact=ct_2"))).toBe("?contact=ct_2");
  });

  it("los filtros combinables viajan a la lista y se cuentan en el botón", () => {
    const filtros = f({ filter: "unread", stageId: "stg_2", origin: "ad", unassigned: true });
    expect(params(buildListQuery(filtros))).toMatchObject({
      filter: "unread",
      stage: "stg_2",
      origin: "ad",
      unassigned: "1",
    });
    expect(panelFilterCount(filtros)).toBe(3); // la vista no cuenta
    expect(panelFilterCount(f({ q: "ana", filter: "human" }))).toBe(0);
    expect(hasActiveFilters(f({ origin: "none" }))).toBe(true);
    const limpio = { ...filtros, ...clearPanelFilters() };
    expect(panelFilterCount(limpio)).toBe(0);
    expect(limpio.filter).toBe("unread"); // "Limpiar" deja la vista
  });

  it("el espejo combina vista + origen + etapa como el servidor", () => {
    const deAnuncio = mk({ unreadCount: 2, anuncio: { headline: "Promo", sourceType: "ad" } });
    const post = mk({ unreadCount: 2, anuncio: { headline: "Post", sourceType: "post" } });
    const leida = mk({ anuncio: { headline: "Promo", sourceType: "ad" } });
    const items = [deAnuncio, post, leida];
    expect(ids(visibleConversations(items, f({ filter: "unread", origin: "ad" }), "u1"))).toEqual([
      deAnuncio.id,
    ]);
    expect(
      ids(visibleConversations(items, f({ filter: "unread", origin: "post" }), "u1"))
    ).toEqual([post.id]);
    expect(
      ids(visibleConversations(items, f({ filter: "unread", origin: "none" }), "u1"))
    ).toEqual([]);
  });
});

describe("022 — espejo de la regla de archivo", () => {
  const viva = mk({ name: "Ana Viva", unreadCount: 2 });
  const archivada = mk({
    name: "Ana Archivada",
    unreadCount: 3,
    archivedAt: "2026-10-05T12:00:00.000Z",
    archivedReason: "manual",
  });
  const items = [viva, archivada];

  it("vistas normales excluyen archivadas; la vista archived solo trae ellas", () => {
    for (const filter of ["all", "unread", "mine", "human"] as const) {
      expect(ids(visibleConversations(items, f({ filter }), undefined)), filter).not.toContain(
        archivada.id
      );
    }
    expect(ids(visibleConversations(items, f({ filter: "archived" }), undefined))).toEqual([
      archivada.id,
    ]);
    expect(matchesFilters(archivada, f(), undefined)).toBe(false);
    expect(matchesFilters(archivada, f({ filter: "archived" }), undefined)).toBe(true);
    expect(matchesFilters(viva, f({ filter: "archived" }), undefined)).toBe(false);
  });

  it("con búsqueda entran ambas (salvo en la vista archived)", () => {
    expect(ids(visibleConversations(items, f({ q: "ana" }), undefined)).sort()).toEqual(
      [viva.id, archivada.id].sort()
    );
    expect(ids(visibleConversations(items, f({ q: "ana", filter: "archived" }), undefined))).toEqual(
      [archivada.id]
    );
    // Una q en blanco no es búsqueda.
    expect(ids(visibleConversations(items, f({ q: "   " }), undefined))).toEqual([viva.id]);
  });

  it("displayedConversations: la búsqueda ya resuelta por el servidor NO tira las archivadas", () => {
    const activos = f({ q: "ana" });
    const shown = displayedConversations(items, buildListQuery(activos), activos, undefined);
    expect(ids(shown).sort()).toEqual([viva.id, archivada.id].sort());
    // Sin búsqueda, la misma página cargada no pinta archivadas.
    const sinQ = f();
    expect(ids(displayedConversations(items, buildListQuery(sinQ), sinQ, undefined))).toEqual([
      viva.id,
    ]);
  });

  it("countsFromLoaded: archived propio; el resto y el badge sin archivadas", () => {
    const counts = countsFromLoaded(items, f(), undefined);
    expect(counts.all).toBe(1);
    expect(counts.unread).toBe(1);
    expect(counts.archived).toBe(1);
    expect(counts.byChannel.whatsapp).toBe(1);
    expect(counts.unreadConversations).toBe(1);
    expect(counts.unreadMessages).toBe(2);
    // En la vista archived, las facetas cuentan dentro de ella.
    const enArchivadas = countsFromLoaded(items, f({ filter: "archived" }), undefined);
    expect(enArchivadas.byChannel.whatsapp).toBe(1);
    expect(enArchivadas.all).toBe(1);
    // Con búsqueda, `all` incluye ambas.
    expect(countsFromLoaded(items, f({ q: "ana" }), undefined).all).toBe(2);
  });

  it("la URL acepta ?filter=archived y lo reenvía al servidor", () => {
    const parsed = filtersFromSearchParams(new URLSearchParams("filter=archived"));
    expect(parsed.filter).toBe("archived");
    expect(params(buildListQuery(parsed))).toEqual({ limit: "50", filter: "archived" });
    expect(params(buildCountsQuery(parsed))).toEqual({ filter: "archived" });
  });
});
