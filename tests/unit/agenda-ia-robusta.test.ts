import { beforeEach, describe, expect, it, vi } from "vitest";
import { zonedWallClockToUtc } from "@/lib/time/slots";

/**
 * 025 — Agenda por IA robusta (incidente del 21-oct): día pedido y franja,
 * reservar con la clave LOCAL contra el array del turno, re-oferta sin
 * repetir, trato tú/usted, y el prompt con la fecha, el calendario y las
 * ofertas vigentes.
 */

const tz = "America/Mexico_City";
// Miércoles 21 de octubre de 2026, 12:24 en CDMX.
const NOW = new Date("2026-10-21T18:24:00.000Z");
const at = (day: string, hhmm: string) =>
  zonedWallClockToUtc(day, hhmm, tz)!.toISOString();

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
const SERVICIO: T = { ...PRUEBA, id: "apt_s", name: "Servicio", position: 1 };
let types: T[] = [];

const settings = {
  weeklyHours: {},
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 0,
  maxDaysAhead: 7,
  timezone: tz,
  connector: "enlace-fijo" as const,
  meetingLink: null,
  address: "Blvd. Adolfo Ruiz Cortines 915" as string | null,
};

/** Huecos reales: hoy 3 por la tarde, jueves 2, viernes de 9 a 17 cada hora, sábado nada, lunes 2. */
const FRIDAY = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"];
function availability() {
  const days: [string, string[]][] = [
    ["2026-10-21", ["15:00", "16:00", "17:00"]],
    ["2026-10-22", ["10:00", "11:00"]],
    ["2026-10-23", FRIDAY],
    ["2026-10-26", ["10:00", "16:00"]],
  ];
  return days.flatMap(([day, hours]) =>
    hours.map((h) => ({
      startUtc: at(day, h),
      endUtc: at(day, h),
      label: `${day} ${h}`,
      conflicts: [],
    }))
  );
}

const computeAvailability = vi.fn(async (_org: string, _opts: unknown) => availability());
const replaceOffers = vi.fn(async (..._args: unknown[]) => {});
const createSessionBooking = vi.fn();

