/**
 * 035 — Recordatorios internos del vendedor («Recordarme», Seguimiento ›
 * Pendientes). Contrato compartido cliente/servidor, puro y sin React.
 *
 * Ojo con el nombre: los «recordatorios de cita» automáticos AL CLIENTE son
 * otra cosa (`booking_reminder`, `src/lib/reminders.ts`). Esto es para el
 * vendedor y nunca sale del CRM; en el código se llama `follow_up`.
 *
 * Importaciones RELATIVAS a propósito: lo lee el esquema
 * (`lib/db/schema.ts`), y drizzle-kit no resuelve el alias `@/`.
 *
 * Horas: `due_at` es un instante UTC (como `booking.scheduled_at`). Todo lo de
 * pared —capturar, mostrar, «mañana a la misma hora», «cada 6 meses»— se hace
 * en la zona del negocio, igual que Citas.
 */
import { z } from "zod";
import { addDaysISO, dayIsoInTz, zonedWallClockToUtc } from "./time/slots";
import { tzLabel } from "./tz-label";

// ── Catálogos ────────────────────────────────────────────────────────────

export const FOLLOW_UP_REASONS = [
  "volver_a_contactar",
  "servicio",
  "informacion",
  "cita",
  "otro",
] as const;
export type FollowUpReason = (typeof FOLLOW_UP_REASONS)[number];

export const FOLLOW_UP_REASON_LABEL: Record<FollowUpReason, string> = {
  volver_a_contactar: "Volver a contactar",
  servicio: "Servicio",
  informacion: "Información solicitada",
  cita: "Cita",
  otro: "Otro",
};

export const FOLLOW_UP_STATUSES = ["open", "done"] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

/** De dónde nació. La fase C agrega «al marcar perdido» y «no asistió». */
export const FOLLOW_UP_SOURCES = ["manual"] as const;
export type FollowUpSource = (typeof FOLLOW_UP_SOURCES)[number];

export const REPEAT_MONTHS = [3, 6, 12] as const;
export type RepeatMonths = (typeof REPEAT_MONTHS)[number];

/** Hora por omisión de los atajos del diálogo (hora del negocio). */
export const DEFAULT_FOLLOW_UP_TIME = "10:00";
export const FOLLOW_UP_NOTE_MAX = 500;

/** Atajos de «¿Cuándo?» del diálogo. */
export const WHEN_SHORTCUTS = ["tomorrow", "3d", "week", "month"] as const;
export type WhenShortcut = (typeof WHEN_SHORTCUTS)[number];
export const WHEN_SHORTCUT_LABEL: Record<WhenShortcut, string> = {
  tomorrow: "Mañana",
  "3d": "En 3 días",
  week: "En 1 semana",
  month: "En 1 mes",
};

/** Opciones de «Posponer ▾» (la cuarta es «Otra fecha y hora»). */
export const POSTPONE_PRESETS = ["1h", "tomorrow", "week"] as const;
export type PostponePreset = (typeof POSTPONE_PRESETS)[number];
export const POSTPONE_LABEL: Record<PostponePreset, string> = {
  "1h": "1 hora",
  tomorrow: "Mañana a la misma hora",
  week: "1 semana",
};

/** «Sin contacto»: último mensaje hace más de N días. */
export const NO_CONTACT_DAYS = [15, 30, 60, 90] as const;
/** «Sin respuesta a tu plantilla»: la plantilla salió hace más de N días. */
export const NO_REPLY_DAYS = [3, 7, 14] as const;

// ── Validación (Zod) ─────────────────────────────────────────────────────

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `YYYY-MM-DD` que existe en el calendario (rechaza 2026-02-30). */
export function isRealDay(day: string): boolean {
  if (!ISO_DAY.test(day)) return false;
  const t = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === day;
}

const daySchema = z.string().refine(isRealDay, "fecha inválida (YYYY-MM-DD)");
const timeSchema = z.string().regex(HHMM, "hora inválida (HH:mm)");
const idSchema = z.string().trim().min(1).max(64);
const noteSchema = z
  .string()
  .max(FOLLOW_UP_NOTE_MAX, `máximo ${FOLLOW_UP_NOTE_MAX} caracteres`)
  .nullish()
  .transform((v) => (v?.trim() ? v.trim() : null));
const repeatSchema = z
  .union([z.literal(3), z.literal(6), z.literal(12)])
  .nullish()
  .transform((v) => v ?? null);

