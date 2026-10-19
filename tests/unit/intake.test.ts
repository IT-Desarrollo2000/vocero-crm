import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: () => ({}), schema: {} }));
// archive.ts arma SQL con el schema al cargar; aquí solo importa la constante.
vi.mock("@/server/inbox/archive", () => ({ UNARCHIVE_SET: {} }));

import { normalizeMx } from "@/lib/meta/client";
import {
  LEAD_INTAKE_HEADER,
  leadCardForAgent,
  parseLeadCard,
} from "@/lib/lead-intake";
import type { FichaFieldDef } from "@/lib/ficha-fields";
import { toChatHistory, type HistoryRow } from "@/server/ai/history";
import {
  NO_NAME,
  buildLeadCardText,
  fullName,
  intakeLeadSchema,
  type IntakeLead,
} from "@/server/intake/contract";
import { parseIntakeFlag } from "@/server/intake/flag";
import { fichaPatchFor, SOURCE_FOR_ORIGIN } from "@/server/intake/ingest";
import { normalizeIntakePhone, phoneLast4 } from "@/server/intake/phone";
import { generateIntakeKey, intakeKeyMatches } from "@/server/intake/settings";

/**
 * 011 — Leads externos: lo puro (teléfono, contrato, tarjeta, clave, ficha,
 * historial del agente). El flujo contra la BD lo cubre
 * `scripts/e2e-leads-externos.mjs`.
 */

const LEAD_ID = "6f1c2b9e-3d4a-4e5f-8a7b-1c2d3e4f5a6b";

function parse(raw: Record<string, unknown>): IntakeLead {
  const r = intakeLeadSchema.safeParse(raw);
  if (!r.success) throw new Error(JSON.stringify(r.error.issues));
  return r.data;
}

describe("RF-4 — teléfono", () => {
  it.each([
    ["5512345678", "525512345678"],
    ["55 1234 5678", "525512345678"],
    ["55-1234-5678", "525512345678"],
    ["(55) 1234-5678", "525512345678"],
    ["525512345678", "525512345678"],
    ["+52 55 1234 5678", "525512345678"],
    ["5215512345678", "525512345678"],
    ["+52 1 55 1234 5678", "525512345678"],
  ])("%s → %s", (raw, out) => {
    expect(normalizeIntakePhone(raw)).toBe(out);
  });

  it("521 + 10 coincide con normalizeMx (el from de Meta)", () => {
    expect(normalizeIntakePhone("5215512345678")).toBe(normalizeMx("5215512345678"));
  });

  it("52 + 10 que empieza por 1 NO pierde ese 1 (longitud antes que prefijo)", () => {
    // 12 dígitos: 52 + 1234567890 — un número válido, no un 521 de celular.
    expect(normalizeIntakePhone("521234567890")).toBe("521234567890");
  });

  it.each([
    "",
    "12345",
    "551234567", // 9
    "15512345678", // 11 sin 52
    "445512345678", // 12 sin 52
    "5225512345678", // 13 sin 521
    "55123456789012",
    "55abc12345678",
    "tel: 5512345678",
  ])("inválido: %j → null", (raw) => {
    expect(normalizeIntakePhone(raw)).toBeNull();
  });

  it("al log solo van los últimos 4", () => {
    expect(phoneLast4("525512345678")).toBe("5678");
  });
});

