import {
  addDaysISO,
  dayIsoInTz,
  timeInTz,
  zonedWallClockToUtc,
} from "@/lib/time/slots";

/**
 * 025 — Cómo se NOMBRA un horario ofrecido, en un solo lugar (PURO: sin BD).
 *
 * Tres formas, cada una con un dueño:
 *  - `localKey`   "2026-10-23 11:00"  — la clave con la que el modelo reserva
 *                 (`book_slot.slot`). Hora LOCAL del negocio: convertir a UTC
 *                 a ojo fue lo que falló en el incidente del 21-oct.
 *  - `shortLabel` "vie 23 oct 11:00"  — lo que el cliente VIO; se guarda en
 *                 `message.agent_action.shown` y de ahí salen la marca `*` del
 *                 prompt y la re-oferta "sin repetir lo mostrado".
 *  - el bloque HORARIOS OFRECIDOS del prompt (`formatOffersForPrompt`).
 *
 * La marca `*` y el filtro "no mostrados" recomputan `shortLabel` y comparan
 * contra `shown`: nunca con dos formateadores distintos.
 */

/** Encabezado del bloque del prompt (el ai-mock lo busca). */
export const OFFERS_MARKER = "HORARIOS OFRECIDOS";

const WEEKDAY_FMT = (tz: string) =>
  new Intl.DateTimeFormat("es-MX", { timeZone: tz, weekday: "short" });

function stripDot(s: string): string {
  return s.replace(/\.$/, "");
}

/** Día de la semana corto ("vie", "sáb") de un instante en la zona. */
export function weekdayShort(instant: Date, tz: string): string {
  return stripDot(WEEKDAY_FMT(tz).format(instant));
}

/** "2026-10-23 11:00" — la clave local de un instante. */
export function localKey(startUtc: string, tz: string): string {
  const d = new Date(startUtc);
  if (Number.isNaN(d.getTime())) return "";
  return `${dayIsoInTz(d, tz)} ${timeInTz(startUtc, tz)}`;
}

/** "vie 23 oct 11:00" — la etiqueta corta de lo mostrado. */
export function shortLabel(startUtc: string, tz: string): string {
  const d = new Date(startUtc);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("es-MX", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return `${stripDot(map.weekday ?? "")} ${map.day} ${stripDot(map.month ?? "")} ${timeInTz(startUtc, tz)}`;
}

/**
 * Normaliza una clave local que escribió el modelo: acepta espacio o `T`, la
 * hora con 1 o 2 dígitos y lo que venga detrás ("2026-10-23 9:00 (vie)").
 * Devuelve "YYYY-MM-DD HH:MM" o null.
 */
export function normalizeSlotKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = /(\d{4})-(\d{2})-(\d{2})[ T]+(\d{1,2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[4]);
  const min = Number(m[5]);
  if (h > 23 || min > 59) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${String(h).padStart(2, "0")}:${m[5]}`;
}

/** Clave local → instante UTC (ISO), con la zona del negocio. */
export function slotKeyToUtc(key: string, tz: string): string | null {
  const norm = normalizeSlotKey(key);
  if (!norm) return null;
  const [day, hhmm] = norm.split(" ") as [string, string];
  const d = zonedWallClockToUtc(day, hhmm, tz);
  return d ? d.toISOString() : null;
}

export type PromptOffer = {
  startUtc: string;
  /** Nombre del tipo de la oferta (null en ofertas legacy). */
  typeName?: string | null;
};

/**
 * El bloque HORARIOS OFRECIDOS: una línea por oferta vigente, en orden, con
 * su clave local. `*` = el cliente la VIO en el último mensaje de horarios;
 * `-` = registrada (reservable) pero no mostrada.
 *
 *   HORARIOS OFRECIDOS (…):
 *   * 2026-10-23 10:00 (vie) — Prueba de manejo
 *   - 2026-10-23 10:30 (vie) — Prueba de manejo
 */
export function formatOffersForPrompt(
  offers: readonly PromptOffer[],
  tz: string,
  shown: readonly string[] = []
): string {
  if (offers.length === 0) {
    return `${OFFERS_MARKER}: ninguno vigente. Para reservar, primero ofrece con offer_slots.`;
  }
  const seen = new Set(shown);
  const lines = offers.map((o) => {
    const mark = seen.has(shortLabel(o.startUtc, tz)) ? "*" : "-";
    const day = weekdayShort(new Date(o.startUtc), tz);
    const type = o.typeName ? ` — ${o.typeName}` : "";
    return `${mark} ${localKey(o.startUtc, tz)} (${day})${type}`;
  });
  return [
    `${OFFERS_MARKER} (vigentes en esta conversación; reserva con book_slot y "slot" = la clave exacta "YYYY-MM-DD HH:MM"; * = los que el cliente vio en tu último mensaje de horarios):`,
    ...lines,
  ].join("\n");
}

/** "miércoles 21 oct 2026 12:24" en la zona. */
function longToday(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("es-MX", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).formatToParts(now);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.weekday} ${map.day} ${stripDot(map.month ?? "")} ${map.year} ${timeInTz(now.toISOString(), tz)}`;
}

/**
 * La fecha fija de la sección de agenda (A8), independiente del bloque de
 * contacto (que puede faltar):
 *
 *   Hoy: miércoles 21 oct 2026 12:24 (America/Mexico_City) = 2026-10-21
 *   Próximos días: jue 22=2026-10-22, vie 23=2026-10-23, …
 */
export function renderAgendaCalendar(now: Date, tz: string, days = 14): string {
  const today = dayIsoInTz(now, tz);
  const next: string[] = [];
  for (let i = 1; i <= days; i++) {
    const iso = addDaysISO(today, i);
    const noon = zonedWallClockToUtc(iso, "12:00", tz);
    if (!noon) continue;
    next.push(`${weekdayShort(noon, tz)} ${Number(iso.slice(8, 10))}=${iso}`);
  }
  return [
    `Hoy: ${longToday(now, tz)} (${tz}) = ${today}`,
    `Próximos días: ${next.join(", ")}`,
  ].join("\n");
}
