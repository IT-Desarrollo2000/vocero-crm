import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { isOwner } from "@/lib/roles";
import { publish } from "@/server/events/bus";
import {
  assignConversation,
  getConversation,
  instagramSourceFor,
  serializeConversation,
} from "@/server/inbox/queries";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const assignSchema = z.object({
  /** User id (NO el id de membresía) o null = sin asignar. */
  userId: z.string().min(1).nullable(),
  expect: z.literal("unassigned").optional(),
});

/**
 * 09 — Tomar / liberar / asignar / reasignar una conversación
 * (dev-tasks/09-equipo-asignacion-y-respuestas-rapidas.md, "Contrato 09-0").
 *
 * Body `AssignBody` = `{ userId: string | null, expect?: "unassigned" }`.
 *   Vendedor: `userId = yo` (tomar; implica `expect: "unassigned"`) o
 *             `null` sobre la suya (liberar). Otro destino → 403 `forbidden`
 *             (D-09-6: el Vendedor no cede a otro; reasigna el Propietario).
 *   Propietario: cualquier miembro o `null`, incondicional; con
 *             `expect: "unassigned"` se comporta como "tomar" (409 si ya
 *             tiene responsable).
 *
 * 200 `{ conversation: ConversationDto }` (idempotente: tomar la propia o
 *     liberar una sin asignar → 200 sin cambios y sin evento).
 * 403 `forbidden` · 404 `not_found` (no existe, no visible o `is_test`) ·
 * 409 `already_assigned` (`error.assignedTo` solo al Propietario) ·
 * 422 `invalid_body` / `invalid_assignee`.
 * Tras el commit publica `conversation.updated { conversation: { id } }`.
 * Nunca toca `ai_enabled` ni `handoff_at` (RF-09-16).
 */
export const POST = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, assignSchema);
  if (!body.ok) return body.response;
  const { userId: to } = body.data;

  const owner = isOwner(session);
  if (!owner && to !== null && to !== session.userId) {
    return apiError(
      403,
      "forbidden",
      "Solo el Propietario puede asignar una conversación a otra persona"
    );
  }
  // El Vendedor que se asigna a sí mismo siempre "toma": solo si nadie la tiene.
  const expect = owner ? body.data.expect : to ? "unassigned" : undefined;

  const result = await assignConversation(
    session.organizationId,
    id,
    { to, expect },
    session
  );

  switch (result.kind) {
    case "not_found":
      return apiError(404, "not_found", "Conversación no encontrada");
    case "invalid_assignee":
      return apiError(
        422,
        "invalid_assignee",
        "Ese usuario no es miembro de la organización"
      );
    case "conflict":
      return Response.json(
        {
          error: {
            code: "already_assigned",
            message: "Otra persona ya tomó esta conversación",
            // Al Vendedor no se le dice quién: ya no puede verla.
            ...(owner && result.assignee ? { assignedTo: result.assignee } : {}),
          },
        },
        { status: 409 }
      );
    case "ok":
      break;
  }

  if (result.changed) {
    publish(session.organizationId, {
      type: "conversation.updated",
      data: { conversation: { id } },
    });
  }

  const row = await getConversation(session.organizationId, id, session);
  if (!row) return apiError(404, "not_found", "Conversación no encontrada");
  return Response.json({
    conversation: serializeConversation(
      row.conversation,
      row.contact,
      null,
      null,
      row.assignee,
      null,
      await instagramSourceFor(session.organizationId, row.conversation.channel),
      row.anuncio
    ),
  });
});
