/**
 * 036 — Lo puro de `scripts/importar-leads.mjs` (sin red ni archivos), para
 * probarlo desde Vitest (`tests/unit/importar-leads-036.test.ts`).
 *
 * La lectura del archivo (encabezados por alias, celdas, enlaces wa.me, CSV,
 * `lead_id`, cuerpo del lead) vive en UN solo módulo que comparte con el
 * importador de la app (Contactos → Importar desde Excel):
 * `src/lib/contact-import/core.mjs`. Aquí solo queda lo propio del script:
 * su copia del normalizador de teléfono, los textos de la consola/CSV y la
 * ruta del resultado.
 */

import { leadPayload, planImportRows } from "../../src/lib/contact-import/core.mjs";

export {
  cellText,
  classifyHeader,
  FIELDS,
  findHeaderRow,
  firstSheetWithData,
  LEAD_ID_NAMESPACE,
  leadIdFor,
  normalizeHeader,
  normalizeText,
  parseCsv,
  phoneFromCell,
  waLinkDigits,
  worksheetRows,
} from "../../src/lib/contact-import/core.mjs";

/* ───────────────────────────── teléfono ──────────────────────────── */

/**
 * Port de `normalizeIntakePhone` (src/server/intake/phone.ts) — mantener en
 * sincronía (un test lo compara). Las 3 reglas: 10 dígitos → `52`+10; `52`+10
 * (12) se queda; `521`+10 (13) pierde el 1 (como `normalizeMx`). Solo dígitos
 * y los adornos de una captura a mano (espacios, +, -, paréntesis, puntos).
 * El servidor usa el suyo; el script no puede importar TypeScript.
 *
 * @returns `52` + 10 dígitos, o `null`.
 */
export function normalizePhone(raw) {
  const s = String(raw ?? "").trim();
  if (!/^[\d\s+\-().]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `52${digits}`;
  if (digits.length === 12 && digits.startsWith("52")) return digits;
  if (digits.length === 13 && digits.startsWith("521")) return `52${digits.slice(3)}`;
  return null;
}

/* ───────────────────────────── plan ──────────────────────────────── */

const CLI_REASON = {
  name_missing: "falta el nombre",
  phone_missing: "falta el WhatsApp",
};

/**
 * De las filas del archivo a la lista de leads (textos del script). Cada
 * fila de datos sale con su número de fila del archivo (1 = la primera) y un
 * estado: `listo` | `inválido` (con motivo) | `repetido` (mismo WhatsApp que
 * una fila anterior: se queda la primera). Las filas vacías se saltan.
 */
export function planRows(rows, header, event) {
  return planImportRows(rows, header, normalizePhone).map((r) => {
    const base = {
      fila: r.rowNumber,
      name: r.name,
      rawPhone: r.rawPhone,
      seller: r.seller,
      phone: null,
      leadId: null,
      payload: null,
    };
    if (r.status === "invalid") {
      const code = r.problem?.code ?? "";
      return {
        ...base,
        estado: "inválido",
        motivo: CLI_REASON[code] ?? "WhatsApp no válido (deben ser 10 dígitos)",
      };
    }
    if (r.status === "repeated") {
      return { ...base, phone: r.phone, estado: "repetido", motivo: `mismo WhatsApp que la fila ${r.repeatOf}` };
    }
    const payload = leadPayload(r, event, r.phone);
    return { ...base, phone: r.phone, leadId: payload.lead_id, payload, estado: "listo", motivo: "" };
  });
}

/* ───────────────────────────── salida ────────────────────────────── */

/** Una línea CSV con comillas donde hagan falta. */
export function csvLine(values) {
  return values
    .map((v) => {
      const s = String(v ?? "");
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

/** Ruta del resultado: junto al archivo, con sufijo `.resultado.csv`. */
export function resultPathFor(input) {
  return `${String(input).replace(/\.(xlsx|csv)$/i, "")}.resultado.csv`;
}
