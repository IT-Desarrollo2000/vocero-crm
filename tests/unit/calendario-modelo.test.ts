import { describe, expect, it } from "vitest";
import {
  defaultView,
  FALLBACK_RANGE,
  gridStarts,
  initials,
  instantAt,
  parseStoredView,
  previewState,
  rowStarts,
  segmentBox,
  sellerColumns,
  snapMinute,
  typeColorIndex,
  validStarts,
  visibleMinuteRange,
  type CalendarHours,
} from "@/components/bookings/calendar/calendar-model";
import {
  bookingAriaLabel,
  bookingTone,
} from "@/components/bookings/booking-look";
import type { BusyItem } from "@/server/agenda/conflicts";
import { computeOverlaps, pickOverlaps, type OverlapItem } from "@/server/agenda/overlaps";

/**
 * 028 — Piezas puras del calendario: traslapes en dos niveles (A4), rejilla
 * real con margen y aviso mínimo (A1), estados de la vista previa, rango
 * visible (A3), columnas por vendedor, color estable del tipo y el aspecto de
 * cada bloque (A7).
 */

const MX = "America/Mexico_City";
// Lunes 19 oct 2026; en México la hora de pared es UTC−6 todo el año.
const MON = "2026-10-19";
const SUN = "2026-10-25";
const utc = (hhmmLocal: string, day = MON) => {
  const [h, m] = hhmmLocal.split(":").map(Number) as [number, number];
  const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d, h + 6, m)).toISOString();
};
const local = (iso: string) => {
  const d = new Date(Date.parse(iso) - 6 * 3_600_000);
  return d.toISOString().slice(11, 16);
};

function hours(over: Partial<CalendarHours> = {}): CalendarHours {
  return {
    weeklyHours: { mon: [{ start: "09:00", end: "12:00" }] },
    slotMinutes: 30,
    bufferMinutes: 0,
    minNoticeHours: 0,
    timezone: MX,
    ...over,
  };
}

function item(
  id: string,
  startLocal: string,
  over: Partial<OverlapItem> & { minutes?: number } = {}
): OverlapItem {
  const start = utc(startLocal);
  const minutes = over.minutes ?? 30;
  return {
    id,
    kind: "session",
    startUtc: start,
    endUtc: new Date(Date.parse(start) + minutes * 60_000).toISOString(),
    typeId: "apt_s",
    exclusive: false,
    assignedUserId: null,
    typeName: "Servicio",
    sellerName: null,
    ...over,
  };
}

describe("traslapes en dos niveles (A4)", () => {
  it("otro vendedor, tipo no exclusivo ⇒ soft para ambas", () => {
    const map = computeOverlaps([
      item("a", "10:00", { assignedUserId: "u_ana" }),
      item("b", "10:15", { assignedUserId: "u_juan" }),
    ]);
    expect(map).toEqual({ a: "soft", b: "soft" });
  });

  it("mismo vendedor ⇒ hard", () => {
    const map = computeOverlaps([
      item("a", "10:00", { assignedUserId: "u_ana" }),
      item("b", "10:15", { assignedUserId: "u_ana" }),
    ]);
    expect(map).toEqual({ a: "hard", b: "hard" });
  });

  it("mismo tipo exclusivo, aunque sean vendedores distintos ⇒ hard", () => {
    const map = computeOverlaps([
      item("a", "10:00", { assignedUserId: "u_ana", exclusive: true }),
      item("b", "10:15", { assignedUserId: "u_juan", exclusive: true }),
    ]);
    expect(map).toEqual({ a: "hard", b: "hard" });
  });

  it("tipos distintos (uno exclusivo) ⇒ soft: la exclusividad es por tipo", () => {
    const map = computeOverlaps([
      item("a", "10:00", { assignedUserId: "u_ana", exclusive: true }),
      item("b", "10:15", { assignedUserId: "u_juan", typeId: "apt_otro" }),
    ]);
    expect(map).toEqual({ a: "soft", b: "soft" });
  });

  it("un bloqueo encima ⇒ la cita es hard; el bloqueo no lleva atributo", () => {
    const map = computeOverlaps([
      item("cita", "10:00", { assignedUserId: "u_ana" }),
      item("blk", "09:30", { kind: "block", typeId: null, minutes: 60 }),
    ]);
    expect(map).toEqual({ cita: "hard" });
  });

  it("las citas de prueba, canceladas y no-show no cuentan", () => {
    const map = computeOverlaps([
      item("a", "10:00", { assignedUserId: "u_ana" }),
      item("prueba", "10:00", { assignedUserId: "u_ana", isTest: true }),
      item("cancelada", "10:00", { assignedUserId: "u_ana", status: "cancelada" }),
      item("noshow", "10:00", { assignedUserId: "u_ana", status: "no_show" }),
    ]);
    expect(map).toEqual({});
  });

  it("sin margen: una cita que empieza cuando la otra termina no se traslapa", () => {
    const map = computeOverlaps([
      item("a", "10:00", { assignedUserId: "u_ana" }),
      item("b", "10:30", { assignedUserId: "u_ana" }),
    ]);
    expect(map).toEqual({});
  });

  it("hard gana a soft en la misma cita", () => {
    const map = computeOverlaps([
      item("a", "10:00", { assignedUserId: "u_ana", minutes: 60 }),
      item("b", "10:00", { assignedUserId: "u_juan" }),
      item("c", "10:30", { assignedUserId: "u_ana" }),
    ]);
    expect(map.a).toBe("hard");
    expect(map.b).toBe("soft");
  });

  it("solo se entrega lo visible", () => {
    expect(pickOverlaps({ a: "soft", oculta: "hard" }, ["a", "z"])).toEqual({ a: "soft" });
  });
});