export const followUpCreateSchema = z.object({
  contactId: idSchema,
  conversationId: idSchema.nullish().transform((v) => v ?? null),
  /** Día y hora DE PARED en la zona del negocio. */
  day: daySchema,
  time: timeSchema,
  reason: z.enum(FOLLOW_UP_REASONS),
  note: noteSchema,
  repeatMonths: repeatSchema,
});
export type FollowUpCreateBody = z.infer<typeof followUpCreateSchema>;

export const followUpPatchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("done"), note: noteSchema }),
  z.object({ action: z.literal("postpone"), preset: z.enum(POSTPONE_PRESETS) }),
  z.object({ action: z.literal("reschedule"), day: daySchema, time: timeSchema }),
]);
export type FollowUpPatchBody = z.infer<typeof followUpPatchSchema>;

/** Query de `GET /api/follow-ups/pending` (lo que llega en la URL). */
export const pendingQuerySchema = z
  .object({
    userId: z.string().trim().min(1).max(64).optional(),
    days: z.coerce
      .number()
      .refine((n) => (NO_CONTACT_DAYS as readonly number[]).includes(n), "días: 15, 30, 60 o 90")
      .optional(),
    from: daySchema.optional(),
    to: daySchema.optional(),
    includeLost: z
      .enum(["0", "1", "true", "false"])
      .optional()
      .transform((v) => v === "1" || v === "true"),
    replyDays: z.coerce
      .number()
      .refine((n) => (NO_REPLY_DAYS as readonly number[]).includes(n), "días: 3, 7 o 14")
      .optional(),
  })
  .refine((q) => !(q.from && q.to) || q.from <= q.to, {
    message: "«Desde» debe ser antes de «Hasta»",
    path: ["from"],
  });
export type PendingQuery = z.infer<typeof pendingQuerySchema>;

// ── Aritmética de fechas (pared, zona del negocio) ───────────────────────

function daysInMonth(y: number, m1: number): number {
  return new Date(Date.UTC(y, m1, 0)).getUTCDate();
}

/**
 * Suma meses a un día ISO conservando el día del mes cuando existe y, si no,
 * el último del mes: 31 ene + 1 → 28 feb (29 en bisiesto); 31 ago + 6 → 28 feb.
 * El año corre solo (nov + 3 → feb del siguiente).
 */
export function addMonthsClamped(day: string, months: number): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  const idx = y * 12 + (m - 1) + months;
  const ty = Math.floor(idx / 12);
  const tm = (idx % 12) + 1;
  const td = Math.min(d, daysInMonth(ty, tm));
  return `${String(ty).padStart(4, "0")}-${String(tm).padStart(2, "0")}-${String(td).padStart(2, "0")}`;
}

const HM_FORMATS = new Map<string, Intl.DateTimeFormat>();
/** `HH:mm` de pared de un instante en la zona (00–23, nunca «24:00»). */
export function hhmmInTz(instant: Date, tz: string): string {
  let f = HM_FORMATS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    HM_FORMATS.set(tz, f);
  }
  return f.format(instant);
}

/** Día y hora de pared de un instante en la zona del negocio. */
export function wallOf(instant: Date | string, tz: string): { day: string; time: string } {
  const d = new Date(instant);
  return { day: dayIsoInTz(d, tz), time: hhmmInTz(d, tz) };
}

/** Día + hora de pared → instante UTC. `null` si los datos no se entienden. */
export function dueAtFromWall(day: string, time: string, tz: string): Date | null {
  if (!isRealDay(day) || !HHMM.test(time)) return null;
  return zonedWallClockToUtc(day, time, tz);
}

/**
 * Repetir: el siguiente queda N meses después del ORIGINAL (no de cuándo se
 * marcó hecho), el mismo día del mes si existe y a la misma hora de pared.
 */
export function nextRepeatDue(dueAt: Date | string, months: number, tz: string): Date {
  const w = wallOf(dueAt, tz);
  return dueAtFromWall(addMonthsClamped(w.day, months), w.time, tz) ?? new Date(dueAt);
}

/**
 * Posponer: mueve el mismo recordatorio.
 * - `1h`: dentro de una hora desde AHORA.
 * - `tomorrow`: mañana (en la zona) a la hora de pared del recordatorio.
 * - `week`: dentro de 7 días desde hoy, a esa misma hora.
 * Contar desde hoy y no desde `due_at` evita que posponer uno vencido hace
 * dos semanas lo deje… todavía vencido.
 */
