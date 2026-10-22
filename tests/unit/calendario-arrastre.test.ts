import { describe, expect, it } from "vitest";
import { panelClosesOnEscape } from "@/components/bookings/booking-detail-panel";
import type { Booking } from "@/components/bookings/booking-look";
import type { CalendarHours } from "@/components/bookings/calendar/calendar-model";
import {
  applyOverride,
  canDragBooking,
  DRAG_OVERLAY_STYLE,
  dropPreview,
  moveRequest,
  parseMoveResponse,
  previewLabel,
  snapBlockMinute,
} from "@/components/bookings/calendar/drag-model";

/**
 * 028 (Fase B) — Reglas puras del arrastre: qué se arrastra, a qué minuto
 * salta, qué dice la vista previa (libre / choque permitido / rechazo), qué
 * se manda en el `move` y cómo se lee la respuesta.
 */

const MX = "America/Mexico_City";
const MON = "2026-10-19"; // lunes; México = UTC−6
const at = (hhmm: string, day = MON) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d, h + 6, m)).toISOString();
};
const NOW = new Date(at("08:00"));

const hours: CalendarHours = {
  weeklyHours: { mon: [{ start: "09:00", end: "18:00" }] },
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 0,
  timezone: MX,
};

function bk(id: string, hhmm: string, over: Partial<Booking> = {}): Booking {
  return {
    id,
    kind: "session",
    status: "agendada",
    source: "manual",
    scheduledAtUtc: at(hhmm),
    durationMinutes: 30,
    date: "",
    time: "",
    weekday: "",
    contact: { id: "ct", name: "María" },
    conversationId: null,
    connector: null,
    meetingLink: null,
    linkPending: false,
    isTest: false,
    notes: null,
    reminders: [],
    type: { id: "apt_s", name: "Servicio" },
    assignedUser: { id: "u_ana", name: "Ana" },
    createdByUserId: null,
    exclusive: false,
    ...over,
  };
}

const target = (columnKey: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return { columnKey, dayIso: MON, rawMinute: h * 60 + m };
};

describe("qué se arrastra", () => {
  it("sesiones agendadas, futuras y no de prueba", () => {
    expect(canDragBooking(bk("a", "10:00"), { view: "semana", now: NOW })).toBe(true);
    expect(canDragBooking(bk("a", "07:00"), { view: "semana", now: NOW })).toBe(false);
    expect(canDragBooking(bk("a", "10:00", { isTest: true }), { view: "semana", now: NOW })).toBe(false);
    expect(canDragBooking(bk("a", "10:00", { status: "realizada" }), { view: "dia", now: NOW })).toBe(false);
    expect(
      canDragBooking(bk("a", "10:00"), { view: "semana", now: NOW, continuesBefore: true })
    ).toBe(false);
  });

  it("los bloqueos solo en Semana", () => {
    const blk = bk("b", "10:00", { kind: "block", type: null, assignedUser: null });
    expect(canDragBooking(blk, { view: "semana", now: NOW })).toBe(true);
    expect(canDragBooking(blk, { view: "dia", now: NOW })).toBe(false);
  });
});

describe("snap de bloqueos (A5)", () => {
  it("a múltiplos de slotMinutes desde las 00:00, sin pasarse del día", () => {
    expect(snapBlockMinute(10 * 60 + 10, 30, 60)).toBe(10 * 60);
    expect(snapBlockMinute(10 * 60 + 20, 30, 60)).toBe(10 * 60 + 30);
    expect(snapBlockMinute(23 * 60 + 50, 30, 60)).toBe(23 * 60);
    expect(snapBlockMinute(-5, 30, 60)).toBe(0);
  });
});

