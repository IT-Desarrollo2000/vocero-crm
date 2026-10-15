import { apiError, parseBody, withAuth } from "@/lib/api";
import { catalogBatchSchema } from "@/lib/catalog";
import { CatalogBatchError, sendCatalogBatch } from "@/server/catalog/send";
import { gateSend, getConversation } from "@/server/inbox/queries";
import { SendError } from "@/server/inbox/send";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const SEND_ERROR_STATUS: Record<SendError["code"], number> = {
  sandbox_violation: 403,
  not_connected: 409,
  reconnect_required: 409,
  window_closed: 409,
  meta_error: 422,
  meta_unavailable: 503,
  upload_failed: 502,
  unsupported_channel: 422,
};

/**
 * 019 — Envía archivos del catálogo (y un texto opcional) por la
 * conversación, en orden (FR-940/941). Body JSON: `{ text?, fileIds }`.
 * 200 con `CatalogBatchResult` (un item por id, sin repetidos). Un fallo que
 * detiene el lote antes de que salga nada responde como un envío suelto
 * (409/403/503/422); ningún id del catálogo en la org → 404 sin enviar.
 */
export const POST = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  // 09: no visible para quien pide → 404.
  const conv = await getConversation(session.organizationId, id, session);
  if (!conv) return apiError(404, "not_found", "Conversación no encontrada");

  const body = await parseBody(req, catalogBatchSchema);
  if (!body.ok) return body.response;

  // 09: UNA compuerta para todo el lote ("responder = tomar", RF-09-07).
  if (!(await gateSend(session, id, conv.conversation.assignedUserId))) {
    return apiError(404, "not_found", "Conversación no encontrada");
  }

  try {
    const result = await sendCatalogBatch({
      conversationId: id,
      organizationId: session.organizationId,
      text: body.data.text,
      fileIds: body.data.fileIds,
    });
    return Response.json(result);
  } catch (err) {
    if (err instanceof CatalogBatchError) {
      return apiError(404, err.code, err.message);
    }
    if (err instanceof SendError) {
      return apiError(SEND_ERROR_STATUS[err.code], err.code, err.message);
    }
    throw err;
  }
});
