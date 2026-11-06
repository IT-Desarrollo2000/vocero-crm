import { describe, expect, it } from "vitest";
import {
  bookingsTodo,
  needsOutcome,
  outcomeQuestion,
  outcomeWhen,
  todayTitle,
  todoRange,
  tomorrowLine,
  unassignedLine,
  unassignedTitle,
  type TodoBooking,
  type TodoViewer,
} from "@/lib/bookings-todo";

/**
 * 032 — Citas: «lo que te toca». Horas SIEMPRE en la zona del negocio
 * (CDMX = UTC−6, sin horario de verano).
 */

const TZ = "America/Mexico_City";
// Viernes 6-nov-2026 12:00 en CDMX = 18:00 UTC.
const NOW = Date.parse("2026-11-06T18:00:00.000Z");
const ANA: TodoViewer = { userId: "u_ana", role: "member" };
const OWNER: TodoViewer = { userId: "u_owner", role: "owner" };

let seq = 0;
function bk(local: string, over: Partial<TodoBooking> = {}): TodoBooking {
  // `local` = "2026-11-05T17:00" en CDMX ⇒ +6 h en UTC.
  const utc = new Date(Date.parse(`${local}:00.000Z`) + 6 * 3_600_000).toISOString();
  return {
    id: `bk_${++seq}`,
    kind: "session",
    status: "agendada",
    isTest: false,
    scheduledAtUtc: utc,
    durationMinutes: 30,
    contact: { id: "ct_1", name: "Sofía Castro" },
    type: { id: "apt_v", name: "Visita a la tienda" },
    assignedUser: { id: "u_ana", name: "Ana" },
    ...over,
  };
}

describe("rango propio de la franja", () => {
  it("−14 días … +2 días desde HOY en la zona del negocio", () => {
    expect(todoRange(new Date(NOW), TZ)).toEqual({ from: "2026-10-23", to: "2026-11-08" });
    // 23:30 del 6 en CDMX ya es 7 en UTC: manda la zona del negocio.
    expect(todoRange(new Date("2026-11-07T05:30:00.000Z"), TZ).to).toBe("2026-11-08");
  });
});

describe("(a) pasadas sin resultado", () => {
  it("sesión agendada que ya terminó; no las futuras, ni en curso, ni con resultado", () => {
    const ayer = bk("2026-11-05T17:00");
    const enCurso = bk("2026-11-06T11:45"); // termina 12:15
    const realizada = bk("2026-11-04T10:00", { status: "realizada" });
    const cancelada = bk("2026-11-04T11:00", { status: "cancelada" });
    const prueba = bk("2026-11-04T12:00", { isTest: true });
    const bloqueo = bk("2026-11-04T13:00", { kind: "block", contact: null, type: null, assignedUser: null });
    const todo = bookingsTodo([enCurso, ayer, realizada, cancelada, prueba, bloqueo], ANA, NOW, TZ);
    expect(todo.pending.map((b) => b.id)).toEqual([ayer.id]);
    expect(needsOutcome(enCurso, NOW)).toBe(false);
    expect(needsOutcome(ayer, NOW)).toBe(true);
  });

  it("Vendedor: solo las suyas; Propietario: todas, la más reciente primero", () => {
    const suya = bk("2026-11-03T10:00");
    const deJuan = bk("2026-11-05T10:00", { assignedUser: { id: "u_juan", name: "Juan" } });
    const sinVendedor = bk("2026-11-04T10:00", { assignedUser: null });
    expect(bookingsTodo([suya, deJuan, sinVendedor], ANA, NOW, TZ).pending.map((b) => b.id)).toEqual([suya.id]);
    expect(bookingsTodo([suya, deJuan, sinVendedor], OWNER, NOW, TZ).pending.map((b) => b.id)).toEqual([
      deJuan.id,
      sinVendedor.id,
      suya.id,
    ]);
  });

  it("textos: «¿Cómo le fue a X?» y «Ayer, 5:00 p. m. · Tipo»", () => {
    const ayer = bk("2026-11-05T17:00");
    expect(outcomeQuestion(ayer)).toBe("¿Cómo le fue a Sofía Castro?");
    expect(outcomeWhen(ayer, NOW, TZ)).toBe("Ayer, 5:00 p. m. · Visita a la tienda");
    expect(outcomeWhen(bk("2026-11-02T09:30", { type: null }), NOW, TZ)).toBe("El lun 2 nov, 9:30 a. m.");
  });
});

