import { describe, expect, it } from "vitest";
import {
  agoLabel,
  bookingAssignedKey,
  bookingWhen,
  browserNotificationCopy,
  chatAssignedKey,
  dailySummaryKey,
  dailySummaryText,
  dailySummaryWindow,
  followUpDueKey,
  isDueForNotice,
  notificationCopy,
  notificationReadSchema,
  todayWindow,
  toastCopy,
  type NotificationDto,
} from "@/lib/notifications";
import { dueAtFromWall } from "@/lib/follow-ups";

/** 035 B — Avisos: claves, regla del resumen del día y textos. */

const MX = "America/Mexico_City"; // UTC-6
const at = (day: string, time: string, tz = MX) => dueAtFromWall(day, time, tz)!;

describe("claves de dedupe (deterministas)", () => {
  it("recordatorio: id + due_at ISO; posponer = otra clave", () => {
    const k1 = followUpDueKey("fu_1", "2026-11-12T16:00:00Z");
    expect(k1).toBe("fu:fu_1:2026-11-12T16:00:00.000Z");
    expect(followUpDueKey("fu_1", new Date("2026-11-12T16:00:00.000Z"))).toBe(k1);
    expect(followUpDueKey("fu_1", "2026-11-12T17:00:00Z")).not.toBe(k1);
  });
  it("resumen: día de pared; chat y cita con destinatario e instante", () => {
    expect(dailySummaryKey("2026-11-12")).toBe("daily:2026-11-12");
    expect(chatAssignedKey("cv_1", "u_1", "2026-11-12T16:00:00Z")).toBe(
      "chat:cv_1:u_1:2026-11-12T16:00:00.000Z"
    );
    expect(bookingAssignedKey("bk_1", "u_1", new Date("2026-11-12T16:00:00Z"))).toBe(
      "booking:bk_1:u_1:2026-11-12T16:00:00.000Z"
    );
  });
});

describe("regla del resumen del día (08:00 de pared del negocio)", () => {
  it("antes de las 08:00 no; desde las 08:00 sí, con el día de pared", () => {
    expect(dailySummaryWindow(at("2026-11-12", "07:59"), MX)).toBeNull();
    const w = dailySummaryWindow(at("2026-11-12", "08:00"), MX);
    expect(w?.day).toBe("2026-11-12");
    expect(w?.endOfDay.toISOString()).toBe(at("2026-11-13", "00:00").toISOString());
  });
  it("es el día del NEGOCIO, no el de UTC (23:30 en CDMX ya es mañana en UTC)", () => {
    const late = at("2026-11-12", "23:30");
    expect(late.toISOString().slice(0, 10)).toBe("2026-11-13");
    expect(dailySummaryWindow(late, MX)?.day).toBe("2026-11-12");
    expect(todayWindow(late, MX).day).toBe("2026-11-12");
  });
  it("vencido: solo de las últimas 24 h", () => {
    const now = at("2026-11-12", "10:00");
    expect(isDueForNotice(at("2026-11-12", "09:59"), now)).toBe(true);
    expect(isDueForNotice(now, now)).toBe(true);
    expect(isDueForNotice(at("2026-11-12", "10:01"), now)).toBe(false);
    expect(isDueForNotice(at("2026-11-11", "09:59"), now)).toBe(false);
  });
});

