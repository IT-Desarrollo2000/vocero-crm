/**
 * 032 — Citas «que se explican solas»: lo que te toca. Puro: lo usa
 * `src/components/bookings/bookings-client.tsx` (franja «Lo que te toca») y lo
 * cubre `tests/unit/bookings-todo.test.ts`.
 *
 * Dadas las citas de un rango propio (−14 d … +2 d desde hoy, zona del
 * NEGOCIO), quién mira, la hora y la zona, decide:
 *  (a) las pasadas sin resultado («¿Cómo le fue a X?»): sesión `agendada`, ya
 *      terminó, no es de prueba. Vendedor: solo las asignadas a él (lo
 *      creado-sin-vendedor cae en la tarjeta «sin vendedor»); Propietario:
 *      todas.
 *  (b) hoy / mañana y la próxima.
 *  (c) las que siguen sin vendedor (futuras o en curso).
 *
 * Nada aquí lee `Date.now()`: `now` se inyecta. Las horas se arman a mano
 * (`clockLabel`) por la variación de ICU con «p. m.».
 */

import { clockLabel, dayWord } from "@/lib/pipeline-card";
import { firstName } from "@/lib/quick-replies";
import { isOwner, type Role } from "@/lib/roles";
import { addDaysISO, dayIsoInTz } from "@/lib/time/slots";

/** Días hacia atrás y hacia adelante del rango propio de la franja. */
export const TODO_PAST_DAYS = 14;
export const TODO_AHEAD_DAYS = 2;

export type TodoBooking = {
  id: string;
  kind: "session" | "block";
  status: "agendada" | "realizada" | "no_show" | "cancelada";
  isTest: boolean;
  scheduledAtUtc: string;
  durationMinutes: number;
  contact: { id: string; name: string } | null;
  type: { id: string; name: string } | null;
  assignedUser: { id: string; name: string } | null;
};

export type TodoViewer = { userId: string; role: Role };

export type BookingsTodo<T extends TodoBooking> = {
  /** (a) Pasadas sin resultado, la más reciente primero. */
  pending: T[];
  /** (b) Las de hoy que aún no terminan, en orden. */
  today: T[];
  /** (b) Las de mañana, en orden. */
  tomorrow: T[];
  /** (b) La próxima que no ha terminado (hoy o después), o null. */
  next: T | null;
  /** (c) Sin vendedor, aún no terminadas, en orden. */
  unassigned: T[];
};

/** `from`/`to` (días del negocio) del rango propio de la franja. */
export function todoRange(now: Date, tz: string): { from: string; to: string } {
  const today = dayIsoInTz(now, tz);
  return {
    from: addDaysISO(today, -TODO_PAST_DAYS),
    to: addDaysISO(today, TODO_AHEAD_DAYS),
  };
}

const endMs = (b: TodoBooking) =>
  Date.parse(b.scheduledAtUtc) + b.durationMinutes * 60_000;
const startMs = (b: TodoBooking) => Date.parse(b.scheduledAtUtc);

/** ¿La cita ya terminó y sigue `agendada`? (sesión, no de prueba). */
export function needsOutcome(
  b: Pick<TodoBooking, "kind" | "status" | "isTest" | "scheduledAtUtc" | "durationMinutes">,
  now: number
): boolean {
  return (
    b.kind === "session" &&
    b.status === "agendada" &&
    !b.isTest &&
    endMs(b as TodoBooking) <= now
  );
}

