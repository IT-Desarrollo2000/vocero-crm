import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { labErrorResponse } from "@/server/lab/errors";
import {
  legacySuggestionApplySchema,
  suggestionApplySchema,
} from "@/server/lab/schemas";
import { applySuggestion } from "@/server/lab/suggestions";

export const dynamic = "force-dynamic";

/**
 * Aplica una sugerencia del juez con un click (FR-033; 08: RF-08-12/13).
 *
 * Forma 08 («Contrato 08-0»): `LabSuggestionApplyInput`
 *   `{ testCaseId, hallazgoIndex, target: "kb"|"profile", field?, pregunta?,
 *      respuesta?, text? }` — idempotente por (testCaseId, hallazgoIndex).
 *   → 200 `LabSuggestionApplyResultDto` `{ result: "applied"|"alreadyApplied",
 *     application }`
 *   · 404 `not_found` · 422 `invalid_body` · 422 `hallazgo_not_found`
 *   · 422 `target_mismatch` · 422 `too_long`.
 *
 * Forma anterior (UI y E2E actuales, se retira cuando 08-B migre la UI):
 *   `{ caseId, hallazgoIndex, pregunta, respuesta }` → 201 `{ entry }`.
 */
const bodySchema = z.union([suggestionApplySchema, legacySuggestionApplySchema]);

export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  if ("target" in body.data) {
    try {
      const result = await applySuggestion(
        session.organizationId,
        session.userId,
        body.data
      );
      return Response.json(result);
    } catch (err) {
      const res = labErrorResponse(err);
      if (res) return res;
      throw err;
    }
  }

  const legacy = body.data;
  const db = getDb();
  const cases = await db
    .select({ id: schema.agentTestCase.id })
    .from(schema.agentTestCase)
    .where(
      scoped(
        schema.agentTestCase.organizationId,
        session.organizationId,
        eq(schema.agentTestCase.id, legacy.caseId)
      )
    )
    .limit(1);
  if (!cases[0]) return apiError(404, "not_found", "Caso no encontrado");

  const inserted = await db
    .insert(schema.kbEntry)
    .values({
      id: newId("kbEntry"),
      organizationId: session.organizationId,
      kind: "qa",
      question: legacy.pregunta,
      answer: legacy.respuesta,
    })
    .returning();
  return Response.json({ entry: inserted[0] }, { status: 201 });
}, { role: "owner" });
