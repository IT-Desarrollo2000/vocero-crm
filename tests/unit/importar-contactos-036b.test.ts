import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cellText,
  classifyHeader,
  findHeaderRow,
  leadIdFor,
  leadPayload,
  parseCsv,
  phoneFromCell,
  phoneProblem,
  planImportRows,
} from "@/lib/contact-import/core.mjs";
import {
  IMPORT_BATCH_MAX,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  importBatchSchema,
  previewRowText,
  problemText,
  resultFileName,
  TEMPLATE_COLUMNS,
  type PreviewRow,
} from "@/lib/contact-import";
import { normalizeIntakePhone } from "@/server/intake/phone";
import { buildPreview } from "@/server/contact-import/preview";
import { readImportFile } from "@/server/contact-import/read";
import { buildResultSheet, buildTemplate, TEMPLATE_ROWS } from "@/server/contact-import/sheets";
import { planRows } from "../../scripts/lib/importar-leads-core.mjs";

/**
 * 036 fase 2 — Importar desde la app (Contactos → Importar desde Excel): el
 * lector ÚNICO (`src/lib/contact-import/core.mjs`, compartido con el script),
 * la vista previa (pura), la plantilla y el resultado (re-leídos con
 * exceljs), los contratos y que un lote siga el MISMO camino que el script.
 * El recorrido contra la app: scripts/e2e-importar-contactos.mjs.
 */

const ingest = vi.hoisted(() => ({
  calls: [] as { lead: Record<string, unknown>; phone: string }[],
  fail: new Set<string>(),
}));

vi.mock("@/server/intake/ingest", () => ({
  ingestExternalLead: async (_org: string, lead: Record<string, unknown>, phone: string) => {
    ingest.calls.push({ lead, phone });
    if (ingest.fail.has(phone)) throw new Error("caído");
    return {
      contactId: `ct_${phone}`,
      conversationId: `cv_${phone}`,
      created: phone.endsWith("1"),
      duplicate: phone.endsWith("9"),
      ...(lead.seller ? { assignment: lead.seller === "Mariana" ? "asignado" : "vendedor_no_encontrado" } : {}),
    };
  },
}));

vi.mock("@/lib/db", async () => {
  const schema = await vi.importActual<typeof import("@/lib/db/schema")>("@/lib/db/schema");
  return {
    schema,
    // La consulta de con quién quedó cada chat: aquí, ninguno asignado.
    getDb: () => ({
      select: () => ({ from: () => ({ where: async () => [] }) }),
    }),
  };
});

const { importRows } = await import("@/server/contact-import/run");

/* ───────────────────────────── lector ─────────────────────────────── */

