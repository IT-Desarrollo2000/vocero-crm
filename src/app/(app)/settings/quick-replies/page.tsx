import { QuickRepliesClient } from "@/components/settings/quick-replies-client";

export const dynamic = "force-dynamic";

/**
 * 09 — Catálogo de respuestas rápidas. 029: fuera del grupo `(owner)` (misma
 * URL): el Vendedor también la ve, con el autor de cada una y acciones solo
 * en las suyas; la autorización real vive en la API.
 */
export default function QuickRepliesSettingsPage() {
  return <QuickRepliesClient />;
}
