import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionContext } from "@/lib/auth/session";

/**
 * 028 — `GET /api/bookings?from=&to=` hasta la BD (falsa). Adaptado de la
 * prueba de upstream (215) a NUESTRO listado (visibilidad, tipo, vendedor,
 * recordatorios): corte a la medianoche del NEGOCIO, 24 h hacia atrás con
 * post-filtro por fin, orden ascendente, `truncated`, 422 `invalid_range`,
 * `hours` con solo cinco campos, `overlaps` calculados sobre toda la org pero
 * entregados solo para lo visible, y SIN rango la respuesta de siempre.
 */

const state = vi.hoisted(() => ({
  session: null as SessionContext | null,
  calls: [] as { method: string; args: unknown[] }[],
  rows: [] as unknown[],
  busy: [] as unknown[],
  busyCalls: [] as unknown[][],
}));

const OWNER: SessionContext = { userId: "u_owner", organizationId: "org_a", role: "owner" };
const SELLER: SessionContext = { userId: "u_ana", organizationId: "org_a", role: "member" };

const SETTINGS = {
  weeklyHours: { mon: [{ start: "09:00", end: "18:00" }] },
  slotMinutes: 30,
  bufferMinutes: 15,
  minNoticeHours: 2,
  maxDaysAhead: 14,
  timezone: "America/Mexico_City",
  connector: "enlace-fijo" as const,
  meetingLink: "https://meet.ejemplo.com/sala",
  address: "Calle Secreta 123",
};

vi.mock("@/lib/auth/session", () => {
  class UnauthorizedError extends Error {}
  return {
    UnauthorizedError,
    requireSession: async () => {
      if (!state.session) throw new UnauthorizedError();
      return state.session;
    },
  };
});

vi.mock("@/server/agenda/settings", async (orig) => {
  const real = await orig<typeof import("@/server/agenda/settings")>();
  return { ...real, getSettings: async () => SETTINGS };
});

vi.mock("@/server/agenda/reminders", () => ({
  remindersForBookings: async () => new Map(),
}));

vi.mock("@/server/agenda/types-store", async (orig) => {
  const real = await orig<typeof import("@/server/agenda/types-store")>();
  return { ...real, listTypes: async () => [] };
});

vi.mock("@/server/team/members", () => ({
  listMembers: async () => [{ userId: "u_ana", name: "Ana" }],
}));

vi.mock("@/server/agenda/availability", () => ({
  getBusyIntervals: async (...args: unknown[]) => {
    state.busyCalls.push(args);
    return state.busy;
  },
}));

// El tenant y los cortes, legibles en la prueba.
vi.mock("@/lib/db/tenant", () => ({
  scoped: (_col: unknown, organizationId: string, ...conditions: unknown[]) => ({
    organizationId,
    conditions,
  }),
}));
vi.mock("drizzle-orm", async (orig) => {
  const real = await orig<typeof import("drizzle-orm")>();
  return {
    ...real,
    gte: (_c: unknown, value: unknown) => ({ op: "gte", value }),
    lt: (_c: unknown, value: unknown) => ({ op: "lt", value }),
    eq: (_c: unknown, value: unknown) => ({ op: "eq", value }),
    isNull: () => ({ op: "isNull" }),
    or: (...conds: unknown[]) => ({ op: "or", conds }),
    asc: () => "asc",
    desc: () => "desc",
  };
});

vi.mock("@/lib/db", async (orig) => {
  const real = await orig<typeof import("@/lib/db")>();
  const builder = () => {
    const b: Record<string, (...args: unknown[]) => unknown> = {};
    for (const m of ["select", "from", "leftJoin", "where", "orderBy"]) {
      b[m] = (...args: unknown[]) => {
        state.calls.push({ method: m, args });
        return b;
      };
    }
    b.limit = (n: unknown) => {
      state.calls.push({ method: "limit", args: [n] });
      return Promise.resolve(state.rows.slice(0, Number(n)));
    };
    return b;
  };
  return { ...real, getDb: () => builder() };
});

process.env.AGENDA = "on";
const { GET } = await import("@/app/api/bookings/route");
const { RANGE_LIMIT, LIST_LIMIT } = await import("@/server/agenda/queries");

