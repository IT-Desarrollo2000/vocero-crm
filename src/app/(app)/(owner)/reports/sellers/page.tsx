import { Suspense } from "react";
import { SellersReportClient } from "@/components/reports/sellers-report-client";

export const dynamic = "force-dynamic";

/** 024 — Reportes → Vendedores (el layout de `(owner)` ya da 404 al Vendedor). */
export default function SellersReportPage() {
  // `useSearchParams` del cliente pide un límite de Suspense.
  return (
    <Suspense>
      <SellersReportClient />
    </Suspense>
  );
}
