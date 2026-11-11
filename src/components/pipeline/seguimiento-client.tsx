"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { PendientesView } from "@/components/follow-ups/pendientes-view";
import { useOverdueCount } from "@/components/follow-ups/use-overdue-count";
import { PipelineClient } from "./pipeline-client";

export type SeguimientoView = "tablero" | "pendientes";

/**
 * 035 — Seguimiento con dos vistas: «Tablero» (el kanban, sin cambios) y
 * «Pendientes». La vista va en la URL (`/pipeline?vista=pendientes`) para que
 * se pueda enlazar (el menú y los avisos de la fase B).
 */
export function SeguimientoClient({ view: initial }: { view: SeguimientoView }) {
  const router = useRouter();
  const [view, setView] = useState<SeguimientoView>(initial);
  // Un enlace a la otra vista (p. ej. «Ver en Pendientes») cambia la prop.
  useEffect(() => setView(initial), [initial]);
  const overdue = useOverdueCount();

  function pick(v: SeguimientoView) {
    if (v === view) return;
    setView(v);
    router.replace(v === "pendientes" ? "/pipeline?vista=pendientes" : "/pipeline", { scroll: false });
  }

  const tabs = (
    <div
      role="tablist"
      aria-label="Vista"
      className="inline-flex gap-[3px] rounded-lg border bg-secondary p-[3px]"
    >
      {(["tablero", "pendientes"] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={view === v}
          onClick={() => pick(v)}
          data-testid={`view-${v}`}
          className={cn(
            "min-h-[38px] rounded-md px-3.5 py-2 text-[13.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            view === v ? "bg-background font-semibold text-foreground shadow-sm" : "text-text-2 hover:text-foreground"
          )}
        >
          {v === "tablero" ? "Tablero" : "Pendientes"}
          {v === "pendientes" && overdue > 0 && (
            <span className="text-danger-text"> · {overdue} {overdue === 1 ? "vencido" : "vencidos"}</span>
          )}
        </button>
      ))}
    </div>
  );

  return view === "pendientes" ? <PendientesView viewSwitch={tabs} /> : <PipelineClient viewSwitch={tabs} />;
}
