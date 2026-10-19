import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { publish } from "@/server/events/bus";
import {
  getConversation,
  instagramSourceFor,
  listConversations,
  serializeConversation,
  updateConversation,
} from "@/server/inbox/queries";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  aiEnabled: z.boolean().optional(),
  reactivate: z.boolean().optional(),
  markRead: z.boolean().optional(),
  /**
   * 022: archivar (`true`) / desarchivar (`false`). Vendedor y Propietario,
   * con su visibilidad; una `is_test` → 404.
   */
  archived: z.boolean().optional(),
});

type Params = { params: Promise<{ id: string }> };

/**
 * 06: detalle de UNA conversación (`{ conversation: ConversationDto }`) con la
 * visibilidad del viewer; no existe, es `is_test` o no la ves → 404. Es el
 * modo `?ids=` de la lista con un solo id: mismo DTO (preview y etapa
 * incluidos) y mismas reglas.
 */
export const GET = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const { conversations } = await listConversations(
    session.organizationId,
    session,
    { ids: [id] }
  );
  const conversation = conversations[0];
  if (!conversation) {
    return apiError(404, "not_found", "Conversación no encontrada");
  }
  return Response.json({ conversation });
});

/**
 * 09: el predicado de visibilidad va en el WHERE del UPDATE
 * (`updateConversation(..., session)`): 0 filas = no existe o no la ves → 404.
 * La asignación NO se cambia por aquí: tiene su ruta
 * (`POST /api/conversations/[id]/assign`).
 */
export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  const updated = await updateConversation(
    session.organizationId,
    id,
    body.data,
    session
  );
  if (!updated) return apiError(404, "not_found", "Conversación no encontrada");

  // Por SSE viaja solo el id (RF-09-09): el cliente refetchea con su vista.
  publish(session.organizationId, {
    type: "conversation.updated",
    data: { conversation: { id } },
  });

  const row = await getConversation(session.organizationId, id, session);
  if (row) {
    const dto = serializeConversation(
      row.conversation,
      row.contact,
      null,
      null,
      row.assignee,
      null,
      await instagramSourceFor(session.organizationId, row.conversation.channel),
      row.anuncio
    );
    return Response.json({ conversation: dto });
  }
  return Response.json({ conversation: null });
});
