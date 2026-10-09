import { apiError, withAuth } from "@/lib/api";
import {
  atribucionDisabledResponse,
  atribucionEnabled,
} from "@/server/attribution/flag";
import {
  getConversionActivityRow,
  retryConversion,
} from "@/server/attribution/conversions";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * 016 — Reintentar UNA conversión `failed` o `skipped`-reintentable.
 *
 * Reusa la misma fila y el mismo `event_id` (Meta deduplica por él). Un
 * `sent`, un `pending` o un `skipped` definitivo (sin `ctwa_clid`) responden
 * 409: reintentarlos no cambiaría nada o mandaría dos veces.
 */
export const POST = withAuth(async (session, _req: Request, ctx: Params) => {
  if (!atribucionEnabled()) return atribucionDisabledResponse();
  const { id } = await ctx.params;

  const result = await retryConversion(session.organizationId, id);
  if (!result.ok) {
    if (result.reason === "disabled") return atribucionDisabledResponse();
    if (result.reason === "not_found") {
      return apiError(404, "not_found", "Conversión no encontrada");
    }
    return apiError(
      409,
      "not_retryable",
      "Esta conversión no se puede reintentar en su estado actual"
    );
  }

  const event = await getConversionActivityRow(session.organizationId, id);
  return Response.json({ outcome: result.outcome, event });
});
