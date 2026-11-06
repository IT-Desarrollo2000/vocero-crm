"use client";

import { Check, Lock, X } from "lucide-react";
import { TypeDot } from "./booking-block";

/**
 * 028 — Leyenda visible del calendario (US-4), con el color de cada tipo de
 * cita. Cada muestra lleva texto e ícono: nada se dice solo con color.
 *
 * 032 — Corta: Agendada · Ya pasó (Realizada / No asistió / falta resultado)
 * · Sin vendedor · Bloqueo. El choque y el traslape ya no van aquí: los dice
 * el propio bloque en palabras.
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
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-foreground">Ya pasó:</span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className={`${swatch} border-success-soft bg-success-tint`} />
          <Check className="h-3 w-3 text-success-text" strokeWidth={2.4} aria-hidden />
          Realizada
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className={`${swatch} border-danger-soft bg-danger-tint`} />
          <X className="h-3 w-3 text-danger-text" strokeWidth={2.4} aria-hidden />
          No asistió
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className={`${swatch} border-warning bg-warning-tint`} />
          falta resultado
        </span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={`${swatch} border-dashed border-warning bg-card`} />
        Sin vendedor
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={`${swatch} booking-hatch border-border-strong`} />
        <Lock className="h-3 w-3" strokeWidth={2} aria-hidden />
        Bloqueo
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