export function postponeDue(
  dueAt: Date | string,
  preset: PostponePreset,
  now: Date,
  tz: string
): Date {
  if (preset === "1h") return new Date(now.getTime() + 60 * 60_000);
  const { time } = wallOf(dueAt, tz);
  const today = dayIsoInTz(now, tz);
  const day = addDaysISO(today, preset === "tomorrow" ? 1 : 7);
  return dueAtFromWall(day, time, tz) ?? new Date(now.getTime() + 24 * 60 * 60_000);
}

/** Día de pared de un atajo del diálogo, contado desde hoy en la zona. */
export function shortcutDay(shortcut: WhenShortcut, now: Date, tz: string): string {
  const today = dayIsoInTz(now, tz);
  switch (shortcut) {
    case "tomorrow":
      return addDaysISO(today, 1);
    case "3d":
      return addDaysISO(today, 3);
    case "week":
      return addDaysISO(today, 7);
    case "month":
      return addMonthsClamped(today, 1);
  }
}

// ── Grupos de «Mis recordatorios» ────────────────────────────────────────

export const FOLLOW_UP_GROUPS = ["overdue", "today", "week", "later"] as const;
export type FollowUpGroup = (typeof FOLLOW_UP_GROUPS)[number];
export const FOLLOW_UP_GROUP_LABEL: Record<FollowUpGroup, string> = {
  overdue: "Vencidos",
  today: "Hoy",
  week: "Esta semana",
  later: "Después",
};

/** Domingo (día ISO) de la semana de calendario lunes–domingo que contiene `day`. */
export function endOfWeekDay(day: string): string {
  const wd = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = domingo
  return addDaysISO(day, (7 - wd) % 7);
}

/**
 * Vencido = su instante ya pasó (aunque sea de hoy). Hoy = lo que queda de hoy
 * en la zona del negocio. Esta semana = de mañana al DOMINGO de esta semana de
 * calendario (lunes a domingo, en la zona; un domingo queda vacía). Después =
 * del lunes siguiente en adelante.
 */
export function followUpGroup(dueAt: Date | string, now: Date, tz: string): FollowUpGroup {
  const due = new Date(dueAt);
  if (due.getTime() < now.getTime()) return "overdue";
  const day = dayIsoInTz(due, tz);
  const today = dayIsoInTz(now, tz);
  if (day === today) return "today";
  if (day <= endOfWeekDay(today)) return "week";
  return "later";
}

/** Agrupa (y ordena por hora, el más próximo primero) en los cuatro grupos. */
export function groupFollowUps<T extends { dueAt: string }>(
  items: readonly T[],
  now: Date,
  tz: string
): Record<FollowUpGroup, T[]> {
  const out: Record<FollowUpGroup, T[]> = { overdue: [], today: [], week: [], later: [] };
  const sorted = [...items].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  for (const it of sorted) out[followUpGroup(it.dueAt, now, tz)].push(it);
  return out;
}

/** Contadores del filtro por motivo («Todos · 11», «Servicio · 2»…). */
export function reasonCounts<T extends { reason: FollowUpReason }>(
  items: readonly T[]
): Record<FollowUpReason | "all", number> {
  const out = { all: items.length } as Record<FollowUpReason | "all", number>;
  for (const r of FOLLOW_UP_REASONS) out[r] = 0;
  for (const it of items) out[it.reason]++;
  return out;
}

// ── Etiquetas ────────────────────────────────────────────────────────────

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MONTHS_LONG = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const WEEKDAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const WEEKDAYS_LONG = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

function dayParts(day: string): { y: number; m: number; d: number; wd: number } {
  const t = new Date(`${day}T12:00:00Z`);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), wd: t.getUTCDay() };
}

