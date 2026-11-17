import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: () => ({}), schema: {} }));

import {
  LEAD_INTAKE_HEADER,
  leadCardForAgent,
  parseLeadCard,
} from "@/lib/lead-intake";
import { SOURCE_LABELS, SOURCE_VALUES } from "@/server/contact-source";
import {
  buildLeadCardText,
  intakeLeadSchema,
  parseConsent,
} from "@/server/intake/contract";
import {
  matchSeller,
  normalizePersonName,
  type SellerMember,
} from "@/server/intake/seller-match";
import {
  cellText,
  classifyHeader,
  csvLine,
  findHeaderRow,
  leadIdFor,
  normalizePhone,
  parseCsv,
  phoneFromCell,
  planRows,
  resultPathFor,
} from "../../scripts/lib/importar-leads-core.mjs";
import { normalizeIntakePhone } from "@/server/intake/phone";

/**
 * 036 — Importar leads de evento: contrato (`evento`, consentimiento,
 * tarjeta), vendedor del Excel → persona del equipo, y lo puro del script
 * (`scripts/lib/importar-leads-core.mjs`). El flujo contra la app lo cubre
 * `scripts/e2e-leads-externos.mjs` (sección p).
 */

const LEAD_ID = "6f1c2b9e-3d4a-4e5f-8a7b-1c2d3e4f5a6b";

describe("contrato — origen evento", () => {
  it.each([
    ["sí", "Sí"],
    ["Si", "Sí"],
    ["SÍ.", "Sí"],
    ["x", "Sí"],
    ["X", "Sí"],
    ["1", "Sí"],
    [1, "Sí"],
    ["true", "Sí"],
    [true, "Sí"],
    ["yes", "Sí"],
    ["no", "No"],
    ["NO", "No"],
    ["0", "No"],
    [0, "No"],
    ["false", "No"],
    [false, "No"],
    ["", undefined],
    ["  ", undefined],
    ["tal vez", undefined],
    [null, undefined],
    [undefined, undefined],
  ])("consentimiento %j → %j", (raw, out) => {
    expect(parseConsent(raw)).toBe(out);
    const r = intakeLeadSchema.parse({
      lead_id: LEAD_ID,
      origin: "evento",
      phone: "5512345678",
      whatsapp_consent: raw,
    });
    expect(r.whatsapp_consent).toBe(out);
  });

  it("acepta origin evento con event, seller y los recorta", () => {
    const r = intakeLeadSchema.parse({
      lead_id: LEAD_ID,
      origin: "evento",
      first_name: "Ana  López",
      phone: "5512345678",
      event: "  Expo   Autos 2026 ",
      seller: "x".repeat(200),
    });
    expect(r.origin).toBe("evento");
    expect(r.event).toBe("Expo Autos 2026");
    expect(r.seller).toHaveLength(120);
  });

  it("la tarjeta: cabecera CONSTANTE y Evento después de Nombre/Correo", () => {
    const lead = intakeLeadSchema.parse({
      lead_id: LEAD_ID,
      origin: "evento",
      first_name: "Ana López",
      phone: "5512345678",
      email: "ana@example.com",
      event: "Expo Autos 2026",
      seller: "Mariana",
      whatsapp_consent: "sí",
      vehicle: "BYD Dolphin",
      notes: "Prueba de manejo el sábado",
    });
    const text = buildLeadCardText(lead);
    expect(text.split("\n")).toEqual([
      "Lead de evento",
      "Nombre: Ana López",
      "Correo: ana@example.com",
      "Evento: Expo Autos 2026",
      "Vendedor: Mariana",
      "Autorizó WhatsApp: Sí",
      "Vehículo: BYD Dolphin",
      "Notas: Prueba de manejo el sábado",
    ]);
    // El nombre del evento NUNCA va en la cabecera (el Resumen la compara exacta).
    expect(LEAD_INTAKE_HEADER.evento).toBe("Lead de evento");
    const card = parseLeadCard(text);
    expect(card.origin).toBe("evento");
    expect(card.fields[2]).toEqual({ label: "Evento", value: "Expo Autos 2026" });
    expect(leadCardForAgent(text)).toMatch(/^\[Lead de evento\] Nombre: Ana López · /);
  });

  it("sin los campos opcionales, la tarjeta no trae sus líneas", () => {
    const text = buildLeadCardText(
      intakeLeadSchema.parse({ lead_id: LEAD_ID, origin: "evento", first_name: "Ana", phone: "5512345678" })
    );
    expect(text).toBe("Lead de evento\nNombre: Ana");
  });

  it("parseLeadCard reconoce los tres orígenes y nada más", () => {
    for (const [k, h] of Object.entries(LEAD_INTAKE_HEADER)) {
      expect(parseLeadCard(`${h}\nNombre: X`).origin).toBe(k);
    }
    expect(parseLeadCard("Lead de evento: Expo\nNombre: X").origin).toBeNull();
  });

  it("fuente «Evento» en el catálogo, con etiqueta", () => {
    expect(SOURCE_VALUES).toContain("evento");
    expect(SOURCE_LABELS.evento).toBe("Evento");
    // Antes de «Otro» (orden de reportes y del selector).
    expect(SOURCE_VALUES.indexOf("evento")).toBe(SOURCE_VALUES.indexOf("otro") - 1);
  });
});

