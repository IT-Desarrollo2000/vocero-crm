import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickFallbackType } from "@/lib/agenda-types";

/**
 * 015 — La carrera del hueco (FR-006) · 023 — choques por tipo y vendedor.
 *
 * Con la 023 la carrera se cierra con un candado consultivo POR ORGANIZACIÓN
 * (dentro de la transacción se re-calculan los choques y se escribe); los
 * índices únicos parciales quedan como red de seguridad. Lo que se fija aquí:
 *
 *  - `23505` ⇒ `slot_taken` CON alternativas frescas, registradas DESPUÉS del
 *    commit (A1), y jamás una cita creada;
 *  - el motor de choques real decide: mismo tipo exclusivo / mismo vendedor ⇒
 *    `slot_taken`; cita compatible de otro vendedor ⇒ `overlap_warning` (y con
 *    confirmación, se crea); la IA (`strict`) no pisa nada; el margen cuenta.
 *
 * Se usa el motor de disponibilidad REAL: solo la base está simulada. La
 * consulta de "lo ocupado" se reconoce por sus columnas (`sellerName`).
 *
 * La carrera de verdad, con dos peticiones concurrentes contra la app viva, la
 * corre el arnés E2E: esto asegura que cuando ocurra, la respuesta sea útil.
 */

const settings = {
  weeklyHours: { wed: [{ start: "09:00", end: "18:00" }] },
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 0,
  maxDaysAhead: 7,
  timezone: "America/Mexico_City",
  connector: "enlace-fijo" as const,
  meetingLink: "https://meet.ejemplo.com/sala",
  address: null,
};

/** Miércoles 5 ago 2026, 09:00 en México. */
const SLOT = "2026-08-05T15:00:00.000Z";
const NOW = new Date("2026-08-01T00:00:00.000Z");

type FakeType = {
  id: string;
  name: string;
  durationMinutes: number;
  exclusive: boolean;
  active: boolean;
  position: number;
};
const PRUEBA: FakeType = {
  id: "apt_prueba",
  name: "Prueba de manejo",
  durationMinutes: 60,
  exclusive: true,
  active: true,
  position: 0,
};
const SERVICIO: FakeType = {
  id: "apt_serv",
  name: "Servicio",
  durationMinutes: 30,
  exclusive: false,
  active: true,
  position: 1,
};
let types: FakeType[] = [];

/** Bitácora de orden: el candado, el INSERT y lo que va después del commit. */
const log: string[] = [];

let offers: { startUtc: string; label: string; typeId?: string | null }[] = [];
const replaceOffers = vi.fn(async (..._args: unknown[]) => {
  log.push("replaceOffers");
});
const clearOffers = vi.fn(async () => {});
const createMeeting = vi.fn(async () => ({
  externalId: null,
  joinUrl: settings.meetingLink,
}));

vi.mock("@/server/agenda/settings", () => ({
  getSettings: async () => settings,
}));

vi.mock("@/server/agenda/types-store", () => ({
  getType: async (_org: string, id: string) =>
    types.find((t) => t.id === id) ?? null,
  listTypes: async () => types.filter((t) => t.active),
  resolveFallbackType: async () => pickFallbackType(types),
}));

vi.mock("@/server/agenda/offers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/offers")>();
  return {
    ...original,
    getOffers: async () => offers,
    replaceOffers,
    clearOffers,
  };
});

vi.mock("@/server/agenda/connectors", () => ({
  bindConnector: async () => ({
    id: "enlace-fijo",
    createMeeting,
    updateMeeting: async () => {},
    deleteMeeting: async () => {},
    testConnection: async () => ({ ok: true }),
  }),
  markConnectorAuthError: async () => {},
}));

vi.mock("@/server/leads/stage-history", () => ({
  moveLeadToStage: async () => ({ ok: true as const }),
}));
vi.mock("@/server/events/bus", () => ({ publish: () => {} }));

