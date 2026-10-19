import { useId } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { EMPTY_VALUE } from "./format";

/**
 * Cifra principal de una métrica. La definición (la fórmula de dev-tasks/02)
 * va como ayuda: visible al pasar el cursor y leída por el lector de
 * pantalla como descripción de la tarjeta.
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
  help: string;
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
      className="min-w-0 rounded-lg border bg-card p-4 shadow-sm print:break-inside-avoid print:p-3 print:shadow-none"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <span title={help} className="shrink-0 text-text-4 print:hidden">
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </div>
      <p
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums",
          (loading || unavailable || shown === EMPTY_VALUE) && "text-text-3"
        )}
      >
        {shown}
      </p>
      {unavailable ? (
        <p className="mt-0.5 text-xs text-warning-text">No disponible</p>
      ) : (
        detail && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
      )}
      <span id={helpId} className="sr-only">
        {help}
      </span>
    </div>
  );
}
