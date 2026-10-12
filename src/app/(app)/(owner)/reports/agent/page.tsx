import { Suspense } from "react";
import { AgentReportClient } from "@/components/reports/agent-report-client";

export const dynamic = "force-dynamic";

export default function AgentReportPage() {
  // `useSearchParams` del cliente pide un límite de Suspense.
  return (
    <Suspense>
      <AgentReportClient />
    </Suspense>
  );
}
