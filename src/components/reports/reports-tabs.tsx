import Link from "next/link";

/**
 * Pestañas de Reportes. Hoy solo existe «Agente» (02); «Ventas» (punto 1) y
 * «Anuncios» (07, solo con `ATRIBUCION` encendida) se anuncian deshabilitadas
 * para que el marco no cambie de forma cuando lleguen.
 */
export function ReportsTabs({ ads }: { ads: boolean }) {
  return (
    <nav aria-label="Tipos de reporte" className="-mb-px mt-3 flex gap-1 overflow-x-auto">
      <Link
        href="/reports/agent"
        aria-current="page"
        className="border-b-2 border-primary px-3 pb-2 text-sm font-medium text-foreground"
      >
        Agente
      </Link>
      <DisabledTab label="Ventas" />
      {ads && <DisabledTab label="Anuncios" />}
    </nav>
  );
}

function DisabledTab({ label }: { label: string }) {
  return (
    <span
      aria-disabled="true"
      title="Próximamente"
      className="flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 pb-2 text-sm text-text-4"
    >
      {label}
      <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-text-3">
        Próximamente
      </span>
    </span>
  );
}
