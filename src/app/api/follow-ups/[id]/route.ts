import { apiError, parseBody, withAuth } from "@/lib/api";
import { followUpPatchSchema } from "@/lib/follow-ups";
import { FollowUpError, patchFollowUp } from "@/server/follow-ups/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * 035 — Hecho / posponer / otra fecha de un recordatorio.
 *
 * PATCH `{ action: "done", note? }` → cierra; si se repite, crea el siguiente
 *   (`due_at` original + N meses) y lo devuelve en `next`.
 *   `{ action: "postpone", preset: "1h"|"tomorrow"|"week" }` · `{ action:
 *   "reschedule", day, time }` → mueve `due_at` (no crea otro).
 *   → 200 `{ followUp, next }` · 404 `not_found` (también uno ajeno, para el
 *   Vendedor) · 409 `already_done` · 422 `invalid_body` / `invalid_date`.
 */
export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, followUpPatchSchema);
  if (!body.ok) return body.response;
  try {
    const result = await patchFollowUp(session.organizationId, session, id, body.data);
    return Response.json(result);
  } catch (err) {
    if (err instanceof FollowUpError) return apiError(err.status, err.code, err.message);
    throw err;
  }
});
