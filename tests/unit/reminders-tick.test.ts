import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ReminderBooking,
  ReminderOrgConfig,
  ReminderRow,
} from "@/server/agenda/reminder-store";

/**
 * 10 — Recordatorios de cita: el tick, el rescate y el reintento con un
 * almacén SIMULADO en memoria que respeta lo que la BD garantiza: el UNIQUE
 * `(booking_id, offset_minutes, scheduled_for)` del claim, el UPDATE
 * condicionado del reintento y el filtro de candidatos (sesión, agendada,
 * no prueba, en ventana). El reloj se inyecta: nada espera de verdad.
 */

const MIN = 60_000;
const H = 60 * MIN;
const ORG = "org_1";

type Db = {
  configs: ReminderOrgConfig[];
  bookings: ReminderBooking[];
  rows: (ReminderRow & { organizationId: string; claimedAt: Date })[];
  templates: { id: string; status: string; body: string }[];
};
const db: Db = { configs: [], bookings: [], rows: [], templates: [] };
let seq = 0;

function claimKey(bookingId: string, offset: number, scheduledFor: Date) {
  return `${bookingId}|${offset}|${scheduledFor.getTime()}`;
}

vi.mock("@/server/agenda/reminder-store", async (orig) => {
  const real = await orig<typeof import("@/server/agenda/reminder-store")>();
  return {
    normalizeOffsets: real.normalizeOffsets,
    normalizeVariables: real.normalizeVariables,
    listReminderOrganizations: async () => db.configs.filter((c) => c.enabled),
    getReminderOrgConfig: async (org: string) =>
      db.configs.find((c) => c.organizationId === org) ?? null,
    saveReminderOrgConfig: async () => {},
    listCandidateBookings: async (_org: string, now: Date, maxOffset: number) =>
      db.bookings
        .filter(
          (b) =>
            b.kind === "session" &&
            b.status === "agendada" &&
            !b.isTest &&
            b.scheduledAt.getTime() >= now.getTime() + 15 * MIN &&
            b.scheduledAt.getTime() <= now.getTime() + maxOffset * MIN
        )
        .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime()),
    getReminderBooking: async (_org: string, id: string) =>
      db.bookings.find((b) => b.id === id) ?? null,
    getReminderBookings: async (_org: string, ids: string[]) =>
      db.bookings.filter((b) => ids.includes(b.id)),
    listReminderRows: async (_org: string, ids: string[]) =>
      db.rows.filter((r) => ids.includes(r.bookingId)).map((r) => ({ ...r })),
    getReminderRow: async (_org: string, id: string) => {
      const r = db.rows.find((x) => x.id === id);
      return r ? { ...r } : null;
    },
    // El UNIQUE: la segunda inserción de la misma terna no devuelve fila.
    insertReminderClaim: async (input: {
      organizationId: string;
      bookingId: string;
      offsetMinutes: number;
      scheduledFor: Date;
      now: Date;
    }) => {
      const key = claimKey(input.bookingId, input.offsetMinutes, input.scheduledFor);
      if (db.rows.some((r) => claimKey(r.bookingId, r.offsetMinutes, r.scheduledFor) === key)) {
        return null;
      }
      const id = `brm_${++seq}`;
      db.rows.push({
        id,
        organizationId: input.organizationId,
        bookingId: input.bookingId,
        offsetMinutes: input.offsetMinutes,
        scheduledFor: input.scheduledFor,
        status: "sending",
        reason: null,
        error: null,
        sentAt: null,
        attempts: 1,
        messageId: null,
        delivery: null,
        deliveryError: null,
        claimedAt: input.now,
      });
      return id;
    },
    updateReminder: async (_org: string, id: string, patch: Partial<ReminderRow>) => {
      const r = db.rows.find((x) => x.id === id)!;
      Object.assign(r, patch);
      if (patch.messageId) r.delivery = "pending";
    },
    markStuckReminders: async (now: Date) => {
      const out = [];
      for (const r of db.rows) {
        if (r.status === "sending" && r.claimedAt.getTime() < now.getTime() - 10 * MIN) {
          r.status = "failed";
          r.error = "interrumpido";
          out.push({ id: r.id, bookingId: r.bookingId, organizationId: r.organizationId });
        }
      }
      return out;
    },
    claimReminderRetry: async (input: { reminderId: string; bookingId: string; now: Date }) => {
      const r = db.rows.find(
        (x) =>
          x.id === input.reminderId &&
          x.bookingId === input.bookingId &&
          x.status === "failed" &&
          x.attempts <= 1
      );
      if (!r) return false;
      r.status = "sending";
      r.attempts += 1;
      r.claimedAt = input.now;
      r.error = null;
      return true;
    },
    getReminderTemplate: async (_org: string, id: string) =>
      db.templates.find((t) => t.id === id) ?? null,
    getOrganizationName: async () => "Clínica Sol",
    findRealConversation: async () => ({ id: "cv_real", isTest: false, channel: "whatsapp" }),
    getConversationBrief: async (_org: string, id: string) => ({
      id,
      isTest: id.startsWith("cv_lab"),
      channel: "whatsapp",
    }),
    getMessageWaId: async (_org: string, id: string) => `wamid.${id}`,
  };
});

