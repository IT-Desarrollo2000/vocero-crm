import { redirect } from "next/navigation";
import { getSessionOrNull } from "@/lib/auth/session";
import { isOwner } from "@/lib/roles";

// Cada rol aterriza en su pestaña principal (RF-00-06): el Vendedor tiene
// "Mi cuenta" (029: y Respuestas rápidas); mandarlo a WhatsApp sería un 404.
export default async function SettingsPage() {
  const session = await getSessionOrNull();
  if (!session) redirect("/login");
  redirect(isOwner(session) ? "/settings/whatsapp" : "/settings/account");
}
