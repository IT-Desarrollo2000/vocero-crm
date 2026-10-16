import { Suspense } from "react";
import { AdsReportClient } from "@/components/reports/ads-report-client";

export const dynamic = "force-dynamic";

/** 020 fase B — Reportes → Anuncios (el layout de `(owner)` ya da 404 al Vendedor). */
export default function AdsReportPage() {
  // `useSearchParams` del cliente pide un límite de Suspense.
  return (
    <Suspense>
      <AdsReportClient />
    </Suspense>
  );
}