const sendTemplate = vi.fn();
vi.mock("@/server/whatsapp/templates", async () => {
  const { TemplateError } = await vi.importActual<
    typeof import("@/server/whatsapp/templates")
  >("@/server/whatsapp/templates");
  return { sendTemplate, TemplateError };
});

const publish = vi.fn();
vi.mock("@/server/events/bus", () => ({ publish }));

const getOrCreateConversation = vi.fn(async () => ({ id: "cv_created" }));
vi.mock("@/server/inbox/ingest", () => ({ getOrCreateConversation }));

const { SendError } = await import("@/server/inbox/send");
const { TemplateError } = await import("@/server/whatsapp/templates");
const {
  runReminderTick,
  recoverStuckReminders,
  retryReminder,
  remindersForBookings,
  ReminderError,
} = await import("@/server/agenda/reminders");

const SCHEDULED = new Date("2026-10-20T16:00:00.000Z");
const DUE_24 = new Date(SCHEDULED.getTime() - 24 * H);

function booking(over: Partial<ReminderBooking> = {}): ReminderBooking {
  return {
    id: "bk_1",
    kind: "session",
    status: "agendada",
    isTest: false,
    scheduledAt: SCHEDULED,
    createdAt: new Date(SCHEDULED.getTime() - 3 * 24 * H),
    conversationId: "cv_1",
    meetingLink: null,
    contact: {
      id: "ct_1",
      name: "Ana",
      channel: "whatsapp",
      phone: "5215512345678",
      waUserId: null,
    },
    ...over,
  };
}

function config(over: Partial<ReminderOrgConfig> = {}): ReminderOrgConfig {
  return {
    organizationId: ORG,
    enabled: true,
    enabledAt: new Date("2026-10-01T00:00:00.000Z"),
    templateId: "tpl_1",
    offsetsMinutes: [1440],
    variables: ["contact_name", "booking_datetime", "meeting_link"],
    timezone: "America/Mexico_City",
    ...over,
  };
}

const at = (base: Date, deltaMs: number) => new Date(base.getTime() + deltaMs);

beforeEach(() => {
  db.configs = [config()];
  db.bookings = [booking()];
  db.rows = [];
  db.templates = [
    { id: "tpl_1", status: "approved", body: "Hola {{1}}, tu cita es {{2}}. Sala: {{3}}" },
  ];
  seq = 0;
  sendTemplate.mockReset();
  sendTemplate.mockImplementation(async () => ({ messageId: `msg_${seq}` }));
  publish.mockReset();
  getOrCreateConversation.mockClear();
});