describe("vendedor del Excel → persona del equipo", () => {
  const team: SellerMember[] = [
    { userId: "u_mariana", name: "Mariana López" },
    { userId: "u_inigo", name: "Íñigo  Pérez" },
    { userId: "u_rocio1", name: "Rocío Gómez" },
    { userId: "u_rocio2", name: "Rocio Ruiz" },
    { userId: "u_owner", name: "Daniel" },
  ];

  it("normaliza: acentos, mayúsculas y espacios", () => {
    expect(normalizePersonName("  ÍÑIGO   Pérez ")).toBe("inigo perez");
  });

  it.each([
    ["Mariana López", "u_mariana"],
    ["mariana lopez", "u_mariana"],
    ["MARIANA   LÓPEZ", "u_mariana"],
    ["inigo perez", "u_inigo"],
    ["Mariana", "u_mariana"],
    ["íñigo", "u_inigo"],
    ["daniel", "u_owner"],
  ])("%j → %s", (seller, userId) => {
    expect(matchSeller(seller, team)).toEqual({ kind: "match", userId });
  });

  it("primer nombre compartido → ambiguo", () => {
    expect(matchSeller("Rocío", team)).toEqual({ kind: "ambiguous" });
    expect(matchSeller("rocio ruiz", team)).toEqual({ kind: "match", userId: "u_rocio2" });
  });

  it("nombre completo repetido → ambiguo", () => {
    expect(
      matchSeller("Ana", [
        { userId: "a", name: "Ana" },
        { userId: "b", name: "ana" },
      ])
    ).toEqual({ kind: "ambiguous" });
  });

  it.each(["López", "Mar", "Mariana Gómez", "Pedro", "", "   "])("%j → no encontrado", (seller) => {
    expect(matchSeller(seller, team)).toEqual({ kind: "none" });
  });
});

describe("script — celdas y teléfono", () => {
  it("texto de celda en todas sus formas de exceljs", () => {
    expect(cellText(null)).toBe("");
    expect(cellText("  Ana ")).toBe("Ana");
    expect(cellText(5512345678)).toBe("5512345678");
    expect(cellText(5215512345678)).toBe("5215512345678");
    expect(cellText(true)).toBe("true");
    expect(cellText({ formula: "A1", result: "Hola" })).toBe("Hola");
    expect(cellText({ text: "ana@x.mx", hyperlink: "mailto:ana@x.mx" })).toBe("ana@x.mx");
    expect(cellText({ richText: [{ text: "Ana " }, { text: "López" }] })).toBe("Ana López");
    expect(cellText(new Date("2026-11-10T00:00:00Z"))).toBe("2026-11-10");
    expect(cellText({ error: "#N/A" })).toBe("");
  });

  it("WhatsApp de texto, número, fórmula HYPERLINK e hipervínculo", () => {
    expect(phoneFromCell("55 1234 5678")).toBe("55 1234 5678");
    expect(phoneFromCell(5512345678)).toBe("5512345678");
    expect(
      phoneFromCell({ formula: 'HYPERLINK("https://wa.me/5215512345678","Enviar WhatsApp")', result: "Enviar WhatsApp" })
    ).toBe("5215512345678");
    expect(phoneFromCell({ text: "Enviar WhatsApp", hyperlink: "https://wa.me/525512345678" })).toBe("525512345678");
    expect(phoneFromCell({ text: "x", hyperlink: "https://api.whatsapp.com/send?phone=525512345678" })).toBe("525512345678");
    expect(phoneFromCell({ formula: 'HYPERLINK("https://example.com","Ver")', result: "Ver" })).toBe("Ver");
  });

  it.each([
    "5512345678",
    "55 1234 5678",
    "(55) 1234-5678",
    "525512345678",
    "+52 1 55 1234 5678",
    "5215512345678",
    "521234567890",
    "12345",
    "Enviar WhatsApp",
    "55123456789",
    "",
  ])("normalizePhone(%j) = normalizeIntakePhone (mismo resultado que el servidor)", (raw) => {
    expect(normalizePhone(raw)).toBe(normalizeIntakePhone(raw));
  });
});