function row(
  id: string,
  startIso: string,
  over: { durationMinutes?: number; sellerId?: string | null; kind?: "session" | "block" } = {}
) {
  return {
    booking: {
      id,
      organizationId: "org_a",
      kind: over.kind ?? "session",
      status: "agendada",
      source: "manual",
      scheduledAt: new Date(startIso),
      durationMinutes: over.durationMinutes ?? 30,
      contactId: "ct_1",
      conversationId: null,
      connector: null,
      meetingLink: null,
      linkPending: false,
      isTest: false,
      notes: null,
      createdByUserId: null,
      exclusive: false,
    },
    contactId: "ct_1",
    contactName: "María",
    typeId: "apt_s",
    typeName: "Servicio",
    sellerId: over.sellerId ?? null,
    sellerName: over.sellerId ? "Ana" : null,
  };
}

function busy(id: string, startIso: string, over: Record<string, unknown> = {}) {
  const start = Date.parse(startIso);
  return {
    id,
    kind: "session",
    startUtc: new Date(start).toISOString(),
    endUtc: new Date(start + 30 * 60_000).toISOString(),
    typeId: "apt_s",
    exclusive: false,
    assignedUserId: null,
    typeName: "Servicio",
    sellerName: null,
    ...over,
  };
}

const call = (m: string) => state.calls.find((c) => c.method === m);
const whereConds = () =>
  (call("where")?.args[0] as { conditions: unknown[] }).conditions;

async function get(query = "") {
  const res = await GET(new Request(`http://localhost/api/bookings${query}`));
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

beforeEach(() => {
  state.session = OWNER;
  state.calls = [];
  state.rows = [];
  state.busy = [];
  state.busyCalls = [];
});

// Semana lun 19 – dom 25 oct 2026. México no cambia de horario desde 2022:
// la medianoche del negocio es 06:00 UTC.
const WEEK = "?from=2026-10-19&to=2026-10-25";
const START = Date.parse("2026-10-19T06:00:00.000Z");
const END = Date.parse("2026-10-26T06:00:00.000Z");

describe("sin rango: la respuesta de siempre", () => {
  it("Propietario: exactamente bookings, businessTimezone, types y sellers", async () => {
    state.rows = [row("bk_1", "2026-10-20T16:00:00.000Z")];
    const { status, body } = await get("?sellerId=none&typeId=apt_s");
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["bookings", "businessTimezone", "sellers", "types"]);
    expect(call("limit")?.args[0]).toBe(LIST_LIMIT);
    expect(call("orderBy")?.args[0]).toBe("desc");
    expect(state.busyCalls).toHaveLength(0);
    // Sin cortes de fecha: solo visibilidad (owner ⇒ undefined), vendedor y tipo.
    expect(whereConds()).toEqual([undefined, { op: "isNull" }, { op: "eq", value: "apt_s" }]);
  });

  it("Vendedor: sin sellers, y con su visibilidad", async () => {
    state.session = SELLER;
    const { body } = await get();
    expect(Object.keys(body).sort()).toEqual(["bookings", "businessTimezone", "types"]);
    expect((whereConds()[0] as { op: string }).op).toBe("or");
  });
});

