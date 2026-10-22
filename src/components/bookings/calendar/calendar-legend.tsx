"use client";

import { AlertTriangle, Check, Lock, X } from "lucide-react";
import { TypeDot } from "./booking-block";

/**
 * 028 — Leyenda visible del calendario (US-4): estados, traslape permitido y
 * conflicto, bloqueo y fuera de horario, más el color de cada tipo de cita.
 * Cada muestra lleva texto e ícono: nada se dice solo con color.
 */
export function CalendarLegend({
  types,
}: {
  types: { id: string; name: string }[];
}) {
  const swatch = "inline-block h-3 w-4 shrink-0 rounded-sm border";
  return (
    <div
      data-testid="cal-legend"
      aria-label="Leyenda del calendario"
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-text-2"
    >
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={`${swatch} border-transparent bg-brand`} />
        Agendada
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={`${swatch} border-success-soft bg-success-tint`} />
        <Check className="h-3 w-3 text-success-text" strokeWidth={2.4} aria-hidden />
        Realizada
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={`${swatch} border-danger-soft bg-danger-tint`} />
        <X className="h-3 w-3 text-danger-text" strokeWidth={2.4} aria-hidden />
        No asistió
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={`${swatch} booking-hatch border-border-strong`} />
        <Lock className="h-3 w-3" strokeWidth={2} aria-hidden />
        Bloqueo
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={`${swatch} cal-off`} />
        Fuera de horario
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={`${swatch} border-l-4 border-l-warning bg-brand`} />
        <span aria-hidden>⧉</span>
        Traslape permitido (otro vendedor)
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={`${swatch} border-2 border-danger bg-brand`} />
        <AlertTriangle className="h-3 w-3 text-danger-text" strokeWidth={2.2} aria-hidden />
        Conflicto (mismo vendedor, tipo exclusivo o bloqueo)
      </span>
      {types.map((t) => (
        <span key={t.id} className="inline-flex items-center gap-1.5">
          <TypeDot typeId={t.id} className="text-border-strong" />
          {t.name}
        </span>
      ))}
    </div>
  );
}