describe("vista previa al arrastrar", () => {
  const base = { view: "semana" as const, owner: true, hours, now: NOW };

  it("libre, con la hora destino en el texto", () => {
    const p = dropPreview({ ...base, booking: bk("a", "10:00"), target: target(MON, "11:10"), bookings: [] });
    expect(p.state).toBe("free");
    expect(p.minute).toBe(11 * 60); // salta a la rejilla
    expect(p.startUtc).toBe(at("11:00"));
    expect(p.label).toBe(previewLabel(MON, 660, "Libre"));
    expect(p.label).toBe("lun 19, 11:00 · Libre");
  });

  it("choque con otro vendedor ⇒ soft; con el mismo vendedor ⇒ reject", () => {
    const a = bk("a", "10:00");
    const juan = bk("j", "12:00", { assignedUser: { id: "u_juan", name: "Juan" } });
    const ana = bk("x", "12:00");
    expect(dropPreview({ ...base, booking: a, target: target(MON, "12:00"), bookings: [a, juan] }).state).toBe(
      "soft"
    );
    const r = dropPreview({ ...base, booking: a, target: target(MON, "12:00"), bookings: [a, ana] });
    expect(r.state).toBe("reject");
    expect(r.reason).toBe("taken");
  });

  it("fuera de horario, no cabe y demasiado pronto ⇒ reject", () => {
    const a = bk("a", "10:00", { durationMinutes: 60 });
    expect(dropPreview({ ...base, booking: a, target: target(MON, "19:00"), bookings: [] }).reason).toBe(
      "off_hours"
    );
    expect(dropPreview({ ...base, booking: a, target: target(MON, "17:30"), bookings: [] }).reason).toBe(
      "no_fit"
    );
    const soon = { ...hours, minNoticeHours: 3 };
    expect(
      dropPreview({ ...base, hours: soon, booking: a, target: target(MON, "10:00"), bookings: [] }).reason
    ).toBe("too_soon");
  });

  it("mismo tipo exclusivo ⇒ reject", () => {
    const a = bk("a", "10:00", { exclusive: true });
    const other = bk("p", "12:00", { exclusive: true, assignedUser: { id: "u_juan", name: "Juan" } });
    expect(dropPreview({ ...base, booking: a, target: target(MON, "12:00"), bookings: [a, other] }).state).toBe(
      "reject"
    );
  });

  it("Día por vendedor: otra columna reasigna (Propietario) y mide con el vendedor destino", () => {
    const a = bk("a", "10:00");
    const juanBusy = bk("j", "10:00", { assignedUser: { id: "u_juan", name: "Juan" } });
    const p = dropPreview({ ...base, view: "dia", booking: a, target: target("u_pedro", "10:00"), bookings: [a] });
    expect(p.state).toBe("free");
    expect(p.sellerId).toBe("u_pedro");
    const clash = dropPreview({
      ...base,
      view: "dia",
      booking: a,
      target: target("u_juan", "10:00"),
      bookings: [a, juanBusy],
    });
    expect(clash.state).toBe("reject");
    expect(dropPreview({ ...base, view: "dia", booking: a, target: target("none", "11:00"), bookings: [] }).sellerId).toBeNull();
  });

  it("Día por vendedor: el Vendedor no puede soltar en otra columna", () => {
    const p = dropPreview({
      ...base,
      owner: false,
      view: "dia",
      booking: bk("a", "10:00"),
      target: target("u_juan", "11:00"),
      bookings: [],
    });
    expect(p.state).toBe("reject");
    expect(p.reason).toBe("not_owner");
    expect(p.label).toContain("Solo el Propietario reasigna");
  });

  it("bloqueo: cualquier hora alineada; si cubre citas ⇒ soft", () => {
    const blk = bk("b", "10:00", { kind: "block", type: null, assignedUser: null, durationMinutes: 60 });
    const cita = bk("c", "20:30", { assignedUser: { id: "u_juan", name: "Juan" } });
    const free = dropPreview({ ...base, booking: blk, target: target(MON, "06:10"), bookings: [blk] });
    expect(free.state).toBe("free");
    expect(free.minute).toBe(6 * 60);
    const covers = dropPreview({ ...base, booking: blk, target: target(MON, "20:00"), bookings: [blk, cita] });
    expect(covers.state).toBe("soft");
    expect(covers.label).toContain("Cubrirá 1 cita");
  });
});

