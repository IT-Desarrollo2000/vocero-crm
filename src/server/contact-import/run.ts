import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { leadPayload } from "@/lib/contact-import/core.mjs";
import type { ImportRow, ImportRowResult } from "@/lib/contact-import";
import { intakeLeadSchema } from "@/server/intake/contract";
import { ingestExternalLead } from "@/server/intake/ingest";
import { normalizeIntakePhone, phoneLast4 } from "@/server/intake/phone";

/**
 * 036 fase 2 — Importa un lote de renglones ya revisados (la pantalla manda
 * de 50 en 50, en orden).
 *
 * Cada renglón sigue EXACTAMENTE el camino del script de línea de comandos:
 * el mismo cuerpo (`leadPayload`, mismo `lead_id` determinista de evento +
 * WhatsApp), el mismo contrato (`intakeLeadSchema`) y la misma ingesta
 * (`ingestExternalLead`). Por eso un archivo importado por la pantalla y por
 * el script se reconocen entre sí como «ya importado».
 *
 * No pasa por `requireIntakeKey`: es la sesión del Propietario, no el ERP, así
 * que funciona con `LEADS_EXTERNOS` apagada y no gasta el cupo del ERP.
 *
 * Renglón por renglón y cada uno en su try/catch: un fallo es un `error` de
 * ese renglón, no del lote; reintentar es seguro (idempotente por `lead_id`).
 * Al log: solo `lead_id` y los últimos 4 del teléfono (en la ingesta).
 */
export async function importRows(
  organizationId: string,
  event: string,
  rows: readonly ImportRow[]
): Promise<ImportRowResult[]> {
  const results: ImportRowResult[] = [];
  const conversationOf = new Map<number, string>();
  const seen = new Set<string>();

  for (const row of rows) {
    const phone = normalizeIntakePhone(row.phone);
    if (!phone || seen.has(phone)) {
      // La vista previa ya los separó; si llegan, no se importan.
      results.push({ rowNumber: row.rowNumber, outcome: "error", assignee: null });
      continue;
    }
    seen.add(phone);
    const payload = leadPayload(row, event, phone);
    const lead = intakeLeadSchema.safeParse(payload);
    if (!lead.success) {
      results.push({ rowNumber: row.rowNumber, outcome: "error", assignee: null });
      continue;
    }
    try {
      const r = await ingestExternalLead(organizationId, lead.data, phone);
      conversationOf.set(row.rowNumber, r.conversationId);
      results.push({
        rowNumber: row.rowNumber,
        outcome: r.duplicate ? "duplicate" : r.created ? "created" : "existing",
        assignee: r.assignment === "asignado" ? "seller" : null,
      });
    } catch (err) {
      console.error(
        `[036] importar: lead ${payload.lead_id} ··${phoneLast4(phone)}: error:`,
        err instanceof Error ? err.message : "desconocido"
      );
      results.push({ rowNumber: row.rowNumber, outcome: "error", assignee: null });
    }
  }

  // Con quién quedó cada chat que no se asignó a su vendedor: si ya tenía a
  // alguien (otra persona, o el renglón venía sin vendedor), «other»; si no,
  // sigue en el Buzón. Una consulta por lote.
  const pending = results.filter((r) => r.outcome !== "error" && r.assignee === null);
  const ids = [...new Set(pending.map((r) => conversationOf.get(r.rowNumber)).filter((x): x is string => !!x))];
  if (ids.length > 0) {
    try {
      const convs = await getDb()
        .select({ id: schema.conversation.id, assignedUserId: schema.conversation.assignedUserId })
        .from(schema.conversation)
        .where(scoped(schema.conversation.organizationId, organizationId, inArray(schema.conversation.id, ids)));
      const assigned = new Set(convs.filter((c) => c.assignedUserId).map((c) => c.id));
      for (const r of pending) {
        const conv = conversationOf.get(r.rowNumber);
        if (conv && assigned.has(conv)) r.assignee = "other";
      }
    } catch (err) {
      // Accesorio: los leads ya entraron; solo se pierde el detalle del conteo.
      console.error("[036] importar: no se pudo leer la asignación:", err instanceof Error ? err.message : "desconocido");
    }
  }
  return results;
}
