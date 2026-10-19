import { sql, type SQL } from "drizzle-orm";
import { schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  ratio,
  type ReportRangeDto,
  type SalesAdvisorRowDto,
  type SalesByAdvisorDto,
  type SalesByDayDto,
  type SalesFiguresDto,
  type SalesFunnelDto,
  type SalesFunnelStageDto,
  type SalesLossReasonsDto,
  type SalesReportDto,
  type SalesSummaryDto,
  type SalesTimeToCloseDto,
  type WonAmountDto,
} from "@/lib/reports";
import { LOSS_REASON_LABEL, type LossReason } from "@/lib/types";
import {
  addWon,
  emptyAmount,
  firstOriginCte,
  notLabContact,
  num,
  numOrNull,
  sortOthers,
  str,
  truthy,
  ts,
  wonInMainCurrency,
  type Row,
} from "./common";
import { previousRange, toRangeDto, type ReportRange } from "./range";
import { runBlocks, runReadOnly, type ReportExec, type RunBlocksOptions } from "./run";

/**
 * 021 — Reportes → Ventas (solo Propietario). Mismo marco que Anuncios:
 * `parseReportRange` + `reportTimezone` en la ruta, y aquí `runBlocks` +
 * `runReadOnly` con seis bloques independientes.
 *
 * Semántica (plan 021 §3.1; documentada también en `src/lib/reports.ts`):
 *  - VENTA = lead HOY en una etapa `won`, fechada por el `occurred_at` de su
 *    ÚLTIMO evento `to_stage_kind = 'won'` (D1). Cuenta en el periodo si esa
 *    fecha cae en `[fromUtc, toUtc)`. Un ganado reabierto o perdido deja de
 *    ser venta. Un lead en `won` sin evento `won` va a `withoutDate` (nunca
 *    se usa `updated_at`).
 *  - PERDIDA = análogo con `lost`; motivo = `loss_reason` de ese evento.
 *  - ASESOR (D2) = `actor_user_id` del evento; si es NULL (bot, sistema,
 *    migración), el `assigned_user_id` de la conversación REAL más reciente
 *    del contacto (`created_at desc, id desc`); si tampoco hay, «Sin asesor».
 *  - LLEGADA del lead = su primer anuncio de origen (el de la ficha) o, sin
 *    anuncio, `lead.created_at` — la misma que usa Anuncios.
 *  - Fechas `approximate = true` (sembradas por 0013) cuentan para totales y
 *    se reportan en `approximateCount`, pero NO entran a los tiempos.
 *  - Laboratorio fuera (`notLabContact`, la misma regla que Anuncios).
 *
 * Reglas que TODAS las consultas cumplen (un unit test las vigila sobre el
 * SQL renderizado): tenant por `scoped`, límites como texto `::timestamp`,
 * nada de `now()`. El embudo es una foto actual: no lleva límites de rango.
 */

export type SalesReportParams = {
  organizationId: string;
  fromUtc: Date;
  toUtc: Date;
  /** Zona del reporte (IANA), parámetro ligado de los cortes por día. */
  tz: string;
};

const L = schema.lead;
const S = schema.pipelineStage;
const E = schema.leadStageEvent;
const C = schema.conversation;
const U = schema.user;

/** Motivo de una perdida sembrada sin `loss_reason` (la CHECK lo permite). */
export const NO_LOSS_REASON = "sin_motivo";
export const NO_LOSS_REASON_LABEL = "Sin motivo registrado";
/** Nombre de la fila sin asesor (D2). */
export const NO_ADVISOR_LABEL = "Sin asesor";

/**
 * Los leads que HOY están en `won` o `lost`, con su ÚLTIMO evento del mismo
 * tipo (fecha, ¿aproximada?, motivo), su asesor por la regla D2, su llegada
 * y su primer anuncio. `closed_at` NULL = sin evento (anomalía).
 *
 * Requiere el CTE `fa` (`firstOriginCte`) antes.
 */
export function closedCte(p: { organizationId: string }): SQL {
  return sql`closed as (
  select ${L.id} as lead_id,
    ${L.contactId} as contact_id,
    ${S.kind} as kind,
    ${L.amountCents} as amount_cents,
    ${L.currency} as currency,
    ev.occurred_at as closed_at,
    coalesce(ev.approximate, false) as approximate,
    ev.loss_reason,
    coalesce(ev.actor_user_id, (
      select rc.assigned_user_id from ${C} rc
      where rc.organization_id = ${p.organizationId}
        and rc.contact_id = ${L.contactId} and rc.is_test = false
      order by rc.created_at desc, rc.id desc
      limit 1
    )) as advisor_id,
    coalesce(fa.arrived_at, ${L.createdAt}) as arrived_at,
    fa.attribution_id,
    fa.source_id,
    fa.source_type,
    fa.headline
  from ${L}
  join ${S} on ${S.id} = ${L.stageId} and ${S.organizationId} = ${L.organizationId}
  left join lateral (
    select ev1.occurred_at, ev1.approximate, ev1.loss_reason, ev1.actor_user_id
    from ${E} ev1
    where ev1.organization_id = ${p.organizationId}
      and ev1.lead_id = ${L.id} and ev1.to_stage_kind = ${S.kind}
    order by ev1.occurred_at desc, ev1.id desc
    limit 1
  ) ev on true
  left join fa on fa.contact_id = ${L.contactId}
  where ${scoped(
    L.organizationId,
    p.organizationId,
    sql`${S.kind} in ('won', 'lost')`,
    notLabContact(p)
  )}
)`;
}