describe("lector único — encabezados y celdas", () => {
  it.each([
    ["Nombre", "name"],
    ["NOMBRE COMPLETO", "name"],
    ["Teléfono", "phone"],
    ["📱 Celular", "phone"],
    ["WhatsApp (10 dígitos)", "phone"],
    ["Asesora", "seller"],
    ["Modelo de interés", "model"],
    ["Notas", "notes"],
    ["E-mail", "email"],
    ["¿Aceptó que le escribamos por WhatsApp?", "consent"],
    ["Autoriza contacto", "consent"],
    ["Fecha", null],
  ])("classifyHeader(%j) = %j", (raw, field) => {
    expect(classifyHeader(raw)).toBe(field);
  });

  it("las columnas de la plantilla se reconocen todas, en orden", () => {
    const h = findHeaderRow([[...TEMPLATE_COLUMNS]]);
    expect(h?.columns).toEqual({ name: 0, phone: 1, seller: 2, model: 3, notes: 4, email: 5, consent: 6 });
    expect(h?.unknown).toEqual([]);
  });

  it("celdas de exceljs: número grande, fórmula, texto enriquecido, enlace, fecha", () => {
    expect(cellText(5512345678)).toBe("5512345678");
    expect(cellText({ formula: "A1", result: 5587654321 })).toBe("5587654321");
    expect(cellText({ richText: [{ text: "Ana " }, { text: "López" }] })).toBe("Ana López");
    expect(cellText({ text: "Enviar", hyperlink: "https://wa.me/525511112222" })).toBe("Enviar");
    expect(cellText(new Date("2026-11-01T00:00:00Z"))).toBe("2026-11-01");
    expect(cellText({ error: "#N/A" })).toBe("");
  });

  it("WhatsApp desde HYPERLINK (fórmula) o hipervínculo: los dígitos del enlace", () => {
    expect(phoneFromCell({ formula: 'HYPERLINK("https://wa.me/5215512345678","Enviar WhatsApp")', result: "Enviar WhatsApp" })).toBe(
      "5215512345678"
    );
    expect(phoneFromCell({ text: "Enviar", hyperlink: "https://api.whatsapp.com/send?phone=525598765432" })).toBe(
      "525598765432"
    );
    expect(phoneFromCell("55 1234 5678")).toBe("55 1234 5678");
  });

  it("CSV con BOM y punto y coma", () => {
    expect(parseCsv('﻿Nombre;WhatsApp\n"López; Ana";5512345678\r\n')).toEqual([
      ["Nombre", "WhatsApp"],
      ["López; Ana", "5512345678"],
    ]);
  });

  it.each([
    ["", { code: "phone_missing" }],
    ["sofia.cruz@correo", { code: "phone_not_number" }],
    ["55 1234 567", { code: "phone_short", missing: 1 }],
    ["5512", { code: "phone_short", missing: 6 }],
    ["1 305 555 0102", { code: "phone_not_mx" }],
  ])("phoneProblem(%j)", (raw, problem) => {
    expect(phoneProblem(raw)).toEqual(problem);
  });

  it("textos para personas", () => {
    expect(problemText({ code: "phone_short", missing: 1 }, null)).toBe("Le falta un dígito (deben ser 10)");
    expect(problemText({ code: "phone_short", missing: 2 }, null)).toBe("Le faltan 2 dígitos (deben ser 10)");
    expect(problemText({ code: "phone_not_mx" }, null)).toBe("No es un número de México de 10 dígitos");
    expect(problemText({ code: "phone_not_number" }, null)).toBe("El WhatsApp no es un número");
    expect(problemText({ code: "phone_missing" }, null)).toBe("Falta el WhatsApp");
    expect(problemText({ code: "name_missing" }, null)).toBe("Falta el nombre");
    expect(problemText(null, 4)).toBe("Repetido del renglón 4");
  });

  it("el plan del script y el de la app son el mismo (mismo lead_id y cuerpo)", () => {
    const rows = [
      ["Nombre", "WhatsApp", "Vendedor", "Modelo", "Notas", "Correo", "Autoriza"],
      ["Ana López", "55 1234 5678", "Mariana", "Dolphin", "Sábado", "ana@x.mx", "sí"],
      ["Luis", 5587654321, "", "", "", "", ""],
      ["Repe", "+52 1 55 1234 5678", "", "", "", "", ""],
    ];
    const header = findHeaderRow(rows)!;
    const cli = planRows(rows, header, "Expo Autos ");
    const app = planImportRows(rows, header, normalizeIntakePhone);
    expect(app.map((r) => r.status)).toEqual(["ready", "ready", "repeated"]);
    for (const [i, r] of app.entries()) {
      if (r.status !== "ready") continue;
      expect(leadPayload(r, "Expo Autos ", r.phone!)).toEqual(cli[i]?.payload);
    }
    expect(cli[0]?.payload?.lead_id).toBe(leadIdFor("expo autos", "525512345678"));
  });
});

/* ───────────────────────────── vista previa ───────────────────────── */

