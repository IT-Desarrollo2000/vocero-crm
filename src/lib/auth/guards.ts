import { notFound, redirect } from "next/navigation";
import { getSessionOrNull, type SessionContext } from "@/lib/auth/session";
import { isOwner } from "@/lib/roles";

/**
 * Guarda de páginas server (layouts/pages) solo del Propietario:
 * sin sesión → redirect a /login (igual que `(app)/layout.tsx`);
 * Vendedor → notFound() (404 de la app, mismo patrón que las banderas).
 * Devuelve la sesión ya validada.
 */
export async function requireOwnerPage(): Promise<SessionContext> {
  const session = await getSessionOrNull();
  if (!session) redirect("/login");
  if (!isOwner(session)) notFound();
  return session;
}
