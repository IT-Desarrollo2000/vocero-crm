"use client";

import { useEffect, useId, useState } from "react";
import { Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  MAX_RANGE_DAYS,
  RANGE_PRESETS,
  validateCustomRange,
  type RangeSelection,
} from "./range-params";
import { formatDayRange } from "./format";

/**
 * Selector de rango: 7/30/90 días o personalizado (≤ 366 días), siempre en la
 * zona horaria del negocio — la que el servidor usó, que se muestra al lado
 * para que nadie compare «hoy» de su navegador con «hoy» del reporte.
 */
export function RangePicker({
  value,
  onChange,
  timezone,
  resolved,
  disabled = false,
}: {
  value: RangeSelection;
  onChange: (next: RangeSelection) => void;
  /** Zona del negocio que devolvió el servidor (null mientras carga). */
  timezone: string | null;
  /** Días que el servidor resolvió para el rango actual. */
  resolved: { from: string; to: string } | null;
  disabled?: boolean;
}) {
  const fromId = useId();
  const toId = useId();
  const errorId = useId();
  const [customOpen, setCustomOpen] = useState(value.preset === "custom");
  const [from, setFrom] = useState(value.preset === "custom" ? value.from : "");
  const [to, setTo] = useState(value.preset === "custom" ? value.to : "");
  const [error, setError] = useState<string | null>(null);

  // Al abrir «Personalizado» sin fechas propias se precargan las del rango
  // en pantalla: lo usual es mover un extremo, no escribir los dos.
  useEffect(() => {
    if (!customOpen || !resolved) return;
    setFrom((f) => f || resolved.from);
    setTo((t) => t || resolved.to);
  }, [customOpen, resolved]);

  function applyCustom(e: React.FormEvent) {
    e.preventDefault();
    const check = validateCustomRange(from, to);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    setError(null);
    onChange({ preset: "custom", from, to });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="Rango del reporte"
          className="inline-flex rounded-md border bg-secondary p-0.5"
        >
          {RANGE_PRESETS.map((p) => {
            const active = value.preset === p.preset && !customOpen;
            return (
              <button
                key={p.preset}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                onClick={() => {
                  setCustomOpen(false);
                  setError(null);
                  onChange({ preset: p.preset });
                }}
                className={cn(
                  "rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {p.label}
              </button>
            );
          })}
          <button
            type="button"
            disabled={disabled}
            aria-pressed={customOpen || value.preset === "custom"}
            aria-expanded={customOpen}
            onClick={() => setCustomOpen((o) => !o)}
            className={cn(
              "rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              customOpen || value.preset === "custom"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Personalizado
          </button>
        </div>
        <p
          className="flex items-center gap-1 text-xs text-muted-foreground"
          aria-label={
            timezone ? `Zona horaria del reporte: ${timezone}` : "Zona horaria del reporte"
          }
        >
          <Globe className="h-3.5 w-3.5" aria-hidden="true" />
          {resolved && <span>{formatDayRange(resolved.from, resolved.to)} ·</span>}
          <span>{timezone ?? "…"}</span>
        </p>
      </div>

      {customOpen && (
        <form
          onSubmit={applyCustom}
          className="flex flex-wrap items-end gap-2"
          aria-label="Rango personalizado"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor={fromId} className="text-xs text-muted-foreground">
              Desde
            </label>
            <Input
              id={fromId}
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              className="h-8 w-[150px] text-xs"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={toId} className="text-xs text-muted-foreground">
              Hasta (incluido)
            </label>
            <Input
              id={toId}
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              className="h-8 w-[150px] text-xs"
            />
          </div>
          <Button type="submit" size="sm" disabled={disabled}>
            Aplicar
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            Máximo {MAX_RANGE_DAYS} días.
          </p>
          {error && (
            <p id={errorId} role="alert" className="w-full text-xs text-destructive">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
