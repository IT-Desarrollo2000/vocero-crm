import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { fichaFieldsSchema } from "@/lib/ficha-fields";
import type { FichaFieldsResponse } from "@/lib/types";
import { getFichaFields, setFichaFields } from "@/server/ficha-fields";

export const dynamic = "force-dynamic";

/**
 * 04 — Definición de los campos de la ficha (solo Propietario).
 * Contrato 04-0 (dev-tasks/04-el-agente-llena-la-ficha.md).
 *
 * GET → 200 `FichaFieldsResponse` · 404 si no hay `agent_profile`.
 * PUT `FichaFieldsPutBody` (validado con `fichaFieldsSchema`, estricto: es
 * input humano) → 200 `FichaFieldsResponse` canónico · 422 `invalid_body`
 * con detalle. `[]` se guarda como NULL (= sin definición). No convierte ni
 * borra valores guardados.
 */
export const GET = withAuth(async (session) => {
  const fields = await getFichaFields(session.organizationId);
  if (fields === undefined) {
    return apiError(404, "not_found", "El agente aún no está configurado");
  }
  const body: FichaFieldsResponse = { fields };
  return Response.json(body);
}, { role: "owner" });

const putSchema = z.object({ fields: fichaFieldsSchema.nullable() });

export const PUT = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;
  const fields = await setFichaFields(session.organizationId, body.data.fields);
  if (fields === undefined) {
    return apiError(404, "not_found", "El agente aún no está configurado");
  }
  const res: FichaFieldsResponse = { fields };
  return Response.json(res);
}, { role: "owner" });
