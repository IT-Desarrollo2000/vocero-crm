/**
 * 031 — Cuánto le queda al vendedor para escribir libre (barra del pie del
 * compositor). Puro: lo usa `composer.tsx` y lo cubre
 * `tests/unit/reply-window.test.ts`.
 *
 * Se recalcula desde `lastInboundAt` (como el «Cierra en…» de la lista,
 * `src/lib/closing-window.ts`) para que avance con el reloj; si no hay
 * entrante, se usa el `windowRemainingMs` que trajo el DTO.
 */

import type { Channel, ReplyMode } from "@/lib/channels";
import { CLOSING_SOON_MS } from "@/lib/closing-window";
import { capabilitiesFor } from "@/server/channels/capabilities";

export type ReplyWindowBar = {
  /** `free` = dentro de las 24 h; `human_agent` = 24 h–7 días (IG/Messenger). */
  kind: "free" | "human_agent";
  remainingMs: number;
  /** 0..1 de la ventana que queda (para la barra, decorativa). */
  fraction: number;
  /** Menos de 2 h (la misma franja que «Por cerrar»): tono de aviso. */
  low: boolean;
};

export function replyWindowBar(
  c: {
    channel: Channel;
    replyMode: ReplyMode;
    lastInboundAt: string | null;
    windowRemainingMs: number;
  },
  now: number = Date.now()
): ReplyWindowBar | null {
  if (c.replyMode !== "free" && c.replyMode !== "human_agent") return null;
  const caps = capabilitiesFor(c.channel);
  const totalMs = c.replyMode === "free" ? caps.windowMs : caps.humanAgentWindowMs;
  // Canal sin ventana: escribir libre no se acaba, no hay barra.
  if (totalMs === null) return null;
  const last = c.lastInboundAt ? Date.parse(c.lastInboundAt) : Number.NaN;
  const remainingMs = Number.isFinite(last)
    ? Math.max(0, last + totalMs - now)
    : Math.max(0, c.replyMode === "free" ? c.windowRemainingMs : 0);
  return {
    kind: c.replyMode,
    remainingMs,
    fraction: Math.min(1, Math.max(0, remainingMs / totalMs)),
    low: remainingMs < CLOSING_SOON_MS,
  };
}
