import { parseBody, withAuth } from "@/lib/api";
import { labErrorResponse } from "@/server/lab/errors";
import { createPersona, listPersonas } from "@/server/lab/persona-store";
import { personaCreateSchema } from "@/server/lab/schemas";

export const dynamic = "force-dynamic";

/**
 * 08 — Personas del Laboratorio («Contrato 08-0»). Solo Propietario.
 *
 * GET `?archived=1` incluye archivadas. 08-A: siembra perezosa antes de
 * listar (`ensureSeedPersonas`, D-08-01). El stub NO siembra: fijaría el set
 * de la org antes de tiempo.
 *   → 200 `LabPersonasResponse` `{ personas, runInProgress }`
 *   · hoy 501 `not_implemented`.
 */
export const GET = withAuth(async (session, req: Request) => {
  try {
    const includeArchived = new URL(req.url).searchParams.get("archived") === "1";
    const personas = await listPersonas(session.organizationId, { includeArchived });
    return Response.json({ personas, runInProgress: false });
  } catch (err) {
    const res = labErrorResponse(err);
    if (res) return res;
    throw err;
  }
}, { role: "owner" });

/**
 * POST `LabPersonaCreateInput` (key y phone los genera el servidor).
 *   → 201 `{ persona: LabPersonaDto }`
 *   · 422 `invalid_body` · hoy 501 `not_implemented`.
 */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, personaCreateSchema);
  if (!body.ok) return body.response;
  try {
    // 08-A: `ensureSeedPersonas` antes de crear (la primera persona propia no
    // debe impedir la siembra).
    const persona = await createPersona(session.organizationId, body.data);
    return Response.json({ persona }, { status: 201 });
  } catch (err) {
    const res = labErrorResponse(err);
    if (res) return res;
    throw err;
  }
}, { role: "owner" });
