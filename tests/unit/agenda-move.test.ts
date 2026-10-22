import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 028 (A2/A5) — `moveBooking`: mover hora y/o vendedor de forma ATÓMICA (un
 * candado, un UPDATE) con las reglas de reprogramar + reasignar. Motor de
 * disponibilidad y de choques REALES; solo la base está simulada. La consulta
 * de lo ocupado se reconoce por sus columnas (`sellerName`).
 */

const settings = {
  weeklyHours: { wed: [{ start: "09:00", end: "18:00" }] },
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 0,
  maxDaysAhead: 7,
  timezone: "America/Mexico_City",
  connector: "zoom" as const,
  meetingLink: null,
  address: null,
};

/** Miércoles 5 ago 2026 en México (UTC−6). */
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(2026, 7, 5, h + 6, m)).toISOString();
};
const NOW = new Date("2026-08-01T00:00:00.000Z");

const SERVICIO = { id: "apt_serv", name: "Servicio", durationMinutes: 30, exclusive: false, active: true };
const PRUEBA = { id: "apt_prueba", name: "Prueba de manejo", durationMinutes: 30, exclusive: true, active: true };

const updateMeeting = vi.fn(async (..._a: unknown[]) => {});
const publish = vi.fn();

vi.mock("@/server/agenda/settings", () => ({ getSettings: async () => settings }));
vi.mock("@/server/agenda/types-store", () => ({
  getType: async (_o: string, id: string) => [SERVICIO, PRUEBA].find((t) => t.id === id) ?? null,
  listTypes: async () => [SERVICIO, PRUEBA],
  resolveFallbackType: async () => SERVICIO,
}));
vi.mock("@/server/agenda/connectors", () => ({
  bindConnector: async () => ({
    id: "zoom",
    createMeeting: async () => ({ externalId: null, joinUrl: null }),
    updateMeeting,
    deleteMeeting: async () => {},
    testConnection: async () => ({ ok: true }),
  }),
  markConnectorAuthError: async () => {},
}));
vi.mock("@/server/leads/stage-history", () => ({
  moveLeadToStage: async () => ({ ok: true as const }),
}));
vi.mock("@/server/events/bus", () => ({ publish: (...a: unknown[]) => publish(...a) }));

const state = {
  booking: {} as Record<string, unknown>,
  member: true,
  busy: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  updateThrows: null as unknown,
  transactions: 0,
  locks: 0,
};

function chain(rows: () => unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "leftJoin", "innerJoin"]) c[m] = () => c;
  c.limit = () => Promise.resolve(rows());
  c.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
    Promise.resolve(rows()).then(ok, ko);
  return c;
}

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  const db: Record<string, unknown> = {
    select: (fields?: Record<string, unknown>) => {
      if (fields && "sellerName" in fields) return chain(() => state.busy);
      // `isOrgMember` pide `{ id: member.id }`; `getOwnBooking`, la fila entera.
      if (fields && Object.keys(fields).length === 1 && "id" in fields) {
        return chain(() => (state.member ? [{ id: "mem_1" }] : []));
      }
      return chain(() => [state.booking]);
    },
    execute: async () => {
      state.locks++;
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      state.transactions++;
      return fn(db);
    },
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => ({
          returning: () => {
            if (state.updateThrows) return Promise.reject(state.updateThrows);
            state.updates.push(v);
            return Promise.resolve([{ ...state.booking, ...v }]);
          },
        }),
      }),
    }),
  };
  return { getDb: () => db, schema };
});

const { moveBooking, BookingError } = await import("@/server/agenda/service");

function booking(over: Record<string, unknown> = {}) {
  return {
    id: "bk_1",
    organizationId: "org_1",
    kind: "session",
    status: "agendada",
    source: "manual",
    scheduledAt: new Date(at("09:00")),
    durationMinutes: 30,
    appointmentTypeId: SERVICIO.id,
    exclusive: false,
    assignedUserId: "u_ana",
    isTest: false,
    externalRef: "ext_1",
    connector: "zoom",
    meetingLink: "https://zoom.example/j/1",
    linkPending: false,
    ...over,
  };
}

