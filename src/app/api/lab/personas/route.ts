import { parseBody, withAuth } from "@/lib/api";
import type { LabPersonasResponse } from "@/lib/lab";
import { labErrorResponse } from "@/server/lab/errors";
import {
  createPersona,
  ensureSeedPersonas,
  hasRunInProgress,
  listPersonas,
} from "@/server/lab/persona-store";
import { personaCreateSchema } from "@/server/lab/schemas";

export const dynamic = "force-dynamic";

/**
 * 08 — Personas del Laboratorio («Contrato 08-0»). Solo Propietario.
 *
 * GET `?archived=1` incluye archivadas. Siembra perezosa antes de listar
 * (`ensureSeedPersonas`, D-08-01).
 *   → 200 `LabPersonasResponse` `{ personas, runInProgress }` (D-08-06:
 *     `runInProgress` es un aviso; no bloquea la edición).
 */
export const GET = withAuth(async (session, req: Request) => {
  try {
    const includeArchived = new URL(req.url).searchParams.get("archived") === "1";
    await ensureSeedPersonas(session.organizationId);
    const [personas, runInProgress] = await Promise.all([
      listPersonas(session.organizationId, { includeArchived }),
      hasRunInProgress(session.organizationId),
    ]);
    const payload: LabPersonasResponse = { personas, runInProgress };
    return Response.json(payload);
  } catch (err) {
    const res = labErrorResponse(err);
    if (res) return res;
    throw err;
  }
}, { role: "owner" });

/**
 * POST `LabPersonaCreateInput` (key y phone los genera el servidor).
 *   → 201 `{ persona: LabPersonaDto }`
 *   · 422 `invalid_body`.
 */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, personaCreateSchema);
  if (!body.ok) return body.response;
  try {
    // La primera persona propia no debe impedir la siembra: se siembra antes.
    await ensureSeedPersonas(session.organizationId);
    const persona = await createPersona(session.organizationId, body.data);
    return Response.json({ persona }, { status: 201 });
  } catch (err) {
    const res = labErrorResponse(err);
    if (res) return res;
    throw err;
  }
}, { role: "owner" });