describe("rejilla real (A1)", () => {
  it("con margen: paso slot+buffer anclado a la apertura y la cita completa cabe", () => {
    const h = hours({ bufferMinutes: 15 });
    expect(gridStarts(MON, h, 30).map((s) => local(s.startUtc))).toEqual([
      "09:00",
      "09:45",
      "10:30",
      "11:15",
    ]);
    // Una cita de 60 ya no cabe a las 11:15.
    expect(gridStarts(MON, h, 60).map((s) => local(s.startUtc))).toEqual([
      "09:00",
      "09:45",
      "10:30",
    ]);
  });

  it("horario partido: cada intervalo ancla su propia rejilla", () => {
    const h = hours({
      bufferMinutes: 15,
      weeklyHours: {
        mon: [
          { start: "09:00", end: "10:00" },
          { start: "15:10", end: "16:00" },
        ],
      },
    });
    expect(gridStarts(MON, h, 30).map((s) => local(s.startUtc))).toEqual(["09:00", "15:10"]);
  });

  it("aviso mínimo: lo de antes de ahora + aviso no es válido", () => {
    const h = hours({ bufferMinutes: 15, minNoticeHours: 1 });
    const now = new Date(utc("09:30"));
    expect(validStarts(MON, h, 30, now).map((s) => local(s.startUtc))).toEqual([
      "10:30",
      "11:15",
    ]);
  });

  it("día cerrado ⇒ ningún inicio", () => {
    expect(gridStarts(SUN, hours(), 30)).toEqual([]);
  });

  it("snap: al paso de la rejilla dentro del horario, a slotMinutes fuera", () => {
    const h = hours({ bufferMinutes: 15 });
    expect(snapMinute(MON, 9 * 60 + 50, h)).toBe(9 * 60 + 45);
    expect(snapMinute(MON, 11 * 60 + 59, h)).toBe(11 * 60 + 15); // último paso
    expect(snapMinute(MON, 8 * 60 + 10, h)).toBe(8 * 60);
    expect(snapMinute(SUN, 23 * 60 + 59, h)).toBe(1440 - 30);
  });

  it("instantAt: la hora de pared del NEGOCIO, no la del proceso", () => {
    expect(instantAt(MON, 10 * 60, MX)).toBe("2026-10-19T16:00:00.000Z");
    expect(instantAt(MON, 10 * 60, "Asia/Tokyo")).toBe("2026-10-19T01:00:00.000Z");
    expect(instantAt(MON, 1440, MX)).toBeNull();
  });
});

