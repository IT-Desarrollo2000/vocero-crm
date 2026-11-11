import { parseBody, withAuth } from "@/lib/api";
import { trainingReorderSchema } from "@/lib/training";
import { trainingErrorResponse } from "@/server/training/http";
import { reorderTrainingAssets } from "@/server/training/store";

export const dynamic = "force-dynamic";

/**
 * 034 — Orden de los documentos o de los videos (solo Propietario).
 * `{ kind: "document" | "video", ids: [...] }` con TODOS los de ese tipo →
 * 200 `{ assets }` · 422 `invalid_body` / `invalid_order`.
 */
export const POST = withAuth(
  async (session, req: Request) => {
    const body = await parseBody(req, trainingReorderSchema);
    if (!body.ok) return body.response;
    try {
      const assets = await reorderTrainingAssets(session.organizationId, body.data);
      return Response.json({ assets });
    } catch (err) {
      return trainingErrorResponse(err);
    }
  },
  { role: "owner" }
);
