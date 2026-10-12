import { Suspense } from "react";
import { notFound } from "next/navigation";
import { BookingsReportClient } from "@/components/reports/bookings-report-client";
import { agendaEnabled } from "@/server/agenda/flag";

export const dynamic = "force-dynamic";

export default function BookingsReportPage() {
  // 10 — Sin la bandera de agenda esta pestaña no existe en esta instancia.
  if (!agendaEnabled()) notFound();
  // `useSearchParams` del cliente pide un límite de Suspense.
  return (
    <Suspense>
      <BookingsReportClient />
    </Suspense>
  );
}
