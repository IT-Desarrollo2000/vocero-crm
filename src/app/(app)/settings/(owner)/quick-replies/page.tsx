import { QuickRepliesClient } from "@/components/settings/quick-replies-client";

export const dynamic = "force-dynamic";

/** 09 — Catálogo de respuestas rápidas (solo Propietario: grupo `(owner)`). */
export default function QuickRepliesSettingsPage() {
  return <QuickRepliesClient />;
}