describe("vista previa (pura)", () => {
  const members = [
    { userId: "u1", name: "Mariana López" },
    { userId: "u2", name: "Jorge Ruiz" },
    { userId: "u3", name: "Ana Torres" },
    { userId: "u4", name: "Ana Pérez" },
  ];
  const rows = [
    ["Lista de la expo"],
    ["Nombre", "WhatsApp", "Vendedor", "Columna rara"],
    ["Laura", "5512340001", "Mariana", "x"],
    ["Ricardo", "5512340002", "mariana lopez", ""],
    ["Pedro", "5512340003", "Jorge Ruiz", ""],
    ["Sofía", "5512340004", "Lupita", ""],
    ["Elena", "5512340005", "Ana", ""],
    ["Tomás", "5512340006", "", ""],
    ["Héctor", "55 1234 567", "Jorge Ruiz", ""],
    ["", "5512340008", "Mariana", ""],
    ["Laura bis", "55 1234 0001", "Mariana", ""],
    [],
  ];
  const r = buildPreview({
    fileName: "lista.xlsx",
    rows,
    members,
    existing: new Set(["525512340003"]),
  });

  it("cuenta listos, ya existentes, con problema y repetidos", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.totalRows).toBe(9);
    expect(r.preview.summary).toEqual({ ready: 6, existing: 1, invalid: 2, repeated: 1 });
    expect(r.preview.columns).toEqual({ recognized: ["Nombre", "WhatsApp", "Vendedor"], ignored: ["Columna rara"] });
  });

  it("una línea por vendedor (normalizado): con nombre, nadie, ambiguo; y sin vendedor", () => {
    if (!r.ok) return;
    expect(r.preview.sellers).toEqual([
      // Una línea por TEXTO distinto (normalizado): «Mariana» y «mariana lopez»
      // son dos líneas, las dos hacia la misma persona.
      { text: "Jorge Ruiz", kind: "match", memberName: "Jorge Ruiz", count: 1 },
      { text: "Mariana", kind: "match", memberName: "Mariana López", count: 1 },
      { text: "mariana lopez", kind: "match", memberName: "Mariana López", count: 1 },
      { text: "Ana", kind: "ambiguous", memberName: null, count: 1 },
      { text: "Lupita", kind: "none", memberName: null, count: 1 },
    ]);
    expect(r.preview.noSeller).toBe(1);
  });

  it("los motivos por renglón (número de fila del archivo)", () => {
    if (!r.ok) return;
    const byRow = new Map(r.preview.rows.map((x: PreviewRow) => [x.rowNumber, previewRowText(x)]));
    expect(byRow.get(5)).toBe("Ya está en tus contactos: se le agrega la tarjeta");
    expect(byRow.get(3)).toBe("Contacto nuevo");
    expect(byRow.get(9)).toBe("Le falta un dígito (deben ser 10)");
    expect(byRow.get(10)).toBe("Falta el nombre");
    expect(byRow.get(11)).toBe("Repetido del renglón 3");
  });

  it("sin columnas de nombre y WhatsApp: dice cuáles necesita", () => {
    const bad = buildPreview({ fileName: "x.csv", rows: [["Cliente", "Tel"]], members, existing: new Set() });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe("no_header");
    expect(bad.message).toContain("«Nombre» y «WhatsApp»");
  });

  it("solo encabezados → vacío; más de 2,000 renglones → too_many_rows", () => {
    const empty = buildPreview({ fileName: "x.csv", rows: [["Nombre", "WhatsApp"], [], []], members, existing: new Set() });
    expect(!empty.ok && empty.code).toBe("empty");
    const many = [["Nombre", "WhatsApp"], ...Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => [`P${i}`, `55${String(i).padStart(8, "0")}`])];
    const big = buildPreview({ fileName: "x.csv", rows: many, members, existing: new Set() });
    expect(!big.ok && big.code).toBe("too_many_rows");
  });
});

/* ───────────────────────────── archivo ────────────────────────────── */

