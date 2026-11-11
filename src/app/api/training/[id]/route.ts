import { parseBody, withAuth } from "@/lib/api";
import { trainingPatchSchema } from "@/lib/training";
import { invalidTrainingId, trainingErrorResponse } from "@/server/training/http";
import { deleteTrainingAsset, updateTrainingAsset } from "@/server/training/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * 034 — Un material de capacitación (solo Propietario).
 *
 * PATCH `{ title?, topicId? }` (`topicId` solo en videos; `null` = «Ninguno:
 *   solo en la lista de videos») → 200 `{ asset }` · 404 · 422
 *   `invalid_body` / `invalid_topic`.
 * DELETE → 200 `{ ok: true }` · 404; borra los bytes donde se guardaron
 *   (best-effort, después de la fila).
 */
export const PATCH = withAuth(
  async (session, req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    const bad = invalidTrainingId(id);
    if (bad) return bad;
    const body = await parseBody(req, trainingPatchSchema);
    if (!body.ok) return body.response;
    try {
      const asset = await updateTrainingAsset(session.organizationId, id, body.data);
      return Response.json({ asset });
    } catch (err) {
      return trainingErrorResponse(err);
    }
  },
  { role: "owner" }
);

export const DELETE = withAuth(
  async (session, _req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    const bad = invalidTrainingId(id);
    if (bad) return bad;
    try {
      await deleteTrainingAsset(session.organizationId, id);
      return Response.json({ ok: true });
    } catch (err) {
      return trainingErrorResponse(err);
    }
  },
  { role: "owner" }
);