/** Cierre dentro del rango (sobre el CTE `closed`). */
export function closedInRange(p: { fromUtc: Date; toUtc: Date }): SQL {
  return sql`closed.closed_at >= ${ts(p.fromUtc)} and closed.closed_at < ${ts(p.toUtc)}`;
}

// ── SQL ──────────────────────────────────────────────────────────────────

/**
 * Cierres del rango por tipo × ¿aproximado? × moneda; más los ganados SIN
 * fecha (`no_date`), que no dependen del rango.
 */
export function salesSummarySql(p: SalesReportParams): SQL {
  return sql`with ${firstOriginCte(p)}, ${closedCte(p)}
select kind,
  (closed_at is null) as no_date,
  approximate,
  case when kind = 'won' then currency end as currency,
  (kind = 'won' and amount_cents is not null) as has_amount,
  count(*)::int as n,
  coalesce(sum(case when kind = 'won' then amount_cents end), 0)::bigint as cents
from closed
where (kind = 'won' and closed_at is null) or (${closedInRange(p)})
group by 1, 2, 3, 4, 5`;
}

/** Cierres del rango por asesor (D2) × tipo × moneda, con el nombre. */
export function byAdvisorSql(p: SalesReportParams): SQL {
  return sql`with ${firstOriginCte(p)}, ${closedCte(p)}
select closed.advisor_id,
  coalesce(nullif(u.name, ''), u.email) as advisor_name,
  closed.kind,
  case when closed.kind = 'won' then closed.currency end as currency,
  (closed.kind = 'won' and closed.amount_cents is not null) as has_amount,
  count(*)::int as n,
  coalesce(sum(case when closed.kind = 'won' then closed.amount_cents end), 0)::bigint as cents
from closed
left join ${U} u on u.id = closed.advisor_id
where ${closedInRange(p)}
group by 1, 2, 3, 4, 5`;
}

/** Perdidas del rango por motivo de su último evento `lost`. */
export function lossReasonsSql(p: SalesReportParams): SQL {
  return sql`with ${firstOriginCte(p)}, ${closedCte(p)}
select loss_reason as reason, count(*)::int as n
from closed
where kind = 'lost' and ${closedInRange(p)}
group by 1`;
}

/**
 * Embudo: FOTO ACTUAL por etapa (no depende del rango). El Laboratorio sale
 * en el ON del LEFT JOIN: en el WHERE se comería las etapas vacías.
 */
export function funnelSql(p: { organizationId: string }, currency: string): SQL {
  const main = sql`coalesce(${L.currency}, ${currency}) = ${currency}`;
  return sql`select ${S.id} as stage_id, ${S.name} as name, ${S.kind} as kind, ${S.position} as position,
  count(${L.id})::int as leads,
  coalesce(sum(${L.amountCents}) filter (where ${L.amountCents} is not null and ${main}), 0)::bigint as cents,
  (count(${L.id}) filter (where ${L.amountCents} is null))::int as without_amount,
  (count(${L.id}) filter (where ${L.amountCents} is not null and not ${main}))::int as other_currency
from ${S}
left join ${L} on ${L.stageId} = ${S.id} and ${L.organizationId} = ${S.organizationId}
  and ${notLabContact(p)}
where ${scoped(S.organizationId, p.organizationId)}
group by ${S.id}, ${S.name}, ${S.kind}, ${S.position}
order by ${S.position} asc, ${S.id} asc`;
}

/**
 * Tiempo de cierre (segundos) de las ventas del rango: mediana y p75 sobre
 * las de fecha EXACTA; una llegada posterior a la venta cuenta como 0.
 */
export function timeToCloseSql(p: SalesReportParams): SQL {
  const secs = sql`greatest(0, extract(epoch from closed_at - arrived_at))`;
  return sql`with ${firstOriginCte(p)}, ${closedCte(p)}
select (count(*) filter (where not approximate))::int as sales,
  (count(*) filter (where approximate))::int as approx,
  percentile_cont(0.5) within group (order by ${secs}) filter (where not approximate) as p50_s,
  percentile_cont(0.75) within group (order by ${secs}) filter (where not approximate) as p75_s
from closed
where kind = 'won' and ${closedInRange(p)}`;
}

