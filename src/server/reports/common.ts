import { sql, type SQL } from "drizzle-orm";
import { schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import type { WonAmountDto } from "@/lib/reports";
import { pgTimestamp } from "./agent";

/**
 * Piezas SQL y de plegado compartidas por Anuncios (020), Ventas y Resumen
 * (021). Se extrajeron de `ads.ts` SIN cambiar su SQL renderizado: el test de
 * Anuncios afirma los textos exactos.
 */

const A = schema.adAttribution;
const L = schema.lead;
const C = schema.conversation;

/** Límite de rango como texto `::timestamp` (nunca un `Date` timestamptz). */
export function ts(d: Date): SQL {
  return sql`${pgTimestamp(d)}::timestamp`;
}

/**
 * El primer origen de cada contacto de la organización (020 D1). Una fila
 * por contacto; el mismo orden que la ficha (`created_at asc, id asc`).
 */
export function firstOriginCte(p: { organizationId: string }): SQL {
  return sql`fa as (
  select distinct on (${A.contactId}) ${A.contactId} as contact_id,
    ${A.id} as attribution_id,
    ${A.sourceId} as source_id,
    ${A.sourceType} as source_type,
    ${A.headline} as headline,
    ${A.mediaType} as media_type,
    ${A.createdAt} as arrived_at
  from ${A}
  where ${scoped(A.organizationId, p.organizationId)}
  order by ${A.contactId}, ${A.createdAt} asc, ${A.id} asc
)`;
}

/**
 * Contacto del Laboratorio = TODAS sus conversaciones son de prueba. Un
 * contacto real que además tuvo una conversación de prueba sigue contando, y
 * uno sin conversaciones (alta manual) también. Se evalúa sobre
 * `"lead"."contact_id"`: sirve a las consultas que parten del lead.
 */
export function notLabContact(p: { organizationId: string }): SQL {
  return sql`(
    not exists (
      select 1 from ${C} lab
      where lab.organization_id = ${p.organizationId}
        and lab.contact_id = ${L.contactId} and lab.is_test = true
    )
    or exists (
      select 1 from ${C} real_conv
      where real_conv.organization_id = ${p.organizationId}
        and real_conv.contact_id = ${L.contactId} and real_conv.is_test = false
    )
  )`;
}

// ── Plegado de filas crudas ──────────────────────────────────────────────

export type Row = Record<string, unknown>;

/** count/int que el driver puede entregar como texto. */
export function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** percentile_cont: número, texto o null. */
export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function truthy(v: unknown): boolean {
  return v === true || v === "t" || v === "true" || v === 1;
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Acumulador del monto ganado (centavos enteros, por moneda). */
export function emptyAmount(currency: string): WonAmountDto {
  return { currency, amountCents: 0, otherCurrencies: [], wonWithoutAmount: 0 };
}

/**
 * Suma un grupo de GANADOS al monto: sin monto → solo se cuenta; con monto en
 * la moneda del negocio (o sin moneda) → suma; en otra → aparte. Nunca se
 * suman monedas distintas.
 */
export function addWon(
  acc: WonAmountDto,
  g: { currency: string | null; hasAmount: boolean; won: number; cents: number }
): void {
  if (!g.hasAmount) {
    acc.wonWithoutAmount += g.won;
    return;
  }
  const cur = g.currency ?? acc.currency;
  if (cur === acc.currency) {
    acc.amountCents += g.cents;
    return;
  }
  const other = acc.otherCurrencies.find((o) => o.currency === cur);
  if (other) {
    other.amountCents += g.cents;
    other.won += g.won;
  } else {
    acc.otherCurrencies.push({ currency: cur, amountCents: g.cents, won: g.won });
  }
}

export function sortOthers(acc: WonAmountDto): WonAmountDto {
  acc.otherCurrencies.sort((a, b) => b.amountCents - a.amountCents || a.currency.localeCompare(b.currency));
  return acc;
}

/**
 * Ventas con monto en la moneda principal (denominador del ticket promedio):
 * las ganadas menos las sin monto y las de otras monedas.
 */
export function wonInMainCurrency(won: number, amount: WonAmountDto): number {
  const others = amount.otherCurrencies.reduce((a, o) => a + o.won, 0);
  return Math.max(0, won - amount.wonWithoutAmount - others);
}