function busy(id: string, hhmm: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "session",
    scheduledAt: new Date(at(hhmm)),
    durationMinutes: 30,
    typeId: SERVICIO.id,
    exclusive: false,
    assignedUserId: "u_juan",
    typeName: "Servicio",
    sellerName: "Juan",
    ...over,
  };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    expect(err).toBeInstanceOf(BookingError);
    return (err as InstanceType<typeof BookingError>).code;
  }
}

const base = { organizationId: "org_1", bookingId: "bk_1", now: NOW };

beforeEach(() => {
  state.booking = booking();
  state.member = true;
  state.busy = [];
  state.updates = [];
  state.updateThrows = null;
  state.transactions = 0;
  state.locks = 0;
  settings.bufferMinutes = 0;
  updateMeeting.mockClear();
  publish.mockClear();
});

describe("moveBooking — sesiones", () => {
  it("cambia la hora: un candado, un UPDATE, el conector y el aviso SSE", async () => {
    const r = await moveBooking({ ...base, startUtc: at("10:00") });
    expect(state.transactions).toBe(1);
    expect(state.locks).toBe(2); // lock_timeout + pg_advisory_xact_lock
    expect(state.updates).toHaveLength(1);
    expect((state.updates[0]!.scheduledAt as Date).toISOString()).toBe(at("10:00"));
    expect(state.updates[0]!.assignedUserId).toBe("u_ana");
    expect(r.timeChanged).toBe(true);
    expect(updateMeeting).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
  });

  it("cambia solo el vendedor: sin rejilla, sin tocar el conector", async () => {
    // Fuera del horario actual (20:00): reasignar no lo rechaza por eso.
    state.booking = booking({ scheduledAt: new Date(at("20:00")) });
    const r = await moveBooking({ ...base, userId: "u_juan" });
    expect(r.timeChanged).toBe(false);
    expect(state.updates[0]!.assignedUserId).toBe("u_juan");
    expect((state.updates[0]!.scheduledAt as Date).toISOString()).toBe(at("20:00"));
    expect(updateMeeting).not.toHaveBeenCalled();
  });

  it("cambia ambos en UNA escritura; el choque se mide con el vendedor DESTINO", async () => {
    // Juan tiene algo a las 09:00 (la hora vieja), no a las 10:00.
    state.busy = [busy("bk_j", "09:00")];
    await moveBooking({ ...base, startUtc: at("10:00"), userId: "u_juan" });
    expect(state.transactions).toBe(1);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.assignedUserId).toBe("u_juan");
    expect((state.updates[0]!.scheduledAt as Date).toISOString()).toBe(at("10:00"));
  });

  it("a la hora de una cita del vendedor destino ⇒ slot_taken", async () => {
    state.busy = [busy("bk_j", "10:00")];
    expect(await code(moveBooking({ ...base, startUtc: at("10:00"), userId: "u_juan" }))).toBe(
      "slot_taken"
    );
    expect(state.updates).toHaveLength(0);
  });

  it("solo vendedor, pero el destino ya tiene cita a esa hora ⇒ slot_taken", async () => {
    state.busy = [busy("bk_j", "09:00")];
    expect(await code(moveBooking({ ...base, userId: "u_juan" }))).toBe("slot_taken");
  });

  it("mismo tipo exclusivo a esa hora ⇒ slot_taken", async () => {
    state.booking = booking({ appointmentTypeId: PRUEBA.id, exclusive: true });
    state.busy = [busy("bk_p", "10:00", { typeId: PRUEBA.id, exclusive: true, assignedUserId: "u_pedro" })];
    expect(await code(moveBooking({ ...base, startUtc: at("10:00") }))).toBe("slot_taken");
  });

  it("mismo vendedor (sin reasignar) a esa hora ⇒ slot_taken", async () => {
    state.busy = [busy("bk_a", "10:00", { assignedUserId: "u_ana" })];
    expect(await code(moveBooking({ ...base, startUtc: at("10:00") }))).toBe("slot_taken");
  });

  it("cita de otro vendedor ⇒ overlap_warning; con confirmOverlap se mueve", async () => {
    state.busy = [busy("bk_j", "10:00")];
    expect(await code(moveBooking({ ...base, startUtc: at("10:00") }))).toBe("overlap_warning");
    expect(state.updates).toHaveLength(0);
    expect(await code(moveBooking({ ...base, startUtc: at("10:00"), confirmOverlap: true }))).toBe(
      "ok"
    );
    expect(state.updates).toHaveLength(1);
  });

  it("fuera de la rejilla ⇒ slot_taken", async () => {
    expect(await code(moveBooking({ ...base, startUtc: at("20:00") }))).toBe("slot_taken");
  });

  it("expectedStartUtc distinto ⇒ stale; igual ⇒ se mueve", async () => {
    expect(
      await code(moveBooking({ ...base, startUtc: at("10:00"), expectedStartUtc: at("09:30") }))
    ).toBe("stale");
    expect(
      await code(moveBooking({ ...base, startUtc: at("10:00"), expectedStartUtc: at("09:00") }))
    ).toBe("ok");
  });

  it("no agendada o de prueba ⇒ invalid", async () => {
    state.booking = booking({ status: "realizada" });
    expect(await code(moveBooking({ ...base, startUtc: at("10:00") }))).toBe("invalid");
    state.booking = booking({ isTest: true });
    expect(await code(moveBooking({ ...base, startUtc: at("10:00") }))).toBe("invalid");
  });

  it("vendedor que no es miembro ⇒ invalid", async () => {
    state.member = false;
    expect(await code(moveBooking({ ...base, userId: "u_fantasma" }))).toBe("invalid");
  });

  it("sin hora ni vendedor ⇒ invalid, sin tomar el candado", async () => {
    expect(await code(moveBooking({ ...base }))).toBe("invalid");
    expect(state.transactions).toBe(0);
  });

  it("un 23505 del UPDATE ⇒ slot_taken", async () => {
    state.updateThrows = { cause: { code: "23505" } };
    expect(await code(moveBooking({ ...base, startUtc: at("10:00") }))).toBe("slot_taken");
  });
});

