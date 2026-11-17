/**
 * 036 — Lectura PURA de la lista de un evento (Excel/CSV): la ÚNICA copia.
 *
 * La usan las dos entradas del importador, así que el mismo archivo y el
 * mismo evento dan exactamente los mismos leads (y el mismo `lead_id`) por
 * cualquiera de los dos caminos:
 *  - el servidor (Contactos → Importar desde Excel, `src/server/contact-import/`),
 *  - el script de línea de comandos (`scripts/importar-leads.mjs`, vía
 *    `scripts/lib/importar-leads-core.mjs`).
 *
 * Es `.mjs` (con sus tipos en `core.d.mts`) porque el script corre con
 * `node` a secas: nada de alias `@/` ni de TypeScript aquí. Solo Node
 * (`node:crypto`): no importarlo desde el cliente.
 *
 * El WhatsApp NO se normaliza aquí: quien llama pasa su normalizador
 * (el servidor, `normalizeIntakePhone`; el script, su copia comentada).
 */

import { createHash } from "node:crypto";

/* ───────────────────────────── texto ───────────────────────────── */

/** trim, minúsculas, sin acentos, espacios colapsados. */
export function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Encabezado comparable: sin acentos, emojis, puntuación ni guiones bajos. */
export function normalizeHeader(s) {
  return normalizeText(s)
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Texto de una celda de exceljs. `cell.value` puede ser: string, number,
 * boolean, Date, null, `{ formula, result }`, `{ sharedFormula, result }`,
 * `{ text, hyperlink }`, `{ richText: [{ text }] }` o `{ error }`.
 */
export function cellText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") {
    // 5512345678 o 5215512345678: enteros grandes sin notación científica.
    return Number.isInteger(v) ? v.toFixed(0) : String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map((p) => p?.text ?? "").join("").trim();
    if ("text" in v && v.text !== undefined) return cellText(v.text);
    if ("result" in v) return cellText(v.result);
    if ("error" in v) return "";
  }
  return String(v).trim();
}

/** Dígitos de un enlace de WhatsApp (`wa.me/52…`, `api.whatsapp.com/send?phone=52…`). */
export function waLinkDigits(s) {
  const m = String(s ?? "").match(/wa\.me\/\+?(\d{8,15})|[?&]phone=\+?(\d{8,15})/i);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/**
 * El WhatsApp de una celda, tal cual (aún sin normalizar). Si la celda es un
 * enlace (`HYPERLINK("https://wa.me/52…","Enviar WhatsApp")` o un hipervínculo)
 * se toman los dígitos del enlace, no el texto que se ve.
 */
export function phoneFromCell(v) {
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const fromLink =
      waLinkDigits(v.formula) ??
      waLinkDigits(v.sharedFormula) ??
      waLinkDigits(v.hyperlink) ??
      waLinkDigits(cellText(v));
    if (fromLink) return fromLink;
  }
  const text = cellText(v);
  return waLinkDigits(text) ?? text;
}

/**
 * Por qué un WhatsApp no sirve, en códigos (el texto para personas lo pone
 * cada pantalla). Solo se llama cuando el normalizador ya dijo que no.
 *  - `phone_missing`: celda vacía;
 *  - `phone_not_number`: trae letras u otros símbolos (un correo, «no dio»);
 *  - `phone_short`: menos de 10 dígitos (`missing` = cuántos faltan);
 *  - `phone_not_mx`: dígitos de más o de otro país.
 */
export function phoneProblem(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { code: "phone_missing" };
  if (!/^[\d\s+\-().]+$/.test(s)) return { code: "phone_not_number" };
  const digits = s.replace(/\D/g, "");
  if (!digits) return { code: "phone_not_number" };
  if (digits.length < 10) return { code: "phone_short", missing: 10 - digits.length };
  return { code: "phone_not_mx" };
}

/* ───────────────────────────── encabezados ───────────────────────── */

export const FIELDS = ["name", "phone", "seller", "model", "notes", "email", "consent"];

const ALIASES = {
  name: ["nombre", "nombre completo", "nombre del cliente"],
  phone: ["whatsapp", "telefono", "celular", "numero", "numero de whatsapp", "numero de telefono"],
  seller: ["vendedor", "vendedora", "asesor", "asesora"],
  model: ["modelo", "modelo de interes", "auto", "vehiculo"],
  notes: ["comentarios", "comentario", "notas", "nota", "observaciones"],
  email: ["correo", "correo electronico", "email", "e mail"],
};

/** ¿A qué campo corresponde un encabezado? null = columna desconocida. */
export function classifyHeader(raw) {
  const h = normalizeHeader(raw);
  if (!h) return null;
  // Primero el consentimiento: «¿Aceptó que le escribamos por WhatsApp?»
  // menciona WhatsApp y no es el teléfono.
  if (/^(acept|autoriz|consent)/.test(h)) return "consent";
  for (const [field, aliases] of Object.entries(ALIASES)) {
    // «WhatsApp* (10 dígitos)» → «whatsapp 10 digitos»: alias + palabras extra.
    if (aliases.some((a) => h === a || h.startsWith(`${a} `))) return field;
  }
  return null;
}

/** Cuántas filas de arriba se miran buscando los encabezados. */
export const HEADER_SEARCH_ROWS = 5;

