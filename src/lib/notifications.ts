/**
 * 035 fase B — Avisos dentro del CRM (campana, aviso emergente, navegador).
 * Contrato compartido cliente/servidor, puro y sin React.
 *
 * Importaciones RELATIVAS a propósito: lo lee el esquema
 * (`lib/db/schema.ts`), y drizzle-kit no resuelve el alias `@/`.
 *
 * Un aviso es SIEMPRE de una persona (`notification.user_id`): el Propietario
 * no recibe los de su equipo (sus vencidos los ve en Pendientes con el filtro).
 */
import { z } from "zod";
import { FOLLOW_UP_REASON_LABEL, shortDay, whenShort, type FollowUpReason } from "./follow-ups";
import { addDaysISO, dayIsoInTz, labelInTz, timeInTz, zonedWallClockToUtc } from "./time/slots";

// ── Catálogos ────────────────────────────────────────────────────────────

export const NOTIFICATION_KINDS = [
  "follow_up_due",
  "daily_summary",
  "chat_assigned",
  "booking_assigned",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Vuelta del reloj de avisos (`NOTIFICATIONS_TICK_MS`): 60 s. */
export const NOTIFICATIONS_TICK_DEFAULT_MS = 60_000;
/** Solo se avisa de lo vencido en las últimas 24 h (no inundar al arrancar). */
export const DUE_LOOKBACK_MS = 24 * 60 * 60_000;
/** Los leídos se borran a los 60 días. */
export const READ_RETENTION_DAYS = 60;
/** El resumen del día sale desde esta hora de pared del negocio. */
export const DAILY_SUMMARY_TIME = "08:00";
/** Cuántos avisos trae la campana. */
export const NOTIFICATION_LIST_LIMIT = 30;
/** Avisos emergentes a la vista a la vez. */
export const TOAST_MAX = 3;

/**
 * Instantánea para el texto: lo que había al crear el aviso (el nombre del
 * cliente puede cambiar después; el aviso cuenta lo que pasó).
 */
export type NotificationPayload = {
  contactName?: string;
  reason?: FollowUpReason;
  note?: string | null;
  /** `follow_up.due_at` que disparó el aviso (ISO). */
  dueAt?: string;
  /** `booking.scheduled_at` (ISO). */
  scheduledAt?: string;
  /** Resumen del día: día de pared y cuántos tenía al crearse. */
  day?: string;
  total?: number;
  /** La cita la agendó la IA o el bot (sin actor humano): texto neutro. */
  byAgent?: boolean;
};

// ── Claves de dedupe (DETERMINISTAS: el UNIQUE es el candado) ────────────

const iso = (d: Date | string) => new Date(d).toISOString();

/** Posponer = otra hora = otro aviso. */
export function followUpDueKey(followUpId: string, dueAt: Date | string): string {
  return `fu:${followUpId}:${iso(dueAt)}`;
}
/** Uno por usuario y día de pared del negocio. */
export function dailySummaryKey(day: string): string {
  return `daily:${day}`;
}
export function chatAssignedKey(conversationId: string, toUserId: string, assignedAt: Date | string): string {
  return `chat:${conversationId}:${toUserId}:${iso(assignedAt)}`;
}
export function bookingAssignedKey(bookingId: string, toUserId: string, updatedAt: Date | string): string {
  return `booking:${bookingId}:${toUserId}:${iso(updatedAt)}`;
}

// ── Reglas del reloj ─────────────────────────────────────────────────────

/** Día de pared de hoy y fin de hoy (instante UTC del 00:00 de mañana). */
export function todayWindow(now: Date, tz: string): { day: string; endOfDay: Date } {
  const day = dayIsoInTz(now, tz);
  const end = zonedWallClockToUtc(addDaysISO(day, 1), "00:00", tz);
  return { day, endOfDay: end ?? new Date(now.getTime() + 24 * 60 * 60_000) };
}

/**
 * Resumen del día: desde las 08:00 de pared del negocio (`null` antes).
 * Devuelve el día al que pertenece (la clave) y el fin de ese día.
 */
export function dailySummaryWindow(now: Date, tz: string): { day: string; endOfDay: Date } | null {
  const w = todayWindow(now, tz);
  const start = zonedWallClockToUtc(w.day, DAILY_SUMMARY_TIME, tz);
  if (!start || now.getTime() < start.getTime()) return null;
  return w;
}

/** ¿Este recordatorio abierto amerita aviso de vencido en `now`? */
export function isDueForNotice(dueAt: Date | string, now: Date): boolean {
  const t = new Date(dueAt).getTime();
  return t <= now.getTime() && t > now.getTime() - DUE_LOOKBACK_MS;
}

// ── Validación (Zod) ─────────────────────────────────────────────────────

export const notificationReadSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ ids: z.array(z.string().trim().min(1).max(64)).min(1).max(100) }),
]);
export type NotificationReadBody = z.infer<typeof notificationReadSchema>;

