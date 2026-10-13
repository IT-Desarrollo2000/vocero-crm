import { apiError, parseBody, withAuth } from "@/lib/api";
import {
  findUnknownVars,
  quickReplyPatchSchema,
  unknownVariableMessage,
} from "@/lib/quick-replies";
import {
  deleteQuickReply,
  QuickReplyError,
  updateQuickReply,
} from "@/server/quick-replies";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * 09 — Editar / borrar una respuesta rápida (solo Propietario)
 * (dev-tasks/09-equipo-asignacion-y-respuestas-rapidas.md, "Contrato 09-0").
 *
 * PATCH `QuickReplyPatchBody` (parcial; reordenar = cambiar `position`) →
 *   200 `{ quickReply: QuickReplyDto }` · 404 `not_found` · 422 `invalid_body`
 *   · 422 `unknown_variable` · 409 `duplicate_shortcut`.
 * DELETE → 200 `{ ok: true }` · 404 `not_found`.
 */
export const PATCH = withAuth(
  async (session, req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    const body = await parseBody(req, quickReplyPatchSchema);
    if (!body.ok) return body.response;

    if (body.data.body !== undefined) {
      const unknown = findUnknownVars(body.data.body);
      if (unknown.length > 0) {
        return apiError(422, "unknown_variable", unknownVariableMessage(unknown));
      }
    }

    try {
      const quickReply = await updateQuickReply(session.organizationId, id, body.data);
      return Response.json({ quickReply });
    } catch (err) {
      if (err instanceof QuickReplyError) {
        return apiError(err.status, err.code, err.message);
      }
      throw err;
    }
  },
  { role: "owner" }
);

export const DELETE = withAuth(
  async (session, _req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    try {
      await deleteQuickReply(session.organizationId, id);
      return Response.json({ ok: true });
    } catch (err) {
      if (err instanceof QuickReplyError) {
        return apiError(err.status, err.code, err.message);
      }
      throw err;
    }
  },
  { role: "owner" }
);
