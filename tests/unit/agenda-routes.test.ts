import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionContext } from "@/lib/auth/session";

/**
 * 023 — Superficies de la agenda presencial: bandera antes que la sesión en
 * `/api/calendar/types`, guardas de Propietario (`?all=1`, alta, edición,
 * vendedor explícito, reasignar), 404 a la cita de otro vendedor y `conflicts`
 * en la disponibilidad. El servicio y las lecturas están simulados: aquí se
 * fija el CONTRATO HTTP.
 */

const sessionState: { current: SessionContext | null } = { current: null };
vi.mock("@/lib/auth/session", () => {
  class UnauthorizedError extends Error {}
  return {
    UnauthorizedError,
    requireSession: async () => {
      if (!sessionState.current) throw new UnauthorizedError();
      return sessionState.current;
    },
  };
});

const OWNER: SessionContext = { userId: "u_owner", organizationId: "org_1", role: "owner" };
const SELLER: SessionContext = { userId: "u_ana", organizationId: "org_1", role: "member" };

const TYPE = {
  id: "apt_s",
  organizationId: "org_1",
  name: "Servicio",
  durationMinutes: 30,
  exclusive: false,
  position: 1,
  active: true,
  seedKey: "servicio",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const listTypes = vi.fn(async (..._a: unknown[]) => [TYPE]);
const createType = vi.fn(async () => TYPE);
const updateType = vi.fn(async () => TYPE);
vi.mock("@/server/agenda/types-store", async (orig) => {
  const real = await orig<typeof import("@/server/agenda/types-store")>();
  return {
    ...real,
    listTypes,
    createType,
    updateType,
    getType: async (_o: string, id: string) => (id === TYPE.id ? TYPE : null),
    resolveTypeByName: async (_o: string, name: string) =>
      name.toLowerCase().startsWith("serv") ? TYPE : null,
    resolveFallbackType: async () => TYPE,
  };
});

const computeAvailability = vi.fn(async (..._a: unknown[]) => [
  {
    startUtc: "2026-08-05T15:00:00.000Z",
    endUtc: "2026-08-05T15:30:00.000Z",
    label: "mié 5 ago, 09:00",
    conflicts: [
      {
        id: "bk_9",
        kind: "session",
        startUtc: "2026-08-05T15:00:00.000Z",
        endUtc: "2026-08-05T15:30:00.000Z",
        typeId: "apt_s",
        exclusive: false,
        assignedUserId: "u_juan",
        typeName: "Servicio",
        sellerName: "Juan",
      },
    ],
  },
]);
vi.mock("@/server/agenda/availability", () => ({ computeAvailability }));

vi.mock("@/server/agenda/settings", async (orig) => {
  const real = await orig<typeof import("@/server/agenda/settings")>();
  return { ...real, getSettings: async () => real.DEFAULT_CALENDAR_SETTINGS };
});

let visible: Record<string, unknown> | null = null;
const listBookings = vi.fn(async (..._a: unknown[]) => []);
vi.mock("@/server/agenda/queries", async (orig) => {
  const real = await orig<typeof import("@/server/agenda/queries")>();
  return {
    ...real,
    listBookings,
    getVisibleBooking: async () => visible,
  };
});

const createSessionBooking = vi.fn(async (..._a: unknown[]) => ({
  booking: { id: "bk_new" },
  meetingLink: null,
  linkPending: false,
  label: "mié 5 ago, 09:00",
  typeName: "Servicio",
}));
const assignBooking = vi.fn(async (..._a: unknown[]) => ({ assignedUserId: "u_juan" }));
const rescheduleBooking = vi.fn(async (..._a: unknown[]) => ({ label: "x" }));
vi.mock("@/server/agenda/service", async (orig) => {
  const real = await orig<typeof import("@/server/agenda/service")>();
  return { ...real, createSessionBooking, assignBooking, rescheduleBooking };
});

const replaceOffers = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@/server/agenda/offers", () => ({ replaceOffers }));
vi.mock("@/server/bot/auth", () => ({
  requireBotKey: () => null,
  resolveInstanceOrg: async () => "org_1",
}));
vi.mock("@/lib/db", async () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where"]) chain[m] = () => chain;
  chain.limit = async () => [{ id: "cv_1" }];
  return { getDb: () => ({ select: () => chain }), schema: await import("@/lib/db/schema") };
});

