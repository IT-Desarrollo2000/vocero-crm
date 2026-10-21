import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 023 — El agente agenda visitas con TIPO de cita (US-5).
 *
 * Una sola regla de tipo al ofrecer: el nombre resuelve ⇒ ese; si no y hay un
 * solo tipo activo ⇒ ese; si no ⇒ se pregunta con los nombres reales. La
 * confirmación la redacta el motor (tipo, fecha y dirección reales).
 */

type T = {
  id: string;
  name: string;
  durationMinutes: number;
  exclusive: boolean;
  active: boolean;
  position: number;
};
const PRUEBA: T = {
  id: "apt_p",
  name: "Prueba de manejo",
  durationMinutes: 60,
  exclusive: true,
  active: true,
  position: 0,
};
const SERVICIO: T = { ...PRUEBA, id: "apt_s", name: "Servicio", durationMinutes: 30, exclusive: false, position: 1 };
const GARANTIA: T = { ...SERVICIO, id: "apt_g", name: "Garantía", position: 2 };
const OTRO: T = { ...SERVICIO, id: "apt_o", name: "Otro", position: 3 };

let types: T[] = [];
const settings = {
  weeklyHours: { wed: [{ start: "09:00", end: "18:00" }] },
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 0,
  maxDaysAhead: 7,
  timezone: "America/Mexico_City",
  connector: "enlace-fijo" as const,
  meetingLink: null,
  address: null as string | null,
};

const computeAvailability = vi.fn(async (_org: string, _opts: unknown) => [
  {
    startUtc: "2099-08-05T15:00:00.000Z",
    endUtc: "2099-08-05T16:00:00.000Z",
    label: "mié 5 ago, 09:00",
    conflicts: [],
  },
]);
const replaceOffers = vi.fn(async (..._args: unknown[]) => {});
const createSessionBooking = vi.fn();

vi.mock("@/server/agenda/types-store", () => ({
  listTypes: async () => types.filter((t) => t.active),
}));
vi.mock("@/server/agenda/settings", () => ({ getSettings: async () => settings }));
vi.mock("@/server/agenda/availability", () => ({ computeAvailability }));
vi.mock("@/server/agenda/offers", async (importOriginal) => ({
  // findOffered real (epoch exacto); la BD, simulada.
  ...(await importOriginal<typeof import("@/server/agenda/offers")>()),
  replaceOffers,
  getOffers: async () => [],
}));
vi.mock("@/server/agenda/service", async () => {
  // BookingError y TYPE_GONE_MESSAGE reales: son el contrato con el agente.
  class BookingError extends Error {
    code: string;
    slots: unknown[];
    conflicts: unknown[];
    constructor(code: string, message: string, slots: unknown[] = []) {
      super(message);
      this.code = code;
      this.slots = slots;
      this.conflicts = [];
    }
  }
  return {
    BookingError,
    TYPE_GONE_MESSAGE: "Ese tipo de cita ya no está disponible",
    createSessionBooking,
  };
});

const { offerSlots, bookSlot, typeQuestion } = await import(
  "@/server/agenda/agent"
);
const { BookingError } = (await import("@/server/agenda/service")) as unknown as {
  BookingError: new (code: string, message: string, slots?: unknown[]) => Error;
};

const base = { organizationId: "org_1", conversationId: "cv_1" };
/** 025 — Reloj del motor: el día de la oferta simulada (mié 5 ago 2099). */
const NOW = new Date("2099-08-05T12:00:00.000Z");
/** 025 — La oferta vigente del turno (el array que vio el prompt). */
const OFFERS = [
  { startUtc: "2099-08-05T15:00:00.000Z", label: "mié 5 ago, 09:00", typeId: "apt_s" },
];
const book = (over: Record<string, unknown> = {}) =>
  bookSlot({ ...base, startUtc: "2099-08-05T15:00:00.000Z", offers: OFFERS, now: NOW, ...over });

