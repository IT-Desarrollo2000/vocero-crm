"use client";

import { useState } from "react";
import { UserCheck, UserMinus } from "lucide-react";
import type { ConversationDto } from "@/lib/types";
import { cn } from "@/lib/utils";
import { isMine } from "./helpers";

/** Miembro elegible como responsable (de `GET /api/settings/team`). */
export type TeamOption = { userId: string; name: string };

/**
 * 09 — Control "Responsable" de una conversación. Una sola pieza para la
 * cabecera del hilo y el panel de detalles (nunca los dos a la vez en el DOM:
 * los aria-label son los que usa el E2E).
 *
 *  - Propietario: selector con los miembros + "Sin asignar" (reasigna sin
 *    condiciones, D-09-6).
 *  - Vendedor: "Tomar" si nadie la tiene, "Devolver al buzón" (027; antes
 *    "Liberar") si es suya. No puede pasarla a otro: para eso está el
 *    Propietario.
 */
export function AssignmentControl({
  conversation,
  owner,
  viewerId,
  team,
  onAssign,
  className,
}: {
  conversation: ConversationDto;
  owner: boolean;
  viewerId: string;
  /** Solo Propietario; null mientras carga o si falló. */
  team: TeamOption[] | null;
  onAssign: (userId: string | null) => Promise<void>;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);

  async function run(userId: string | null) {
    setBusy(true);
    try {
      await onAssign(userId);
    } finally {
      setBusy(false);
    }
  }

  const current = conversation.assignedTo;

  if (owner) {
    const options: TeamOption[] = [...(team ?? [])];
    // Un responsable que ya no aparece en el equipo (baja reciente) se sigue
    // mostrando para que el selector no mienta sobre el estado actual.
    if (current && !options.some((m) => m.userId === current.userId)) {
      options.push({ userId: current.userId, name: current.name });
    }
    return (
      <select
        aria-label="Responsable"
        value={current?.userId ?? ""}
        disabled={busy}
        onChange={(e) => void run(e.target.value || null)}
        className={cn(
          "min-w-0 max-w-[160px] truncate rounded-md border bg-background px-2 py-1 text-[12.5px] font-medium text-text-2 transition-colors hover:bg-accent disabled:opacity-60",
          className
        )}
      >
        <option value="">Sin asignar</option>
        {options.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.userId === viewerId ? `${m.name} (tú)` : m.name}
          </option>
        ))}
      </select>
    );
  }

  if (!current) {
    return (
      <button
        type="button"
        aria-label="Tomar conversación"
        title="Tomar esta conversación: quedará a tu nombre"
        disabled={busy}
        onClick={() => void run(viewerId)}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-md bg-brand px-2.5 py-1 text-[12.5px] font-medium text-brand-fg transition-colors hover:bg-brand-hover disabled:opacity-60",
          className
        )}
      >
        <UserCheck className="h-3.5 w-3.5" strokeWidth={1.8} />
        {busy ? "Tomando…" : "Tomar"}
      </button>
    );
  }

  if (isMine(conversation, viewerId)) {
    return (
      // 027: "Liberar" pasó a "Devolver al buzón": dice a dónde va el chat.
      <button
        type="button"
        aria-label="Devolver al buzón"
        title="Devolver al Buzón para que otro vendedor la tome"
        disabled={busy}
        onClick={() => void run(null)}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-md border bg-background px-2.5 py-1 text-[12.5px] font-medium text-text-2 transition-colors hover:bg-accent disabled:opacity-60",
          className
        )}
      >
        <UserMinus className="h-3.5 w-3.5" strokeWidth={1.8} />
        {/* En móvil la cabecera del hilo no tiene ancho para el texto
            largo: queda el icono (el aria-label lo nombra). */}
        <span className="max-md:sr-only">{busy ? "Devolviendo…" : "Devolver al buzón"}</span>
      </button>
    );
  }

  // El Vendedor no debería ver una ajena (el servidor la oculta); si llega a
  // pintarse un instante antes del refetch, solo se informa.
  return (
    <span className={cn("text-[12.5px] text-text-3", className)}>
      {current.name}
    </span>
  );
}
