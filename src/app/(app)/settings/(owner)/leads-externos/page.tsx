import { notFound } from "next/navigation";
import { IntakeClient } from "@/components/settings/intake-client";
import { intakeEnabled } from "@/server/intake/flag";

export const dynamic = "force-dynamic";

export default function LeadsExternosSettingsPage() {
  // Sin la bandera esta pantalla no existe en esta instancia.
  if (!intakeEnabled()) notFound();
  return <IntakeClient />;
}
