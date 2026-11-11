import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { followUpCreateSchema, FOLLOW_UP_STATUSES } from "@/lib/follow-ups";
import { reportTimezone } from "@/server/reports/timezone";
import { createFollowUp, FollowUpError, listFollowUps } from "@/server/follow-ups/store";

export const dynamic = "force-dynamic";

const listQuery = z.object({
  status: z.enum(FOLLOW_UP_STATUSES).optional(),
  contactId: z.string().trim().min(1).max(64).optional(),
  userId: z.string().trim().min(1).max(64).optional(),
});

/**
 * 035 — Recordatorios internos del vendedor.
 *
 * GET (cualquier rol) `?status=open|done&contactId=&userId=` → 200
 *   `{ followUps: FollowUpDto[], businessTimezone }`. El Vendedor recibe solo
 *   los suyos (`userId` se ignora); el Propietario todos o los de `userId`.
 *   Abiertos por hora; hechos, el último primero (máx. 50).
 * POST (cualquier rol) `FollowUpCreateBody` (`day` + `time` de pared en la
 *   zona del negocio) → 201 `{ followUp }` · 404 `contact_not_found`
 *   · 422 `invalid_body` / `invalid_conversation` / `invalid_date`.
 *   El dueño del recordatorio es siempre quien lo crea.
 */
export const GET = withAuth(async (session, req: Request) => {
  const url = new URL(req.url);
  const parsed = listQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return apiError(422, "invalid_query", "Parámetros inválidos");
  const [followUps, businessTimezone] = await Promise.all([
    listFollowUps(session.organizationId, session, parsed.data),
    reportTimezone(session.organizationId),
  ]);
  return Response.json({ followUps, businessTimezone });
});

export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, followUpCreateSchema);
  if (!body.ok) return body.response;
  try {
    const followUp = await createFollowUp(session.organizationId, session, body.data);
    return Response.json({ followUp }, { status: 201 });
  } catch (err) {
    if (err instanceof FollowUpError) return apiError(err.status, err.code, err.message);
    throw err;
  }
});
