import { CHANNEL_ORDER, type Channel } from "@/lib/channels";
import { capabilitiesFor } from "@/server/channels/capabilities";

/**
 * 05 — «Ventana por cerrar» (RF-05-13): conversaciones cuya ventana de
 * servicio (24 h desde el último ENTRANTE, por canal) cierra en menos de 2 h.
 *
 * Una sola regla para el servidor (`filter=closing` y `counts.closing`, en
 * `src/server/inbox/queries.ts`) y su espejo en el cliente (pastilla, chip
 * «Cierra en …» y `matchesFilters`). Los cortes se calculan en Node y viajan
 * como parámetros: nunca `now()` de SQL, porque las columnas son `timestamp`
 * sin zona (mismo criterio que `src/server/inbox/window.ts`).
 *
 * Bordes (idénticos en ambos lados):
 *   dentro  ⇔  now − windowMs < last_inbound_at ≤ now − (windowMs − 2 h)
 * — 22 h exactas entra; 24 h exactas ya cerró (sale); sin entrantes, fuera.
 * Los canales sin ventana (`windowMs === null`) nunca entran.
 */

export const CLOSING_SOON_MS = 2 * 60 * 60 * 1000;

/** Límites de la franja «por cerrar» para una ventana de `windowMs`. */
export function closingBounds(
  windowMs: number,
  now: number
): { after: Date; atOrBefore: Date } {
  return {
    after: new Date(now - windowMs),
    atOrBefore: new Date(now - (windowMs - CLOSING_SOON_MS)),
  };
}

/** Ventana del canal si admite la franja (null = sin ventana o demasiado corta). */
export function closingWindowMs(channel: Channel): number | null {
  const w = capabilitiesFor(channel).windowMs;
  return w !== null && w > CLOSING_SOON_MS ? w : null;
}

/** Canales agrupados por duración de ventana (para armar el SQL). */
export function closingWindowGroups(): { windowMs: number; channels: Channel[] }[] {
  const groups = new Map<number, Channel[]>();
  for (const ch of CHANNEL_ORDER) {
    const w = closingWindowMs(ch);
    if (w === null) continue;
    groups.set(w, [...(groups.get(w) ?? []), ch]);
  }
  return [...groups].map(([windowMs, channels]) => ({ windowMs, channels }));
}

function toMs(value: string | Date | null | undefined): number | null {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** ¿La ventana de esta conversación cierra en menos de 2 h? */
export function isClosingSoon(
  channel: Channel,
  lastInboundAt: string | Date | null | undefined,
  now: number = Date.now()
): boolean {
  const w = closingWindowMs(channel);
  const t = toMs(lastInboundAt);
  if (w === null || t === null) return false;
  const { after, atOrBefore } = closingBounds(w, now);
  return t > after.getTime() && t <= atOrBefore.getTime();
}

/**
 * Ms que le quedan a la ventana, recalculados desde `lastInboundAt` (no del
 * `windowRemainingMs` serializado, que envejece). `null` si no está por cerrar.
 */
export function closingRemainingMs(
  channel: Channel,
  lastInboundAt: string | Date | null | undefined,
  now: number = Date.now()
): number | null {
  if (!isClosingSoon(channel, lastInboundAt, now)) return null;
  const w = closingWindowMs(channel)!;
  return Math.max(0, toMs(lastInboundAt)! + w - now);
}