vi.mock("@/server/team/members", () => ({
  listMembers: async () => [
    { id: "mem_1", userId: "u_owner", role: "owner", name: "Dueña", email: "", createdAt: new Date() },
    { id: "mem_2", userId: "u_ana", role: "member", name: "Ana", email: "", createdAt: new Date() },
  ],
}));

const types = await import("@/app/api/calendar/types/route");
const typeById = await import("@/app/api/calendar/types/[id]/route");
const availability = await import("@/app/api/calendar/availability/route");
const bookings = await import("@/app/api/bookings/route");
const bookingById = await import("@/app/api/bookings/[id]/route");
const botAvailability = await import("@/app/api/bot/availability/route");

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.stubEnv("AGENDA", "on");
  sessionState.current = null;
  visible = { id: "bk_1", assignedUserId: "u_ana", createdByUserId: null };
  for (const f of [listTypes, createType, updateType, computeAvailability, listBookings, createSessionBooking, assignBooking, rescheduleBooking]) {
    f.mockClear();
  }
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/calendar/types", () => {
  it("con AGENDA apagada responde 404 ANTES de mirar la sesión", async () => {
    vi.stubEnv("AGENDA", "");
    const urls = "http://x/api/calendar/types";
    expect((await types.GET(new Request(urls))).status).toBe(404);
    expect((await types.POST(new Request(urls, json({})))).status).toBe(404);
    expect(
      (await typeById.PATCH(new Request(urls, { method: "PATCH" }), params("apt_s"))).status
    ).toBe(404);
  });

  it("encendida y sin sesión ⇒ 401", async () => {
    expect((await types.GET(new Request("http://x/api/calendar/types"))).status).toBe(401);
  });

  it("GET: el Vendedor lee los activos; `?all=1` es solo del Propietario", async () => {
    sessionState.current = SELLER;
    const res = await types.GET(new Request("http://x/api/calendar/types"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      types: [
        { id: "apt_s", name: "Servicio", durationMinutes: 30, exclusive: false, position: 1, active: true },
      ],
    });
    expect((await types.GET(new Request("http://x/api/calendar/types?all=1"))).status).toBe(403);

    sessionState.current = OWNER;
    expect((await types.GET(new Request("http://x/api/calendar/types?all=1"))).status).toBe(200);
    expect(listTypes.mock.calls.at(-1)![1]).toEqual({ includeInactive: true });
  });

  it("POST y PATCH: 403 al Vendedor; 201/200 al Propietario", async () => {
    const body = { name: "Lavado", durationMinutes: 45 };
    sessionState.current = SELLER;
    expect((await types.POST(new Request("http://x", json(body)))).status).toBe(403);
    expect(
      (await typeById.PATCH(new Request("http://x", { ...json({ active: false }), method: "PATCH" }), params("apt_s"))).status
    ).toBe(403);
    expect(createType).not.toHaveBeenCalled();

    sessionState.current = OWNER;
    expect((await types.POST(new Request("http://x", json(body)))).status).toBe(201);
    expect(
      (await typeById.PATCH(new Request("http://x", { ...json({ active: false }), method: "PATCH" }), params("apt_s"))).status
    ).toBe(200);
  });
});

