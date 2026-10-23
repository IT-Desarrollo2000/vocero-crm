import { apiError, parseBody, withAuth } from "@/lib/api";
import { quickReplyPatchSchema } from "@/lib/quick-replies";
import {
  deleteQuickReply,
  QuickReplyError,
  updateQuickReply,
} from "@/server/quick-replies";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * 09 — Editar / borrar una respuesta rápida
 * (dev-tasks/09-equipo-asignacion-y-respuestas-rapidas.md, "Contrato 09-0").
 * 029: cualquier rol; el Propietario todas, el Vendedor solo las suyas de
 * texto y con el interruptor encendido (`src/lib/quick-reply-policy.ts`).
 *
 * PATCH `QuickReplyPatchBody` (parcial; reordenar = cambiar `position`) →
 *   200 `{ quickReply: QuickReplyDto }` · 404 `not_found` · 422 `invalid_body`
 *   · 422 `unknown_variable` · 409 `duplicate_shortcut`.
 *   019: `productId` (null = desliga, `attach` → null) y `attach`; las
 *   reglas se validan sobre el estado resultante → 422 `invalid_body`
 *   · 422 `unknown_variable` · 422 `invalid_product`.
 *   029: 403 `forbidden` si el Vendedor toca una ajena, una con producto, o
 *   manda `productId`/`attach` no nulos o `position`.
 * DELETE → 200 `{ ok: true }` · 404 `not_found` · 403 `forbidden` (029).
 */
export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, quickReplyPatchSchema);
  if (!body.ok) return body.response;

  // 019: variables y liga a producto se validan en el store sobre el estado
  // fusionado (un PATCH solo de `productId` cambia si `{{producto}}` vale).
  try {
    const quickReply = await updateQuickReply(session.organizationId, session, id, body.data);
    return Response.json({ quickReply });
  } catch (err) {
    if (err instanceof QuickReplyError) {
      return apiError(err.status, err.code, err.message);
    }
    throw err;
  }
});

export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  try {
    await deleteQuickReply(session.organizationId, session, id);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof QuickReplyError) {
      return apiError(err.status, err.code, err.message);
    }
    throw err;
  }
});
