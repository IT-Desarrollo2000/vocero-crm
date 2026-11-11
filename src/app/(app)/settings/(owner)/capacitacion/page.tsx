import { existsSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { TrainingClient, type TrainingTopicOption } from "@/components/settings/training-client";
import { getSessionOrNull } from "@/lib/auth/session";
import { fillBrand, visibleTopics } from "@/lib/help/topics";
import { getBranding } from "@/server/branding";
import { agendaEnabled } from "@/server/agenda/flag";
import { enabledChannels } from "@/server/channels/enabled";

export const metadata: Metadata = { title: "Material de capacitación" };

// Las banderas (qué temas existen) se leen en cada petición, igual que /ayuda.
export const dynamic = "force-dynamic";

/**
 * 034 — Ajustes › Material de capacitación. Solo Propietario: la guarda
 * (`requireOwnerPage`) vive en `settings/(owner)/layout.tsx`. Los temas son
 * los VISIBLES en esta instancia (sin agenda no se ofrece el de citas), con
 * el nombre del negocio y la captura de ejemplo de cada uno.
 */
export default async function TrainingSettingsPage() {
  const session = await getSessionOrNull();
  const branding = await getBranding(session?.organizationId);
  const dir = path.join(process.cwd(), "public", "ayuda");
  const topics: TrainingTopicOption[] = visibleTopics({
    agenda: agendaEnabled(),
    channels: enabledChannels(),
  }).map((t) => ({
    id: t.id,
    title: fillBrand(t.titulo, branding.name),
    example: (t.captura ?? []).find((f) => existsSync(path.join(dir, f))) ?? null,
  }));
  return <TrainingClient topics={topics} />;
}