describe("validación de «marcar leído»", () => {
  it("ids o all, nada más", () => {
    expect(notificationReadSchema.safeParse({ all: true }).success).toBe(true);
    expect(notificationReadSchema.safeParse({ ids: ["ntf_1"] }).success).toBe(true);
    expect(notificationReadSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(notificationReadSchema.safeParse({ all: false }).success).toBe(false);
    expect(notificationReadSchema.safeParse({}).success).toBe(false);
  });
});

const now = at("2026-11-12", "11:00");
const base: NotificationDto = {
  id: "ntf_1",
  kind: "follow_up_due",
  createdAt: at("2026-11-12", "10:40").toISOString(),
  readAt: null,
  contact: { id: "ct_1", name: "Carlos Ruiz" },
  conversationId: "cv_1",
  bookingId: null,
  followUpId: "fu_1",
  actorName: null,
  payload: {
    contactName: "Carlos Ruiz",
    reason: "volver_a_contactar",
    note: "Quedó de decidir después de la quincena.",
    dueAt: at("2026-11-11", "10:00").toISOString(),
  },
  followUp: {
    status: "open",
    dueAt: at("2026-11-11", "10:00").toISOString(),
    conversationId: "cv_1",
  },
};
const ctx = { now, tz: MX, summary: { today: 5, overdue: 2 } };

describe("textos de la campana", () => {
  it("recordatorio vencido: nombre · motivo, «nota» · cuándo", () => {
    const c = notificationCopy(base, ctx);
    expect(c.lead).toBe("Recordatorio vencido:");
    expect(c.title).toBe("Carlos Ruiz · Volver a contactar");
    expect(c.detail).toBe("«Quedó de decidir después de la quincena.» · Ayer, 10:00 a. m.");
    expect(c.state).toBeNull();
    expect(c.tone).toBe("danger");
  });
  it("ya hecho → «Ya lo marcaste como hecho»; pospuesto → para cuándo", () => {
    expect(
      notificationCopy({ ...base, followUp: { ...base.followUp!, status: "done" } }, ctx).state
    ).toBe("Ya lo marcaste como hecho");
    const moved = notificationCopy(
      { ...base, followUp: { ...base.followUp!, dueAt: at("2026-11-12", "12:00").toISOString() } },
      ctx
    );
    expect(moved.state).toBe("Lo pospusiste para hoy, 12:00 p. m.");
  });
  it("resumen del día: en vivo; con 0, atenuado", () => {
    const daily: NotificationDto = {
      ...base,
      kind: "daily_summary",
      followUp: null,
      payload: { day: "2026-11-12", total: 6 },
    };
    const c = notificationCopy(daily, ctx);
    expect(`${c.lead}${c.title}`).toBe("Hoy tienes 5 recordatorios (2 vencidos)");
    const done = notificationCopy(daily, { ...ctx, summary: { today: 0, overdue: 0 } });
    expect(done.lead).toBe("Ya no te quedan recordatorios para hoy");
    expect(done.muted).toBe(true);
    expect(dailySummaryText({ today: 1, overdue: 0 })).toEqual({
      lead: "Hoy tienes 1 recordatorio",
      rest: "",
      muted: false,
    });
  });
  it("te asignaron a … (chat) con quién y hace cuánto", () => {
    const chat: NotificationDto = {
      ...base,
      kind: "chat_assigned",
      followUp: null,
      actorName: "Alejandro Treviño",
      contact: { id: "ct_2", name: "Patricia Luna" },
    };
    const c = notificationCopy(chat, ctx);
    expect(c.title).toBe("Te asignaron a Patricia Luna");
    expect(c.detail).toBe("Alejandro Treviño la pasó a tu nombre · hace 20 min");
  });
  it("cita: «Te asignaron…» con actor; «Se agendó…» si fue la IA", () => {
    const cita: NotificationDto = {
      ...base,
      kind: "booking_assigned",
      followUp: null,
      bookingId: "bk_1",
      actorName: "Alejandro Treviño",
      contact: { id: "ct_3", name: "Sofía Castro" },
      payload: { contactName: "Sofía Castro", scheduledAt: at("2026-11-13", "12:00").toISOString() },
    };
    expect(notificationCopy(cita, ctx).title).toBe(
      "Te asignaron la cita de Sofía Castro · mañana 12:00"
    );
    const ia = notificationCopy(
      { ...cita, actorName: null, payload: { ...cita.payload, byAgent: true } },
      ctx
    );
    expect(ia.title).toBe("Se agendó la cita de Sofía Castro · mañana 12:00");
    expect(ia.detail).toBe("Hace 20 min");
  });
  it("emergente y navegador", () => {
    expect(toastCopy(base)).toEqual({
      title: "Recordatorio: Carlos Ruiz",
      body: "Volver a contactar · «Quedó de decidir después de la quincena.»",
    });
    expect(browserNotificationCopy({ ...base, kind: "daily_summary" }, ctx)).toBeNull();
    expect(
      browserNotificationCopy({ ...base, kind: "chat_assigned", actorName: "Ale" }, ctx)?.title
    ).toBe("Te asignaron a Carlos Ruiz");
  });
  it("hace cuánto y cuándo es la cita", () => {
    expect(agoLabel(now, now, MX)).toBe("ahora mismo");
    expect(agoLabel(at("2026-11-12", "08:00"), now, MX)).toBe("hace 3 h");
    expect(agoLabel(at("2026-11-11", "08:00"), now, MX)).toBe("ayer");
    expect(agoLabel(at("2026-11-02", "08:00"), now, MX)).toBe("2 nov");
    expect(bookingWhen(at("2026-11-12", "16:30"), now, MX)).toBe("hoy 16:30");
    expect(bookingWhen(at("2026-11-18", "10:00"), now, MX)).toMatch(/18 nov, 10:00$/);
  });
});