/** Cola de resultados para cada `select(...).limit(n)` en orden de llamada. */
const selectRows: unknown[][] = [];
/** Lo que devuelve la consulta de lo ocupado (filas de `booking` + nombres). */
let busyRows: Record<string, unknown>[] = [];
/** Si tiene algo, el INSERT lo lanza en vez de insertar. */
let insertThrows: unknown = null;
const inserted: Record<string, unknown>[] = [];

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "leftJoin", "innerJoin"]) {
    c[m] = () => c;
  }
  c.limit = () => Promise.resolve(rows);
  // La consulta de lo ocupado no termina en `.limit`: se espera tal cual.
  c.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(ok, ko);
  return c;
}

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  const db: Record<string, unknown> = {
    select: (fields?: Record<string, unknown>) =>
      fields && "sellerName" in fields
        ? chain(busyRows)
        : chain(selectRows.shift() ?? []),
    execute: async () => {
      log.push("execute");
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      log.push("tx:start");
      try {
        return await fn(db);
      } finally {
        log.push("tx:end");
      }
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: () => {
          if (insertThrows) return Promise.reject(insertThrows);
          log.push("insert");
          inserted.push(v);
          return Promise.resolve([
            {
              ...v,
              meetingLink: null,
              linkPending: false,
              externalRef: null,
            },
          ]);
        },
      }),
    }),
    update: () => ({
      set: (v: unknown) => ({
        where: () => ({
          returning: () =>
            Promise.resolve([
              {
                ...(inserted[inserted.length - 1] ?? {}),
                ...(v as object),
              },
            ]),
        }),
      }),
    }),
  };
  return { getDb: () => db, schema };
});

function busy(over: Record<string, unknown>) {
  return {
    id: "bk_otra",
    kind: "session",
    scheduledAt: new Date(SLOT),
    durationMinutes: 30,
    typeId: SERVICIO.id,
    exclusive: false,
    assignedUserId: "u_juan",
    typeName: "Servicio",
    sellerName: "Juan",
    ...over,
  };
}

/** 1) la conversación, 2) el lead, 3) el nombre del contacto (tras el commit). */
function primeLookups(assignedUserId: string | null = null) {
  selectRows.push([{ contactId: "ct_1", isTest: false, assignedUserId }]);
  selectRows.push([{ id: "ld_1" }]);
  selectRows.push([{ name: "Ana" }]);
}

const aiBooking = {
  organizationId: "org_1",
  conversationId: "cv_1",
  startUtc: SLOT,
  source: "ai" as const,
  requireOffer: true,
  now: NOW,
};

beforeEach(() => {
  selectRows.length = 0;
  inserted.length = 0;
  log.length = 0;
  busyRows = [];
  insertThrows = null;
  settings.bufferMinutes = 0;
  types = [PRUEBA, SERVICIO];
  offers = [{ startUtc: SLOT, label: "mié 5 ago, 09:00", typeId: SERVICIO.id }];
  replaceOffers.mockClear();
  clearOffers.mockClear();
});

describe("la carrera del hueco", () => {
  it("un 23505 se traduce a slot_taken con alternativas frescas, sin crear la cita", async () => {
    const { createSessionBooking, BookingError } = await import(
      "@/server/agenda/service"
    );
    primeLookups();
    insertThrows = { code: "23505" };

    const promise = createSessionBooking(aiBooking);

    await expect(promise).rejects.toBeInstanceOf(BookingError);
    await promise.catch((err) => {
      expect(err.code).toBe("slot_taken");
      // Con alternativas concretas: sin ellas, la conversación se queda sin
      // salida y el cliente sin cita.
      expect(err.slots).toHaveLength(3);
      expect(err.slots[0].label).toBe("mié 5 ago, 09:00");
      // Del MISMO tipo que se intentó reservar.
      expect(err.slots[0].typeId).toBe(SERVICIO.id);
    });

    // Y quedan REGISTRADAS como la nueva oferta: el cliente puede aceptar una
    // de inmediato y la validación seguirá siendo válida.
    expect(replaceOffers).toHaveBeenCalledOnce();
    expect(replaceOffers.mock.calls[0]![3]).toBe(SERVICIO.id);
    expect(inserted).toHaveLength(0);
  });

  it("toma el candado por organización y re-ofrece DESPUÉS del commit (A1)", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeLookups();
    insertThrows = { code: "23505" };

    await createSessionBooking(aiBooking).catch(() => {});

    // lock_timeout + pg_advisory_xact_lock, ambos dentro de la transacción.
    expect(log.slice(0, 3)).toEqual(["tx:start", "execute", "execute"]);
    expect(log.indexOf("replaceOffers")).toBeGreaterThan(log.indexOf("tx:end"));
  });

  it("el 23505 también se reconoce cuando el driver lo envuelve en `cause`", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeLookups();
    insertThrows = Object.assign(new Error("insert falló"), {
      cause: { code: "23505" },
    });

    await expect(createSessionBooking(aiBooking)).rejects.toMatchObject({
      code: "slot_taken",
    });
  });

  it("un error que NO es la carrera se propaga tal cual, sin disfrazarse de slot_taken", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeLookups();
    insertThrows = { code: "23503", message: "foreign key" };

    await expect(createSessionBooking(aiBooking)).rejects.toMatchObject({
      code: "23503",
    });
  });

  it("un instante que nunca se ofreció se rechaza ANTES de tocar la base", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeLookups();

    const promise = createSessionBooking({
      ...aiBooking,
      // Libre y válido, pero jamás ofrecido en esta conversación.
      startUtc: "2026-08-05T20:00:00.000Z",
    });

    await expect(promise).rejects.toMatchObject({ code: "slot_not_offered" });
    await promise.catch((err) => {
      // Se devuelve lo que SÍ se ofreció, para que se re-ofrezca en vez de
      // inventar.
      expect(err.slots[0].startUtc).toBe(SLOT);
    });
    expect(inserted).toHaveLength(0);
  });
});