/** Ventas del rango por día local × moneda (los días vacíos se rellenan en Node). */
export function byDaySql(p: SalesReportParams): SQL {
  return sql`with ${firstOriginCte(p)}, ${closedCte(p)}
select to_char(((closed_at at time zone 'UTC') at time zone ${p.tz})::date, 'YYYY-MM-DD') as dia,
  currency,
  (amount_cents is not null) as has_amount,
  count(*)::int as n,
  coalesce(sum(amount_cents), 0)::bigint as cents
from closed
where kind = 'won' and ${closedInRange(p)}
group by 1, 2, 3`;
}

/** Los builders con rango (el test de vigilancia recorre esta lista). */
export const SALES_REPORT_SQL = {
  salesSummarySql,
  byAdvisorSql,
  lossReasonsSql,
  timeToCloseSql,
  byDaySql,
} as const;

// ── Forma (filas crudas → DTO) ───────────────────────────────────────────

const SECONDS_PER_DAY = 86_400;

function wonGroup(r: Row) {
  return {
    currency: str(r.currency),
    hasAmount: truthy(r.has_amount),
    won: num(r.n),
    cents: num(r.cents),
  };
}

function averageTicket(won: number, amount: WonAmountDto): number | null {
  const n = wonInMainCurrency(won, amount);
  return n > 0 ? Math.round(amount.amountCents / n) : null;
}

/** Cifras del rango + ganados sin fecha, a partir de `salesSummarySql`. */
export function shapeSalesFigures(
  rows: Row[],
  currency: string
): SalesFiguresDto & { withoutDate: number } {
  let won = 0;
  let lost = 0;
  let approximateCount = 0;
  let withoutDate = 0;
  const wonAmount = emptyAmount(currency);
  for (const r of rows) {
    const n = num(r.n);
    if (truthy(r.no_date)) {
      if (r.kind === "won") withoutDate += n;
      continue;
    }
    if (truthy(r.approximate)) approximateCount += n;
    if (r.kind === "won") {
      won += n;
      addWon(wonAmount, wonGroup(r));
    } else if (r.kind === "lost") {
      lost += n;
    }
  }
  sortOthers(wonAmount);
  return {
    won,
    lost,
    closeRate: ratio(won, won + lost),
    wonAmount,
    averageTicketCents: averageTicket(won, wonAmount),
    approximateCount,
    withoutDate,
  };
}

export function shapeByAdvisor(rows: Row[], currency: string): SalesByAdvisorDto {
  const by = new Map<string, SalesAdvisorRowDto>();
  for (const r of rows) {
    const userId = str(r.advisor_id);
    const key = userId ?? "";
    let row = by.get(key);
    if (!row) {
      row = {
        userId,
        name: userId ? (str(r.advisor_name) ?? userId) : NO_ADVISOR_LABEL,
        won: 0,
        lost: 0,
        closeRate: null,
        wonAmount: emptyAmount(currency),
      };
      by.set(key, row);
    }
    const n = num(r.n);
    if (r.kind === "won") {
      row.won += n;
      addWon(row.wonAmount, wonGroup(r));
    } else if (r.kind === "lost") {
      row.lost += n;
    }
  }
  const out = [...by.values()].map((row) => ({
    ...row,
    closeRate: ratio(row.won, row.won + row.lost),
    wonAmount: sortOthers(row.wonAmount),
  }));
  out.sort(
    (a, b) =>
      Number(a.userId === null) - Number(b.userId === null) ||
      b.won - a.won ||
      b.wonAmount.amountCents - a.wonAmount.amountCents ||
      a.name.localeCompare(b.name, "es")
  );
  return { rows: out };
}

function lossLabel(reason: string): string {
  return reason in LOSS_REASON_LABEL
    ? LOSS_REASON_LABEL[reason as LossReason]
    : NO_LOSS_REASON_LABEL;
}