describe("con rango: el calendario", () => {
  it("corta a la medianoche del negocio, mira 24 h atrás y ordena ascendente", async () => {
    const { status, body } = await get(WEEK);
    expect(status).toBe(200);
    const conds = whereConds();
    const gte = conds.find((c) => (c as { op?: string })?.op === "gte") as { value: Date };
    const lt = conds.find((c) => (c as { op?: string })?.op === "lt") as { value: Date };
    expect(gte.value.getTime()).toBe(START - 24 * 3_600_000);
    expect(lt.value.getTime()).toBe(END);
    expect(call("orderBy")?.args[0]).toBe("asc");
    expect(call("limit")?.args[0]).toBe(RANGE_LIMIT);
    expect(body.range).toEqual({ from: "2026-10-19", to: "2026-10-25" });
    expect(body.truncated).toBe(false);
  });

  it("de lo que empezó la víspera, solo queda lo que sigue ocupando el rango", async () => {
    state.rows = [
      // dom 18 22:00–23:00 MX: termina antes de la medianoche ⇒ fuera.
      row("bk_antes", "2026-10-19T04:00:00.000Z", { durationMinutes: 60 }),
      // dom 18 23:30 – lun 19 00:30 MX: cruza ⇒ dentro.
      row("bk_cruza", "2026-10-19T05:30:00.000Z", { durationMinutes: 60, kind: "block" }),
      // Termina JUSTO a la medianoche ⇒ fuera (intervalo semiabierto).
      row("bk_justo", "2026-10-19T05:30:00.000Z", { durationMinutes: 30 }),
      row("bk_lunes", "2026-10-19T06:00:00.000Z"),
    ];
    const { body } = await get(WEEK);
    expect((body.bookings as { id: string }[]).map((b) => b.id)).toEqual(["bk_cruza", "bk_lunes"]);
  });

  it("los filtros de vendedor y tipo aplican igual que en la Lista", async () => {
    await get(`${WEEK}&sellerId=u_ana&typeId=apt_s`);
    const conds = whereConds();
    expect(conds.slice(0, 3)).toEqual([
      undefined,
      { op: "eq", value: "u_ana" },
      { op: "eq", value: "apt_s" },
    ]);
  });

  it("el Vendedor solo pide lo que puede ver", async () => {
    state.session = SELLER;
    const { body } = await get(WEEK);
    expect((whereConds()[0] as { op: string }).op).toBe("or");
    expect(body.sellers).toBeUndefined();
  });

  it("avisa si toca el tope de seguridad", async () => {
    state.rows = Array.from({ length: RANGE_LIMIT }, (_, i) =>
      row(`bk_${i}`, new Date(START + i * 60_000).toISOString())
    );
    const { body } = await get(WEEK);
    expect(body.truncated).toBe(true);
  });

  it("hours trae SOLO los cinco campos de la rejilla (nada de dirección ni sala)", async () => {
    const { body } = await get(WEEK);
    expect(body.hours).toEqual({
      weeklyHours: SETTINGS.weeklyHours,
      slotMinutes: 30,
      bufferMinutes: 15,
      minNoticeHours: 2,
      timezone: "America/Mexico_City",
    });
    expect(JSON.stringify(body)).not.toContain("Calle Secreta");
    expect(JSON.stringify(body)).not.toContain("meet.ejemplo.com");
  });

  it("overlaps: sobre toda la org, entregados solo para lo visible", async () => {
    state.session = SELLER;
    state.rows = [row("bk_1", "2026-10-20T16:00:00.000Z", { sellerId: "u_ana" })];
    state.busy = [
      busy("bk_1", "2026-10-20T16:00:00.000Z", { assignedUserId: "u_ana" }),
      // De otro vendedor: Ana no la ve, pero traslapa la suya.
      busy("bk_oculta", "2026-10-20T16:15:00.000Z", { assignedUserId: "u_juan" }),
    ];
    const { body } = await get(WEEK);
    expect(body.overlaps).toEqual({ bk_1: "soft" });
    const [org, window] = state.busyCalls[0] as [string, { fromUtc: Date; toUtc: Date }];
    expect(org).toBe("org_a");
    expect(window.fromUtc.getTime()).toBe(START - 24 * 3_600_000);
    expect(window.toUtc.getTime()).toBe(END + 24 * 3_600_000);
  });

  it("sin citas visibles, ni siquiera consulta los traslapes", async () => {
    const { body } = await get(WEEK);
    expect(body.overlaps).toEqual({});
    expect(state.busyCalls).toHaveLength(0);
  });
});

describe("rango inválido: 422 invalid_range", () => {
  it.each([
    ["?from=2026-10-19", "uno solo"],
    ["?to=2026-10-19", "uno solo"],
    ["?from=2026-02-31&to=2026-03-02", "fecha inexistente"],
    ["?from=2026-10-25&to=2026-10-19", "al revés"],
    ["?from=2026-01-01&to=2026-04-03", "93 días"],
  ])("%s (%s)", async (q) => {
    const { status, body } = await get(q);
    expect(status).toBe(422);
    expect((body.error as { code: string }).code).toBe("invalid_range");
    expect(state.calls).toHaveLength(0);
  });
});
