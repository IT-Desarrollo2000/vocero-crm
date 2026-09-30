import { notFound } from "next/navigation";
import { MessengerSettingsClient } from "@/components/settings/messenger-client";
import { isChannelEnabled } from "@/server/channels/enabled";

export const dynamic = "force-dynamic";

export default function MessengerSettingsPage() {
  // Sin el canal en CHANNELS esta pantalla no existe en esta instancia.
  if (!isChannelEnabled("messenger")) notFound();
  return <MessengerSettingsClient />;
}
