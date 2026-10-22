import { InboxClient } from "@/components/inbox/inbox-client";
import { CHANNEL_ORDER } from "@/lib/channels";
import { getSessionOrNull } from "@/lib/auth/session";
import { isOwner } from "@/lib/roles";
import { normalizeOverdueMinutes, OVERDUE_DEFAULT_MINUTES } from "@/lib/awaiting";
import { enabledChannels } from "@/server/channels/enabled";
import { agendaEnabled } from "@/server/agenda/flag";
import { getInboxSettings } from "@/server/inbox/archive";
import { teamModeFor } from "@/server/inbox/queries";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  /**
   * 014 — Qué bandejas existen se decide en el servidor, no mirando los datos.
   * Si se dedujera de las conversaciones cargadas, la marca de canal aparecería
   * y desaparecería sola: una instancia con Instagram encendido pero sin DMs
   * todavía se vería como una instancia de un solo canal, y el primer mensaje
   * repintaría la lista entera.
   */
  const enabled = enabledChannels();
  const channels = CHANNEL_ORDER.filter((c) => enabled.has(c));

  // 026 — Umbral de "atrasada" de la organización, leído aquí: el endpoint de
  // ajustes es solo del Propietario y el Vendedor también ve el rojo. Sin
  // sesión (el layout ya redirige) o si la lectura falla → 60: un hipo de la
  // BD no tumba la Bandeja.
  // 027 — Igual el modo equipo: el selector de alcance se pinta desde el
  // primer HTML, sin esperar a `/counts` (ni parpadear).
  const session = await getSessionOrNull().catch(() => null);
  const [overdueMinutes, initialTeamMode] = await Promise.all([
    readOverdueMinutes(session?.organizationId),
    readTeamMode(session),
  ]);

  // 023 — Igual que los canales: el botón "Agendar" existe solo si la agenda
  // está encendida en esta instancia.
  return (
    <InboxClient
      channels={channels}
      agenda={agendaEnabled()}
      overdueMinutes={overdueMinutes}
      initialTeamMode={initialTeamMode}
    />
  );
}

async function readOverdueMinutes(organizationId: string | undefined): Promise<number> {
  try {
    if (!organizationId) return OVERDUE_DEFAULT_MINUTES;
    const settings = await getInboxSettings(organizationId);
    return normalizeOverdueMinutes(settings.overdueMinutes);
  } catch (err) {
    console.error("[inbox] no se pudo leer el umbral de atrasadas:", err);
    return OVERDUE_DEFAULT_MINUTES;
  }
}

/**
 * 027 — Si la BD falla, la regla sin consultas (`!owner`): el Vendedor
 * siempre trabaja en equipo; para el Propietario lo corrige `/counts`.
 */
async function readTeamMode(
  session: Awaited<ReturnType<typeof getSessionOrNull>>
): Promise<boolean> {
  if (!session) return false;
  try {
    return await teamModeFor(session.organizationId, session);
  } catch (err) {
    console.error("[inbox] no se pudo calcular el modo equipo:", err);
    return !isOwner(session);
  }
}
