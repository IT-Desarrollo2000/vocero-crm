import { parseBody, withAuth } from "@/lib/api";
import { labErrorResponse } from "@/server/lab/errors";
import { archivePersona, updatePersona } from "@/server/lab/persona-store";
import { personaPatchSchema } from "@/server/lab/schemas";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * 08 — Editar una persona («Contrato 08-0»). Solo Propietario. `key` y
 * `phone` no se editan (si llegan, se ignoran).
 *   → 200 `{ persona: LabPersonaDto }`
 *   · 404 `not_found` · 422 `invalid_body`.
 */
export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, personaPatchSchema);
  if (!body.ok) return body.response;
  try {
    const persona = await updatePersona(session.organizationId, id, body.data);
    return Response.json({ persona });
  } catch (err) {
    const res = labErrorResponse(err);
    if (res) return res;
    throw err;
  }
}, { role: "owner" });

/**
 * DELETE = ARCHIVAR (RF-08-05): las corridas pasadas siguen legibles por su
 * `persona_snapshot`. Idempotente.
 *   → 200 `{ persona: LabPersonaDto }` (con `archivedAt`)
 *   · 404 `not_found`.
 */
export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  try {
    const persona = await archivePersona(session.organizationId, id);
    return Response.json({ persona });
  } catch (err) {
    const res = labErrorResponse(err);
    if (res) return res;
    throw err;
  }
}, { role: "owner" });