describe("(b) hoy y mañana", () => {
  it("hoy: las que aún no terminan, en orden; mañana aparte", () => {
    const tarde = bk("2026-11-06T16:00", { contact: { id: "c", name: "Carlos Ruiz" } });
    const pronto = bk("2026-11-06T13:00", { contact: { id: "l", name: "Laura Gómez" } });
    const yaPaso = bk("2026-11-06T09:00");
    const manana = bk("2026-11-07T11:00", { contact: { id: "l", name: "Laura Gómez" } });
    const todo = bookingsTodo([tarde, yaPaso, manana, pronto], ANA, NOW, TZ);
    expect(todo.today.map((b) => b.id)).toEqual([pronto.id, tarde.id]);
    expect(todo.tomorrow.map((b) => b.id)).toEqual([manana.id]);
    expect(todo.next?.id).toBe(pronto.id);
    expect(todayTitle(todo, false, TZ)).toBe("Hoy tienes 2 · la próxima: Laura 1:00 p. m.");
    expect(todayTitle(todo, true, TZ)).toBe("Hoy hay 2 · la próxima: Laura 1:00 p. m.");
  });

  it("sin citas hoy; mañana con nombres", () => {
    const a = bk("2026-11-07T11:00", { contact: { id: "l", name: "Laura Gómez" } });
    const b = bk("2026-11-07T16:00", { contact: { id: "c", name: "Carlos Ruiz" } });
    const todo = bookingsTodo([b, a], ANA, NOW, TZ);
    expect(todayTitle(todo, false, TZ)).toBe("Hoy no tienes citas");
    expect(todayTitle(todo, true, TZ)).toBe("Hoy no hay citas");
    expect(tomorrowLine(todo, false, TZ)).toBe("Mañana: Laura 11:00 a. m. y Carlos 4:00 p. m.");
    expect(tomorrowLine(bookingsTodo([], ANA, NOW, TZ), false, TZ)).toBe("Mañana no tienes citas");
  });

  it("muchas mañana ⇒ cuenta y la primera; el Vendedor no cuenta las de otro", () => {
    const many = ["09:00", "10:00", "11:00", "12:00"].map((h) => bk(`2026-11-07T${h}`));
    const deJuan = bk("2026-11-07T08:00", { assignedUser: { id: "u_juan", name: "Juan" } });
    const todo = bookingsTodo([...many, deJuan], ANA, NOW, TZ);
    expect(tomorrowLine(todo, false, TZ)).toBe("Mañana: 4 citas, la primera Sofía 9:00 a. m.");
  });
});

describe("(c) sin vendedor", () => {
  it("futuras o en curso, sin vendedor, no de prueba, en orden", () => {
    const sab = bk("2026-11-07T12:00", { assignedUser: null, contact: { id: "j", name: "Jorge Méndez" } });
    const pasada = bk("2026-11-05T12:00", { assignedUser: null });
    const prueba = bk("2026-11-07T13:00", { assignedUser: null, isTest: true });
    const todo = bookingsTodo([sab, pasada, prueba], ANA, NOW, TZ);
    expect(todo.unassigned.map((b) => b.id)).toEqual([sab.id]);
    expect(unassignedTitle(1)).toBe("1 cita sin vendedor");
    expect(unassignedTitle(3)).toBe("3 citas sin vendedor");
    expect(unassignedTitle(3)).not.toMatch(/^Citas/);
    expect(unassignedLine(sab, NOW, TZ)).toBe("Jorge Méndez · mañana, 12:00 p. m.");
  });
});