// ── DTOs ─────────────────────────────────────────────────────────────────

export type NotificationDto = {
  id: string;
  kind: NotificationKind;
  createdAt: string;
  readAt: string | null;
  contact: { id: string; name: string } | null;
  conversationId: string | null;
  bookingId: string | null;
  followUpId: string | null;
  /** Quien lo provocó (asignaciones); `null` si fue la IA o el bot. */
  actorName: string | null;
  payload: NotificationPayload;
  /** Estado VIVO del recordatorio (solo `follow_up_due`). */
  followUp: { status: "open" | "done"; dueAt: string; conversationId: string | null } | null;
};

/** Recordatorios propios de hoy (incluye vencidos) y vencidos, en vivo. */
export type FollowUpCountsDto = { overdue: number; today: number };

export type NotificationListDto = {
  notifications: NotificationDto[];
  unread: number;
  summary: FollowUpCountsDto;
  businessTimezone: string;
};

// ── Textos ───────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** «ahora mismo» · «hace 20 min» · «hace 3 h» · «ayer» · «9 nov». */
export function agoLabel(instant: Date | string, now: Date, tz: string): string {
  const t = new Date(instant).getTime();
  const min = Math.max(0, Math.floor((now.getTime() - t) / 60_000));
  if (min < 1) return "ahora mismo";
  if (min < 60) return `hace ${min} min`;
  const day = dayIsoInTz(new Date(t), tz);
  const today = dayIsoInTz(now, tz);
  if (day === today) return `hace ${Math.floor(min / 60)} h`;
  if (day === addDaysISO(today, -1)) return "ayer";
  return shortDay(instant, tz);
}

/** Hora de una cita: «mañana 12:00» · «hoy 16:30» · «mié 5 ago, 10:00». */
export function bookingWhen(scheduledAt: Date | string, now: Date, tz: string): string {
  const s = iso(scheduledAt);
  const day = dayIsoInTz(new Date(s), tz);
  const today = dayIsoInTz(now, tz);
  if (day === today) return `hoy ${timeInTz(s, tz)}`;
  if (day === addDaysISO(today, 1)) return `mañana ${timeInTz(s, tz)}`;
  if (day === addDaysISO(today, -1)) return `ayer ${timeInTz(s, tz)}`;
  return labelInTz(s, tz);
}

/** «Hoy tienes 5 recordatorios» + « (2 vencidos)»; con 0, el texto atenuado. */
export function dailySummaryText(c: FollowUpCountsDto): { lead: string; rest: string; muted: boolean } {
  if (c.today <= 0) return { lead: "Ya no te quedan recordatorios para hoy", rest: "", muted: true };
  return {
    lead: `Hoy tienes ${c.today} ${plural(c.today, "recordatorio", "recordatorios")}`,
    rest: c.overdue > 0 ? ` (${c.overdue} ${plural(c.overdue, "vencido", "vencidos")})` : "",
    muted: false,
  };
}

/**
 * Lo que dice una fila de la campana (el panel decide botones y enlaces):
 *   `lead` en negrita (si hay) + `title`; `detail` debajo; `state` reemplaza
 *   a los botones de un recordatorio que ya se atendió.
 */
export type NotificationCopy = {
  lead: string | null;
  title: string;
  detail: string | null;
  state: string | null;
  muted: boolean;
  tone: "danger" | "accent";
};

