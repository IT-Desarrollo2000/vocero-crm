import { Suspense } from "react";
import { BarChart3 } from "lucide-react";
import { PrintButton } from "@/components/reports/print-button";
import { ReportPrintHeader, ReportPrintProvider } from "@/components/reports/report-print";
import { ReportsTabs } from "@/components/reports/reports-tabs";
import { agendaEnabled } from "@/server/agenda/flag";

// 02 — Reportes es solo del Propietario: el layout de `(owner)` ya responde
// 404 al Vendedor. Este marco (encabezado + pestañas) lo reutilizan los
// reportes de citas (10, con `AGENDA`), ventas (punto 1) y anuncios (020).
export const dynamic = "force-dynamic";

// 021 — En impresión (Descargar PDF) este contenedor deja de tener scroll
// propio: un ancestro con scroll imprime solo lo visible y el PDF sale de una
// hoja. La misma regla corre en AppShell. Botones y pestañas no van al papel.
export default function ReportsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex h-full flex-col overflow-y-auto print:block print:h-auto print:overflow-visible">
      <ReportPrintProvider>
        <header className="border-b px-4 pt-3 sm:px-6 sm:pt-4 print:hidden">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 font-semibold">
                <BarChart3 className="h-4 w-4 text-primary" aria-hidden="true" /> Reportes
              </h2>
              <p className="text-xs text-muted-foreground">
                Solo Propietario · no incluye el Laboratorio
              </p>
            </div>
            <Suspense>
              <PrintButton />
            </Suspense>
          </div>
          {/* Las pestañas leen la URL (`useSearchParams`) para conservar el rango. */}
          <Suspense>
            <ReportsTabs bookings={agendaEnabled()} />
          </Suspense>
        </header>
        <ReportPrintHeader />
        <div className="min-w-0 print:[&_button]:hidden">{children}</div>
      </ReportPrintProvider>
    </div>
  );
}
