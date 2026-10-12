import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { apiError, parseBody } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { handoffNoteFrom, toHandoffReason } from "@/server/bot/handoff";
import { markHandoff } from "@/server/inbox/handoff";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  conversationId: z.string().min(1),
  /**
   * Texto libre a propósito: el catálogo se aplica después, con fallback
   * (ver `server/bot/handoff`). Un motivo raro no puede costar el handoff.
   */
  reason: z.string().optional(),
  /**
   * Explicación libre para el humano que recibe la conversación. Opcional:
   * los clientes que no la mandan siguen funcionando igual. Se recorta, no se
   * rechaza — una nota larga tampoco puede costar el handoff.
   */
  note: z.string().optional(),
});

/**
 * Handoff pedido por el cerebro externo: pausa la IA y deja la conversación
 * para un humano. Idempotente — solo escribe en la transición, así que
 * reintentar no pisa la hora ni el motivo original.
 *
 * Es la misma pausa que el toggle de la bandeja, y publica el mismo evento,
 * así que la app lo ve en vivo sin refrescar.
 */
export async function POST(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const rows = await db
    .select({
      id: schema.conversation.id,
      handoffAt: schema.conversation.handoffAt,
    })
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.id, body.data.conversationId)
      )
    )
    .limit(1);
  const conv = rows[0];
  if (!conv) return apiError(404, "not_found", "Conversación no encontrada");

  if (!conv.handoffAt) {
    // Puerta única (05/02-0): el UPDATE es condicional, así que una carrera
    // entre dos reintentos tampoco escribe ni publica dos veces.
    await markHandoff({
      organizationId,
      conversationId: conv.id,
      reason: toHandoffReason(body.data.reason),
      note: handoffNoteFrom(body.data.reason, body.data.note),
      source: "bot_externo",
      pauseAi: true,
    });
  }
  return Response.json({ ok: true });
}
