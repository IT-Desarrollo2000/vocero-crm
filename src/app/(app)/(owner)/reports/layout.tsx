import { Suspense } from "react";
import { BarChart3 } from "lucide-react";
import { ReportsTabs } from "@/components/reports/reports-tabs";
import { agendaEnabled } from "@/server/agenda/flag";

// 02 — Reportes es solo del Propietario: el layout de `(owner)` ya responde
// 404 al Vendedor. Este marco (encabezado + pestañas) lo reutilizan los
// reportes de citas (10, con `AGENDA`), ventas (punto 1) y anuncios (020).
export const dynamic = "force-dynamic";

export default function ReportsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b px-4 pt-3 sm:px-6 sm:pt-4">
        <h2 className="flex items-center gap-2 font-semibold">
          <BarChart3 className="h-4 w-4 text-primary" aria-hidden="true" /> Reportes
        </h2>
        <p className="text-xs text-muted-foreground">
          Solo Propietario · no incluye el Laboratorio
        </p>
        {/* Las pestañas leen la URL (`useSearchParams`) para conservar el rango. */}
        <Suspense>
          <ReportsTabs bookings={agendaEnabled()} />
        </Suspense>
      </header>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
