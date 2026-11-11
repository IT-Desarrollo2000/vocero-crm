import { describe, expect, it } from "vitest";
import {
  addMonthsClamped,
  betweenLabel,
  clock12,
  dayWordOf,
  dueAtFromWall,
  endOfWeekDay,
  followUpCreateSchema,
  followUpGroup,
  followUpPatchSchema,
  groupFollowUps,
  nextRepeatDue,
  pendingQuerySchema,
  postponeDue,
  reasonCounts,
  repeatNotice,
  shortcutDay,
  wallOf,
  wallPreview,
} from "@/lib/follow-ups";

const MX = "America/Mexico_City"; // UTC-6, sin horario de verano desde 2022
const NY = "America/New_York"; // con horario de verano

/** Instante UTC de una hora de pared en la zona. */
const at = (day: string, time: string, tz = MX) => dueAtFromWall(day, time, tz)!;

describe("addMonthsClamped (fin de mes y cambio de año)", () => {
  it("conserva el día cuando existe", () => {
    expect(addMonthsClamped("2026-11-09", 6)).toBe("2027-05-09");
  });
  it("31 → 30 en un mes de 30 días", () => {
    expect(addMonthsClamped("2026-03-31", 1)).toBe("2026-04-30");
  });
  it("31 → 28 en febrero normal y 29 en bisiesto", () => {
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsClamped("2027-08-31", 6)).toBe("2028-02-29");
  });
  it("cruza de año hacia adelante (nov + 3 → feb)", () => {
    expect(addMonthsClamped("2026-11-30", 3)).toBe("2027-02-28");
    expect(addMonthsClamped("2026-12-15", 12)).toBe("2027-12-15");
  });
});

describe("nextRepeatDue: N meses después del ORIGINAL, a la misma hora de pared", () => {
  it("cada 6 meses: 9 nov 10:00 → 9 may 10:00 (hora del negocio)", () => {
    const next = nextRepeatDue(at("2026-11-09", "10:00"), 6, MX);
    expect(wallOf(next, MX)).toEqual({ day: "2027-05-09", time: "10:00" });
  });
  it("31 de enero cada 3 meses → 30 de abril", () => {
    const next = nextRepeatDue(at("2027-01-31", "16:30"), 3, MX);
    expect(wallOf(next, MX)).toEqual({ day: "2027-04-30", time: "16:30" });
  });
  it("cruza el cambio de horario sin mover la hora de pared", () => {
    // 15 ene (EST, UTC-5) + 6 meses → 15 jul (EDT, UTC-4): sigue a las 09:00.
    const next = nextRepeatDue(at("2027-01-15", "09:00", NY), 6, NY);
    expect(wallOf(next, NY)).toEqual({ day: "2027-07-15", time: "09:00" });
    expect(next.toISOString()).toBe("2027-07-15T13:00:00.000Z");
  });
  it("cada 12 meses desde un 29 de febrero → 28 de febrero", () => {
    const next = nextRepeatDue(at("2028-02-29", "10:00"), 12, MX);
    expect(wallOf(next, MX).day).toBe("2029-02-28");
  });
});

describe("postponeDue: mueve el mismo recordatorio", () => {
  const now = at("2026-11-11", "15:20"); // miércoles
  it("1 h: desde ahora", () => {
    expect(postponeDue(at("2026-11-02", "10:00"), "1h", now, MX).getTime()).toBe(
      now.getTime() + 3_600_000
    );
  });
  it("mañana: mañana (zona del negocio) a la hora del recordatorio", () => {
    const d = postponeDue(at("2026-11-02", "10:00"), "tomorrow", now, MX);
    expect(wallOf(d, MX)).toEqual({ day: "2026-11-12", time: "10:00" });
  });
  it("1 semana: hoy + 7 a esa hora (no deja vencido al que ya lo estaba)", () => {
    const d = postponeDue(at("2026-10-01", "18:45"), "week", now, MX);
    expect(wallOf(d, MX)).toEqual({ day: "2026-11-18", time: "18:45" });
  });
  it("cruza de año", () => {
    const d = postponeDue(at("2026-12-31", "09:00"), "tomorrow", at("2026-12-31", "20:00"), MX);
    expect(wallOf(d, MX)).toEqual({ day: "2027-01-01", time: "09:00" });
  });
  it("«mañana» depende del día en la zona, no en UTC", () => {
    // 23:30 en CDMX del 11 nov = 05:30 UTC del 12: mañana sigue siendo el 12.
    const late = at("2026-11-11", "23:30");
    expect(late.toISOString().slice(0, 10)).toBe("2026-11-12");
    const d = postponeDue(at("2026-11-11", "10:00"), "tomorrow", late, MX);
    expect(wallOf(d, MX).day).toBe("2026-11-12");
  });
});