describe("/api/calendar/availability", () => {
  it("con typeId: modo staff y cada slot trae `conflicts` en forma conflictPayload", async () => {
    sessionState.current = SELLER;
    const res = await availability.GET(
      new Request("http://x/api/calendar/availability?typeId=apt_s&sellerId=u_juan")
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slots: { conflicts: unknown[] }[] };
    expect(body.slots[0]!.conflicts).toEqual([
      {
        bookingId: "bk_9",
        typeName: "Servicio",
        sellerName: "Juan",
        startUtc: "2026-08-05T15:00:00.000Z",
        endUtc: "2026-08-05T15:30:00.000Z",
      },
    ]);
    const opts = computeAvailability.mock.calls[0]![1] as { ctx: unknown; durationMinutes: number };
    // El Vendedor no elige vendedor: se le fija el suyo.
    expect(opts.ctx).toEqual({ mode: "staff", typeId: "apt_s", typeExclusive: false, sellerId: "u_ana" });
    expect(opts.durationMinutes).toBe(30);
  });

  it("el Propietario sí elige vendedor (`none` = sin vendedor)", async () => {
    sessionState.current = OWNER;
    await availability.GET(new Request("http://x/api/calendar/availability?typeId=apt_s&sellerId=none"));
    expect((computeAvailability.mock.calls[0]![1] as { ctx: { sellerId: unknown } }).ctx.sellerId).toBeNull();
  });

  it("sin typeId: strict como en la 015; tipo inválido ⇒ 422", async () => {
    sessionState.current = OWNER;
    await availability.GET(new Request("http://x/api/calendar/availability"));
    expect((computeAvailability.mock.calls[0]![1] as { ctx: unknown }).ctx).toEqual({ mode: "strict" });
    expect(
      (await availability.GET(new Request("http://x/api/calendar/availability?typeId=apt_x"))).status
    ).toBe(422);
  });

  it("excludeBookingId de una cita que no se ve ⇒ 404", async () => {
    sessionState.current = SELLER;
    visible = null;
    expect(
      (await availability.GET(new Request("http://x/api/calendar/availability?excludeBookingId=bk_9"))).status
    ).toBe(404);
  });
});

describe("/api/bookings", () => {
  const session = {
    kind: "session",
    contactId: "ct_1",
    startUtc: "2026-08-05T15:00:00.000Z",
    typeId: "apt_s",
  };

  it("GET: filtros, `types` para todos y `sellers` solo para el Propietario", async () => {
    sessionState.current = SELLER;
    const res = await bookings.GET(new Request("http://x/api/bookings?sellerId=none&typeId=apt_s"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.types).toHaveLength(1);
    expect("sellers" in body).toBe(false);
    expect(listBookings.mock.calls[0]![1]).toEqual({
      viewer: { userId: "u_ana", role: "member" },
      sellerId: null,
      typeId: "apt_s",
    });

    sessionState.current = OWNER;
    const owner = (await (await bookings.GET(new Request("http://x/api/bookings"))).json()) as {
      sellers: unknown;
    };
    expect(owner.sellers).toEqual([
      { id: "u_owner", name: "Dueña" },
      { id: "u_ana", name: "Ana" },
    ]);
  });

  it("POST sin typeId ⇒ 422", async () => {
    sessionState.current = SELLER;
    const { typeId: _omit, ...sinTipo } = session;
    expect((await bookings.POST(new Request("http://x", json(sinTipo)))).status).toBe(422);
  });

  it("POST con assignedUserId: 403 al Vendedor, pasa para el Propietario", async () => {
    sessionState.current = SELLER;
    expect(
      (await bookings.POST(new Request("http://x", json({ ...session, assignedUserId: "u_juan" })))).status
    ).toBe(403);
    expect(createSessionBooking).not.toHaveBeenCalled();

    sessionState.current = OWNER;
    const res = await bookings.POST(
      new Request("http://x", json({ ...session, assignedUserId: null, confirmOverlap: true }))
    );
    expect(res.status).toBe(201);
    expect(createSessionBooking.mock.calls[0]![0]).toMatchObject({
      typeId: "apt_s",
      assignedUserId: null,
      actorUserId: "u_owner",
      confirmOverlap: true,
      source: "manual",
    });
  });

  it("POST: un overlap_warning del servicio sale como 409 con `conflicts`", async () => {
    sessionState.current = SELLER;
    const { BookingError } = await import("@/server/agenda/service");
    createSessionBooking.mockRejectedValueOnce(
      new BookingError("overlap_warning", "A esa hora ya hay 1 cita (Servicio, con Juan).")
    );
    const res = await bookings.POST(new Request("http://x", json(session)));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string }; conflicts: unknown[] };
    expect(body.error.code).toBe("overlap_warning");
    expect(body.conflicts).toEqual([]);
  });
});

