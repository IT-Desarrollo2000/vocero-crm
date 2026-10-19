import { z } from "zod";
import { LEAD_INTAKE_HEADER } from "@/lib/lead-intake";

/**
 * 011 (RF-3) — Contrato de `POST /api/intake/lead`.
 *
 * Lo arma el ERP (`crm_lead_payload`) a partir de su tabla `leads`. Tolerante
 * a propósito con lo opcional: el ERP manda `null` en lo que no tiene, y un
 * campo de más (o un formato raro en uno que solo va a la tarjeta) no debe
 * costar el lead. Los campos desconocidos se ignoran (Zod los quita).
 */

export const INTAKE_ORIGINS = ["website", "fast_app"] as const;
export type IntakeOrigin = (typeof INTAKE_ORIGINS)[number];

/** Tope por campo de texto libre: la tarjeta es un resumen, no un archivo. */
const TEXT_MAX = 500;
const NOTES_MAX = 1000;

/** Texto opcional: `null`/vacío → undefined; espacios colapsados; recortado. */
const optText = (max = TEXT_MAX) =>
  z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => {
      if (v === null || v === undefined) return undefined;
      const s = String(v).replace(/\s+/g, " ").trim();
      return s ? s.slice(0, max) : undefined;
    });

/** Monto: número o texto numérico ("350,000"); otra cosa se descarta. */
const optAmount = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((v) => {
    if (v === null || v === undefined) return undefined;
    const n = typeof v === "number" ? v : Number(v.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  });

export const intakeLeadSchema = z.object({
  lead_id: z.string().uuid(),
  origin: z.enum(INTAKE_ORIGINS),
  lead_code: optText(64),
  first_name: z.string().trim().min(1).max(TEXT_MAX),
  last_name: optText(),
  phone: z.union([z.string(), z.number()]).transform((v) => String(v)),
  email: optText(254),
  notes: optText(NOTES_MAX),
  vehicle: optText(),
  branch: optText(),
  promoter: optText(),
  budget_min: optAmount,
  budget_max: optAmount,
  payment_method: optText(),
  trade_in: z
    .union([z.boolean(), z.string()])
    .nullish()
    .transform((v) => {
      if (v === null || v === undefined) return undefined;
      if (typeof v === "boolean") return v ? "Sí" : "No";
      const s = v.trim();
      return s ? s.slice(0, TEXT_MAX) : undefined;
    }),
  utm_source: optText(120),
  utm_medium: optText(120),
  utm_campaign: optText(120),
  created_at: z
    .string()
    .nullish()
    .transform((v) => {
      if (!v) return undefined;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? undefined : d;
    }),
});

export type IntakeLead = z.output<typeof intakeLeadSchema>;

/** Correo con forma de correo; si no, no va a la ficha (sí a la tarjeta). */
export function looksLikeEmail(v: string | undefined): v is string {
  return !!v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export function fullName(lead: IntakeLead): string {
  return [lead.first_name.trim(), lead.last_name].filter(Boolean).join(" ");
}

const money = (n: number) =>
  `$${n.toLocaleString("es-MX", { maximumFractionDigits: 0 })}`;

function budgetText(min?: number, max?: number): string | undefined {
  if (min && max) return `${money(min)} – ${money(max)}`;
  if (max) return `hasta ${money(max)}`;
  if (min) return `desde ${money(min)}`;
  return undefined;
}

/**
 * El `text` de la tarjeta (ver `src/lib/lead-intake.ts`): cabecera de origen
 * y un campo por línea, solo los que vinieron.
 */
export function buildLeadCardText(lead: IntakeLead): string {
  const campaign = [lead.utm_source, lead.utm_medium, lead.utm_campaign]
    .filter(Boolean)
    .join(" / ");
  const rows: [string, string | undefined][] = [
    ["Nombre", fullName(lead)],
    ["Correo", lead.email],
    ["Vehículo", lead.vehicle],
    ["Sucursal", lead.branch],
    ["Promotor", lead.promoter],
    ["Presupuesto", budgetText(lead.budget_min, lead.budget_max)],
    ["Forma de pago", lead.payment_method],
    ["Auto a cuenta", lead.trade_in],
    ["Notas", lead.notes],
    ["Campaña", campaign || undefined],
    ["Código", lead.lead_code],
  ];
  return [
    LEAD_INTAKE_HEADER[lead.origin],
    ...rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`),
  ].join("\n");
}