describe("shortcutDay: atajos del diálogo", () => {
  const now = at("2026-11-11", "15:00");
  it("Mañana · En 3 días · En 1 semana · En 1 mes", () => {
    expect(shortcutDay("tomorrow", now, MX)).toBe("2026-11-12");
    expect(shortcutDay("3d", now, MX)).toBe("2026-11-14");
    expect(shortcutDay("week", now, MX)).toBe("2026-11-18");
    expect(shortcutDay("month", now, MX)).toBe("2026-12-11");
  });
  it("En 1 mes desde el 31 de enero → 28 de febrero; desde diciembre cruza el año", () => {
    expect(shortcutDay("month", at("2027-01-31", "09:00"), MX)).toBe("2027-02-28");
    expect(shortcutDay("month", at("2026-12-20", "09:00"), MX)).toBe("2027-01-20");
  });
});

describe("grupos en la zona del negocio", () => {
  const now = at("2026-11-11", "15:00");
  it("vencido = ya pasó, aunque sea de hoy", () => {
    expect(followUpGroup(at("2026-11-11", "10:00"), now, MX)).toBe("overdue");
    expect(followUpGroup(at("2026-11-10", "10:00"), now, MX)).toBe("overdue");
  });
  it("hoy = lo que queda del día de hoy en la zona", () => {
    expect(followUpGroup(at("2026-11-11", "16:30"), now, MX)).toBe("today");
    // 23:00 de CDMX ya es el 12 en UTC: sigue siendo «hoy».
    expect(followUpGroup(at("2026-11-11", "23:00"), now, MX)).toBe("today");
  });
  it("esta semana = de mañana al domingo (calendario lun–dom); después, desde el lunes", () => {
    // Miércoles 11 nov → domingo 15.
    expect(followUpGroup(at("2026-11-12", "00:00"), now, MX)).toBe("week");
    expect(followUpGroup(at("2026-11-15", "23:59"), now, MX)).toBe("week");
    expect(followUpGroup(at("2026-11-16", "00:00"), now, MX)).toBe("later");
  });
  it("lunes: la semana llega hasta el domingo 6 días después", () => {
    const lunes = at("2026-11-09", "09:00");
    expect(endOfWeekDay("2026-11-09")).toBe("2026-11-15");
    expect(followUpGroup(at("2026-11-15", "20:00"), lunes, MX)).toBe("week");
    expect(followUpGroup(at("2026-11-16", "08:00"), lunes, MX)).toBe("later");
  });
  it("domingo: «Esta semana» queda vacía (mañana ya es «Después»)", () => {
    const domingo = at("2026-11-15", "09:00");
    expect(endOfWeekDay("2026-11-15")).toBe("2026-11-15");
    expect(followUpGroup(at("2026-11-15", "20:00"), domingo, MX)).toBe("today");
    expect(followUpGroup(at("2026-11-16", "08:00"), domingo, MX)).toBe("later");
  });
  it("la semana cruza de mes y de año", () => {
    // Jueves 29 oct → domingo 1 nov.
    const jueves = at("2026-10-29", "12:00");
    expect(followUpGroup(at("2026-11-01", "18:00"), jueves, MX)).toBe("week");
    expect(followUpGroup(at("2026-11-02", "09:00"), jueves, MX)).toBe("later");
    // Martes 29 dic → domingo 3 ene.
    const martes = at("2026-12-29", "12:00");
    expect(endOfWeekDay("2026-12-29")).toBe("2027-01-03");
    expect(followUpGroup(at("2027-01-03", "23:59"), martes, MX)).toBe("week");
    expect(followUpGroup(at("2027-01-04", "00:00"), martes, MX)).toBe("later");
  });
  it("el lunes de la zona, no el de UTC (domingo 23:00 en CDMX ya es lunes en UTC)", () => {
    const domingoNoche = at("2026-11-15", "22:00");
    expect(followUpGroup(at("2026-11-15", "23:30"), domingoNoche, MX)).toBe("today");
    expect(followUpGroup(at("2026-11-16", "10:00"), domingoNoche, MX)).toBe("later");
  });
  it("groupFollowUps ordena por hora dentro de cada grupo", () => {
    const items = [
      { id: "c", dueAt: at("2026-11-11", "18:00").toISOString() },
      { id: "a", dueAt: at("2026-11-09", "10:00").toISOString() },
      { id: "b", dueAt: at("2026-11-11", "16:30").toISOString() },
      { id: "d", dueAt: at("2027-01-05", "10:00").toISOString() },
      { id: "e", dueAt: at("2026-11-10", "10:00").toISOString() },
    ];
    const g = groupFollowUps(items, now, MX);
    expect(g.overdue.map((x) => x.id)).toEqual(["a", "e"]);
    expect(g.today.map((x) => x.id)).toEqual(["b", "c"]);
    expect(g.week).toEqual([]);
    expect(g.later.map((x) => x.id)).toEqual(["d"]);
  });
  it("reasonCounts cuenta todos los motivos, también los vacíos", () => {
    const c = reasonCounts([{ reason: "servicio" }, { reason: "servicio" }, { reason: "cita" }] as const);
    expect(c).toMatchObject({ all: 3, servicio: 2, cita: 1, otro: 0, volver_a_contactar: 0 });
  });
});

