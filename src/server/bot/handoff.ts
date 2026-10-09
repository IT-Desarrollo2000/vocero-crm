import { toHandoffNote } from "@/server/ai/handoff";

/**
 * Motivos por los que un cerebro externo devuelve la conversación a un humano.
 *
 * El catálogo es cerrado, pero se aplica con FALLBACK, nunca rechazando: un
 * motivo fuera de lista no puede costar el handoff. Un 422 aquí dejaría al bot
 * hablándole a alguien que acaba de pedir una persona — el peor final posible
 * de esa ruta. Del otro lado hay un LLM: tarde o temprano manda "porque se
 * enojó" en vez de "hostilidad".
 */

export const HANDOFF_REASONS = [
  "cliente",
  "modelo",
  "error",
  "ventana",
  "hostilidad",
] as const;

export type HandoffReason = (typeof HANDOFF_REASONS)[number];

export function toHandoffReason(raw: string | undefined | null): HandoffReason {
  const v = raw?.trim().toLowerCase() ?? "";
  return (HANDOFF_REASONS as readonly string[]).includes(v)
    ? (v as HandoffReason)
    : "modelo";
}

/**
 * Nota libre del handoff del cerebro externo. Si manda `note`, esa manda. Si
 * no, y su `reason` cayó fuera del catálogo (el fallback lo volvió "modelo"),
 * ese texto crudo ES la explicación — "porque se enojó" — y se conserva como
 * nota en vez de perderse.
 */
export function handoffNoteFrom(
  reason: string | undefined | null,
  note: string | undefined | null
): string | null {
  const explicit = toHandoffNote(note);
  if (explicit) return explicit;
  const v = reason?.trim().toLowerCase() ?? "";
  if (!v || (HANDOFF_REASONS as readonly string[]).includes(v)) return null;
  return toHandoffNote(reason);
}