describe("vista previa del arrastre (A1)", () => {
  const ctx = { mode: "staff" as const, typeId: "apt_s", typeExclusive: false, sellerId: "u_ana" };
  const base = {
    dayIso: MON,
    durationMinutes: 30,
    now: new Date(utc("08:00")),
    busy: [] as BusyItem[],
    ctx,
  };

  it("libre", () => {
    expect(previewState({ ...base, minute: 10 * 60, hours: hours() }).state).toBe("free");
  });

  it("día cerrado, fuera de horario y no cabe antes del cierre", () => {
    expect(previewState({ ...base, dayIso: SUN, minute: 600, hours: hours() }).state).toBe("closed_day");
    expect(previewState({ ...base, minute: 8 * 60, hours: hours() }).state).toBe("off_hours");
    expect(previewState({ ...base, minute: 12 * 60, hours: hours() }).state).toBe("off_hours");
    expect(
      previewState({ ...base, minute: 11 * 60 + 30, durationMinutes: 60, hours: hours() }).state
    ).toBe("no_fit");
  });

  it("demasiado pronto (aviso mínimo)", () => {
    const h = hours({ minNoticeHours: 2 });
    expect(previewState({ ...base, minute: 9 * 60 + 30, hours: h }).state).toBe("too_soon");
    expect(previewState({ ...base, minute: 10 * 60, hours: h }).state).toBe("free");
  });

  it("ocupado (hard) y ocupado por otro vendedor (soft), con el margen aplicado", () => {
    const h = hours({ bufferMinutes: 15 });
    const mine = item("x", "10:00", { assignedUserId: "u_ana" });
    const other = item("y", "10:00", { assignedUserId: "u_juan" });
    // 10:30 queda dentro del margen de la cita propia de las 10:00.
    expect(previewState({ ...base, minute: 10 * 60 + 30, hours: h, busy: [mine] }).state).toBe("taken");
    const soft = previewState({ ...base, minute: 10 * 60, hours: h, busy: [other] });
    expect(soft.state).toBe("overlap");
    expect(soft.conflicts.map((c) => c.id)).toEqual(["y"]);
    // La cita que se mueve no choca consigo misma.
    expect(
      previewState({ ...base, minute: 10 * 60, hours: h, busy: [mine], excludeId: "x" }).state
    ).toBe("free");
  });

  it("un bloqueo encima es ocupado", () => {
    const blk = item("b", "09:00", { kind: "block", typeId: null, minutes: 180 });
    expect(previewState({ ...base, minute: 10 * 60, hours: hours(), busy: [blk] }).state).toBe("taken");
  });
});

describe("rango visible (A3)", () => {
  const week = ["2026-10-19", "2026-10-20"];
  const wh = { mon: [{ start: "09:00", end: "17:30" }] };

  it("de la apertura al cierre, redondeado a horas; scroll a la apertura", () => {
    expect(visibleMinuteRange(wh, week, [])).toEqual({
      startMin: 9 * 60,
      endMin: 18 * 60,
      scrollMin: 9 * 60,
    });
  });

  it("se estira para incluir citas fuera de horario de los días que se ven", () => {
    const r = visibleMinuteRange(wh, week, [
      { day: "2026-10-20", startMin: 7 * 60 + 30, endMin: 8 * 60 },
      { day: "2026-10-19", startMin: 19 * 60, endMin: 19 * 60 + 45 },
      { day: "2026-10-27", startMin: 0, endMin: 30 }, // otra semana: no cuenta
    ]);
    expect(r).toEqual({ startMin: 7 * 60, endMin: 20 * 60, scrollMin: 9 * 60 });
  });

  it("sin horario ni citas, un rango por defecto (nunca cero filas)", () => {
    expect(visibleMinuteRange({}, week, [])).toEqual({
      ...FALLBACK_RANGE,
      scrollMin: FALLBACK_RANGE.startMin,
    });
    expect(rowStarts(FALLBACK_RANGE, 30)).toHaveLength(18);
  });

  it("la posición de un tramo se recorta al rango visible", () => {
    expect(segmentBox({ startMin: 600, endMin: 630 }, { startMin: 540, endMin: 1080 }, 0.8)).toEqual({
      top: 48,
      height: 24,
    });
    expect(segmentBox({ startMin: 0, endMin: 560 }, { startMin: 540, endMin: 1080 }, 0.8).top).toBe(0);
  });
});

