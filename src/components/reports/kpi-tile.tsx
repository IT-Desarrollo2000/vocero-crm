import { useId } from "react";
import { cn } from "@/lib/utils";
import { EMPTY_VALUE } from "./format";

/**
 * Cifra principal de una métrica. 032 — La definición va VISIBLE bajo el
 * número, en palabras simples (nada de ⓘ ni de texto al pasar el cursor), y
 * el lector de pantalla la lee como descripción de la tarjeta. También sale
 * en el PDF.
 */
export function KpiTile({
  label,
  value,
  help,
  detail,
  loading = false,
  unavailable = false,
  testId,
}: {
  label: string;
  /** Ya formateado («25 %», «4 s», «—»). */
  value: string;
  /** Qué cuenta el número, en una frase corta. */
  help: string;
  /** Comparación o desglose («3 nuevas · +25 % vs. …»). */
  detail?: string;
  loading?: boolean;
  unavailable?: boolean;
  testId?: string;
}) {
  const helpId = useId();
  const shown = loading ? "…" : unavailable ? EMPTY_VALUE : value;
  return (
    <div
      role="group"
      aria-label={`${label}: ${unavailable ? "no disponible" : shown}`}
      aria-describedby={helpId}
      aria-busy={loading || undefined}
      data-testid={testId}
      className="flex min-w-0 flex-col rounded-lg border bg-card p-4 shadow-sm print:break-inside-avoid print:p-3 print:shadow-none"
    >
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 break-words text-2xl font-semibold tabular-nums",
          (loading || unavailable || shown === EMPTY_VALUE) && "text-text-3"
        )}
      >
        {shown}
      </p>
      {unavailable ? (
        <p className="mt-0.5 text-xs text-warning-text">No disponible</p>
      ) : (
        detail && <p className="mt-0.5 text-xs text-text-2">{detail}</p>
      )}
      <p id={helpId} className="mt-1.5 text-xs leading-snug text-muted-foreground print:text-[10px]">
        {help}
      </p>
    </div>
  );
}
