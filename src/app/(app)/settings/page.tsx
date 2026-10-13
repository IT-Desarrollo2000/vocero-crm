import { redirect } from "next/navigation";
import { getSessionOrNull } from "@/lib/auth/session";
import { isOwner } from "@/lib/roles";

// Cada rol aterriza en su primera pestaña (RF-00-06): el Vendedor solo tiene
// "Mi cuenta"; mandarlo a WhatsApp sería mandarlo a un 404.
export default async function SettingsPage() {
  const session = await getSessionOrNull();
  if (!session) redirect("/login");
  redirect(isOwner(session) ? "/settings/whatsapp" : "/settings/account");
}