describe("etiquetas", () => {
  const now = at("2026-11-11", "15:00");
  it("día de la fila y hora de 12 h", () => {
    expect(dayWordOf(at("2026-11-10", "10:00"), now, MX)).toBe("Ayer");
    expect(dayWordOf(at("2026-11-11", "16:30"), now, MX)).toBe("Hoy");
    expect(dayWordOf(at("2026-11-12", "10:00"), now, MX)).toBe("Mañana");
    expect(dayWordOf(at("2026-11-09", "10:00"), now, MX)).toBe("Lun 9 nov");
    expect(dayWordOf(at("2027-01-04", "10:00"), now, MX)).toBe("Lun 4 ene 2027");
    expect(clock12(at("2026-11-11", "16:30"), MX)).toBe("4:30 p. m.");
    expect(clock12(at("2026-11-11", "00:05"), MX)).toBe("12:05 a. m.");
  });
  it("vista previa del diálogo con la zona en palabras", () => {
    expect(wallPreview("2026-11-18", "10:00", MX)).toBe(
      "Miércoles 18 de noviembre, 10:00 a. m. (hora de Ciudad de México)"
    );
  });
  it("aviso de repetición con la fecha del siguiente", () => {
    expect(repeatNotice(at("2026-11-09", "10:00"), 6, MX)).toBe(
      "Se repite cada 6 meses: el siguiente queda para el 9 de mayo de 2027."
    );
  });
  it("«Entre fechas» en palabras", () => {
    expect(betweenLabel("2026-09-01", "2026-09-30")).toBe("el 1 y el 30 de septiembre");
    expect(betweenLabel("2026-08-20", "2026-09-03")).toBe("el 20 de agosto y el 3 de septiembre");
  });
});

describe("validación (Zod)", () => {
  const ok = { contactId: "ct_1", day: "2026-11-18", time: "10:00", reason: "servicio" };
  it("crear: lo mínimo pasa y normaliza nota y repetir", () => {
    const r = followUpCreateSchema.parse({ ...ok, note: "  ", repeatMonths: undefined });
    expect(r).toMatchObject({ note: null, repeatMonths: null, conversationId: null });
  });
  it("crear: rechaza día inexistente, hora mala, motivo y repetir fuera del catálogo", () => {
    expect(followUpCreateSchema.safeParse({ ...ok, day: "2026-02-30" }).success).toBe(false);
    expect(followUpCreateSchema.safeParse({ ...ok, time: "24:00" }).success).toBe(false);
    expect(followUpCreateSchema.safeParse({ ...ok, reason: "llamar" }).success).toBe(false);
    expect(followUpCreateSchema.safeParse({ ...ok, repeatMonths: 4 }).success).toBe(false);
    expect(followUpCreateSchema.safeParse({ ...ok, note: "x".repeat(501) }).success).toBe(false);
    expect(followUpCreateSchema.safeParse({ ...ok, repeatMonths: 12 }).success).toBe(true);
  });
  it("patch: hecho, posponer y otra fecha", () => {
    expect(followUpPatchSchema.parse({ action: "done", note: "Quedó contenta" })).toEqual({
      action: "done",
      note: "Quedó contenta",
    });
    expect(followUpPatchSchema.safeParse({ action: "postpone", preset: "2h" }).success).toBe(false);
    expect(followUpPatchSchema.safeParse({ action: "reschedule", day: "2026-11-20", time: "09:30" }).success).toBe(true);
    expect(followUpPatchSchema.safeParse({ action: "borrar" }).success).toBe(false);
  });
  it("pendientes: días del catálogo, rango ordenado e «Incluir perdidos»", () => {
    expect(pendingQuerySchema.parse({ days: "60", includeLost: "1" })).toMatchObject({ days: 60, includeLost: true });
    expect(pendingQuerySchema.parse({})).toMatchObject({ includeLost: false });
    expect(pendingQuerySchema.safeParse({ days: "45" }).success).toBe(false);
    expect(pendingQuerySchema.safeParse({ replyDays: "7" }).success).toBe(true);
    expect(pendingQuerySchema.safeParse({ from: "2026-09-30", to: "2026-09-01" }).success).toBe(false);
  });
});