vi.mock("@/server/agenda/types-store", () => ({
  listTypes: async () => types.filter((t) => t.active),
}));
vi.mock("@/server/agenda/settings", () => ({
  getSettings: async () => settings,
  DEFAULT_TIMEZONE: "America/Mexico_City",
}));
vi.mock("@/server/agenda/availability", () => ({ computeAvailability }));
vi.mock("@/server/agenda/offers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/agenda/offers")>()),
  replaceOffers,
  getOffers: async () => [],
}));
vi.mock("@/server/agenda/service", async () => {
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

const { offerSlots, bookSlot, isTypeQuestion, typeQuestion } = await import(
  "@/server/agenda/agent"
);
const { AGENDA_COPY } = await import("@/server/agenda/copy");
const { BookingError } = (await import("@/server/agenda/service")) as unknown as {
  BookingError: new (code: string, message: string, slots?: unknown[]) => Error;
};

const base = { organizationId: "org_1", conversationId: "cv_1", now: NOW };
type Registered = { startUtc: string; label: string }[];
const registered = (call = 0) => replaceOffers.mock.calls[call]![2] as Registered;

beforeEach(() => {
  types = [PRUEBA, SERVICIO];
  computeAvailability.mockClear();
  replaceOffers.mockClear();
  createSessionBooking.mockReset();
});

describe("copy — trato", () => {
  it("ninguna cadena de usted tutea", () => {
    const tuteo = /\b(te|tu|tus|ti|tienes|déjame|puedes|quieres)\b/i;
    for (const [key, text] of Object.entries(AGENDA_COPY.usted)) {
      expect(text, key).not.toMatch(tuteo);
    }
  });

  it("las dos tablas tienen las mismas claves", () => {
    expect(Object.keys(AGENDA_COPY.usted).sort()).toEqual(Object.keys(AGENDA_COPY.tu).sort());
  });

  it("isTypeQuestion reconoce tú, usted y el prefijo viejo de la 023", () => {
    expect(isTypeQuestion(typeQuestion([PRUEBA, SERVICIO], "usted"))).toBe(true);
    expect(isTypeQuestion(typeQuestion([PRUEBA, SERVICIO], "tu"))).toBe(true);
    expect(isTypeQuestion("¿Qué tipo de cita te interesa? Tengo: A o B.")).toBe(true);
    expect(isTypeQuestion("  ¿Qué tipo de cita le interesa?")).toBe(true);
    expect(isTypeQuestion("¿Le interesa una prueba?")).toBe(false);
    expect(typeQuestion([PRUEBA, SERVICIO], "usted")).toBe(
      "¿Qué tipo de cita le interesa? Tengo: Prueba de manejo o Servicio."
    );
  });
});

describe("offerSlots — día y franja (US-1, A3)", () => {
  it("con date: registra TODO el día, enseña 4 repartidos y lo dice en usted", async () => {
    const turn = await offerSlots({
      ...base,
      typeName: "prueba",
      date: "2026-10-23",
      formality: "usted",
    });
    expect(turn.ok).toBe(true);
    expect(registered().map((s) => s.startUtc)).toEqual(FRIDAY.map((h) => at("2026-10-23", h)));
    expect(replaceOffers.mock.calls[0]![3]).toBe(PRUEBA.id);
    expect(turn.text).toBe(
      "Para el viernes 23 de octubre tengo estos horarios para su prueba de manejo:\n• 09:00\n• 12:00\n• 14:00\n• 17:00"
    );
    expect(turn.agentAction).toEqual({
      action: "offer_slots",
      type: "Prueba de manejo",
      date: "2026-10-23",
      part: null,
      shown: ["vie 23 oct 09:00", "vie 23 oct 12:00", "vie 23 oct 14:00", "vie 23 oct 17:00"],
    });
  });

  it("con part=tarde: solo huecos de las 12:00 en adelante (hora local)", async () => {
    const turn = await offerSlots({ ...base, typeName: "prueba", date: "2026-10-23", part: "tarde" });
    expect(registered().map((s) => s.startUtc)).toEqual(
      ["12:00", "13:00", "14:00", "15:00", "16:00", "17:00"].map((h) => at("2026-10-23", h))
    );
    expect(turn.agentAction).toMatchObject({ part: "tarde" });
  });

  it("día sin huecos (sábado) ⇒ el más cercano posterior, diciéndolo", async () => {
    const turn = await offerSlots({ ...base, typeName: "prueba", date: "2026-10-24", formality: "usted" });
    expect(turn.ok).toBe(true);
    expect(turn.text).toMatch(
      /^Ese día ya no tengo horarios para su prueba de manejo; el más cercano es el lunes 26 de octubre:/
    );
    expect(turn.agentAction).toMatchObject({ date: "2026-10-26" });
  });

  it("fuera de la ventana (más allá de maxDaysAhead) ⇒ el día válido más cercano", async () => {
    const turn = await offerSlots({ ...base, typeName: "prueba", date: "2026-11-30" });
    expect(turn.text).toMatch(/^Ese día ya no tengo horarios/);
    expect(turn.agentAction).toMatchObject({ date: "2026-10-26" });
  });

  it("una fecha pasada ⇒ desde hoy", async () => {
    const turn = await offerSlots({ ...base, typeName: "prueba", date: "2026-10-01" });
    expect(turn.agentAction).toMatchObject({ date: "2026-10-21" });
  });

  it("sin date: catálogo de varios días, enseña 3 e invita a pedir otro día (usted)", async () => {
    const turn = await offerSlots({ ...base, typeName: "prueba", formality: "usted" });
    expect(turn.text).toMatch(/^Tengo estos horarios disponibles para su prueba de manejo:/);
    expect(turn.text).toMatch(/Si prefiere otro día, dígame cuál\.$/);
    expect(turn.agentAction).toMatchObject({ date: null, shown: ["mié 21 oct 15:00", "mié 21 oct 16:00", "mié 21 oct 17:00"] });
  });

  it("R4: con intro del modelo el encabezado del motor sigue (con y sin date) y la intro va primero", async () => {
    const sinDia = await offerSlots({ ...base, typeName: "prueba", formality: "usted", intro: "¡Claro!" });
    expect(sinDia.text).toMatch(/^¡Claro!\nTengo estos horarios disponibles para su prueba de manejo:\n• /);
    expect(sinDia.agentAction).toMatchObject({ reply: "¡Claro!" });
    const conDia = await offerSlots({
      ...base,
      typeName: "prueba",
      date: "2026-10-23",
      formality: "usted",
      intro: "¡Claro!",
    });
    expect(conDia.text).toMatch(/^¡Claro!\nPara el viernes 23 de octubre tengo estos horarios para su prueba de manejo:\n• /);
  });

  it("sin date y con lo ya mostrado: no repite los mismos 3", async () => {
    const turn = await offerSlots({
      ...base,
      typeName: "prueba",
      exclude: ["mié 21 oct 15:00", "mié 21 oct 16:00", "mié 21 oct 17:00"],
    });
    const shown = (turn.agentAction as { shown: string[] }).shown;
    expect(shown).not.toContain("mié 21 oct 15:00");
    expect(shown[0]).toBe("jue 22 oct 10:00");
  });
});

describe("bookSlot — clave local contra el array del turno (US-2, A2)", () => {
  const offers = FRIDAY.map((h) => ({
    startUtc: at("2026-10-23", h),
    label: `vie 23 oct, ${h}`,
    typeId: PRUEBA.id,
  }));
  const shown = ["vie 23 oct 09:00", "vie 23 oct 12:00", "vie 23 oct 14:00", "vie 23 oct 17:00"];

  it('slot "2026-10-23 11:00" ⇒ reserva el instante de esa oferta, confirmación en usted', async () => {
    createSessionBooking.mockResolvedValue({
      booking: { id: "bk_1" },
      meetingLink: null,
      linkPending: false,
      label: "vie 23 oct, 11:00",
      typeName: "Prueba de manejo",
    });
    const turn = await bookSlot({ ...base, slot: "2026-10-23 11:00", offers, shown, formality: "usted" });
    expect(createSessionBooking.mock.calls[0]![0]).toMatchObject({
      startUtc: at("2026-10-23", "11:00"),
      source: "ai",
      requireOffer: true,
    });
    expect(turn).toEqual({
      ok: true,
      text: "¡Listo! Le agendé su prueba de manejo para vie 23 oct, 11:00. Le esperamos en Blvd. Adolfo Ruiz Cortines 915.",
      agentAction: { action: "book_slot", booked: "vie 23 oct 11:00" },
    });
  });

  it("acepta la clave con T, hora de un dígito y el día pegado", async () => {
    createSessionBooking.mockResolvedValue({
      booking: { id: "bk_1" },
      meetingLink: null,
      linkPending: false,
      label: "vie 23 oct, 09:00",
      typeName: "Prueba de manejo",
    });
    await bookSlot({ ...base, slot: "2026-10-23T9:00 (vie)", offers });
    expect(createSessionBooking.mock.calls[0]![0]).toMatchObject({ startUtc: at("2026-10-23", "09:00") });
  });

  it("slot no ofrecido ⇒ NO reserva; re-oferta del día sin repetir lo mostrado", async () => {
    const turn = await bookSlot({ ...base, slot: "2026-10-23 10:30", offers, shown, formality: "usted" });
    expect(createSessionBooking).not.toHaveBeenCalled();
    expect(turn.ok).toBe(false);
    expect(turn.text).toMatch(/^Ese horario no lo tengo disponible\.\nPara el viernes 23 de octubre/);
    const again = (turn.agentAction as { shown: string[]; date: string }).shown;
    expect((turn.agentAction as { date: string }).date).toBe("2026-10-23");
    for (const s of shown) expect(again).not.toContain(s);
    // El tipo de la re-oferta es el de la oferta vigente.
    expect(replaceOffers.mock.calls[0]![3]).toBe(PRUEBA.id);
  });

  it("el día inventado del incidente (sábado 24) ⇒ re-oferta del día válido más cercano", async () => {
    const turn = await bookSlot({ ...base, slot: "2026-10-24 11:00", offers, shown });
    expect(createSessionBooking).not.toHaveBeenCalled();
    expect(turn.text).toMatch(/^Ese horario no lo tengo disponible\.\nEse día ya no tengo horarios/);
  });

  it("slot_taken al confirmar ⇒ re-oferta del MISMO día (A7)", async () => {
    createSessionBooking.mockRejectedValue(
      new BookingError("slot_taken", "Ese horario ya no está disponible")
    );
    const turn = await bookSlot({ ...base, slot: "2026-10-23 11:00", offers, shown, formality: "usted" });
    expect(turn.ok).toBe(false);
    expect(turn.text).toMatch(/^Se me acaba de ocupar ese horario, ¡disculpe!\nPara el viernes 23 de octubre/);
  });

  it("slot_not_offered de la BD (la oferta cambió) ⇒ re-oferta del día", async () => {
    createSessionBooking.mockRejectedValue(
      new BookingError("slot_not_offered", "Ese horario no se ofreció en esta conversación")
    );
    const turn = await bookSlot({ ...base, slot: "2026-10-23 11:00", offers, shown });
    expect(turn.text).toMatch(/^Ese horario no lo tengo disponible\.\nPara el viernes 23 de octubre/);
  });

  it("B1: la intro del modelo (el precio) se antepone a la confirmación y se guarda en agent_action", async () => {
    createSessionBooking.mockResolvedValue({
      booking: { id: "bk_1" },
      meetingLink: null,
      linkPending: false,
      label: "vie 23 oct, 11:00",
      typeName: "Prueba de manejo",
    });
    const turn = await bookSlot({
      ...base,
      slot: "2026-10-23 11:00",
      offers,
      shown,
      formality: "usted",
      intro: "El Macaron 2P cuesta $285,990.",
    });
    expect(turn.text).toBe(
      "El Macaron 2P cuesta $285,990.\n¡Listo! Le agendé su prueba de manejo para vie 23 oct, 11:00. Le esperamos en Blvd. Adolfo Ruiz Cortines 915."
    );
    expect(turn.agentAction).toEqual({
      action: "book_slot",
      booked: "vie 23 oct 11:00",
      reply: "El Macaron 2P cuesta $285,990.",
    });
  });

  it("B1: también en la re-oferta (no ofrecido / slot_taken) la intro va primero", async () => {
    const notOffered = await bookSlot({
      ...base,
      slot: "2026-10-23 10:30",
      offers,
      shown,
      formality: "usted",
      intro: "El Macaron 2P cuesta $285,990.",
    });
    expect(notOffered.text).toMatch(
      /^El Macaron 2P cuesta \$285,990\.\nEse horario no lo tengo disponible\.\nPara el viernes 23 de octubre/
    );
    createSessionBooking.mockRejectedValue(
      new BookingError("slot_taken", "Ese horario ya no está disponible")
    );
    const taken = await bookSlot({
      ...base,
      slot: "2026-10-23 11:00",
      offers,
      shown,
      formality: "usted",
      intro: "Con gusto.",
    });
    expect(taken.text).toMatch(/^Con gusto\.\nSe me acaba de ocupar ese horario, ¡disculpe!\nPara el viernes/);
  });

  it("sin slot ni startUtc ⇒ re-oferta de lo no mostrado (nunca reserva)", async () => {
    const turn = await bookSlot({ ...base, offers, shown: ["mié 21 oct 15:00"] });
    expect(createSessionBooking).not.toHaveBeenCalled();
    expect(turn.ok).toBe(false);
    expect((turn.agentAction as { shown: string[] }).shown).not.toContain("mié 21 oct 15:00");
  });
});

describe("HORARIOS OFRECIDOS y calendario (formato del prompt)", () => {
  it("una línea por oferta con su clave local; * = lo que el cliente vio", async () => {
    const { formatOffersForPrompt } = await import("@/server/agenda/offer-format");
    const block = formatOffersForPrompt(
      [
        { startUtc: at("2026-10-23", "10:00"), typeName: "Prueba de manejo" },
        { startUtc: at("2026-10-23", "11:00"), typeName: "Prueba de manejo" },
        { startUtc: at("2026-10-24", "09:00"), typeName: null },
      ],
      tz,
      ["vie 23 oct 11:00"]
    );
    expect(block).toBe(
      [
        'HORARIOS OFRECIDOS (vigentes en esta conversación; reserva con book_slot y "slot" = la clave exacta "YYYY-MM-DD HH:MM"; * = los que el cliente vio en tu último mensaje de horarios):',
        "- 2026-10-23 10:00 (vie) — Prueba de manejo",
        "* 2026-10-23 11:00 (vie) — Prueba de manejo",
        "- 2026-10-24 09:00 (sáb)",
      ].join("\n")
    );
    expect(formatOffersForPrompt([], tz)).toBe(
      "HORARIOS OFRECIDOS: ninguno vigente. Para reservar, primero ofrece con offer_slots."
    );
  });

  it("calendario: hoy fijo y 14 días con la fecha REAL del próximo viernes", async () => {
    const { renderAgendaCalendar } = await import("@/server/agenda/offer-format");
    const cal = renderAgendaCalendar(NOW, tz);
    const [hoy, proximos] = cal.split("\n");
    expect(hoy).toBe("Hoy: miércoles 21 oct 2026 12:24 (America/Mexico_City) = 2026-10-21");
    expect(proximos).toMatch(/^Próximos días: jue 22=2026-10-22, vie 23=2026-10-23, sáb 24=2026-10-24,/);
    expect(proximos!.split(", ")).toHaveLength(14);
    expect(proximos).toMatch(/mié 4=2026-11-04$/);
  });
});

describe("buildAgentSystemPrompt — agenda y trato", () => {
  const profile = { name: "Vale", formality: "usted" } as never;
  const build = async (agenda: boolean) => {
    const { buildAgentSystemPrompt } = await import("@/server/ai/prompts");
    return buildAgentSystemPrompt({
      profile,
      kb: [],
      stages: [{ name: "Nuevo" }],
      agenda,
      appointmentTypes: ["Prueba de manejo", "Servicio"],
      now: NOW,
      timezone: tz,
      offers: [{ startUtc: at("2026-10-23", "11:00"), typeName: "Prueba de manejo" }],
      shownSlots: ["vie 23 oct 11:00"],
    });
  };

  it("con agenda: hoy, calendario, ofertas, reglas nuevas y trato usted", async () => {
    const p = await build(true);
    expect(p).toContain("Hoy: miércoles 21 oct 2026 12:24 (America/Mexico_City) = 2026-10-21");
    expect(p).toContain("vie 23=2026-10-23");
    expect(p).toContain("* 2026-10-23 11:00 (vie) — Prueba de manejo");
    expect(p).toContain('usa offer_slots con "date"');
    expect(p).toContain('book_slot con "slot"');
    expect(p).toContain("Una hora suelta del cliente");
    expect(p).toContain("NO digas que lo pasas con un asesor");
    expect(p).toContain("si hay varios mensajes nuevos suyos, atiéndelos todos");
    expect(p).toContain("Trato con el cliente: de USTED");
  });

  it("sin agenda: nada de agenda, pero el trato sigue", async () => {
    const p = await build(false);
    for (const s of ["AGENDA:", "HORARIOS OFRECIDOS", "Próximos días", "offer_slots", "book_slot", "Hoy:"]) {
      expect(p).not.toContain(s);
    }
    expect(p).toContain("Trato con el cliente: de USTED");
  });

  it("perfil sin trato ⇒ tú", async () => {
    const { buildAgentSystemPrompt } = await import("@/server/ai/prompts");
    const p = buildAgentSystemPrompt({ profile: { name: "Vale" } as never, kb: [], stages: [] });
    expect(p).toContain("Trato con el cliente: de TÚ");
  });
});

describe("actions — campos tolerantes", () => {
  it("offer_slots: date y part normalizados; basura ⇒ ausente", async () => {
    const { agentActionSchema } = await import("@/server/ai/actions");
    const schema = agentActionSchema(true);
    expect(
      schema.parse({ action: "offer_slots", date: "2026-10-23", part: "Mañana" })
    ).toMatchObject({ date: "2026-10-23", part: "mañana" });
    expect(
      schema.parse({ action: "offer_slots", date: "2026-10-23T00:00:00Z", part: "PM" })
    ).toMatchObject({ date: "2026-10-23", part: "tarde" });
    const junk = schema.parse({ action: "offer_slots", date: "el viernes", part: 3 }) as {
      date?: string;
      part?: string;
    };
    expect(junk.date).toBeUndefined();
    expect(junk.part).toBeUndefined();
  });

  it("book_slot: slot normalizado, startUtc opcional, sin ninguno sigue siendo válido", async () => {
    const { agentActionSchema } = await import("@/server/ai/actions");
    const schema = agentActionSchema(true);
    expect(schema.parse({ action: "book_slot", slot: "2026-10-23 9:00 (vie)" })).toMatchObject({
      slot: "2026-10-23 09:00",
    });
    expect(schema.parse({ action: "book_slot", startUtc: "2026-10-23T17:00:00Z" })).toMatchObject({
      startUtc: "2026-10-23T17:00:00Z",
    });
    const bare = schema.safeParse({ action: "book_slot", slot: 15, startUtc: "" });
    expect(bare.success).toBe(true);
    expect(bare.data).toMatchObject({ action: "book_slot" });
    expect((bare.data as { slot?: string }).slot).toBeUndefined();
    expect((bare.data as { startUtc?: string }).startUtc).toBeUndefined();
  });

  it("sin agenda, las acciones de agenda no existen", async () => {
    const { agentActionSchema } = await import("@/server/ai/actions");
    expect(agentActionSchema(false).safeParse({ action: "book_slot", slot: "2026-10-23 11:00" }).success).toBe(false);
  });
});
