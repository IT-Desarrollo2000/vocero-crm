import { parseOptionalBody, withAuth } from "@/lib/api";
import { labErrorResponse } from "@/server/lab/errors";
import { restoreDefaultPersonas } from "@/server/lab/persona-store";
import { restoreDefaultsSchema } from "@/server/lab/schemas";

export const dynamic = "force-dynamic";

/**
 * 08 — "Restaurar predeterminadas" (RF-08-03, «Contrato 08-0»). Solo
 * Propietario. Cuerpo opcional `{ set?: "autos" | "neutro" }`.
 *   → 200 `LabRestoreDefaultsResponse` `{ set, restored, personas }`
 *   · 422 `invalid_body` · hoy 501 `not_implemented`.
 */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseOptionalBody(req, restoreDefaultsSchema);
  if (!body.ok) return body.response;
  try {
    const result = await restoreDefaultPersonas(session.organizationId, body.data.set);
    return Response.json(result);
  } catch (err) {
    const res = labErrorResponse(err);
    if (res) return res;
    throw err;
  }
}, { role: "owner" });