/**
 * La fila de encabezados: la primera (de las 5 primeras) con columna de
 * nombre y de teléfono. `rows` = arreglos de valores de celda (índice 0 =
 * columna A).
 *
 * @returns `{ index, columns: { campo: índice }, unknown: [texto] }` o null.
 */
export function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(HEADER_SEARCH_ROWS, rows.length); i++) {
    const row = rows[i] ?? [];
    const columns = {};
    const unknown = [];
    row.forEach((v, col) => {
      const text = cellText(v);
      if (!text) return;
      const field = classifyHeader(text);
      if (field && columns[field] === undefined) columns[field] = col;
      else unknown.push(text);
    });
    if (columns.name !== undefined && columns.phone !== undefined) {
      return { index: i, columns, unknown };
    }
  }
  return null;
}

/* ───────────────────────────── hoja ──────────────────────────────── */

/**
 * La hoja que se lee: la primera con datos (en la plantilla, «Leads»).
 * `workbook` es un `ExcelJS.Workbook` ya cargado.
 */
export function firstSheetWithData(workbook) {
  return workbook.worksheets.find((w) => w.actualRowCount > 0) ?? null;
}

/**
 * Filas de una hoja de exceljs como arreglos de valores de celda (índice 0 =
 * columna A); los huecos quedan como `[]`.
 */
export function worksheetRows(ws) {
  const rows = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    // row.values es 1-based (índice 0 vacío).
    const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
    rows[n - 1] = vals;
  });
  for (let i = 0; i < rows.length; i++) rows[i] ??= [];
  return rows;
}

/* ───────────────────────────── lead_id ───────────────────────────── */

/** Namespace fijo de 036 (no cambiar: cambiaría todos los lead_id). */
export const LEAD_ID_NAMESPACE = "8f2a6c1e-4b7d-4e3a-9c5f-0d1e2f3a4b5c";

/**
 * UUID v5 (RFC 4122, SHA-1) de `${evento normalizado}|${teléfono}`: el mismo
 * evento y teléfono dan siempre el mismo `lead_id`, así que re-importar el
 * archivo cae en «duplicado» en vez de crear otra tarjeta.
 */
export function leadIdFor(event, phone) {
  const ns = Buffer.from(LEAD_ID_NAMESPACE.replace(/-/g, ""), "hex");
  const bytes = createHash("sha1")
    .update(ns)
    .update(`${normalizeText(event)}|${phone}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // versión 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 4122
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * El cuerpo del lead (contrato de `POST /api/intake/lead`, origen `evento`)
 * para una fila ya validada. Lo arman igual el script y el servidor.
 */
export function leadPayload(fields, event, phone) {
  const { name, seller, model, notes, email, consent } = fields;
  return {
    lead_id: leadIdFor(event, phone),
    origin: "evento",
    first_name: name,
    phone,
    event: String(event).trim(),
    ...(seller ? { seller } : {}),
    ...(model ? { vehicle: model } : {}),
    ...(notes ? { notes } : {}),
    ...(email ? { email } : {}),
    ...(consent ? { whatsapp_consent: consent } : {}),
  };
}

/* ───────────────────────────── plan ──────────────────────────────── */

/**
 * De las filas del archivo a la lista de renglones. Cada renglón de datos
 * sale con su número de fila del archivo (1 = la primera) y un estado:
 * `ready` | `invalid` (con `problem`) | `repeated` (mismo WhatsApp que una
 * fila anterior, `repeatOf`: se queda la primera). Las filas vacías se
 * saltan. `normalizePhone(raw)` → `52`+10 o null.
 */
export function planImportRows(rows, header, normalizePhone) {
  const { index, columns } = header;
  const at = (row, field) => (columns[field] === undefined ? undefined : row[columns[field]]);
  const seen = new Map();
  const out = [];
  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const rowNumber = i + 1;
    const fields = {
      name: cellText(at(row, "name")).replace(/\s+/g, " "),
      rawPhone: phoneFromCell(at(row, "phone")),
      seller: cellText(at(row, "seller")).replace(/\s+/g, " "),
      model: cellText(at(row, "model")),
      notes: cellText(at(row, "notes")),
      email: cellText(at(row, "email")),
      consent: cellText(at(row, "consent")),
    };
    if (!Object.values(fields).some(Boolean)) continue;

    const base = { rowNumber, ...fields, phone: null, repeatOf: null, problem: null };
    if (!fields.name) {
      out.push({ ...base, status: "invalid", problem: { code: "name_missing" } });
      continue;
    }
    const phone = fields.rawPhone ? normalizePhone(fields.rawPhone) : null;
    if (!phone) {
      out.push({ ...base, status: "invalid", problem: phoneProblem(fields.rawPhone) });
      continue;
    }
    if (seen.has(phone)) {
      out.push({ ...base, phone, status: "repeated", repeatOf: seen.get(phone) });
      continue;
    }
    seen.set(phone, rowNumber);
    out.push({ ...base, phone, status: "ready" });
  }
  return out;
}

/* ───────────────────────────── CSV ───────────────────────────────── */

/** CSV simple (UTF-8 con o sin BOM; separador `,` o `;`; comillas dobles). */
export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