export function notificationCopy(
  n: NotificationDto,
  ctx: { now: Date; tz: string; summary: FollowUpCountsDto }
): NotificationCopy {
  const { now, tz } = ctx;
  const p = n.payload;
  const name = n.contact?.name ?? p.contactName ?? "Cliente";
  const ago = agoLabel(n.createdAt, now, tz);
  switch (n.kind) {
    case "follow_up_due": {
      const reason = p.reason ? FOLLOW_UP_REASON_LABEL[p.reason] : null;
      const when = p.dueAt ? whenShort(p.dueAt, now, tz) : null;
      const note = p.note?.trim() ? `«${p.note.trim()}»` : null;
      let state: string | null = null;
      if (n.followUp?.status === "done") state = "Ya lo marcaste como hecho";
      else if (n.followUp && p.dueAt && n.followUp.dueAt !== iso(p.dueAt)) {
        state = `Lo pospusiste para ${lowerFirst(whenShort(n.followUp.dueAt, now, tz))}`;
      } else if (!n.followUp) state = "Ese recordatorio ya no existe";
      return {
        lead: "Recordatorio vencido:",
        title: reason ? `${name} · ${reason}` : name,
        detail: [note, when].filter(Boolean).join(" · ") || null,
        state,
        muted: false,
        tone: "danger",
      };
    }
    case "daily_summary": {
      const today = dayIsoInTz(now, tz);
      if (p.day && p.day !== today) {
        const total = p.total ?? 0;
        return {
          lead: null,
          title: `Ese día tenías ${total} ${plural(total, "recordatorio", "recordatorios")}`,
          detail: null,
          state: null,
          muted: true,
          tone: "accent",
        };
      }
      const t = dailySummaryText(ctx.summary);
      return { lead: t.lead, title: t.rest, detail: null, state: null, muted: t.muted, tone: "accent" };
    }
    case "chat_assigned":
      return {
        lead: null,
        title: `Te asignaron a ${name}`,
        detail: n.actorName ? `${n.actorName} la pasó a tu nombre · ${ago}` : `Quedó a tu nombre · ${ago}`,
        state: null,
        muted: false,
        tone: "accent",
      };
    case "booking_assigned": {
      const when = p.scheduledAt ? ` · ${bookingWhen(p.scheduledAt, now, tz)}` : "";
      return {
        lead: null,
        title: p.byAgent ? `Se agendó la cita de ${name}${when}` : `Te asignaron la cita de ${name}${when}`,
        detail: n.actorName ? `${n.actorName} te la asignó · ${ago}` : capitalize(ago),
        state: null,
        muted: false,
        tone: "accent",
      };
    }
  }
}

/** Aviso emergente de un recordatorio: «Recordatorio: Laura Gómez» + motivo · nota. */
export function toastCopy(n: Pick<NotificationDto, "contact" | "payload">): { title: string; body: string } {
  const p = n.payload;
  const name = n.contact?.name ?? p.contactName ?? "Cliente";
  const reason = p.reason ? FOLLOW_UP_REASON_LABEL[p.reason] : null;
  const note = p.note?.trim() ? `«${p.note.trim()}»` : null;
  return { title: `Recordatorio: ${name}`, body: [reason, note].filter(Boolean).join(" · ") };
}

/** Texto de la notificación del navegador (pestaña oculta). */
export function browserNotificationCopy(
  n: NotificationDto,
  ctx: { now: Date; tz: string }
): { title: string; body: string } | null {
  const name = n.contact?.name ?? n.payload.contactName ?? "Cliente";
  switch (n.kind) {
    case "follow_up_due": {
      const t = toastCopy(n);
      return { title: t.title, body: t.body || "Tienes un recordatorio vencido." };
    }
    case "chat_assigned":
      return { title: `Te asignaron a ${name}`, body: n.actorName ? `${n.actorName} la pasó a tu nombre.` : "Quedó a tu nombre." };
    case "booking_assigned": {
      const when = n.payload.scheduledAt ? ` · ${bookingWhen(n.payload.scheduledAt, ctx.now, ctx.tz)}` : "";
      return {
        title: n.payload.byAgent ? `Se agendó la cita de ${name}` : `Te asignaron la cita de ${name}`,
        body: when ? capitalize(when.slice(3)) : "Ábrela en Citas.",
      };
    }
    case "daily_summary":
      return null;
  }
}

/**
 * Lo que se registra de un error al avisar: nombre y código, NUNCA el mensaje
 * (un error de BD puede citar valores con nombres o notas del cliente).
 */
export function safeErrorTag(err: unknown): string {
  if (!(err instanceof Error)) return "error";
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? `${err.name} ${code}` : err.name;
}
