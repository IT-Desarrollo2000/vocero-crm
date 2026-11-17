import { and, eq, inArray, or } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  FIELDS,
  findHeaderRow,
  HEADER_SEARCH_ROWS,
  planImportRows,
  type CellValue,
} from "@/lib/contact-import/core.mjs";
import {
  FIELD_LABEL,
  IMPORT_MAX_ROWS,
  type ImportPreviewDto,
  type PreviewErrorCode,
  type PreviewRow,
  type SellerLine,
} from "@/lib/contact-import";
import { normalizeIntakePhone } from "@/server/intake/phone";
import { listSellerMembers } from "@/server/intake/seller";
import {
  matchSeller,
  normalizePersonName,
  type SellerMember,
} from "@/server/intake/seller-match";
import { readImportFile } from "./read";

/**
 * 036 fase 2 — Vista previa de la lista: qué entra, qué no y a quién se le
 * asigna cada chat. NO ESCRIBE NADA (solo lee el equipo y busca, en UNA
 * consulta, qué teléfonos ya son contactos).
 */

export type PreviewResult =
  | { ok: true; preview: ImportPreviewDto }
  | { ok: false; code: PreviewErrorCode; message: string };

/**
 * Pura: de las filas del archivo a la vista previa. `existing` = teléfonos
 * (`52`+10) que ya son contactos de WhatsApp de la organización.
 */
export function buildPreview(input: {
  fileName: string;
  rows: readonly (readonly CellValue[])[];
  members: readonly SellerMember[];
  existing: ReadonlySet<string>;
}): PreviewResult {
  const header = findHeaderRow(input.rows);
  if (!header) {
    return {
      ok: false,
      code: "no_header",
      message: `No encontré las columnas «Nombre» y «WhatsApp» en las ${HEADER_SEARCH_ROWS} primeras filas. La lista necesita al menos esas dos (también se reconocen «Teléfono» o «Celular»).`,
    };
  }
  const planned = planImportRows(input.rows, header, normalizeIntakePhone);
  if (planned.length === 0) {
    return { ok: false, code: "empty", message: "La lista no tiene renglones debajo de los encabezados." };
  }
  if (planned.length > IMPORT_MAX_ROWS) {
    return {
      ok: false,
      code: "too_many_rows",
      message: `La lista tiene ${planned.length.toLocaleString("es-MX")} renglones y el tope es ${IMPORT_MAX_ROWS.toLocaleString("es-MX")}. Pártela en dos archivos con el mismo nombre de evento.`,
    };
  }

  const rows: PreviewRow[] = planned.map((r) => ({
    rowNumber: r.rowNumber,
    name: r.name,
    rawPhone: r.rawPhone,
    phone: r.phone,
    seller: r.seller,
    model: r.model,
    notes: r.notes,
    email: r.email,
    consent: r.consent,
    status: r.status,
    problem: r.problem,
    repeatOf: r.repeatOf,
    existing: r.status === "ready" && !!r.phone && input.existing.has(r.phone),
  }));
  const ready = rows.filter((r) => r.status === "ready");

  // Una línea por vendedor distinto (comparado normalizado, como al asignar).
  const groups = new Map<string, SellerLine>();
  let noSeller = 0;
  for (const r of ready) {
    const key = normalizePersonName(r.seller);
    if (!key) {
      noSeller++;
      continue;
    }
    const line = groups.get(key);
    if (line) {
      line.count++;
      continue;
    }
    const m = matchSeller(r.seller, input.members);
    groups.set(key, {
      text: r.seller,
      kind: m.kind === "match" ? "match" : m.kind,
      memberName:
        m.kind === "match" ? (input.members.find((x) => x.userId === m.userId)?.name ?? null) : null,
      count: 1,
    });
  }
  const rank: Record<SellerLine["kind"], number> = { match: 0, ambiguous: 1, none: 2 };
  const sellers = [...groups.values()].sort(
    (a, b) => rank[a.kind] - rank[b.kind] || b.count - a.count || a.text.localeCompare(b.text, "es")
  );

  const recognized = FIELDS.filter((f) => header.columns[f] !== undefined).map((f) => FIELD_LABEL[f]);

  return {
    ok: true,
    preview: {
      fileName: input.fileName,
      totalRows: rows.length,
      columns: { recognized, ignored: header.unknown },
      rows,
      summary: {
        ready: ready.length,
        existing: ready.filter((r) => r.existing).length,
        invalid: rows.filter((r) => r.status === "invalid").length,
        repeated: rows.filter((r) => r.status === "repeated").length,
      },
      sellers,
      noSeller,
    },
  };
}

/**
 * Teléfonos que ya son contactos de WhatsApp. Misma llave que
 * `getOrCreateContactByIdentity` (canal whatsapp): `wa_identity` o `phone`
 * igual al `52`+10. Incluye archivados (la importación los reactiva).
 */
export async function existingWhatsappPhones(
  organizationId: string,
  phones: readonly string[]
): Promise<Set<string>> {
  const found = new Set<string>();
  const unique = [...new Set(phones)];
  if (unique.length === 0) return found;
  const rows = await getDb()
    .select({ waIdentity: schema.contact.waIdentity, phone: schema.contact.phone })
    .from(schema.contact)
    .where(
      scoped(
        schema.contact.organizationId,
        organizationId,
        and(
          eq(schema.contact.channel, "whatsapp"),
          or(inArray(schema.contact.waIdentity, unique), inArray(schema.contact.phone, unique))
        )
      )
    );
  const wanted = new Set(unique);
  for (const r of rows) {
    if (wanted.has(r.waIdentity)) found.add(r.waIdentity);
    if (r.phone && wanted.has(r.phone)) found.add(r.phone);
  }
  return found;
}

/** Lee el archivo y arma la vista previa. Solo lecturas. */
export async function previewImport(
  organizationId: string,
  file: { data: Buffer; fileName: string }
): Promise<PreviewResult> {
  const read = await readImportFile(file.data, file.fileName);
  if (!read.ok) return read;
  const header = findHeaderRow(read.rows);
  // Sin encabezados no hace falta ir a la BD: `buildPreview` explica qué falta.
  if (!header) return buildPreview({ fileName: file.fileName, rows: read.rows, members: [], existing: new Set() });
  const phones = planImportRows(read.rows, header, normalizeIntakePhone)
    .filter((r) => r.status === "ready" && r.phone)
    .map((r) => r.phone as string);
  const [members, existing] = await Promise.all([
    listSellerMembers(organizationId),
    phones.length > IMPORT_MAX_ROWS ? Promise.resolve(new Set<string>()) : existingWhatsappPhones(organizationId, phones),
  ]);
  return buildPreview({ fileName: file.fileName, rows: read.rows, members, existing });
}
