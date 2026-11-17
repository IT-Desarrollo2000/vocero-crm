import {
  firstSheetWithData,
  parseCsv,
  worksheetRows,
  type CellValue,
} from "@/lib/contact-import/core.mjs";
import { IMPORT_MAX_BYTES, type PreviewErrorCode } from "@/lib/contact-import";

/**
 * 036 fase 2 — Del archivo subido a filas de celdas (sin tocar la BD).
 *
 * `.xlsx` (se lee la primera hoja con datos, como el script) o `.csv`
 * (UTF-8, `,` o `;`). El tipo lo decide la FIRMA del archivo, no solo la
 * extensión: un `.xlsx` es un zip (`PK\x03\x04`). exceljs se carga solo aquí
 * (import dinámico, paquete externo del servidor): nunca va al cliente.
 */

export type ReadResult =
  | { ok: true; rows: CellValue[][] }
  | { ok: false; code: PreviewErrorCode; message: string };

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function isZip(data: Uint8Array): boolean {
  return ZIP_MAGIC.every((b, i) => data[i] === b);
}

export async function readImportFile(data: Buffer, fileName: string): Promise<ReadResult> {
  if (data.byteLength > IMPORT_MAX_BYTES) {
    return {
      ok: false,
      code: "too_large",
      message: `El archivo pesa más de ${IMPORT_MAX_BYTES / (1024 * 1024)} MB. Quítale hojas o columnas que no sean de la lista.`,
    };
  }
  if (data.byteLength === 0) {
    return { ok: false, code: "empty", message: "El archivo está vacío." };
  }
  const lower = fileName.toLowerCase();
  const zip = isZip(data);

  if (lower.endsWith(".csv") && !zip) {
    const text = new TextDecoder("utf-8").decode(data);
    return { ok: true, rows: parseCsv(text) };
  }
  if (!zip || !(lower.endsWith(".xlsx") || lower.endsWith(".csv"))) {
    return {
      ok: false,
      code: "unsupported_type",
      message: lower.endsWith(".xls")
        ? "Es un Excel antiguo (.xls). Ábrelo en Excel y guárdalo como «Libro de Excel (.xlsx)»."
        : "Solo se leen archivos de Excel (.xlsx) o .csv.",
    };
  }

  try {
    const { default: ExcelJS } = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    // exceljs tipa `load` con el Buffer viejo de Node; el contenido es el mismo.
    await wb.xlsx.load(data as unknown as ArrayBuffer);
    const ws = firstSheetWithData(wb);
    if (!ws) return { ok: false, code: "empty", message: "El archivo no tiene datos." };
    return { ok: true, rows: worksheetRows(ws) };
  } catch (err) {
    console.warn(
      "[036] importar: no se pudo leer el .xlsx:",
      err instanceof Error ? err.message : "desconocido"
    );
    return {
      ok: false,
      code: "unreadable",
      message: "No se pudo leer el archivo. Ábrelo en Excel, guárdalo otra vez como .xlsx y vuelve a subirlo.",
    };
  }
}
