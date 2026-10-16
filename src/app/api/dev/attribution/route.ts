import { asc, eq } from "drizzle-orm";
import { mockGuard } from "@/lib/dev-guard";
import { apiError } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";

export const dynamic = "force-dynamic";

/**
 * 020 — Qué se GUARDÓ del anuncio de origen de un contacto (solo entorno de
 * pruebas: 404 en producción o sin `WA_MOCK_ENABLED`).
 *
 * Existe porque la API pública no puede contestarlo: `hasCtwaClid` dice
 * `false` con la bandera apagada se haya guardado o no. El self-test necesita
 * afirmar que, apagada, el `ctwa_clid` no llega ni a la columna ni al `raw`.
 * Responde booleanos, no el valor.
 *
 * GET `?contact=<contactId>` → 200 `{ rows: [{ conversationId, sourceId,
 *   ctwaClidColumn, ctwaClidInRaw, imageAssetId }] }` (orden de llegada)
 */
export async function GET(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;

  const contactId = new URL(req.url).searchParams.get("contact")?.trim();
  if (!contactId) return apiError(422, "invalid_query", "Falta ?contact=");

  const db = getDb();
  const contact = await db
    .select({ organizationId: schema.contact.organizationId })
    .from(schema.contact)
    .where(eq(schema.contact.id, contactId))
    .limit(1);
  const org = contact[0]?.organizationId;
  if (!org) return apiError(404, "not_found", "Contacto no encontrado");

  const a = schema.adAttribution;
  const filas = await db
    .select()
    .from(a)
    .where(scoped(a.organizationId, org, eq(a.contactId, contactId)))
    .orderBy(asc(a.createdAt), asc(a.id));
  return Response.json({
    rows: filas.map((f) => ({
      conversationId: f.conversationId,
      sourceId: f.sourceId,
      ctwaClidColumn: f.ctwaClid !== null,
      ctwaClidInRaw:
        typeof f.raw === "object" && f.raw !== null && "ctwa_clid" in f.raw,
      imageAssetId: f.imageAssetId,
    })),
  });
}
