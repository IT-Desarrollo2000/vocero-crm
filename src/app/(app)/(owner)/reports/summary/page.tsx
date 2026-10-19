import { Suspense } from "react";
import { SummaryReportClient } from "@/components/reports/summary-report-client";

export const dynamic = "force-dynamic";

/** 021 — Reportes → Resumen para dirección (el layout de `(owner)` ya da 404 al Vendedor). */
export default function SummaryReportPage() {
  // `useSearchParams` del cliente pide un límite de Suspense.
  return (
    <Suspense>
      <SummaryReportClient />
    </Suspense>
  );
}