describe("moveBooking — bloqueos (A5)", () => {
  beforeEach(() => {
    state.booking = booking({
      kind: "block",
      appointmentTypeId: null,
      assignedUserId: null,
      externalRef: null,
      durationMinutes: 60,
    });
  });

  it("puede caer fuera del horario hábil si está alineado a slotMinutes", async () => {
    expect(await code(moveBooking({ ...base, startUtc: at("20:00") }))).toBe("ok");
  });

  it("desalineado ⇒ invalid", async () => {
    expect(await code(moveBooking({ ...base, startUtc: at("10:10") }))).toBe("invalid");
  });

  it("si cubre citas pide confirmación; con confirmOverlap se mueve", async () => {
    state.busy = [busy("bk_j", "10:30"), busy("bk_k", "10:00", { kind: "block" })];
    try {
      await moveBooking({ ...base, startUtc: at("10:00") });
      throw new Error("debió advertir");
    } catch (err) {
      const e = err as InstanceType<typeof BookingError>;
      expect(e.code).toBe("overlap_warning");
      expect(e.message).toBe("Este bloqueo cubrirá 1 cita.");
      expect(e.conflicts.map((c) => c.id)).toEqual(["bk_j"]);
    }
    expect(await code(moveBooking({ ...base, startUtc: at("10:00"), confirmOverlap: true }))).toBe(
      "ok"
    );
  });

  it("un bloqueo no tiene vendedor ⇒ invalid", async () => {
    expect(await code(moveBooking({ ...base, userId: "u_ana" }))).toBe("invalid");
  });
});