describe("023 — choques de humanos (modo staff)", () => {
  const human = {
    organizationId: "org_1",
    contactId: "ct_1",
    startUtc: SLOT,
    source: "manual" as const,
    requireOffer: false,
    now: NOW,
    actorUserId: "u_ana",
  };
  /** Sin conversación: 1) el contacto en la org, 2) el lead, 3) su nombre. */
  function primeManual() {
    selectRows.push([{ id: "ct_1" }]);
    selectRows.push([{ id: "ld_1" }]);
    selectRows.push([{ name: "Ana" }]);
  }

  it("una segunda Prueba de manejo traslapada se rechaza aunque sea de otro vendedor", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeManual();
    // Traslape PARCIAL (09:30): el índice único no lo vería; el motor sí.
    busyRows = [
      busy({
        scheduledAt: new Date("2026-08-05T15:30:00.000Z"),
        durationMinutes: 60,
        typeId: PRUEBA.id,
        exclusive: true,
        typeName: PRUEBA.name,
      }),
    ];

    await expect(
      createSessionBooking({ ...human, typeId: PRUEBA.id })
    ).rejects.toMatchObject({ code: "slot_taken" });
    expect(inserted).toHaveLength(0);
  });

  it("una cita compatible de otro vendedor pide confirmación (overlap_warning)", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeManual();
    busyRows = [busy({})];

    const promise = createSessionBooking({ ...human, typeId: SERVICIO.id });
    await expect(promise).rejects.toMatchObject({ code: "overlap_warning" });
    await promise.catch((err) => {
      expect(err.conflicts).toHaveLength(1);
      expect(err.conflicts[0]).toMatchObject({
        id: "bk_otra",
        typeName: "Servicio",
        sellerName: "Juan",
      });
      expect(err.message).toContain("Servicio, con Juan");
    });
    expect(inserted).toHaveLength(0);
  });

  it("con la confirmación, se crea con tipo, vendedor y copias del tipo", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeManual();
    busyRows = [busy({})];

    const result = await createSessionBooking({
      ...human,
      typeId: SERVICIO.id,
      confirmOverlap: true,
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      appointmentTypeId: SERVICIO.id,
      durationMinutes: 30,
      exclusive: false,
      // Sin conversación ni vendedor explícito: queda quien agenda.
      assignedUserId: "u_ana",
      createdByUserId: "u_ana",
    });
    expect(result.typeName).toBe("Servicio");
  });

  it("el mismo vendedor no puede tener dos citas traslapadas", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeManual();
    busyRows = [busy({ assignedUserId: "u_ana", sellerName: "Ana" })];

    await expect(
      createSessionBooking({
        ...human,
        typeId: SERVICIO.id,
        confirmOverlap: true,
      })
    ).rejects.toMatchObject({ code: "slot_taken" });
    expect(inserted).toHaveLength(0);
  });

  it("un bloqueo siempre bloquea", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeManual();
    busyRows = [
      busy({
        kind: "block",
        typeId: null,
        assignedUserId: null,
        typeName: null,
        sellerName: null,
      }),
    ];

    await expect(
      createSessionBooking({
        ...human,
        typeId: SERVICIO.id,
        confirmOverlap: true,
      })
    ).rejects.toMatchObject({ code: "slot_taken" });
  });

  it("un humano sin tipo recibe invalid (el tipo es obligatorio, A2)", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeManual();
    await expect(createSessionBooking(human)).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("un vendedor explícito que no es miembro de la organización es invalid", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    selectRows.push([{ id: "ct_1" }]); // el contacto, en la org
    selectRows.push([]); // la membresía
    await expect(
      createSessionBooking({
        ...human,
        typeId: SERVICIO.id,
        assignedUserId: "u_ajeno",
      })
    ).rejects.toMatchObject({ code: "invalid" });
    expect(inserted).toHaveLength(0);
  });
});

