import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { tipoDeOrigen } from "@/lib/anuncios";
import type { ContactDetailResponse } from "@/lib/types";
import {
  getContactById,
  getContactStage,
  serializeContact,
} from "@/server/contacts";
import { upsertFicha } from "@/server/bot/ficha";
import { fichaFieldsOrNull } from "@/server/ficha-fields";
import {
  anuncioDelContacto,
  repararImagenSiFalta,
} from "@/server/attribution/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export const GET = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const contact = await getContactById(session.organizationId, id);
  if (!contact) return apiError(404, "not_found", "Contacto no encontrado");
  const [stageRow, fichaFields, anuncio] = await Promise.all([
    getContactStage(session.organizationId, id),
    // 04 — La definición viaja aquí para que el Vendedor pinte el panel sin
    // acceso a la pantalla de Agente.
    fichaFieldsOrNull(session.organizationId),
    // 020 — De qué anuncio llegó (el primero, D1). La tarjeta la ven todos los
    // roles (D4).
    anuncioDelContacto(session.organizationId, id),
  ]);
  // 020 — Si la miniatura no se copió al llegar, se reintenta ahora, en
  // segundo plano y con freno: la tarjeta se pinta igual sin ella.
  if (anuncio && !anuncio.imageUrl) repararImagenSiFalta(session.organizationId, id);
  const body: ContactDetailResponse = {
    contact: serializeContact(contact, null, null, tipoDeOrigen(anuncio)),
    stage: stageRow
      ? {
          id: stageRow.stage.id,
          name: stageRow.stage.name,
          position: stageRow.stage.position,
          kind: stageRow.stage.kind,
        }
      : null,
    lead: stageRow ? { id: stageRow.lead.id } : null,
    fichaFields,
    anuncio,
  };
  return Response.json(body);
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  notes: z.string().max(4000).nullable().optional(),
  archived: z.boolean().optional(),
  /**
   * Parche de la ficha: solo las claves que cambian. `null` borra una clave.
   * No es un reemplazo — el agente sigue escribiendo mientras el dueño
   * corrige, y mandar la ficha entera haría que el último en guardar le
   * borrara lo recién descubierto al otro. Lo que escribe una persona queda
   * con candado (04): el agente ya no lo pisa.
   */
  ficha: z.record(z.unknown()).optional(),
  /** 04 — "Dejar que el agente lo actualice": quita el candado, conserva el valor. */
  fichaUnlock: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
  /**
   * 020 (D3) — Fuente del prospecto a mano: un valor del catálogo cerrado, o
   * `null` para quitar la captura y volver a la deducida (anuncio de origen o
   * "sin identificar"). "desconocida" no es capturable.
   */
  source: z
    .enum(["anuncio", "organico", "referido", "conocido", "otro"])
    .nullable()
    .optional(),
});

export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  // La ficha va por su propia puerta —la MISMA que usan el cerebro externo y
  // el agente— para heredar el merge, las cotas, la procedencia y la
  // bitácora. Escribirla aquí con un `set` plano sería un segundo camino con
  // otras reglas.
  if (body.data.ficha !== undefined || body.data.fichaUnlock?.length) {
    const res = await upsertFicha({
      organizationId: session.organizationId,
      contactId: id,
      ficha: body.data.ficha ?? {},
      source: "humano",
      userId: session.userId,
      unlock: body.data.fichaUnlock,
    });
    if (!res) return apiError(404, "not_found", "Contacto no encontrado");
  }

  const updated = await updateContactFields(session.organizationId, id, body.data);
  if (!updated) return apiError(404, "not_found", "Contacto no encontrado");
  const anuncio = await anuncioDelContacto(session.organizationId, id);
  return Response.json({
    contact: serializeContact(updated, null, null, tipoDeOrigen(anuncio)),
  });
});

/**
 * Nombre, notas, archivado y (020) fuente. Separado de la puerta de la ficha
 * a propósito: este `update` no toca la calificación del lead (guardarraíl
 * `tests/unit/ficha-guard.test.ts`).
 */
async function updateContactFields(
  organizationId: string,
  id: string,
  data: z.infer<typeof patchSchema>
): Promise<typeof schema.contact.$inferSelect | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) set.name = data.name;
  if (data.notes !== undefined) set.notes = data.notes;
  if (data.archived !== undefined) {
    set.archivedAt = data.archived ? new Date() : null;
  }
  if (data.source !== undefined) set.source = data.source;
  const db = getDb();
  const updated = await db
    .update(schema.contact)
    .set(set)
    .where(
      scoped(schema.contact.organizationId, organizationId, eq(schema.contact.id, id))
    )
    .returning();
  return updated[0] ?? null;
}
