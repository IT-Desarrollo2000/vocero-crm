import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS,
  applyResolvedIds,
  buildCountsQuery,
  buildIdsQuery,
  buildListQuery,
  compareConversations,
  countsFromLoaded,
  effectiveFilters,
  hasActiveFilters,
  matchesFilters,
  mergeConversations,
  removeConversations,
  visibleConversations,
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
    contact: { id: `ct_${seq}`, name: name ?? `Contacto ${seq}`, phone: phone ?? null },
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
    outboundMedia: true,
    templates: true,
    preview: null,
    assignedTo: null,
    assignedAt: null,
    sortAt: "2026-01-01T00:00:00.000Z",
    stageId: null,
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

  it("counts: mismos filtros menos filter/limit/cursor", () => {
    expect(
      params(buildCountsQuery(f({ filter: "unread", stageId: "stg_2", channel: "whatsapp", q: "ana" })))
    ).toEqual({ stage: "stg_2", channel: "whatsapp", q: "ana" });
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
    expect(effectiveFilters(f({ filter: "unassigned" }), true).filter).toBe("unassigned");
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
    expect(matchesFilters(mia, f({ filter: "unassigned" }), "u1")).toBe(false);
    expect(visibleConversations([mia], f({ channel: "whatsapp" }), "u1")).toHaveLength(0);
  });
});

describe("countsFromLoaded — respaldo si /counts no responde", () => {
  const items = [
    mk({ unreadCount: 3 }),
    mk({ unreadCount: 1, handoffAt: "2026-10-01T00:00:00Z", channel: "instagram" }),
    mk({ aiEnabled: false, assignedTo: { userId: "u1", name: "Yo" } }),
    mk({ name: "Zoe" }),
  ];

  it("cuenta pastillas, canales y badge por conversaciones", () => {
    const c = countsFromLoaded(items, f(), "u1");
    expect(c).toMatchObject({
      all: 4,
      unread: 2,
      human: 2,
      mine: 1,
      unassigned: 3,
      byChannel: { whatsapp: 3, instagram: 1, messenger: 0 },
      unreadConversations: 2,
      unreadMessages: 4,
      teamMode: true,
    });
  });

  it("byChannel ignora el canal elegido; las pastillas no", () => {
    const c = countsFromLoaded(items, f({ channel: "instagram", filter: "unread" }), "u1");
    expect(c.all).toBe(1);
    expect(c.unread).toBe(1);
    expect(c.byChannel).toEqual({ whatsapp: 3, instagram: 1, messenger: 0 });
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
