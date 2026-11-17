import type { DataValidation, Worksheet } from "exceljs";
import { IMPORT_MAX_ROWS, TEMPLATE_COLUMNS } from "@/lib/contact-import";

/**
 * 036 fase 2 — Los Excel que genera el importador: la plantilla para el
 * equipo y el resultado por renglón. exceljs se carga solo aquí (import
 * dinámico, paquete externo del servidor).
 *
 * La plantilla (Contactos → Importar desde Excel → «Descargar plantilla»):
 * - Hoja «Leads» (la primera: es la que se lee al importar) con las 7
 *   columnas en orden, encabezado congelado y con formato.
 * - WhatsApp en formato TEXTO (`@`) para que Excel no se coma ceros ni lo
 *   pase a notación científica, con validación de 10 caracteres.
 * - Vendedor: lista desplegable que apunta a la hoja «Equipo» (los nombres
 *   del equipo de hoy). Por rango y no en línea: la lista en línea topa en
 *   255 caracteres. Aviso (no bloqueo) si escriben otro nombre: ese chat
 *   quedará en el Buzón.
 * - ¿Aceptó…?: lista Sí/No.
 * - Hoja «Instrucciones» en palabras simples.
 */

/** Renglones con formato y validaciones (el tope de la importación). */
export const TEMPLATE_ROWS = IMPORT_MAX_ROWS;

/**
 * Validación sobre un RANGO (una sola regla en el archivo). exceljs lo
 * soporta (`worksheet.dataValidations.add`) pero sus tipos no lo declaran.
 */
function validate(ws: Worksheet, range: string, rule: DataValidation): void {
  (ws as unknown as { dataValidations: { add(address: string, v: DataValidation): void } }).dataValidations.add(
    range,
    rule
  );
}

const WIDTHS = [30, 16, 22, 24, 40, 28, 22];

export const TEMPLATE_INSTRUCTIONS = [
  "Cómo llenar la lista",
  "",
  "1. Un renglón por persona, en la hoja «Leads». No cambies los encabezados.",
  "2. Nombre y WhatsApp son obligatorios.",
  "3. WhatsApp: los 10 dígitos, sin espacios ni guiones (ej. 5512345678). No hace falta el 52.",
  "4. Vendedor: elígelo de la lista. Si escribes otro nombre, ese chat queda en el Buzón sin asignar.",
  "5. ¿Aceptó que le escribamos por WhatsApp?: elige Sí o No.",
  "",
  "Importante",
  "• Al importar NO se le manda ningún mensaje al cliente. Cada vendedor le escribe después con una plantilla.",
  "• Usa siempre el mismo nombre de evento al subir la lista: si la subes otra vez (por ejemplo, con más renglones), lo que ya entró no se duplica.",
  "• Se lee solo la primera hoja.",
];

export async function buildTemplate(memberNames: readonly string[]): Promise<Buffer> {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = "Vocero CRM";

  const leads = wb.addWorksheet("Leads", { views: [{ state: "frozen", ySplit: 1 }] });
  const header = leads.getRow(1);
  TEMPLATE_COLUMNS.forEach((title, i) => {
    const cell = header.getCell(i + 1);
    cell.value = title;
    cell.font = { bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F0EE" } };
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "thin", color: { argb: "FFC9CBD1" } } };
    leads.getColumn(i + 1).width = WIDTHS[i] ?? 20;
  });
  header.height = 32;

  const last = TEMPLATE_ROWS + 1;
  // Formato texto en cada celda (a nivel columna no siempre sobrevive).
  for (let r = 2; r <= last; r++) leads.getCell(r, 2).numFmt = "@";

  validate(leads, `B2:B${last}`, {
    type: "textLength",
    operator: "equal",
    formulae: [10],
    allowBlank: true,
    showErrorMessage: true,
    errorStyle: "stop",
    errorTitle: "WhatsApp de 10 dígitos",
    error: "Escribe los 10 dígitos del WhatsApp, sin espacios ni guiones (ej. 5512345678).",
  });

  const names = [...new Set(memberNames.map((n) => n.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "es")
  );
  if (names.length > 0) {
    validate(leads, `C2:C${last}`, {
      type: "list",
      formulae: [`Equipo!$A$2:$A$${names.length + 1}`],
      allowBlank: true,
      showErrorMessage: true,
      errorStyle: "warning",
      errorTitle: "Ese nombre no está en el equipo",
      error: "Si lo dejas así, ese chat quedará en el Buzón sin asignar. Elige un nombre de la lista.",
    });
  }

  validate(leads, `G2:G${last}`, {
    type: "list",
    formulae: ['"Sí,No"'],
    allowBlank: true,
    showErrorMessage: true,
    errorStyle: "stop",
    errorTitle: "Sí o No",
    error: "Elige Sí o No.",
  });

  const instr = wb.addWorksheet("Instrucciones");
  instr.getColumn(1).width = 110;
  TEMPLATE_INSTRUCTIONS.forEach((line, i) => {
    const cell = instr.getCell(i + 1, 1);
    cell.value = line;
    cell.alignment = { wrapText: true, vertical: "top" };
    if (i === 0 || line === "Importante") cell.font = { bold: true, size: i === 0 ? 14 : 12 };
  });

  const team = wb.addWorksheet("Equipo");
  team.getColumn(1).width = 34;
  team.getCell(1, 1).value = "Equipo (la lista de la columna Vendedor)";
  team.getCell(1, 1).font = { bold: true };
  names.forEach((n, i) => {
    team.getCell(i + 2, 1).value = n;
  });

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/** El resultado por renglón (Contactos → Importar → «Descargar el resultado»). */
export async function buildResultSheet(
  rows: readonly {
    rowNumber: number;
    name: string;
    phone: string;
    seller: string;
    result: string;
    assignment: string;
  }[]
): Promise<Buffer> {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = "Vocero CRM";
  const ws = wb.addWorksheet("Resultado", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Renglón", key: "rowNumber", width: 10 },
    { header: "Nombre", key: "name", width: 30 },
    { header: "WhatsApp", key: "phone", width: 18, style: { numFmt: "@" } },
    { header: "Vendedor", key: "seller", width: 22 },
    { header: "Resultado", key: "result", width: 42 },
    { header: "Asignación", key: "assignment", width: 32 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F0EE" } };
  for (const r of [...rows].sort((a, b) => a.rowNumber - b.rowNumber)) ws.addRow(r);
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