export function bookingsTodo<T extends TodoBooking>(
  bookings: readonly T[],
  viewer: TodoViewer,
  now: number,
  tz: string
): BookingsTodo<T> {
  const owner = isOwner(viewer);
  const live = bookings.filter(
    (b) => b.kind === "session" && b.status === "agendada" && !b.isTest
  );
  const mine = (b: T) => owner || b.assignedUser?.id === viewer.userId;
  const asc = (a: T, b: T) => startMs(a) - startMs(b);

  const pending = live
    .filter((b) => endMs(b) <= now && mine(b))
    .sort((a, b) => startMs(b) - startMs(a));

  const ahead = live.filter((b) => endMs(b) > now).sort(asc);
  const todayIso = dayIsoInTz(new Date(now), tz);
  const tomorrowIso = addDaysISO(todayIso, 1);
  const dayOf = (b: T) => dayIsoInTz(new Date(b.scheduledAtUtc), tz);
  const ownAhead = ahead.filter(mine);

  return {
    pending,
    today: ownAhead.filter((b) => dayOf(b) === todayIso),
    tomorrow: ownAhead.filter((b) => dayOf(b) === tomorrowIso),
    next: ownAhead[0] ?? null,
    unassigned: ahead.filter((b) => !b.assignedUser),
  };
}

/* ───────────────────────── textos ───────────────────────── */

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function who(b: TodoBooking): string {
  return b.contact?.name.trim() || "el cliente";
}

/** «¿Cómo le fue a Sofía Castro?» */
export function outcomeQuestion(b: TodoBooking): string {
  return `¿Cómo le fue a ${who(b)}?`;
}

/** «Ayer, 5:00 p. m. · Visita a la tienda» (sin tipo, solo la hora). */
export function outcomeWhen(b: TodoBooking, now: number, tz: string): string {
  const when = `${capitalize(dayWord(b.scheduledAtUtc, now, tz))}, ${clockLabel(b.scheduledAtUtc, tz)}`;
  return b.type ? `${when} · ${b.type.name}` : when;
}

/** «Laura 11:00 a. m.» */
function shortItem(b: TodoBooking, tz: string): string {
  const name = firstName(b.contact?.name) || "Cita";
  return `${name} ${clockLabel(b.scheduledAtUtc, tz)}`;
}

/** «A», «A y B», «A, B y C». */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

/** Hasta cuántas citas se nombran en una línea; más ⇒ «N citas · la primera». */
const NAMED_MAX = 3;

/**
 * Título de la tarjeta de hoy: «Hoy no tienes citas» ·
 * «Hoy tienes 2 · la próxima: Laura 11:00 a. m.» (el Propietario: «Hoy hay …»).
 */
export function todayTitle(
  todo: BookingsTodo<TodoBooking>,
  owner: boolean,
  tz: string
): string {
  const n = todo.today.length;
  const first = todo.today[0];
  if (n === 0 || !first) return owner ? "Hoy no hay citas" : "Hoy no tienes citas";
  return `${owner ? "Hoy hay" : "Hoy tienes"} ${n} · la próxima: ${shortItem(first, tz)}`;
}

/** «Mañana: Laura 11:00 a. m. y Carlos 4:00 p. m.» · «Mañana no tienes citas» */
export function tomorrowLine(
  todo: BookingsTodo<TodoBooking>,
  owner: boolean,
  tz: string
): string {
  const t = todo.tomorrow;
  if (t.length === 0) return owner ? "Mañana no hay citas" : "Mañana no tienes citas";
  if (t.length > NAMED_MAX) {
    return `Mañana: ${t.length} citas, la primera ${shortItem(t[0]!, tz)}`;
  }
  return `Mañana: ${joinList(t.map((b) => shortItem(b, tz)))}`;
}

/** «1 cita sin vendedor» · «3 citas sin vendedor» (nunca empieza con «Citas»). */
export function unassignedTitle(n: number): string {
  return n === 1 ? "1 cita sin vendedor" : `${n} citas sin vendedor`;
}

/** «Jorge Méndez · mañana, 12:00 p. m.» */
export function unassignedLine(b: TodoBooking, now: number, tz: string): string {
  return `${who(b)} · ${dayWord(b.scheduledAtUtc, now, tz)}, ${clockLabel(b.scheduledAtUtc, tz)}`;
}
