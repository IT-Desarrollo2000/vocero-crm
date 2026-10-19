import { Suspense } from "react";
import { SalesReportClient } from "@/components/reports/sales-report-client";

export const dynamic = "force-dynamic";

/** 021 — Reportes → Ventas (el layout de `(owner)` ya da 404 al Vendedor). */
export default function SalesReportPage() {
  // `useSearchParams` del cliente pide un límite de Suspense.
  return (
    <Suspense>
      <SalesReportClient />
    </Suspense>
  );
}