describe("/api/bookings/[id]", () => {
  const patch = (body: unknown) => new Request("http://x", { ...json(body), method: "PATCH" });

  it("la cita de otro vendedor responde 404 (no se puede tocar)", async () => {
    sessionState.current = SELLER;
    visible = null;
    const res = await bookingById.PATCH(patch({ action: "cancel" }), params("bk_1"));
    expect(res.status).toBe(404);
  });

  it("reschedule pasa confirmOverlap en modo staff", async () => {
    sessionState.current = SELLER;
    await bookingById.PATCH(
      patch({ action: "reschedule", startUtc: "2026-08-05T15:00:00.000Z", confirmOverlap: true }),
      params("bk_1")
    );
    expect(rescheduleBooking.mock.calls[0]![0]).toMatchObject({ mode: "staff", confirmOverlap: true });
  });

  it("assign: 403 al Vendedor; el Propietario reasigna", async () => {
    sessionState.current = SELLER;
    expect(
      (await bookingById.PATCH(patch({ action: "assign", userId: "u_juan" }), params("bk_1"))).status
    ).toBe(403);
    expect(assignBooking).not.toHaveBeenCalled();

    sessionState.current = OWNER;
    const res = await bookingById.PATCH(patch({ action: "assign", userId: "u_juan" }), params("bk_1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, assignedUserId: "u_juan" });
  });
});

describe("/api/bot/availability", () => {
  it("type por nombre: oferta registrada con el typeId y `type` en la respuesta", async () => {
    replaceOffers.mockClear();
    const res = await botAvailability.GET(
      new Request("http://x/api/bot/availability?conversationId=cv_1&type=servicio")
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: unknown };
    expect(body.type).toEqual({ id: "apt_s", name: "Servicio", durationMinutes: 30 });
    expect(replaceOffers.mock.calls[0]![3]).toBe("apt_s");
    // strict: sin ctx.
    expect((computeAvailability.mock.calls[0]![1] as { ctx?: unknown }).ctx).toBeUndefined();
  });

  it("type que no resuelve ⇒ 422 unknown_type con los tipos activos", async () => {
    const res = await botAvailability.GET(
      new Request("http://x/api/bot/availability?conversationId=cv_1&type=lavado")
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { code: "unknown_type", message: "Tipo de cita desconocido o ambiguo" },
      types: [{ id: "apt_s", name: "Servicio" }],
    });
  });
});

describe("rutas de la 015: la bandera va ANTES que la sesión", () => {
  it("sin sesión y con AGENDA apagada ⇒ 404 (no 401)", async () => {
    vi.stubEnv("AGENDA", "");
    sessionState.current = null;
    const retry = await import("@/app/api/bookings/[id]/reminders/[reminderId]/retry/route");
    const statuses = [
      (await bookings.GET(new Request("http://x/api/bookings"))).status,
      (await bookings.POST(new Request("http://x", json({})))).status,
      (await bookingById.PATCH(new Request("http://x", { method: "PATCH" }), params("bk_1"))).status,
      (await availability.GET(new Request("http://x/api/calendar/availability"))).status,
      (
        await retry.POST(new Request("http://x", { method: "POST" }), {
          params: Promise.resolve({ id: "bk_1", reminderId: "brm_1" }),
        })
      ).status,
    ];
    expect(statuses).toEqual([404, 404, 404, 404, 404]);
  });

  it("encendida y sin sesión ⇒ 401", async () => {
    sessionState.current = null;
    expect((await bookings.GET(new Request("http://x/api/bookings"))).status).toBe(401);
  });
});
