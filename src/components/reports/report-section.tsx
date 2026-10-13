import { useId } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReportBlock } from "./types";

/**
 * Tarjeta de un bloque del reporte con sus tres estados propios: cargando,
 * «No disponible» (el bloque falló en el servidor) y con datos. Un bloque que
 * falla no tumba la página: los demás se pintan igual.
 */
export function ReportSection<T>({
  title,
  description,
  block,
  loading,
  className,
  children,
}: {
  title: string;
  description?: string;
  /** `undefined` = el servidor no mandó el bloque (se trata como no disponible). */
  block: ReportBlock<T> | undefined;
  loading: boolean;
  className?: string;
  children: (data: T) => React.ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      aria-busy={loading || undefined}
      className={cn("min-w-0 rounded-lg border bg-card p-4 shadow-sm sm:p-5", className)}
    >
      <header className="mb-3">
        <h3 id={headingId} className="text-sm font-semibold">
          {title}
        </h3>
        {description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        )}
      </header>
      {loading ? (
        <div className="space-y-2" aria-label={`Cargando ${title}`}>
          <div className="h-4 w-2/3 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-secondary" />
          <div className="h-16 animate-pulse rounded bg-secondary" />
        </div>
      ) : block?.ok ? (
        children(block.data)
      ) : (
        <BlockUnavailable />
      )}
    </section>
  );
}

export function BlockUnavailable() {
  return (
    <p
      role="status"
      className="flex items-center gap-2 rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-sm text-warning-text"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
      No disponible por ahora. El resto del reporte sí se calculó.
    </p>
  );
}