describe("023 — fixes de la revisión (contacto y oferta)", () => {
  const human = {
    organizationId: "org_1",
    startUtc: SLOT,
    source: "manual" as const,
    requireOffer: false,
    now: NOW,
    actorUserId: "u_ana",
    typeId: PRUEBA.id,
  };

  it("un contactId de OTRA organización es invalid y no se inserta nada", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    selectRows.push([]); // el contacto no existe en org_1
    await expect(
      createSessionBooking({ ...human, contactId: "ct_ajeno" })
    ).rejects.toMatchObject({ code: "invalid", message: "Contacto no encontrado" });
    expect(inserted).toHaveLength(0);
  });

  it("un contactId que no es el de la conversación es invalid", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    selectRows.push([{ contactId: "ct_1", isTest: false, assignedUserId: null }]);
    await expect(
      createSessionBooking({ ...human, conversationId: "cv_1", contactId: "ct_otro" })
    ).rejects.toMatchObject({ code: "invalid" });
    expect(inserted).toHaveLength(0);
  });

  it("el slot_taken de un HUMANO no toca la oferta de la conversación", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    selectRows.push([{ contactId: "ct_1", isTest: false, assignedUserId: null }]);
    selectRows.push([{ id: "ct_1" }]);
    busyRows = [
      busy({ typeId: PRUEBA.id, exclusive: true, typeName: PRUEBA.name, durationMinutes: 60 }),
    ];

    const promise = createSessionBooking({
      ...human,
      conversationId: "cv_1",
      contactId: "ct_1",
    });
    await expect(promise).rejects.toMatchObject({ code: "slot_taken" });
    await promise.catch((err) => expect(err.slots).toEqual([]));
    expect(replaceOffers).not.toHaveBeenCalled();
  });
});

describe("023 — la IA no pisa nada (modo strict)", () => {
  it("una cita compatible de otro vendedor BLOQUEA a la IA", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeLookups();
    busyRows = [busy({})];

    await expect(createSessionBooking(aiBooking)).rejects.toMatchObject({
      code: "slot_taken",
    });
    expect(inserted).toHaveLength(0);
  });

  it("el vendedor es el asignado a la conversación (o ninguno)", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeLookups("u_juan");

    await createSessionBooking(aiBooking);
    expect(inserted[0]).toMatchObject({
      assignedUserId: "u_juan",
      createdByUserId: null,
      appointmentTypeId: SERVICIO.id,
    });
  });

  it("el margen cuenta: una cita que termina justo al inicio choca con buffer", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeLookups();
    settings.bufferMinutes = 15;
    busyRows = [
      busy({ scheduledAt: new Date("2026-08-05T14:30:00.000Z") }), // 08:30-09:00
    ];

    await expect(createSessionBooking(aiBooking)).rejects.toMatchObject({
      code: "slot_taken",
    });
  });

  it("oferta legacy sin tipo: usa el primer tipo activo NO exclusivo", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeLookups();
    offers = [{ startUtc: SLOT, label: "mié 5 ago, 09:00", typeId: null }];

    await createSessionBooking(aiBooking);
    expect(inserted[0]).toMatchObject({ appointmentTypeId: SERVICIO.id });
  });

  it("tipo desactivado entre la oferta y la reserva ⇒ slot_taken, no invalid (A11)", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeLookups();
    types = [PRUEBA, { ...SERVICIO, active: false }];

    await expect(createSessionBooking(aiBooking)).rejects.toMatchObject({
      code: "slot_taken",
    });
    expect(inserted).toHaveLength(0);
  });
});

