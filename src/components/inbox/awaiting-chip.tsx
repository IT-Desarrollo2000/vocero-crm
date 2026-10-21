"use client";

import { Check, Clock } from "lucide-react";
import { formatWait, type AwaitingState } from "@/lib/awaiting";
import type { ConversationDto } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Día y hora locales en que empezó la espera ("21 oct, 14:05"). */
function startedAtLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("es-MX", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 026 — Distintivo de la fila para un chat en manos de una persona:
 *  - «Esperando · 25 min» (ámbar; rojo si pasó el umbral), con la hora en que
 *    empezó la espera en el `title`;
 *  - «Atendida» (neutra, con palomita); el `title` aclara si la IA está en
 *    pausa o el caso sigue escalado.
 * Con la IA al mando (`none`) no pinta nada.
 */
export function AwaitingChip({
  conversation: c,
  state,
  className,
}: {
  conversation: Pick<ConversationDto, "handoffAt" | "aiEnabled">;
  state: AwaitingState;
  className?: string;
}) {
  if (state.kind === "none") return null;
  if (state.kind === "attended") {
    return (
      <span
        data-testid="awaiting-chip"
        data-state="attended"
        title={
          c.handoffAt
            ? "Atendida · sigue escalada a una persona"
            : "Atendida · IA en pausa"
        }
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full border bg-secondary px-2 py-0.5 text-[11px] text-text-3",
          className
        )}
      >
        <Check className="h-3 w-3" strokeWidth={1.9} />
        Atendida
      </span>
    );
  }
  const started = startedAtLabel(state.since);
  return (
    <span
      data-testid="awaiting-chip"
      data-state={state.overdue ? "overdue" : "waiting"}
      title={
        (state.overdue ? "Atrasada · " : "") +
        (started ? `El cliente espera respuesta desde ${started}` : "El cliente espera respuesta")
      }
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
        state.overdue
          ? "border-danger-soft bg-danger-tint font-medium text-danger-text"
          : "border-warning-soft bg-warning-tint text-warning-text",
        className
      )}
    >
      <Clock className="h-3 w-3" strokeWidth={1.7} />
      Esperando · {formatWait(state.ms)}
    </span>
  );
}
