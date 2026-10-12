import { apiError, parseBody, withAuth } from "@/lib/api";
import {
  findUnknownVars,
  quickReplyCreateSchema,
  unknownVariableMessage,
} from "@/lib/quick-replies";
import {
  createQuickReply,
  listQuickReplies,
  QuickReplyError,
} from "@/server/quick-replies";

export const dynamic = "force-dynamic";

/**
 * 09 — Catálogo de respuestas rápidas de la organización
 * (dev-tasks/09-equipo-asignacion-y-respuestas-rapidas.md, "Contrato 09-0").
 *
 * GET (cualquier rol) → 200 `{ quickReplies: QuickReplyDto[] }` ordenadas por
 *   `position` asc, luego `createdAt` asc.
 * POST (Propietario) `QuickReplyCreateBody` → 201 `{ quickReply: QuickReplyDto }`
 *   · 422 `invalid_body` · 422 `unknown_variable` (nombra la variable)
 *   · 409 `duplicate_shortcut`.
 */
export const GET = withAuth(async (session) => {
  const quickReplies = await listQuickReplies(session.organizationId);
  return Response.json({ quickReplies });
});

export const POST = withAuth(
  async (session, req: Request) => {
    const body = await parseBody(req, quickReplyCreateSchema);
    if (!body.ok) return body.response;

    const unknown = findUnknownVars(body.data.body);
    if (unknown.length > 0) {
      return apiError(422, "unknown_variable", unknownVariableMessage(unknown));
    }

    try {
      const quickReply = await createQuickReply(
        session.organizationId,
        session.userId,
        body.data
      );
      return Response.json({ quickReply }, { status: 201 });
    } catch (err) {
      if (err instanceof QuickReplyError) {
        return apiError(err.status, err.code, err.message);
      }
      throw err;
    }
  },
  { role: "owner" }
);
