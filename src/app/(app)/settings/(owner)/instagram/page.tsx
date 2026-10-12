import { notFound } from "next/navigation";
import { InstagramSettingsClient } from "@/components/settings/instagram-client";
import { isChannelEnabled } from "@/server/channels/enabled";

export const dynamic = "force-dynamic";

export default function InstagramSettingsPage() {
  // Sin el canal en CHANNELS esta pantalla no existe en esta instancia.
  if (!isChannelEnabled("instagram")) notFound();
  return <InstagramSettingsClient />;
}
