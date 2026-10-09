import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { getSessionOrNull } from "@/lib/auth/session";
import { normalizeThemePreference, THEME_COOKIE } from "@/lib/theme";
import { NAV_COLLAPSED_COOKIE, normalizeNavCollapsed } from "@/lib/nav";
import { getBranding } from "@/server/branding";
import { AppShell } from "@/components/app-shell";
import { resolveBuildCommit } from "@/lib/version";
import { agendaEnabled } from "@/server/agenda/flag";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getSessionOrNull();
  if (!session) redirect("/login");
  const branding = await getBranding(session.organizationId);
  const authSession = await getAuth().api.getSession({
    headers: await headers(),
  });
  const jar = await cookies();
  const theme = normalizeThemePreference(jar.get(THEME_COOKIE)?.value);
  // Se lee aquí y no en el cliente: así el lateral pinta ya con su ancho.
  const navCollapsed = normalizeNavCollapsed(
    jar.get(NAV_COLLAPSED_COOKIE)?.value
  );

  return (
    <AppShell
      branding={branding}
      userName={authSession?.user.name ?? "Usuario"}
      role={session.role}
      theme={theme}
      navCollapsed={navCollapsed}
      // Se resuelve aquí, en el servidor: el cliente no ve `SOURCE_COMMIT`.
      commit={resolveBuildCommit()}
      // Qué módulos opcionales existen se decide en el servidor y baja por
      // prop, igual que los canales de la Bandeja. El nav es un componente de
      // cliente: no puede —ni debe— leer variables de entorno.
      agenda={agendaEnabled()}
    >
      {children}
    </AppShell>
  );
}
