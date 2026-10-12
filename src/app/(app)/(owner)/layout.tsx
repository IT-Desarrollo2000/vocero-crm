import { requireOwnerPage } from "@/lib/auth/guards";

// Agente y Laboratorio son solo del Propietario (dev-tasks/00, RF-00-04): el
// Vendedor recibe el 404 de la app desde el servidor, sin flash de contenido.
// El route group no cambia las URLs (/agent, /lab).
export const dynamic = "force-dynamic";

export default async function OwnerLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await requireOwnerPage();
  return <>{children}</>;
}