beforeEach(() => {
  types = [PRUEBA, SERVICIO, GARANTIA, OTRO];
  settings.address = null;
  computeAvailability.mockClear();
  replaceOffers.mockClear();
  createSessionBooking.mockReset();
});

describe("offerSlots — el tipo", () => {
  it("sin tipo y con varios activos: pregunta con los nombres reales, sin calcular nada", async () => {
    const turn = await offerSlots(base);
    expect(turn.ok).toBe(false);
    expect(turn.text).toBe(
      "¿Qué tipo de cita te interesa? Tengo: Prueba de manejo, Servicio, Garantía u Otro."
    );
    expect(computeAvailability).not.toHaveBeenCalled();
    expect(replaceOffers).not.toHaveBeenCalled();
  });

  it("un tipo desconocido también pregunta (no adivina)", async () => {
    const turn = await offerSlots({ ...base, typeName: "lavado" });
    expect(turn.ok).toBe(false);
    expect(turn.text).toContain("¿Qué tipo de cita te interesa?");
  });

  it("con un solo tipo activo ofrece ese aunque el modelo no lo diga", async () => {
    types = [SERVICIO, { ...PRUEBA, active: false }];
    const turn = await offerSlots(base);
    expect(turn.ok).toBe(true);
    expect(computeAvailability.mock.calls[0]![1]).toMatchObject({ durationMinutes: 30 });
    expect(replaceOffers.mock.calls[0]![3]).toBe(SERVICIO.id);
  });

  it("el nombre (prefijo único, sin acentos) resuelve: duración del tipo y oferta con su id", async () => {
    const turn = await offerSlots({ ...base, typeName: "PRUEBA" });
    expect(turn.ok).toBe(true);
    expect(turn.text).toMatch(/^Tengo estos horarios disponibles para tu prueba de manejo:/);
    // 025 — Sin fecha, invita a pedir otro día.
    expect(turn.text).toMatch(/Si prefieres otro día, dime cuál\.$/);
    const opts = computeAvailability.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.durationMinutes).toBe(60);
    // Sin ctx = strict: la IA no ofrece huecos con ninguna cita.
    expect(opts.ctx).toBeUndefined();
    expect(replaceOffers.mock.calls[0]![3]).toBe(PRUEBA.id);
  });

  it("sin tipos activos no promete agendar", () => {
    expect(typeQuestion([])).toContain("no puedo agendar en línea");
  });
});