describe("lectura del archivo", () => {
  it("CSV por extensión (UTF-8)", async () => {
    const r = await readImportFile(Buffer.from("Nombre,WhatsApp\nAna,5512345678\n", "utf8"), "lista.csv");
    expect(r).toEqual({ ok: true, rows: [["Nombre", "WhatsApp"], ["Ana", "5512345678"]] });
  });

  it(".xls, PDF o zip roto: mensaje claro, sin reventar", async () => {
    const xls = await readImportFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), "viejo.xls");
    expect(!xls.ok && xls.code).toBe("unsupported_type");
    const pdf = await readImportFile(Buffer.from("%PDF-1.4"), "lista.xlsx");
    expect(!pdf.ok && pdf.code).toBe("unsupported_type");
    const broken = await readImportFile(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), "lista.xlsx");
    expect(!broken.ok && broken.code).toBe("unreadable");
  });

  it("más de 5 MB → too_large", async () => {
    const r = await readImportFile(Buffer.alloc(IMPORT_MAX_BYTES + 1), "lista.csv");
    expect(!r.ok && r.code).toBe("too_large");
  });

  it(".xlsx: lee la primera hoja con datos (incluye HYPERLINK)", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Vacía");
    const ws = wb.addWorksheet("Leads");
    ws.addRow(["Nombre", "WhatsApp"]);
    ws.addRow(["Ana", { formula: 'HYPERLINK("https://wa.me/525511112222","Enviar")', result: "Enviar" }]);
    const data = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await readImportFile(data, "lista.xlsx");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const header = findHeaderRow(r.rows)!;
    expect(planImportRows(r.rows, header, normalizeIntakePhone)[0]?.phone).toBe("525511112222");
  });
});

/* ───────────────────────────── plantilla ──────────────────────────── */