describe("023 — reprogramar, reasignar y reactivar con las mismas reglas", () => {
  const CITA = {
    id: "bk_mia",
    organizationId: "org_1",
    kind: "session",
    status: "agendada",
    scheduledAt: new Date("2026-08-05T18:00:00.000Z"),
    durationMinutes: 30,
    appointmentTypeId: SERVICIO.id,
    exclusive: false,
    assignedUserId: "u_ana",
    createdByUserId: "u_ana",
    isTest: false,
    connector: "enlace-fijo",
    externalRef: null,
    meetingLink: null,
    linkPending: false,
    notes: null,
    contactId: "ct_1",
  };

  it("reprogramar encima de otra cita compatible pide confirmación", async () => {
    const { rescheduleBooking } = await import("@/server/agenda/service");
    selectRows.push([CITA]);
    busyRows = [busy({})];

    await expect(
      rescheduleBooking({
        organizationId: "org_1",
        bookingId: CITA.id,
        startUtc: SLOT,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "overlap_warning" });
  });

  it("…y con la confirmación se mueve", async () => {
    const { rescheduleBooking } = await import("@/server/agenda/service");
    selectRows.push([CITA]);
    busyRows = [busy({})];

    const result = await rescheduleBooking({
      organizationId: "org_1",
      bookingId: CITA.id,
      startUtc: SLOT,
      now: NOW,
      confirmOverlap: true,
    });
    expect(result.typeName).toBe("Servicio");
  });

  it("el bot (strict) no reprograma encima de nada", async () => {
    const { rescheduleBooking } = await import("@/server/agenda/service");
    selectRows.push([CITA]);
    busyRows = [busy({})];

    await expect(
      rescheduleBooking({
        organizationId: "org_1",
        bookingId: CITA.id,
        startUtc: SLOT,
        now: NOW,
        mode: "strict",
        confirmOverlap: true,
      })
    ).rejects.toMatchObject({ code: "slot_taken" });
  });

  it("reasignar a un vendedor con otra cita traslapada se rechaza con el detalle", async () => {
    const { assignBooking } = await import("@/server/agenda/service");
    selectRows.push([CITA]);
    selectRows.push([{ id: "mem_pedro" }]);
    busyRows = [
      busy({
        scheduledAt: CITA.scheduledAt,
        assignedUserId: "u_pedro",
        sellerName: "Pedro",
      }),
    ];

    const promise = assignBooking({
      organizationId: "org_1",
      bookingId: CITA.id,
      userId: "u_pedro",
    });
    await expect(promise).rejects.toMatchObject({ code: "slot_taken" });
    await promise.catch((err) => {
      expect(err.conflicts.map((c: { sellerName: string }) => c.sellerName)).toEqual([
        "Pedro",
      ]);
    });
  });

  it("reasignar ignora las citas de OTROS vendedores a esa hora", async () => {
    const { assignBooking } = await import("@/server/agenda/service");
    selectRows.push([CITA]);
    selectRows.push([{ id: "mem_pedro" }]);
    busyRows = [busy({ scheduledAt: CITA.scheduledAt })]; // de Juan

    const row = await assignBooking({
      organizationId: "org_1",
      bookingId: CITA.id,
      userId: "u_pedro",
    });
    expect(row.assignedUserId).toBe("u_pedro");
  });

  it("reasignar a alguien que no es miembro es invalid", async () => {
    const { assignBooking } = await import("@/server/agenda/service");
    selectRows.push([CITA]);
    selectRows.push([]);

    await expect(
      assignBooking({ organizationId: "org_1", bookingId: CITA.id, userId: "u_x" })
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("no_show → realizada valida que el hueco no choque (hard)", async () => {
    const { markBookingStatus } = await import("@/server/agenda/service");
    selectRows.push([
      {
        ...CITA,
        status: "no_show",
        appointmentTypeId: PRUEBA.id,
        exclusive: true,
        durationMinutes: 60,
      },
    ]);
    // Otra Prueba de manejo se agendó encima mientras estaba en no_show.
    busyRows = [
      busy({
        scheduledAt: CITA.scheduledAt,
        typeId: PRUEBA.id,
        exclusive: true,
        typeName: PRUEBA.name,
      }),
    ];

    await expect(
      markBookingStatus({
        organizationId: "org_1",
        bookingId: CITA.id,
        status: "realizada",
      })
    ).rejects.toMatchObject({ code: "slot_taken" });
  });
});