describe("bookSlot — la confirmación", () => {
  const ok = {
    booking: { id: "bk_1" },
    meetingLink: null,
    linkPending: false,
    label: "mié 5 ago, 09:00",
    typeName: "Servicio",
  };

  it("con dirección: tipo en minúsculas, fecha y «Te esperamos en …», sin enlace", async () => {
    settings.address = "Av. Juárez 100, Centro";
    createSessionBooking.mockResolvedValue(ok);
    const turn = await book();
    expect(turn).toEqual({
      ok: true,
      text: "¡Listo! Te agendé tu servicio para mié 5 ago, 09:00. Te esperamos en Av. Juárez 100, Centro.",
      agentAction: { action: "book_slot", booked: "mié 5 ago 09:00" },
    });
    expect(createSessionBooking.mock.calls[0]![0]).toMatchObject({
      source: "ai",
      requireOffer: true,
    });
  });

  it("sin dirección no inventa una; con enlace, lo agrega", async () => {
    createSessionBooking.mockResolvedValue({ ...ok, meetingLink: "https://meet.x/1" });
    const turn = await book();
    expect(turn.text).toBe(
      "¡Listo! Te agendé tu servicio para mié 5 ago, 09:00.\nEnlace: https://meet.x/1"
    );
  });

  it("tipo desactivado entre la oferta y la reserva ⇒ pregunta el tipo (A11)", async () => {
    createSessionBooking.mockRejectedValue(
      new BookingError("slot_taken", "Ese tipo de cita ya no está disponible")
    );
    const turn = await book();
    expect(turn.ok).toBe(false);
    expect(turn.text).toContain("¿Qué tipo de cita te interesa?");
  });

  it("tipo desactivado y queda UNO: la disculpa nombra el tipo que se ofrece", async () => {
    types = [SERVICIO];
    createSessionBooking.mockRejectedValue(
      new BookingError("slot_taken", "Ese tipo de cita ya no está disponible", [
        { startUtc: "2099-08-05T15:00:00.000Z", label: "mié 5 ago, 09:00", typeId: SERVICIO.id },
      ])
    );
    const turn = await book();
    expect(turn).toMatchObject({
      ok: false,
      text: "Ese tipo de cita ya no está disponible; te puedo ofrecer servicio:\n• mié 5 ago, 09:00",
    });
  });

  it("se ocupó (slot_taken) NO pregunta el tipo: re-ofrece ese día con el tipo de la oferta (A7)", async () => {
    createSessionBooking.mockRejectedValue(
      new BookingError("slot_taken", "Ese horario ya no está disponible")
    );
    const turn = await book();
    expect(turn.ok).toBe(false);
    expect(turn.text).not.toContain("¿Qué tipo de cita");
    expect(turn.text).toMatch(/^Se me acaba de ocupar ese horario, ¡perdón!\nPara el miércoles 5 de agosto/);
    expect(replaceOffers.mock.calls[0]![3]).toBe(SERVICIO.id);
  });

  it("un startUtc que NO está en el array del turno no llega a la reserva (A2)", async () => {
    const turn = await book({ startUtc: "2099-08-05T16:00:00.000Z" });
    expect(createSessionBooking).not.toHaveBeenCalled();
    expect(turn.ok).toBe(false);
    expect(turn.text).toMatch(/^Ese horario no lo tengo disponible\./);
  });
});

describe("prompt y esquema de acciones", () => {
  it("offer_slots acepta `type` y es tolerante con vacío o basura", async () => {
    const { agentActionSchema } = await import("@/server/ai/actions");
    const schema = agentActionSchema(true);
    const a = schema.parse({ action: "offer_slots", type: " Servicio " });
    expect(a).toMatchObject({ action: "offer_slots", type: "Servicio" });
    for (const type of ["", null, 5, { x: 1 }]) {
      const r = schema.safeParse({ action: "offer_slots", type });
      expect(r.success).toBe(true);
      expect((r.data as { type?: string }).type).toBeUndefined();
    }
  });

  it("el prompt lista los tipos, pide el tipo antes de ofrecer y ya no dice WhatsApp", async () => {
    const { buildAgentSystemPrompt } = await import("@/server/ai/prompts");
    const profile = { name: "Vale" } as never;
    const p = buildAgentSystemPrompt({
      profile,
      kb: [],
      stages: [{ name: "Nuevo" }],
      agenda: true,
      appointmentTypes: ["Prueba de manejo", "Servicio"],
    });
    expect(p).toContain(
      '{"action":"offer_slots","type":"<Prueba de manejo | Servicio>","date":"<YYYY-MM-DD, opcional>","part":"<mañana | tarde, opcional>","reply":"..."}'
    );
    expect(p).toContain(
      '{"action":"book_slot","slot":"<YYYY-MM-DD HH:MM, la clave exacta de HORARIOS OFRECIDOS>","reply":"..."}'
    );
    expect(p).not.toContain("ISO UTC");
    expect(p).toContain("necesitas el tipo de cita");
    expect(p).toContain("el asistente de mensajería de este negocio");
    expect(p).not.toContain("asistente de WhatsApp");

    const sinAgenda = buildAgentSystemPrompt({
      profile,
      kb: [],
      stages: [{ name: "Nuevo" }],
      appointmentTypes: ["Servicio"],
    });
    expect(sinAgenda).not.toContain("offer_slots");
  });
});
