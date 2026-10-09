import { withAuth } from "@/lib/api";
import {
  atribucionDisabledResponse,
  atribucionEnabled,
} from "@/server/attribution/flag";
import { retryAllConversions } from "@/server/attribution/conversions";

export const dynamic = "force-dynamic";

/**
 * 016 — Reintentar todas las conversiones reintentables (las más recientes,
 * con tope `RETRY_ALL_MAX`). Para después de conectar el dataset o de una
 * caída de Meta.
 */
export const POST = withAuth(async (session) => {
  if (!atribucionEnabled()) return atribucionDisabledResponse();
  const result = await retryAllConversions(session.organizationId);
  if (!result) return atribucionDisabledResponse();
  return Response.json(result);
});