export function shapeLossReasons(rows: Row[]): SalesLossReasonsDto {
  const by = new Map<string, number>();
  for (const r of rows) {
    const raw = str(r.reason);
    const reason = raw && raw in LOSS_REASON_LABEL ? raw : NO_LOSS_REASON;
    by.set(reason, (by.get(reason) ?? 0) + num(r.n));
  }
  const out = [...by.entries()]
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({ reason, label: lossLabel(reason), count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return { total: out.reduce((a, r) => a + r.count, 0), rows: out };
}

function stageKind(v: unknown): SalesFunnelStageDto["kind"] {
  return v === "won" || v === "lost" ? v : "open";
}

export function shapeFunnel(rows: Row[], currency: string): SalesFunnelDto {
  const stages: SalesFunnelStageDto[] = rows.map((r) => ({
    stageId: String(r.stage_id ?? ""),
    name: String(r.name ?? ""),
    kind: stageKind(r.kind),
    position: num(r.position),
    leads: num(r.leads),
    amountCents: num(r.cents),
    leadsWithoutAmount: num(r.without_amount),
    leadsOtherCurrency: num(r.other_currency),
  }));
  stages.sort((a, b) => a.position - b.position || a.stageId.localeCompare(b.stageId));
  return { currency, stages, totalLeads: stages.reduce((a, s) => a + s.leads, 0) };
}

function days(seconds: unknown): number | null {
  const s = numOrNull(seconds);
  return s === null ? null : s / SECONDS_PER_DAY;
}

export function shapeTimeToClose(rows: Row[]): SalesTimeToCloseDto {
  const row = rows[0] ?? {};
  const sales = num(row.sales);
  return {
    sales,
    excludedApproximate: num(row.approx),
    p50Days: sales ? days(row.p50_s) : null,
    p75Days: sales ? days(row.p75_s) : null,
  };
}

/** Una fila por día del rango, también en cero; monto solo en la principal. */
export function shapeByDay(rows: Row[], dayList: string[], currency: string): SalesByDayDto {
  const by = new Map<string, { won: number; amount: WonAmountDto }>();
  for (const r of rows) {
    const day = String(r.dia ?? "");
    const cell = by.get(day) ?? { won: 0, amount: emptyAmount(currency) };
    cell.won += num(r.n);
    addWon(cell.amount, wonGroup(r));
    by.set(day, cell);
  }
  return {
    currency,
    rows: dayList.map((day) => {
      const cell = by.get(day);
      return { day, won: cell?.won ?? 0, amountCents: cell?.amount.amountCents ?? 0 };
    }),
  };
}

// ── Ejecución ────────────────────────────────────────────────────────────

export type SalesReportDeps = {
  /** Transacción de solo lectura con tope por consulta (`run.ts`). */
  runReadOnly: <T>(fn: (exec: ReportExec) => Promise<T>) => Promise<T>;
  blocks?: RunBlocksOptions;
};

const defaultDeps: SalesReportDeps = { runReadOnly };

function paramsOf(organizationId: string, range: ReportRange): SalesReportParams {
  return { organizationId, fromUtc: range.fromUtc, toUtc: range.toUtc, tz: range.tz };
}

/**
 * El resumen de ventas de un rango con su periodo anterior. Lo comparten
 * Ventas (`summary`) y Resumen (`sales`): una sola definición del número.
 */
export async function salesSummaryOf(
  exec: ReportExec,
  organizationId: string,
  range: ReportRange,
  currency: string
): Promise<SalesSummaryDto> {
  const now = shapeSalesFigures(await exec(salesSummarySql(paramsOf(organizationId, range))), currency);
  const prev = previousRange(range);
  let previous: SalesSummaryDto["previous"] = null;
  if (prev) {
    // `withoutDate` no depende del rango: solo se reporta una vez.
    const f = shapeSalesFigures(
      await exec(salesSummarySql(paramsOf(organizationId, prev))),
      currency
    );
    previous = {
      won: f.won,
      lost: f.lost,
      closeRate: f.closeRate,
      wonAmount: f.wonAmount,
      averageTicketCents: f.averageTicketCents,
      approximateCount: f.approximateCount,
      from: prev.from,
      to: prev.to,
    };
  }
  return { ...now, previous };
}

/**
 * Los seis bloques del reporte de ventas. `currency` = moneda del negocio
 * (Ajustes → Marca): la principal de los montos. Cada bloque en su
 * transacción; uno caído vuelve `{ ok: false }` y los demás se pintan.
 */
export async function salesReport(
  organizationId: string,
  range: ReportRange,
  currency: string,
  deps: SalesReportDeps = defaultDeps
): Promise<SalesReportDto> {
  const p = paramsOf(organizationId, range);
  const run = deps.runReadOnly;
  const rangeDto: ReportRangeDto = toRangeDto(range);

  const blocks = await runBlocks(
    {
      summary: () => run((exec) => salesSummaryOf(exec, organizationId, range, currency)),
      byAdvisor: () =>
        run(async (exec) => shapeByAdvisor(await exec(byAdvisorSql(p)), currency)),
      lossReasons: () => run(async (exec) => shapeLossReasons(await exec(lossReasonsSql(p)))),
      funnel: () => run(async (exec) => shapeFunnel(await exec(funnelSql(p, currency)), currency)),
      timeToClose: () => run(async (exec) => shapeTimeToClose(await exec(timeToCloseSql(p)))),
      byDay: () =>
        run(async (exec) => shapeByDay(await exec(byDaySql(p)), range.days, currency)),
    },
    deps.blocks
  );

  return { range: rangeDto, ...blocks };
}