describe("plantilla (re-leída con exceljs)", () => {
  const team = ["Mariana López", "Jorge Ruiz", "Ana Torres", "Mariana López", " "];

  async function load(buf: Buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    return wb;
  }

  it("hojas, encabezados, formato texto y validaciones", async () => {
    const wb = await load(await buildTemplate(team));
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Leads", "Instrucciones", "Equipo"]);
    const leads = wb.getWorksheet("Leads")!;
    expect((leads.getRow(1).values as unknown[]).slice(1)).toEqual([...TEMPLATE_COLUMNS]);
    expect(leads.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(leads.getCell("B2").numFmt).toBe("@");
    expect(leads.getCell(`B${TEMPLATE_ROWS + 1}`).numFmt).toBe("@");

    const dv = (leads as unknown as { dataValidations: { model: Record<string, Record<string, unknown>> } }).dataValidations
      .model;
    expect(dv.B2).toMatchObject({ type: "textLength", operator: "equal", formulae: [10] });
    expect(dv[`B${TEMPLATE_ROWS + 1}`]).toMatchObject({ type: "textLength" });
    expect(String(dv.B2?.error)).toContain("10 dígitos");
    expect(dv.C2).toMatchObject({ type: "list", formulae: ["Equipo!$A$2:$A$4"] });
    expect(dv.G2).toMatchObject({ type: "list", formulae: ['"Sí,No"'] });

    const equipo = wb.getWorksheet("Equipo")!;
    const names = [2, 3, 4, 5].map((r) => equipo.getCell(r, 1).value ?? null);
    expect(names).toEqual(["Ana Torres", "Jorge Ruiz", "Mariana López", null]);

    const instr = wb.getWorksheet("Instrucciones")!;
    const text = Array.from({ length: instr.rowCount }, (_, i) => String(instr.getCell(i + 1, 1).value ?? "")).join("\n");
    expect(text).toContain("Un renglón por persona");
    expect(text).toContain("NO se le manda ningún mensaje");
    expect(text).toContain("mismo nombre de evento");
  });

  it("la plantilla vacía se lee sin renglones (los 2,000 con formato no cuentan)", async () => {
    const buf = await buildTemplate(team);
    const r = await readImportFile(buf, "plantilla-importar-contactos.xlsx");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = buildPreview({ fileName: "p.xlsx", rows: r.rows, members: [], existing: new Set() });
    expect(!p.ok && p.code).toBe("empty");
  });

  it("resultado por renglón", async () => {
    const wb = await load(
      await buildResultSheet([
        { rowNumber: 3, name: "B", phone: "5512340002", seller: "", result: "Contacto nuevo", assignment: "Buzón, sin asignar" },
        { rowNumber: 2, name: "A", phone: "5512340001", seller: "Mariana", result: "Contacto nuevo", assignment: "Asignado a Mariana López" },
      ])
    );
    const ws = wb.getWorksheet("Resultado")!;
    expect((ws.getRow(1).values as unknown[]).slice(1)).toEqual(["Renglón", "Nombre", "WhatsApp", "Vendedor", "Resultado", "Asignación"]);
    expect((ws.getRow(2).values as unknown[]).slice(1)).toEqual([2, "A", "5512340001", "Mariana", "Contacto nuevo", "Asignado a Mariana López"]);
    expect(resultFileName("Expo Autos Mérida 2026")).toBe("resultado-expo-autos-merida-2026.xlsx");
  });
});

/* ───────────────────────────── importar ───────────────────────────── */

describe("contrato del lote", () => {
  const row = { rowNumber: 2, name: "Ana", phone: "5512345678" };

  it("evento obligatorio, hasta 120; hasta 100 renglones", () => {
    expect(importBatchSchema.safeParse({ event: "Expo", rows: [row] }).success).toBe(true);
    expect(importBatchSchema.safeParse({ event: "  ", rows: [row] }).success).toBe(false);
    expect(importBatchSchema.safeParse({ event: "x".repeat(121), rows: [row] }).success).toBe(false);
    expect(importBatchSchema.safeParse({ event: "Expo", rows: [] }).success).toBe(false);
    const many = Array.from({ length: IMPORT_BATCH_MAX + 1 }, (_, i) => ({ ...row, rowNumber: i + 2 }));
    expect(importBatchSchema.safeParse({ event: "Expo", rows: many }).success).toBe(false);
  });
});

describe("importRows — el mismo camino que el script", () => {
  beforeEach(() => {
    ingest.calls = [];
    ingest.fail.clear();
  });

  it("mismo lead_id y cuerpo que el script; resultado por renglón; un fallo no tumba el lote", async () => {
    ingest.fail.add("525512340003");
    const results = await importRows("org_1", "Expo Autos", [
      { rowNumber: 2, name: "Ana", phone: "55 1234 0001", seller: "Mariana", model: "Dolphin", notes: "", email: "", consent: "sí" },
      { rowNumber: 3, name: "Beto", phone: "5512340002", seller: "Lupita", model: "", notes: "", email: "", consent: "" },
      { rowNumber: 4, name: "Caro", phone: "5512340009", seller: "", model: "", notes: "", email: "", consent: "" },
      { rowNumber: 5, name: "Dani", phone: "5512340003", seller: "", model: "", notes: "", email: "", consent: "" },
      { rowNumber: 6, name: "Repe", phone: "+52 55 1234 0001", seller: "", model: "", notes: "", email: "", consent: "" },
      { rowNumber: 7, name: "Malo", phone: "12345", seller: "", model: "", notes: "", email: "", consent: "" },
    ]);

    expect(results).toEqual([
      { rowNumber: 2, outcome: "created", assignee: "seller" },
      { rowNumber: 3, outcome: "existing", assignee: null },
      { rowNumber: 4, outcome: "duplicate", assignee: null },
      { rowNumber: 5, outcome: "error", assignee: null },
      { rowNumber: 6, outcome: "error", assignee: null },
      { rowNumber: 7, outcome: "error", assignee: null },
    ]);
    const first = ingest.calls[0]!;
    expect(first.phone).toBe("525512340001");
    expect(first.lead).toMatchObject({
      lead_id: leadIdFor("Expo Autos", "525512340001"),
      origin: "evento",
      first_name: "Ana",
      event: "Expo Autos",
      seller: "Mariana",
      vehicle: "Dolphin",
      whatsapp_consent: "Sí",
    });
    // El script manda exactamente el mismo cuerpo para ese renglón.
    const cli = planRows(
      [
        ["Nombre", "WhatsApp", "Vendedor", "Modelo", "Autoriza"],
        ["Ana", "55 1234 0001", "Mariana", "Dolphin", "sí"],
      ],
      findHeaderRow([["Nombre", "WhatsApp", "Vendedor", "Modelo", "Autoriza"]])!,
      "Expo Autos"
    );
    expect(cli[0]?.payload?.lead_id).toBe(first.lead.lead_id);
  });
});
