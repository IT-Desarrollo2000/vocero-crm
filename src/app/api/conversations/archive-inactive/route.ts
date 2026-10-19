import { parseBody, withAuth } from "@/lib/api";
import { archiveInactiveSchema } from "@/lib/inbox-settings";
import { archiveInactive } from "@/server/inbox/archive";

export const dynamic = "force-dynamic";

/**
 * 022 — Limpieza masiva de la Bandeja (solo Propietario): archiva las
 * conversaciones sin actividad desde hace más de `days` días, con las
 * excepciones de `inactiveArchivableCondition` (cita futura, etapa "No
 * archivar", traspaso reciente). Motivo `bulk`, autor = el Propietario.
 *
 * POST `{ days: 1–365, dryRun?: boolean }`
 *   → 200 `{ count }` (con `dryRun`, cuántas se archivarían; sin él, cuántas
 *     se archivaron — los clientes recargan por `conversations.bulk`)
 *   · 422 `invalid_body`
 */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, archiveInactiveSchema);
  if (!body.ok) return body.response;
  const result = await archiveInactive(session.organizationId, {
    days: body.data.days,
    reason: "bulk",
    by: session.userId,
    dryRun: body.data.dryRun,
  });
  return Response.json(result);
}, { role: "owner" });
