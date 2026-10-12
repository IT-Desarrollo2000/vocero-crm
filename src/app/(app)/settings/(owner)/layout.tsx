import { requireOwnerPage } from "@/lib/auth/guards";

// Todas las pestañas de Ajustes del negocio son solo del Propietario
// (dev-tasks/00, RF-00-04). "Mi cuenta" vive fuera de este grupo. Sin markup
// propio: la cabecera y las pestañas las pone `settings/layout.tsx`.
export const dynamic = "force-dynamic";

export default async function SettingsOwnerLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await requireOwnerPage();
  return <>{children}</>;
}
