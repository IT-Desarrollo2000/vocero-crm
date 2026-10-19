import { redirect } from "next/navigation";
import { SettingsNav } from "@/components/settings/settings-nav";
import { getSessionOrNull } from "@/lib/auth/session";
import { agendaEnabled } from "@/server/agenda/flag";
import { atribucionEnabled } from "@/server/attribution/flag";
import { intakeEnabled } from "@/server/intake/flag";
import { azureCatalogStorageEnabled } from "@/server/catalog/storage";
import { isChannelEnabled } from "@/server/channels/enabled";

// La bandera se lee en cada petición: si esto se resolviera al construir, la
// imagen quedaría con la agenda apagada para siempre y encenderla en la
// plataforma no haría nada.
export const dynamic = "force-dynamic";

export default async function SettingsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Compartido por las pestañas del Propietario y por "Mi cuenta": el rol solo
  // decide qué pestañas se pintan. La guarda real está en `(owner)/layout.tsx`.
  const session = await getSessionOrNull();
  if (!session) redirect("/login");
  return (
    <div className="flex h-full flex-col">
      <header className="border-b px-4 py-3 sm:px-6 sm:py-4">
        <h2 className="font-semibold">Configuración</h2>
      </header>
      {/* En móvil las pestañas van arriba (en fila), no como columna lateral. */}
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <SettingsNav
          role={session.role}
          agenda={agendaEnabled()}
          atribucion={atribucionEnabled()}
          instagram={isChannelEnabled("instagram")}
          messenger={isChannelEnabled("messenger")}
          almacenamiento={azureCatalogStorageEnabled()}
          leadsExternos={intakeEnabled()}
        />
        <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">{children}</div>
      </div>
    </div>
  );
}
