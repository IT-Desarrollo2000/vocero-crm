/**
 * 036 — Tipos de `core.mjs` (la lectura pura de la lista del evento). Ver el
 * comentario de cabecera de `core.mjs`.
 */

/** Valor de celda tal como lo da exceljs (o el texto de una celda de CSV). */
export type CellValue = unknown;
export type SheetRow = readonly CellValue[];

export type ImportField = "name" | "phone" | "seller" | "model" | "notes" | "email" | "consent";

export type HeaderRow = {
  /** Índice (0 = primera fila) de la fila de encabezados. */
  index: number;
  columns: Partial<Record<ImportField, number>>;
  /** Encabezados que no se reconocieron (columnas que se ignoran). */
  unknown: string[];
};

export type PhoneProblem =
  | { code: "phone_missing" }
  | { code: "phone_not_number" }
  | { code: "phone_short"; missing: number }
  | { code: "phone_not_mx" };

export type RowProblem = { code: "name_missing" } | PhoneProblem;

export type RowFields = {
  name: string;
  /** El WhatsApp tal como venía (o los dígitos del enlace wa.me). */
  rawPhone: string;
  seller: string;
  model: string;
  notes: string;
  email: string;
  consent: string;
};

export type PlannedRow = RowFields & {
  /** Número de fila del archivo (1 = la primera). */
  rowNumber: number;
  status: "ready" | "invalid" | "repeated";
  /** `52` + 10 dígitos (listo o repetido); null si no sirve. */
  phone: string | null;
  /** Repetido: la fila que sí se importa. */
  repeatOf: number | null;
  problem: RowProblem | null;
};

export type LeadPayload = {
  lead_id: string;
  origin: "evento";
  first_name: string;
  phone: string;
  event: string;
  seller?: string;
  vehicle?: string;
  notes?: string;
  email?: string;
  whatsapp_consent?: string;
};

/** Lo mínimo de un `ExcelJS.Worksheet` que se usa (sin depender de exceljs). */
export type WorksheetLike = {
  actualRowCount: number;
  eachRow(
    opts: { includeEmpty: boolean },
    cb: (row: { values: unknown }, rowNumber: number) => void
  ): void;
};

export function normalizeText(s: unknown): string;
export function normalizeHeader(s: unknown): string;
export function cellText(v: CellValue): string;
export function waLinkDigits(s: unknown): string | null;
export function phoneFromCell(v: CellValue): string;
export function phoneProblem(raw: unknown): PhoneProblem;

export const FIELDS: readonly ImportField[];
export function classifyHeader(raw: unknown): ImportField | null;
export const HEADER_SEARCH_ROWS: number;
export function findHeaderRow(rows: readonly SheetRow[]): HeaderRow | null;

export function firstSheetWithData<W extends { actualRowCount: number }>(workbook: {
  worksheets: W[];
}): W | null;
export function worksheetRows(ws: WorksheetLike): CellValue[][];

export const LEAD_ID_NAMESPACE: string;
export function leadIdFor(event: string, phone: string): string;
export function leadPayload(
  fields: Pick<RowFields, "name" | "seller" | "model" | "notes" | "email" | "consent">,
  event: string,
  phone: string
): LeadPayload;

export function planImportRows(
  rows: readonly SheetRow[],
  header: HeaderRow,
  normalizePhone: (raw: string) => string | null
): PlannedRow[];

export function parseCsv(text: string): string[][];