/** «10:00 a. m.» · «4:30 p. m.» (la hora en la zona del negocio). */
export function clock12(instant: Date | string, tz: string): string {
  const [h, m] = hhmmInTz(new Date(instant), tz).split(":").map(Number) as [number, number];
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "a. m." : "p. m."}`;
}

/** «20 nov» de un instante en la zona. */
export function shortDay(instant: Date | string, tz: string): string {
  const p = dayParts(dayIsoInTz(new Date(instant), tz));
  return `${p.d} ${MONTHS[p.m]}`;
}

/** El día de la fila: «Ayer» · «Hoy» · «Mañana» · «Lun 9 nov». */
export function dayWordOf(instant: Date | string, now: Date, tz: string): string {
  const day = dayIsoInTz(new Date(instant), tz);
  const today = dayIsoInTz(now, tz);
  if (day === today) return "Hoy";
  if (day === addDaysISO(today, -1)) return "Ayer";
  if (day === addDaysISO(today, 1)) return "Mañana";
  const p = dayParts(day);
  const year = p.y !== dayParts(today).y ? ` ${p.y}` : "";
  return `${WEEKDAYS[p.wd]} ${p.d} ${MONTHS[p.m]}${year}`;
}

/** «Hoy, 4:30 p. m.» (pie del diálogo). */
export function whenShort(instant: Date | string, now: Date, tz: string): string {
  return `${dayWordOf(instant, now, tz)}, ${clock12(instant, tz)}`;
}

/** «el 9 de mayo de 2027» de un día ISO. */
export function longDate(day: string): string {
  const p = dayParts(day);
  return `${p.d} de ${MONTHS_LONG[p.m]} de ${p.y}`;
}

/**
 * Vista previa del diálogo: «Miércoles 18 de noviembre, 10:00 a. m. (hora de
 * Ciudad de México)». `null` si la fecha no se entiende.
 */
export function wallPreview(day: string, time: string, tz: string): string | null {
  const at = dueAtFromWall(day, time, tz);
  if (!at) return null;
  const p = dayParts(day);
  const label = tzLabel(tz);
  return `${WEEKDAYS_LONG[p.wd]} ${p.d} de ${MONTHS_LONG[p.m]}, ${clock12(at, tz)}${label ? ` (${label})` : ""}`;
}

/** «cada 6 meses» */
export function repeatLabel(months: number): string {
  return `cada ${months} meses`;
}

/** «Se repite cada 6 meses: el siguiente queda para el 9 de mayo de 2027.» */
export function repeatNotice(dueAt: Date | string, months: number, tz: string): string {
  const next = nextRepeatDue(dueAt, months, tz);
  return `Se repite ${repeatLabel(months)}: el siguiente queda para el ${longDate(dayIsoInTz(next, tz))}.`;
}

/** Días completos entre un instante y ahora (nunca negativo). */
export function daysSince(instant: Date | string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(instant).getTime()) / 86_400_000));
}

/** «hace 74 días» · «hace 1 día» · «hoy». */
export function agoDays(instant: Date | string, now: Date): string {
  const n = daysSince(instant, now);
  if (n === 0) return "hoy";
  return `hace ${n} ${n === 1 ? "día" : "días"}`;
}

/** «el 1 y el 30 de septiembre» · «el 20 de agosto y el 3 de septiembre». */
export function betweenLabel(from: string, to: string): string {
  const a = dayParts(from);
  const b = dayParts(to);
  const sameYear = a.y === b.y;
  if (sameYear && a.m === b.m) return `el ${a.d} y el ${b.d} de ${MONTHS_LONG[b.m]}`;
  const left = `el ${a.d} de ${MONTHS_LONG[a.m]}${sameYear ? "" : ` de ${a.y}`}`;
  return `${left} y el ${b.d} de ${MONTHS_LONG[b.m]}${sameYear ? "" : ` de ${b.y}`}`;
}

// ── DTOs ─────────────────────────────────────────────────────────────────

export type FollowUpDto = {
  id: string;
  contact: { id: string; name: string };
  /** La conversación real del contacto HOY (puede haber nacido después). */
  conversationId: string | null;
  user: { id: string; name: string };
  dueAt: string;
  reason: FollowUpReason;
  note: string | null;
  repeatMonths: RepeatMonths | null;
  status: FollowUpStatus;
  doneAt: string | null;
  doneNote: string | null;
  createdFrom: FollowUpSource;
  /** Etapa del trato del contacto, si tiene. */
  stageName: string | null;
  createdAt: string;
};

export type FollowUpListDto = {
  followUps: FollowUpDto[];
  businessTimezone: string;
};

/** Una fila de «Sin contacto» o de «Sin respuesta a tu plantilla». */
export type PendingRowDto = {
  conversationId: string;
  contact: { id: string; name: string };
  stageName: string | null;
  assignedTo: { id: string; name: string } | null;
  /** Último mensaje (o, sin mensajes, cuándo nació el chat). */
  lastAt: string;
  /** Recordatorio abierto más próximo de este contacto (de quien se mira). */
  openFollowUpAt: string | null;
};

export type NoReplyRowDto = PendingRowDto & {
  templateName: string | null;
  templateStatus: "pending" | "sent" | "delivered" | "read";
};

export type PendingDto = {
  businessTimezone: string;
  noContact: { total: number; rows: PendingRowDto[] };
  noReply: { total: number; rows: NoReplyRowDto[] };
};

/** Tope de filas por recuadro (el total se dice igual). */
export const PENDING_ROW_CAP = 300;