describe("RF-3 — contrato", () => {
  it("website mínimo", () => {
    const lead = parse({
      lead_id: LEAD_ID,
      origin: "website",
      first_name: "Ana",
      phone: "5512345678",
    });
    expect(lead.origin).toBe("website");
    expect(lead.last_name).toBeUndefined();
    expect(lead.created_at).toBeUndefined();
  });

  it("fast_app completo, con nulls del ERP y campos desconocidos ignorados", () => {
    const lead = parse({
      lead_id: LEAD_ID,
      origin: "fast_app",
      lead_code: "LEAD-CDMX-2026-0042",
      first_name: "  Luis ",
      last_name: "Pérez",
      phone: 5512345678,
      email: null,
      notes: "Quiere   prueba\nde manejo",
      vehicle: "BYD Dolphin",
      branch: "Sucursal Norte",
      promoter: "Carlos",
      budget_min: "350,000",
      budget_max: 450000,
      payment_method: "financiamiento",
      trade_in: true,
      utm_source: null,
      created_at: "2026-10-18T15:30:00Z",
      branch_id: "ignorado",
    });
    expect(lead.phone).toBe("5512345678");
    expect(lead.email).toBeUndefined();
    expect(lead.notes).toBe("Quiere prueba de manejo");
    expect(lead.budget_min).toBe(350000);
    expect(lead.trade_in).toBe("Sí");
    expect(lead.created_at?.toISOString()).toBe("2026-10-18T15:30:00.000Z");
    expect(lead).not.toHaveProperty("branch_id");
  });

  it.each([
    [{ origin: "website", first_name: "A", phone: "5512345678" }, "sin lead_id"],
    [{ lead_id: "no-uuid", origin: "website", first_name: "A", phone: "1" }, "lead_id no uuid"],
    [{ lead_id: LEAD_ID, origin: "walk_in", first_name: "A", phone: "1" }, "origen fuera"],
    [{ lead_id: LEAD_ID, origin: "website", first_name: "A" }, "sin teléfono"],
  ])("rechaza %j (%s)", (raw, _motivo) => {
    expect(intakeLeadSchema.safeParse(raw).success).toBe(false);
  });

  it("created_at ilegible se ignora (hora de llegada), no cuesta el lead", () => {
    const lead = parse({
      lead_id: LEAD_ID,
      origin: "website",
      first_name: "A",
      phone: "5512345678",
      created_at: "ayer",
    });
    expect(lead.created_at).toBeUndefined();
  });

  describe("created_at en el futuro", () => {
    const NOW = new Date("2026-10-19T18:00:00.000Z");
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());

    const at = (iso: string) =>
      parse({ lead_id: LEAD_ID, origin: "website", first_name: "A", phone: "5512345678", created_at: iso })
        .created_at;

    it("más de 5 min por delante → se ignora (hora de llegada)", () => {
      expect(at("2026-10-19T19:00:00.000Z")).toBeUndefined();
      expect(at("2026-10-19T18:05:01.000Z")).toBeUndefined();
    });

    it("hasta 5 min por delante (desfase de reloj) se respeta", () => {
      expect(at("2026-10-19T18:02:00.000Z")?.toISOString()).toBe("2026-10-19T18:02:00.000Z");
      expect(at("2026-10-19T18:05:00.000Z")?.toISOString()).toBe("2026-10-19T18:05:00.000Z");
    });

    it("las fechas pasadas se respetan (carga inicial de 30 días)", () => {
      expect(at("2026-09-19T10:00:00.000Z")?.toISOString()).toBe("2026-09-19T10:00:00.000Z");
    });
  });
});

describe("first_name opcional", () => {
  it.each([
    [{}, "sin first_name"],
    [{ first_name: null }, "first_name null"],
    [{ first_name: "   " }, "first_name vacío"],
  ])("%j se acepta (%s)", (extra, _motivo) => {
    const lead = parse({ lead_id: LEAD_ID, origin: "website", phone: "5512345678", ...extra });
    expect(lead.first_name).toBeUndefined();
    expect(fullName(lead)).toBe("");
    expect(buildLeadCardText(lead).split("\n")).toContain(`Nombre: ${NO_NAME}`);
    expect(NO_NAME).toBe("(sin nombre)");
  });

  it("con solo el apellido, el nombre es el apellido", () => {
    const lead = parse({ lead_id: LEAD_ID, origin: "website", phone: "5512345678", last_name: "Pérez" });
    expect(fullName(lead)).toBe("Pérez");
  });

  it("el nombre se recorta y colapsa espacios", () => {
    const lead = parse({ lead_id: LEAD_ID, origin: "website", phone: "5512345678", first_name: "  Ana   María ", last_name: "Ruiz" });
    expect(fullName(lead)).toBe("Ana María Ruiz");
  });
});

