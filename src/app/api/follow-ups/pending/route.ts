import { apiError, withAuth } from "@/lib/api";
import { pendingQuerySchema } from "@/lib/follow-ups";
import { pendingFor } from "@/server/follow-ups/pending";

export const dynamic = "force-dynamic";

/**
 * 035 — «Sin contacto» y «Sin respuesta a tu plantilla» de Pendientes.
 *
 * GET `?days=15|30|60|90` o `?from=YYYY-MM-DD&to=YYYY-MM-DD` (días de pared
 *   del negocio), `includeLost=1`, `replyDays=3|7|14`, `userId` (solo el
 *   Propietario; el Vendedor ve siempre sus clientes) → 200 `PendingDto`
 *   · 422 `invalid_query`.
 */
export const GET = withAuth(async (session, req: Request) => {
  const url = new URL(req.url);
  const parsed = pendingQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ");
    return apiError(422, "invalid_query", detail);
  }
  return Response.json(await pendingFor(session.organizationId, session, parsed.data));
});
