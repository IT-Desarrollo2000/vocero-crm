import { z } from "zod";
import type { RowProblem } from "@/lib/contact-import/core.mjs";

/**
 * 036 fase 2 — Importar contactos desde Excel (Contactos → Importar desde
 * Excel, solo Propietario). Contratos, límites y textos para personas que
 * comparten la pantalla y el servidor. Sin dependencias de servidor: la
 * lectura del archivo vive en `src/lib/contact-import/core.mjs` (solo
 * servidor y script) y en `src/server/contact-import/`.
 */

export type { RowProblem } from "@/lib/contact-import/core.mjs";

/** Tope del archivo (antes de leerlo). */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
/** Tope de renglones de datos (sin contar vacíos ni encabezados). */
export const IMPORT_MAX_ROWS = 2000;
/** Renglones por petición que manda la pantalla (de uno en uno, en orden). */
export const IMPORT_BATCH_SIZE = 50;
/** Tope de renglones por petición que acepta el servidor. */
export const IMPORT_BATCH_MAX = 100;
/** Nombre del evento: el contrato del lead lo recorta a 120 (`event`). */
export const IMPORT_EVENT_MAX = 120;
/** Lo que acepta el selector de archivo. */
export const IMPORT_ACCEPT = ".xlsx,.csv";

/** Columnas de la plantilla, en orden (también son las que se reconocen). */
export const TEMPLATE_COLUMNS = [
  "Nombre",
  "WhatsApp",
  "Vendedor",
  "Modelo de interés",
  "Comentarios",
  "Correo",
  "¿Aceptó que le escribamos por WhatsApp?",
] as const;

/** Nombre visible de cada campo reconocido (en el orden de la plantilla). */
export const FIELD_LABEL = {
  name: "Nombre",
  phone: "WhatsApp",
  seller: "Vendedor",
  model: "Modelo de interés",
  notes: "Comentarios",
  email: "Correo",
  consent: "¿Aceptó que le escribamos por WhatsApp?",
} as const;

/* ───────────────────────────── vista previa ───────────────────────── */

export type PreviewRow = {
  rowNumber: number;
  name: string;
  /** El WhatsApp como venía en el archivo (para que la persona lo reconozca). */
  rawPhone: string;
  /** `52` + 10 (listo o repetido). */
  phone: string | null;
  seller: string;
  model: string;
  notes: string;
  email: string;
  consent: string;
  status: "ready" | "invalid" | "repeated";
  problem: RowProblem | null;
  repeatOf: number | null;
  /** Listo y ya está en los contactos (se le agrega la tarjeta). */
  existing: boolean;
};

/** Una línea de «A quién se le asigna cada chat» (solo renglones listos). */
export type SellerLine = {
  /** El texto como lo escribieron (el primero que apareció). */
  text: string;
  kind: "match" | "none" | "ambiguous";
  /** Nombre en el equipo (solo `match`). */
  memberName: string | null;
  count: number;
};

export type ImportPreviewDto = {
  fileName: string;
  /** Renglones de datos con algo escrito. */
  totalRows: number;
  /** Encabezados reconocidos (nombres de la plantilla) e ignorados (tal cual). */
  columns: { recognized: string[]; ignored: string[] };
  rows: PreviewRow[];
  summary: { ready: number; existing: number; invalid: number; repeated: number };
  sellers: SellerLine[];
  /** Renglones listos sin vendedor anotado. */
  noSeller: number;
};

/** Errores de la vista previa que la pantalla explica (código → texto del servidor). */
export type PreviewErrorCode =
  | "too_large"
  | "unsupported_type"
  | "unreadable"
  | "empty"
  | "no_header"
  | "too_many_rows";

/* ───────────────────────────── importar ───────────────────────────── */

const text = (max: number) => z.string().trim().max(max).optional().default("");