describe("RF-7 — tarjeta", () => {
  const lead = parse({
    lead_id: LEAD_ID,
    origin: "fast_app",
    first_name: "Luis",
    last_name: "Pérez",
    phone: "5512345678",
    email: "luis@example.com",
    vehicle: "BYD Dolphin",
    promoter: "Carlos",
    budget_min: 350000,
    budget_max: 450000,
    notes: "Llamar en la tarde",
    utm_source: "facebook",
    utm_campaign: "otoño",
    lead_code: "LEAD-CDMX-2026-0042",
  });
  const text = buildLeadCardText(lead);

  it("cabecera de origen y un campo por línea, solo los que vinieron", () => {
    const lines = text.split("\n");
    expect(lines[0]).toBe(LEAD_INTAKE_HEADER.fast_app);
    expect(lines).toContain("Nombre: Luis Pérez");
    expect(lines).toContain("Correo: luis@example.com");
    expect(lines).toContain("Promotor: Carlos");
    expect(lines).toContain("Presupuesto: $350,000 – $450,000");
    expect(lines).toContain("Campaña: facebook / otoño");
    expect(lines).toContain("Código: LEAD-CDMX-2026-0042");
    expect(text).not.toContain("Sucursal");
  });

  it("parseLeadCard la lee de vuelta (origen + campos)", () => {
    const card = parseLeadCard(text);
    expect(card.origin).toBe("fast_app");
    expect(card.fields).toContainEqual({ label: "Vehículo", value: "BYD Dolphin" });
  });

  it("parseLeadCard tolera texto ajeno", () => {
    expect(parseLeadCard(null)).toEqual({ header: "Lead externo", origin: null, fields: [] });
    expect(parseLeadCard("algo\nsin etiqueta").fields).toEqual([{ label: null, value: "sin etiqueta" }]);
  });

  it("para el agente: etiquetada y sin el paréntesis", () => {
    expect(leadCardForAgent(text)).toMatch(/^\[Lead de promotor\] Nombre: Luis Pérez · /);
    const web = buildLeadCardText({ ...lead, origin: "website" });
    expect(leadCardForAgent(web)).toMatch(/^\[Lead del sitio web\] /);
  });
});

describe("RF-1 — clave", () => {
  it("32 bytes en base64url", () => {
    const k = generateIntakeKey();
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateIntakeKey()).not.toBe(k);
  });
  it("comparación: igual / distinta / longitud distinta", () => {
    const k = generateIntakeKey();
    expect(intakeKeyMatches(k, k)).toBe(true);
    expect(intakeKeyMatches(k, `${k.slice(0, -1)}x`)).toBe(k.endsWith("x"));
    expect(intakeKeyMatches(k, k.slice(0, 10))).toBe(false);
    expect(intakeKeyMatches(k, "")).toBe(false);
  });
});

describe("bandera LEADS_EXTERNOS", () => {
  it("apagada por defecto; on/1/true/sí encienden", () => {
    expect(parseIntakeFlag(undefined)).toBe(false);
    expect(parseIntakeFlag("")).toBe(false);
    expect(parseIntakeFlag("off")).toBe(false);
    for (const v of ["on", "1", "true", "sí", " ON "]) expect(parseIntakeFlag(v)).toBe(true);
  });
});

describe("D-11-5 / RF-9 — fuente y ficha", () => {
  it("cada origen tiene su fuente", () => {
    expect(SOURCE_FOR_ORIGIN).toEqual({ website: "web", fast_app: "promotor" });
  });

  const lead = parse({
    lead_id: LEAD_ID,
    origin: "website",
    first_name: "Ana",
    phone: "5512345678",
    email: "ana@example.com",
    vehicle: "BYD Seal",
    branch: "Centro",
  });

  it("sin definición: solo el correo (clave libre `email`)", () => {
    expect(fichaPatchFor(lead, null)).toEqual({ email: "ana@example.com" });
  });

  it("con campos del negocio: vehículo y sucursal a SUS claves", () => {
    const fields: FichaFieldDef[] = [
      { key: "correo", label: "Correo", type: "texto", agentFills: false },
      { key: "modelo_interes", label: "Modelo de interés", type: "texto", agentFills: true },
      { key: "sucursal", label: "Sucursal", type: "texto", agentFills: false },
    ];
    expect(fichaPatchFor(lead, fields)).toEqual({
      correo: "ana@example.com",
      modelo_interes: "BYD Seal",
      sucursal: "Centro",
    });
  });

  it("un correo sin forma de correo no va a la ficha", () => {
    expect(fichaPatchFor({ ...lead, email: "no tengo" }, null)).toEqual({});
  });
});

describe("RF-10 — historial del agente", () => {
  const card: HistoryRow = {
    direction: "in",
    type: "lead_intake",
    text: "Lead del sitio web\nNombre: Ana\nNotas: quiero hablar con un asesor",
  };

  it("la tarjeta va etiquetada, no como si el cliente la hubiera escrito", () => {
    const { messages } = toChatHistory([card]);
    expect(messages[0]).toEqual({
      role: "user",
      content: "[Lead del sitio web] Nombre: Ana · Notas: quiero hablar con un asesor",
    });
  });

  it("lastInboundText ignora la tarjeta (el respaldo de handoff no lee sus notas)", () => {
    expect(toChatHistory([card]).lastInboundText).toBeNull();
    const real: HistoryRow = { direction: "in", type: "text", text: "Hola, ¿precio?" };
    expect(toChatHistory([real, card]).lastInboundText).toBe("Hola, ¿precio?");
  });
});