describe("elegibilidad (reloj inyectado)", () => {
  it("antes de vencer no sale; al vencer sale una vez con sus variables", async () => {
    let r = await runReminderTick(at(DUE_24, -5 * MIN));
    expect(r.claimed).toBe(0);
    expect(sendTemplate).not.toHaveBeenCalled();

    r = await runReminderTick(at(DUE_24, MIN));
    expect(r).toMatchObject({ organizations: 1, claimed: 1, sent: 1 });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    const call = sendTemplate.mock.calls[0]![0];
    expect(call.conversationId).toBe("cv_1");
    expect(call.variables[0]).toBe("Ana");
    expect(call.variables[1]).toMatch(/10:00/); // 16:00Z en Ciudad de México
    expect(call.variables[2]).toBe("te lo compartimos por este medio");
    expect(db.rows[0]).toMatchObject({ status: "sent", messageId: "msg_1", waMessageId: "wamid.msg_1" });
    expect(publish).toHaveBeenCalledWith(ORG, { type: "booking.updated", data: { bookingId: "bk_1" } });
  });

  it("dentro de la gracia (6 h) sale; pasada la gracia, nada", async () => {
    expect((await runReminderTick(at(DUE_24, 6 * H + MIN))).claimed).toBe(0);
    expect((await runReminderTick(at(DUE_24, 5 * H))).sent).toBe(1);
  });

  it("encender hoy no avisa vencimientos anteriores a reminder_enabled_at", async () => {
    db.configs = [config({ enabledAt: at(DUE_24, 30 * MIN) })];
    expect((await runReminderTick(at(DUE_24, H))).claimed).toBe(0);
    expect(db.rows).toHaveLength(0);
  });

  it("cita creada dentro de la ventana: el de 24 h no aplica, el de 2 h sí", async () => {
    db.configs = [config({ offsetsMinutes: [1440, 120] })];
    db.bookings = [booking({ createdAt: at(SCHEDULED, -3 * H) })];
    expect((await runReminderTick(at(SCHEDULED, -3 * H + MIN))).claimed).toBe(0);
    const r = await runReminderTick(at(SCHEDULED, -2 * H + MIN));
    expect(r.sent).toBe(1);
    expect(db.rows[0]!.offsetMinutes).toBe(120);
  });

  it("a menos de 15 min de la cita no se reclama nada", async () => {
    db.configs = [config({ offsetsMinutes: [60] })];
    // 60 min → gracia 15 min: a 14 min de la cita ya pasó todo.
    expect((await runReminderTick(at(SCHEDULED, -14 * MIN))).claimed).toBe(0);
  });

  it("reprogramar crea una clave nueva: sale otro; el viejo queda de historial", async () => {
    await runReminderTick(at(DUE_24, MIN));
    const moved = at(SCHEDULED, 3 * 24 * H);
    db.bookings = [booking({ scheduledAt: moved })];
    const r = await runReminderTick(at(moved, -24 * H + MIN));
    expect(r.sent).toBe(1);
    expect(db.rows).toHaveLength(2);
    expect(db.rows.map((x) => x.scheduledFor.getTime())).toEqual([
      SCHEDULED.getTime(),
      moved.getTime(),
    ]);
  });

  it("cancelada / realizada / no_show salen de la consulta: nada se envía", async () => {
    for (const status of ["cancelada", "realizada", "no_show"] as const) {
      db.bookings = [booking({ status })];
      expect((await runReminderTick(at(DUE_24, MIN))).claimed).toBe(0);
    }
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it("tope duro: con tantos `sent` como anticipaciones, no se reclama más", async () => {
    await runReminderTick(at(DUE_24, MIN)); // sale el de 24 h
    // El dueño cambia 24 h → 23 h: la terna es nueva, pero ya hubo un aviso.
    db.configs = [config({ offsetsMinutes: [1380] })];
    const r = await runReminderTick(at(SCHEDULED, -23 * H + MIN));
    expect(r.claimed).toBe(0);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
  });

  it("lote de 50 por organización y vuelta; el resto en la siguiente", async () => {
    db.bookings = Array.from({ length: 60 }, (_, i) =>
      booking({ id: `bk_${i}`, scheduledAt: at(SCHEDULED, i * MIN) })
    );
    const now = at(SCHEDULED, -24 * H + 60 * MIN);
    expect((await runReminderTick(now)).claimed).toBe(50);
    expect((await runReminderTick(now)).claimed).toBe(10);
  });
});

describe("claim atómico (UNIQUE)", () => {
  it("dos ticks a la vez con el mismo reloj → un solo envío", async () => {
    const now = at(DUE_24, MIN);
    const [a, b] = await Promise.all([runReminderTick(now), runReminderTick(now)]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(db.rows).toHaveLength(1);
  });

  it("un claim perdido no cuenta ni envía (el segundo tick choca con la terna)", async () => {
    const now = at(DUE_24, MIN);
    await runReminderTick(now);
    const second = await runReminderTick(now);
    expect(second).toMatchObject({ claimed: 0, sent: 0 });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
  });
});

describe("sandbox del Laboratorio", () => {
  it("una cita is_test jamás genera fila ni envío", async () => {
    db.bookings = [booking({ isTest: true, conversationId: "cv_lab_1" })];
    const r = await runReminderTick(at(DUE_24, MIN));
    expect(r.claimed).toBe(0);
    expect(db.rows).toHaveLength(0);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it("segunda barrera: si sendTemplate lanza sandbox_violation, queda failed", async () => {
    sendTemplate.mockRejectedValueOnce(
      new SendError("sandbox_violation", "Conversación de prueba del Laboratorio")
    );
    const r = await runReminderTick(at(DUE_24, MIN));
    expect(r.failed).toBe(1);
    expect(db.rows[0]).toMatchObject({ status: "failed" });
  });
});

describe("motivos de skipped y failed", () => {
  const cases: [string, () => void, string][] = [
    ["template_missing", () => (db.configs = [config({ templateId: null })]), "template_missing"],
    [
      "template_not_approved",
      () => (db.templates[0]!.status = "rejected"),
      "template_not_approved",
    ],
    [
      "channel_not_whatsapp",
      () =>
        (db.bookings = [
          booking({ contact: { ...booking().contact!, channel: "instagram" } }),
        ]),
      "channel_not_whatsapp",
    ],
    [
      "no_recipient",
      () =>
        (db.bookings = [booking({ contact: { ...booking().contact!, phone: null } })]),
      "no_recipient",
    ],
    [
      "not_connected",
      () => sendTemplate.mockRejectedValueOnce(new TemplateError("not_connected", "x")),
      "not_connected",
    ],
    [
      "reconnect_required",
      () => sendTemplate.mockRejectedValueOnce(new SendError("reconnect_required", "x")),
      "reconnect_required",
    ],
  ];

  for (const [name, arrange, reason] of cases) {
    it(`${name} → skipped con motivo, sin reintento solo`, async () => {
      arrange();
      const r = await runReminderTick(at(DUE_24, MIN));
      expect(r.skipped).toBe(1);
      expect(db.rows[0]).toMatchObject({ status: "skipped", reason });
      // La terna ya existe: el siguiente tick no lo intenta otra vez.
      expect((await runReminderTick(at(DUE_24, 2 * MIN))).claimed).toBe(0);
    });
  }

  it("Meta rechaza → failed con el mensaje; la agenda no se entera", async () => {
    sendTemplate.mockRejectedValueOnce(new SendError("meta_error", "(#131026) Message undeliverable"));
    const r = await runReminderTick(at(DUE_24, MIN));
    expect(r.failed).toBe(1);
    expect(db.rows[0]).toMatchObject({ status: "failed", error: "(#131026) Message undeliverable" });
    expect(db.bookings[0]!.status).toBe("agendada");
  });

  it("un error inesperado no relanza: failed con texto genérico", async () => {
    sendTemplate.mockRejectedValueOnce(new Error("socket hang up"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await runReminderTick(at(DUE_24, MIN));
    expect(r.failed).toBe(1);
    expect(db.rows[0]!.error).toBe("No se pudo enviar el recordatorio");
  });

  it("cita sin conversación: usa la real del contacto", async () => {
    db.bookings = [booking({ conversationId: null })];
    await runReminderTick(at(DUE_24, MIN));
    expect(sendTemplate.mock.calls[0]![0].conversationId).toBe("cv_real");
  });

  it("business_name y enlace de la cita", async () => {
    db.configs = [config({ variables: ["business_name", "meeting_link"] })];
    db.templates[0]!.body = "{{1}}: {{2}}";
    db.bookings = [booking({ meetingLink: "https://meet.example/x" })];
    await runReminderTick(at(DUE_24, MIN));
    expect(sendTemplate.mock.calls[0]![0].variables).toEqual([
      "Clínica Sol",
      "https://meet.example/x",
    ]);
  });
});

describe("recoverStuckReminders", () => {
  it("sending > 10 min → failed/interrumpido, sin reenviar", async () => {
    sendTemplate.mockImplementationOnce(() => new Promise(() => {})); // proceso "muerto"
    void runReminderTick(at(DUE_24, MIN));
    await vi.waitFor(() => expect(db.rows[0]?.status).toBe("sending"));

    expect(await recoverStuckReminders(at(DUE_24, 10 * MIN))).toBe(0);
    expect(await recoverStuckReminders(at(DUE_24, 12 * MIN))).toBe(1);
    expect(db.rows[0]).toMatchObject({ status: "failed", error: "interrumpido" });
    // El siguiente tick no lo reenvía: la terna existe.
    expect((await runReminderTick(at(DUE_24, 13 * MIN))).claimed).toBe(0);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
  });
});

describe("retryReminder", () => {
  async function failedOne() {
    sendTemplate.mockRejectedValueOnce(new SendError("meta_error", "rechazado"));
    await runReminderTick(at(DUE_24, MIN));
    return db.rows[0]!.id;
  }

  it("failed → sent reusando la MISMA fila; el segundo reintento → 409", async () => {
    const id = await failedOne();
    const dto = await retryReminder({
      organizationId: ORG,
      bookingId: "bk_1",
      reminderId: id,
      now: at(DUE_24, 2 * MIN),
    });
    expect(dto).toMatchObject({ id, status: "sent", attempts: 2, canRetry: false });
    expect(db.rows).toHaveLength(1);
    await expect(
      retryReminder({ organizationId: ORG, bookingId: "bk_1", reminderId: id, now: at(DUE_24, 3 * MIN) })
    ).rejects.toMatchObject({ code: "not_retryable" });
  });

  it("falla otra vez → retry_exhausted, canRetry false", async () => {
    const id = await failedOne();
    sendTemplate.mockRejectedValueOnce(new SendError("meta_error", "otra vez"));
    const dto = await retryReminder({ organizationId: ORG, bookingId: "bk_1", reminderId: id, now: at(DUE_24, 2 * MIN) });
    expect(dto).toMatchObject({ status: "failed", attempts: 2, canRetry: false });
    await expect(
      retryReminder({ organizationId: ORG, bookingId: "bk_1", reminderId: id, now: at(DUE_24, 3 * MIN) })
    ).rejects.toMatchObject({ code: "retry_exhausted" });
  });

  it("dos clics a la vez: uno envía, el otro 409", async () => {
    const id = await failedOne();
    const now = at(DUE_24, 2 * MIN);
    const results = await Promise.allSettled([
      retryReminder({ organizationId: ORG, bookingId: "bk_1", reminderId: id, now }),
      retryReminder({ organizationId: ORG, bookingId: "bk_1", reminderId: id, now }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(sendTemplate).toHaveBeenCalledTimes(2); // el fallido + un reintento
  });

  it("cita cancelada o reprogramada → booking_not_active; otra cita → not_found", async () => {
    const id = await failedOne();
    db.bookings = [booking({ status: "cancelada" })];
    await expect(
      retryReminder({ organizationId: ORG, bookingId: "bk_1", reminderId: id, now: at(DUE_24, 2 * MIN) })
    ).rejects.toMatchObject({ code: "booking_not_active" });
    db.bookings = [booking({ scheduledAt: at(SCHEDULED, 24 * H) })];
    await expect(
      retryReminder({ organizationId: ORG, bookingId: "bk_1", reminderId: id, now: at(DUE_24, 2 * MIN) })
    ).rejects.toBeInstanceOf(ReminderError);
    await expect(
      retryReminder({ organizationId: ORG, bookingId: "bk_otro", reminderId: id, now: at(DUE_24, 2 * MIN) })
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("remindersForBookings (DTO de Citas)", () => {
  it("pending sintetizado con dueAt; luego sent con entrega", async () => {
    let map = await remindersForBookings(ORG, ["bk_1"], at(DUE_24, -H));
    expect(map.get("bk_1")).toEqual([
      expect.objectContaining({ id: null, status: "pending", dueAt: DUE_24.toISOString() }),
    ]);
    await runReminderTick(at(DUE_24, MIN));
    map = await remindersForBookings(ORG, ["bk_1"], at(DUE_24, 2 * MIN));
    expect(map.get("bk_1")).toEqual([
      expect.objectContaining({ status: "sent", delivery: "pending", offsetMinutes: 1440 }),
    ]);
  });

  it("vacío con recordatorios apagados, en citas de prueba y en bloqueos", async () => {
    db.bookings = [
      booking({ id: "bk_t", isTest: true }),
      booking({ id: "bk_b", kind: "block", contact: null }),
    ];
    const map = await remindersForBookings(ORG, ["bk_t", "bk_b"], at(DUE_24, -H));
    expect(map.size).toBe(0);
    db.configs = [config({ enabled: false })];
    db.bookings = [booking()];
    expect((await remindersForBookings(ORG, ["bk_1"], at(DUE_24, -H))).size).toBe(0);
  });

  it("vencido sin fila ya no se muestra como pendiente", async () => {
    const map = await remindersForBookings(ORG, ["bk_1"], at(DUE_24, 7 * H));
    expect(map.get("bk_1")).toEqual([]);
  });
});

describe("023 — tipo de cita y dirección en la plantilla (A8)", () => {
  it("el tipo sale de la cita y la dirección de la agenda del negocio", async () => {
    db.configs = [
      config({
        variables: ["contact_name", "appointment_type", "address"],
        address: "Av. Juárez 100",
      }),
    ];
    db.bookings = [booking({ appointmentTypeName: "Prueba de manejo" })];
    db.templates = [
      { id: "tpl_1", status: "approved", body: "Hola {{1}}, tu {{2}} es en {{3}}" },
    ];

    await runReminderTick(at(DUE_24, MIN));
    const call = sendTemplate.mock.calls[0]![0];
    expect(call.variables).toEqual(["Ana", "Prueba de manejo", "Av. Juárez 100"]);
  });

  it("Instagram/Messenger siguen sin recordatorio (decisión 7)", async () => {
    db.bookings = [
      booking({
        appointmentTypeName: "Servicio",
        contact: {
          id: "ct_1",
          name: "Ana",
          channel: "messenger",
          phone: null,
          waUserId: null,
        },
      }),
    ];
    await runReminderTick(at(DUE_24, MIN));
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(db.rows[0]).toMatchObject({ status: "skipped", reason: "channel_not_whatsapp" });
  });
});