export const importEventSchema = z
  .string()
  .trim()
  .min(1, "Falta el nombre del evento")
  .max(IMPORT_EVENT_MAX, `El nombre del evento es de hasta ${IMPORT_EVENT_MAX} letras`);

export const importRowSchema = z.object({
  rowNumber: z.number().int().min(1).max(1_000_000),
  name: z.string().trim().min(1).max(500),
  // Se vuelve a normalizar en el servidor (lo que diga la pantalla no manda).
  phone: z.string().trim().min(1).max(40),
  seller: text(500),
  model: text(500),
  notes: text(2000),
  email: text(500),
  consent: text(100),
});
export type ImportRowInput = z.input<typeof importRowSchema>;
export type ImportRow = z.output<typeof importRowSchema>;

export const importBatchSchema = z.object({
  event: importEventSchema,
  rows: z.array(importRowSchema).min(1).max(IMPORT_BATCH_MAX),
});

/** Lo que pasó con cada renglón importado. */
export type ImportOutcome =
  /** Contacto nuevo. */
  | "created"
  /** El contacto ya existía: se le agregó la tarjeta del evento. */
  | "existing"
  /** Ya se había importado con este mismo evento: nada nuevo. */
  | "duplicate"
  /** Falló; reintentar es seguro. */
  | "error";

export type ImportRowResult = {
  rowNumber: number;
  outcome: ImportOutcome;
  /**
   * Con quién quedó el chat: `seller` = con el vendedor del Excel; `other` =
   * ya tenía a otra persona (no se le quita); null = en el Buzón, sin asignar.
   */
  assignee: "seller" | "other" | null;
};

export type ImportBatchDto = { results: ImportRowResult[] };

/* ───────────────────────────── resultado ──────────────────────────── */

export const resultSheetSchema = z.object({
  event: importEventSchema,
  rows: z
    .array(
      z.object({
        rowNumber: z.number().int().min(1).max(1_000_000),
        name: z.string().max(500),
        phone: z.string().max(60),
        seller: z.string().max(500),
        result: z.string().max(300),
        assignment: z.string().max(300),
      })
    )
    .max(IMPORT_MAX_ROWS),
});
export type ResultSheetInput = z.input<typeof resultSheetSchema>;

/* ───────────────────────────── textos ─────────────────────────────── */

/** «Qué pasa» de un renglón que no se importa. */
export function problemText(problem: RowProblem | null, repeatOf: number | null): string {
  if (repeatOf !== null) return `Repetido del renglón ${repeatOf}`;
  switch (problem?.code) {
    case "name_missing":
      return "Falta el nombre";
    case "phone_missing":
      return "Falta el WhatsApp";
    case "phone_not_number":
      return "El WhatsApp no es un número";
    case "phone_short":
      return problem.missing === 1
        ? "Le falta un dígito (deben ser 10)"
        : `Le faltan ${problem.missing} dígitos (deben ser 10)`;
    case "phone_not_mx":
      return "No es un número de México de 10 dígitos";
    default:
      return "";
  }
}

/** «Qué pasa» de cualquier renglón de la vista previa. */
export function previewRowText(row: PreviewRow): string {
  if (row.status === "ready") {
    return row.existing ? "Ya está en tus contactos: se le agrega la tarjeta" : "Contacto nuevo";
  }
  return problemText(row.problem, row.repeatOf);
}

export const OUTCOME_TEXT: Record<ImportOutcome, string> = {
  created: "Contacto nuevo",
  existing: "Ya estaba: tarjeta nueva",
  duplicate: "Ya se había importado con este evento",
  error: "No se pudo importar",
};

/** «1 chat» / «12 chats». */
export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("es-MX")} ${n === 1 ? one : many}`;
}

/** Nombre del archivo de resultado. */
export function resultFileName(event: string): string {
  const slug = event
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `resultado-${slug || "importacion"}.xlsx`;
}

export const TEMPLATE_FILE_NAME = "plantilla-importar-contactos.xlsx";