describe("lo que se manda al soltar", () => {
  const a = bk("a", "10:00");

  it("sin cambios ⇒ nada", () => {
    expect(moveRequest(a, { startUtc: at("10:00"), sellerId: "u_ana" }, { view: "dia" })).toBeNull();
  });

  it("solo la hora, con expectedStartUtc", () => {
    expect(moveRequest(a, { startUtc: at("11:00"), sellerId: "u_ana" }, { view: "semana" })).toEqual({
      action: "move",
      startUtc: at("11:00"),
      expectedStartUtc: at("10:00"),
    });
  });

  it("solo el vendedor (Día) y ambos; en Semana nunca cambia el vendedor", () => {
    expect(moveRequest(a, { startUtc: at("10:00"), sellerId: null }, { view: "dia" })).toEqual({
      action: "move",
      userId: null,
      expectedStartUtc: at("10:00"),
    });
    expect(
      moveRequest(a, { startUtc: at("11:00"), sellerId: "u_juan" }, { view: "dia", confirmOverlap: true })
    ).toEqual({
      action: "move",
      startUtc: at("11:00"),
      userId: "u_juan",
      expectedStartUtc: at("10:00"),
      confirmOverlap: true,
    });
    expect(moveRequest(a, { startUtc: at("10:00"), sellerId: "u_juan" }, { view: "semana" })).toBeNull();
  });

  it("movimiento optimista", () => {
    const moved = applyOverride([a, bk("z", "12:00")], {
      id: "a",
      scheduledAtUtc: at("11:00"),
      assignedUser: null,
    });
    expect(moved[0]!.scheduledAtUtc).toBe(at("11:00"));
    expect(moved[0]!.assignedUser).toBeNull();
    expect(moved[1]!.scheduledAtUtc).toBe(at("12:00"));
  });
});

describe("cómo se lee la respuesta del move", () => {
  it("éxito, confirmación, stale, ocupado y sin red", () => {
    expect(parseMoveResponse(200, { ok: true, label: "lun 19 oct, 11:00" })).toEqual({
      kind: "ok",
      label: "lun 19 oct, 11:00",
    });
    const warn = parseMoveResponse(409, {
      error: { code: "overlap_warning", message: "A esa hora ya hay 1 cita (Servicio, con Juan)." },
      conflicts: [{ bookingId: "j", typeName: "Servicio", sellerName: "Juan", startUtc: "", endUtc: "" }],
    });
    expect(warn.kind).toBe("overlap_warning");
    expect(parseMoveResponse(409, { error: { code: "stale", message: "Otra persona ya movió esta cita" } })).toEqual({
      kind: "error",
      message: "Otra persona ya movió esta cita",
    });
    expect(parseMoveResponse(409, { error: { code: "slot_taken", message: "Ese horario ya no está disponible" } })).toEqual({
      kind: "error",
      message: "Ese horario ya no está disponible",
    });
    expect(parseMoveResponse(null, null).kind).toBe("error");
  });
});

describe("el bloque flotante sigue al puntero", () => {
  it("el envoltorio del DragOverlay anula el margen que le pondría space-y-*", () => {
    // Con margin-top heredado (12 px en `space-y-3`) dnd-kit medía el overlay
    // más abajo que el puntero y la cita caía una fila más abajo; un arrastre
    // solo lateral (reasignar) cambiaba la hora. E2E: e2e-agenda-calendario.
    expect(DRAG_OVERLAY_STYLE).toEqual({ margin: 0 });
  });
});

describe("Escape con el panel de detalle y un diálogo encima (R2)", () => {
  it("con un diálogo abierto, Escape es del diálogo: el panel no se cierra", () => {
    expect(panelClosesOnEscape("Escape", true)).toBe(false);
  });
  it("sin diálogo, Escape cierra el panel; otras teclas no", () => {
    expect(panelClosesOnEscape("Escape", false)).toBe(true);
    expect(panelClosesOnEscape("Enter", false)).toBe(false);
  });
});
