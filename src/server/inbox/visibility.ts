import { eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { isOwner, type Role } from "@/lib/roles";

/**
 * Visibilidad de conversaciones por asignación (dev-tasks/09, RF-09-02).
 *
 *   Propietario → todas.
 *   Vendedor    → `assigned_user_id = <yo> OR assigned_user_id IS NULL`.
 *
 * La regla vive AQUÍ y se aplica en el WHERE de la query — nunca como
 * "leer y luego comprobar": así lista, detalle, envío, adjuntos, SSE y la
 * paginación de 06 la heredan sin reimplementarla, y no hay TOCTOU.
 *
 * `SessionContext` (`src/lib/auth/session.ts`) cumple `Viewer` tal cual: las
 * rutas pasan `session` directamente.
 */

export type Viewer = { userId: string; role: Role };

/**
 * Condición Drizzle "esta conversación es visible para `viewer`". Siempre
 * devuelve SQL (para el Propietario, `true`), de modo que nunca se cae un
 * WHERE por un `undefined`.
 *
 * Úsala DENTRO de `scoped(...)` — el tenant lo pone `scoped`, no esta función:
 *
 *   select …  .where(scoped(conversation.organizationId, org, eq(id, x), conversationVisibleTo(viewer)))
 *   update …  .where(scoped(conversation.organizationId, org, eq(id, x), conversationVisibleTo(viewer))).returning()
 *
 * En un UPDATE, 0 filas afectadas = "no existe o no la ves" → 404 (RF-09-03,
 * no revela existencia). Nada de consultar primero y actualizar después.
 */
export function conversationVisibleTo(viewer: Viewer): SQL {
  if (isOwner(viewer)) return sql`true`;
  return or(
    eq(schema.conversation.assignedUserId, viewer.userId),
    isNull(schema.conversation.assignedUserId)
  )!;
}

/**
 * ¿`viewer` puede ver la conversación `conversationId` de `organizationId`?
 * Consulta por PK — pensada para el filtro SSE por evento y para `/api/media`.
 *
 * Atajo: para el Propietario devuelve `true` SIN consultar la BD (no es una
 * comprobación de existencia; quien necesite saber si existe, que la lea).
 * Para el Vendedor, una conversación inexistente o de otra org → `false`.
 * Un error de BD se propaga: el llamador decide (SSE: descartar el evento).
 */
export async function canSeeConversation(
  organizationId: string,
  viewer: Viewer,
  conversationId: string
): Promise<boolean> {
  if (isOwner(viewer)) return true;
  const rows = await getDb()
    .select({ id: schema.conversation.id })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.id, conversationId),
        conversationVisibleTo(viewer)
      )
    )
    .limit(1);
  return rows.length > 0;
}