describe("script — encabezados", () => {
  it.each([
    ["Nombre*", "name"],
    ["Nombre completo", "name"],
    ["Nombre del cliente", "name"],
    ["WhatsApp* (10 dígitos)", "phone"],
    ["📱 Teléfono", "phone"],
    ["Celular", "phone"],
    ["Número de WhatsApp", "phone"],
    ["Vendedor (opcional)", "seller"],
    ["Asesor", "seller"],
    ["Vendedora", "seller"],
    ["Modelo de interés", "model"],
    ["Auto", "model"],
    ["Vehículo", "model"],
    ["Comentarios", "notes"],
    ["Observaciones", "notes"],
    ["Correo", "email"],
    ["E-mail", "email"],
    ["email", "email"],
    ["¿Aceptó que le escribamos por WhatsApp?", "consent"],
    ["Autoriza contacto", "consent"],
    ["consentimiento_whatsapp", "consent"],
    ["Fecha", null],
    ["Sucursal", null],
  ])("%j → %j", (h, field) => {
    expect(classifyHeader(h)).toBe(field);
  });

  it("la fila de encabezados puede no ser la primera; reporta las desconocidas", () => {
    const rows = [
      ["Expo Autos — registro"],
      [],
      ["Nombre*", "WhatsApp*", "Fecha", "Vendedor"],
      ["Ana", "5512345678", "hoy", "Mariana"],
    ];
    const h = findHeaderRow(rows);
    expect(h).toMatchObject({ index: 2, columns: { name: 0, phone: 1, seller: 3 }, unknown: ["Fecha"] });
  });

  it("sin nombre ni teléfono en las 5 primeras → null", () => {
    expect(findHeaderRow([["A", "B"], ["Nombre"], [], [], [], ["Nombre", "WhatsApp"]])).toBeNull();
  });
});

describe("script — plan de filas", () => {
  const rows = [
    ["Nombre*", "WhatsApp*", "Vendedor", "Modelo de interés", "Comentarios", "Correo", "¿Aceptó?"],
    ["Ana López", "55 1234 5678", "Mariana", "Dolphin", "Sábado", "ana@x.mx", "sí"],
    [],
    ["Luis", 5587654321, "", "", "", "", ""],
    ["Sin Tel", "", "Mariana", "", "", "", ""],
    ["Mal Tel", "12345", "", "", "", "", ""],
    ["Ana Otra Vez", "+52 1 55 1234 5678", "", "", "", "", ""],
    ["", "5511112222", "", "", "", "", ""],
  ];
  const plan = planRows(rows, findHeaderRow(rows)!, "Expo Autos");

  it("estados por fila (las vacías se saltan; fila = número en el archivo)", () => {
    expect(plan.map((p: { fila: number; estado: string }) => [p.fila, p.estado])).toEqual([
      [2, "listo"],
      [4, "listo"],
      [5, "inválido"],
      [6, "inválido"],
      [7, "repetido"],
      [8, "inválido"],
    ]);
    expect(plan[4]?.motivo).toBe("mismo WhatsApp que la fila 2");
  });

  it("cuerpo del POST: origen evento, campos mapeados, sin vacíos", () => {
    expect(plan[0]?.payload).toEqual({
      lead_id: leadIdFor("Expo Autos", "525512345678"),
      origin: "evento",
      first_name: "Ana López",
      phone: "525512345678",
      event: "Expo Autos",
      seller: "Mariana",
      vehicle: "Dolphin",
      notes: "Sábado",
      email: "ana@x.mx",
      whatsapp_consent: "sí",
    });
    expect(plan[1]?.payload).toEqual({
      lead_id: leadIdFor("Expo Autos", "525587654321"),
      origin: "evento",
      first_name: "Luis",
      phone: "525587654321",
      event: "Expo Autos",
    });
    // El servidor lo acepta tal cual.
    expect(intakeLeadSchema.safeParse(plan[0]?.payload).success).toBe(true);
  });

  it("lead_id: UUID v5 determinista; el evento se compara normalizado", () => {
    const id = leadIdFor("Expo Autos Mérida", "525512345678");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(leadIdFor("  expo   autos MERIDA ", "525512345678")).toBe(id);
    expect(leadIdFor("Expo Autos Mérida", "525512345679")).not.toBe(id);
    expect(leadIdFor("Otra expo", "525512345678")).not.toBe(id);
    expect(intakeLeadSchema.shape.lead_id.safeParse(id).success).toBe(true);
  });
});

describe("script — CSV", () => {
  it("lee UTF-8 con BOM, `;` o `,`, comillas y CRLF", () => {
    expect(parseCsv('\uFEFFNombre;WhatsApp\r\n"López; Ana";5512345678\r\n')).toEqual([
      ["Nombre", "WhatsApp"],
      ["López; Ana", "5512345678"],
    ]);
    expect(parseCsv('Nombre,Notas\nAna,"dijo ""hola""\nmañana"')).toEqual([
      ["Nombre", "Notas"],
      ["Ana", 'dijo "hola"\nmañana'],
    ]);
  });

  it("escribe con comillas donde hace falta", () => {
    expect(csvLine([1, "a,b", 'c"d', null])).toBe('1,"a,b","c""d",');
  });

  it("el resultado va junto al archivo y nunca encima", () => {
    expect(resultPathFor("C:/x/leads.xlsx")).toBe("C:/x/leads.resultado.csv");
    expect(resultPathFor("leads.CSV")).toBe("leads.resultado.csv");
    expect(resultPathFor("leads.resultado.csv")).toBe("leads.resultado.resultado.csv");
  });
});