describe("vista, vendedores y color", () => {
  it("vista por defecto y la recordada", () => {
    expect(defaultView(true)).toBe("semana");
    expect(defaultView(false)).toBe("dia");
    expect(parseStoredView("lista")).toBe("lista");
    expect(parseStoredView("mes")).toBeNull();
    expect(parseStoredView(null)).toBeNull();
  });

  const sellers = [
    { id: "u_ana", name: "Ana" },
    { id: "u_juan", name: "Juan" },
  ];
  const s = (id: string | null, name = "X") => ({
    kind: "session" as const,
    assignedUser: id ? { id, name } : null,
  });

  it("Propietario: todo el equipo + Sin asignar", () => {
    expect(
      sellerColumns({ owner: true, viewerId: "u_owner", sellers, bookings: [], filter: "all" }).map(
        (c) => c.id
      )
    ).toEqual(["u_ana", "u_juan", "none"]);
  });

  it("Vendedor: él + Sin asignar (+ la columna de una cita que creó para otro)", () => {
    const cols = sellerColumns({
      owner: false,
      viewerId: "u_ana",
      sellers: [],
      bookings: [s("u_juan", "Juan"), { kind: "block", assignedUser: null }],
      filter: "all",
    });
    expect(cols.map((c) => [c.id, c.name])).toEqual([
      ["u_ana", "Yo"],
      ["u_juan", "Juan"],
      ["none", "Sin asignar"],
    ]);
  });

  it("con filtro, solo la columna pedida", () => {
    expect(
      sellerColumns({ owner: true, viewerId: "u_owner", sellers, bookings: [], filter: "u_juan" }).map(
        (c) => c.id
      )
    ).toEqual(["u_juan"]);
    expect(
      sellerColumns({ owner: true, viewerId: "u_owner", sellers, bookings: [], filter: "none" }).map(
        (c) => c.id
      )
    ).toEqual(["none"]);
  });

  it("iniciales sin emojis", () => {
    expect(initials("Ana López")).toBe("AL");
    expect(initials("🚀 Juan")).toBe("J");
    expect(initials("")).toBe("");
  });

  it("el color del tipo es estable, de 1 a 6, y se reparte", () => {
    expect(typeColorIndex("apt_s")).toBe(typeColorIndex("apt_s"));
    expect(typeColorIndex(null)).toBeNull();
    const values = Array.from({ length: 60 }, (_, i) => typeColorIndex(`apt_${i}`)!);
    expect(values.every((v) => v >= 1 && v <= 6)).toBe(true);
    expect(new Set(values).size).toBeGreaterThanOrEqual(5);
  });
});

describe("aspecto del bloque (A7)", () => {
  const b = (over: Record<string, unknown> = {}) => ({
    kind: "session" as const,
    status: "agendada" as const,
    isTest: false,
    notes: null,
    contact: { id: "ct", name: "María" },
    type: { id: "apt_s", name: "Servicio" },
    assignedUser: { id: "u_ana", name: "Ana" },
    ...over,
  });

  it("agendada en el acento; realizada verde; no asistió ROJO; bloqueo rayado", () => {
    expect(bookingTone(b())).toContain("bg-brand text-brand-fg");
    expect(bookingTone(b({ status: "realizada" }))).toContain("bg-success-tint");
    expect(bookingTone(b({ status: "no_show" }))).toContain("bg-danger-tint");
    expect(bookingTone(b({ kind: "block" }))).toContain("booking-hatch");
  });

  it("el conflicto suma borde de alerta; el traslape permitido, no", () => {
    expect(bookingTone(b(), "hard")).toContain("border-danger");
    expect(bookingTone(b(), "soft")).not.toContain("border-danger");
  });

  it("aria-label completo, sin depender del color", () => {
    expect(bookingAriaLabel(b(), "10:00–10:30", "soft")).toBe(
      "10:00–10:30, María, Servicio, con Ana, Agendada, Traslape con otro vendedor"
    );
    expect(bookingAriaLabel(b({ assignedUser: null }), "10:00–10:30", "hard")).toContain(
      "sin asignar, Agendada, Conflicto"
    );
  });
});
