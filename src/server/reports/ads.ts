import { sql, type SQL } from "drizzle-orm";
import { schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { tipoDeOrigen, titularDeOrigen } from "@/lib/anuncios";
import {
  ADS_REPORT_MAX_ROWS,
  ratio,
  type AdRowDto,
  type AdSourceKey,
  type AdsByAdDto,
  type AdsBySourceDto,
  type AdsReportDto,
  type AdsSourceRowDto,
  type AdsSummaryDto,
  type AdsSummaryFiguresDto,
} from "@/lib/reports";
import type { SourceValue } from "@/lib/types";
import { effectiveSource, isSourceValue, SOURCE_LABELS, SOURCE_VALUES } from "@/server/contact-source";
import {
  addWon,
  emptyAmount,
  firstOriginCte,
  notLabContact,
  num,
  sortOthers,
  str,
  truthy,
  ts,
  type Row,
} from "./common";
import { previousRange, toRangeDto, type ReportRange } from "./range";
import { runBlocks, runReadOnly, type ReportExec, type RunBlocksOptions } from "./run";

/**
 * 020 fase B — Reportes → Anuncios (solo Propietario, D4). Mismo marco que
 * Agente y Citas: `parseReportRange` + `reportTimezone` en la ruta, y aquí
 * `runBlocks` + `runReadOnly` con tres bloques independientes (`summary`,
 * `bySource`, `byAd`).
 *
 * Semántica (la misma en los tres bloques; documentada en `src/lib/reports.ts`
 * y en el plan 020 §8.5):
 *  - LEAD en el rango = su FECHA DE LLEGADA cae en `[fromUtc, toUtc)`: la del
 *    PRIMER anuncio de origen del contacto si tiene (D1), si no la de alta del
 *    lead.
 *  - GANADO = de esos leads, los que HOY están en una etapa `won`.
 *  - MONTO = `amount_cents` de los ganados, por moneda (NULL = la del negocio).
 *  - CONVERSACIONES = las reales (`is_test = false`) creadas en el rango.
 *
 * La FUENTE EFECTIVA no se reimplementa en SQL: las consultas devuelven grupos
 * crudos por (fuente capturada, ¿tiene origen?, `source_type` del primer
 * origen) y se pliegan aquí con `tipoDeOrigen` + `effectiveSource`, las mismas
 * funciones de la ficha. Si la deducción cambia, el reporte cambia con ella.
 *
 * El PRIMER origen se elige como `primeraFilaDelContacto` (store.ts):
 * `created_at asc, id asc`, sin filtrar `is_test` en la atribución (la ficha
 * tampoco). El Laboratorio sale a nivel contacto (su única conversación es de
 * prueba) y a nivel conversación (`is_test = false`).
 *
 * Reglas que TODAS las consultas cumplen (un unit test las vigila sobre el
 * SQL renderizado): tenant por `scoped`, límites como texto `::timestamp`,
 * nada de `now()`.
 */

export type AdsReportParams = {
  organizationId: string;
  fromUtc: Date;
  toUtc: Date;
};

const A = schema.adAttribution;
const L = schema.lead;
const CT = schema.contact;
const S = schema.pipelineStage;
const C = schema.conversation;

/** Los leads de la cohorte del rango, con su primer origen y su desenlace. */
function cohortCte(p: AdsReportParams): SQL {
  return sql`cohort as (
  select ${L.id} as lead_id,
    ${CT.source} as stored_source,
    (fa.attribution_id is not null) as has_origin,
    fa.attribution_id,
    fa.source_id,
    fa.source_type,
    fa.headline,
    fa.media_type,
    fa.arrived_at,
    coalesce(fa.source_id, fa.attribution_id) as ad_key,
    (${S.kind} = 'won') as won,
    ${L.amountCents} as amount_cents,
    ${L.currency} as currency
  from ${L}
  join ${CT} on ${CT.id} = ${L.contactId} and ${CT.organizationId} = ${L.organizationId}
  join ${S} on ${S.id} = ${L.stageId} and ${S.organizationId} = ${L.organizationId}
  left join fa on fa.contact_id = ${L.contactId}
  where ${scoped(
    L.organizationId,
    p.organizationId,
    notLabContact(p),
    sql`coalesce(fa.arrived_at, ${L.createdAt}) >= ${ts(p.fromUtc)}`,
    sql`coalesce(fa.arrived_at, ${L.createdAt}) < ${ts(p.toUtc)}`
  )}
)`;
}

// ── SQL ──────────────────────────────────────────────────────────────────

/** Conversaciones reales creadas en el rango, por grupo crudo de fuente. */
export function conversationsBySourceSql(p: AdsReportParams): SQL {
  return sql`with ${firstOriginCte(p)}
select ${CT.source} as stored_source,
  (fa.attribution_id is not null) as has_origin,
  fa.source_type as origin_type,
  count(*)::int as n
from ${C}
join ${CT} on ${CT.id} = ${C.contactId} and ${CT.organizationId} = ${C.organizationId}
left join fa on fa.contact_id = ${C.contactId}
where ${scoped(
    C.organizationId,
    p.organizationId,
    sql`${C.isTest} = false`,
    sql`${C.createdAt} >= ${ts(p.fromUtc)}`,
    sql`${C.createdAt} < ${ts(p.toUtc)}`
  )}
group by 1, 2, 3`;
}

/**
 * Leads de la cohorte por grupo crudo de fuente × desenlace × moneda. El
 * monto solo importa en los ganados; los demás se agrupan sin moneda.
 */
export function leadsBySourceSql(p: AdsReportParams): SQL {
  return sql`with ${firstOriginCte(p)}, ${cohortCte(p)}
select stored_source,
  has_origin,
  source_type as origin_type,
  won,
  case when won then currency end as currency,
  (won and amount_cents is not null) as has_amount,
  count(*)::int as n,
  coalesce(sum(case when won then amount_cents end), 0)::bigint as cents
from cohort
group by 1, 2, 3, 4, 5, 6`;
}

/**
 * Por anuncio (D2): una fila por `source_id` (o por fila de atribución si
 * Meta no mandó id), con cada lead contado UNA vez con su primer origen.
 * Ordenado por leads; como mucho `ADS_REPORT_MAX_ROWS`. La miniatura se busca
 * en CUALQUIER fila del mismo `source_id` (una por anuncio, y puede haberse
 * copiado después en otra conversación). `total` = anuncios distintos.
 */
export function byAdSql(p: AdsReportParams): SQL {
  return sql`with ${firstOriginCte(p)}, ${cohortCte(p)},
ads as (
  select ad_key,
    max(source_id) as source_id,
    max(source_type) as source_type,
    max(headline) as headline,
    max(media_type) as media_type,
    max(arrived_at) as last_at,
    count(*)::int as leads,
    (count(*) filter (where won))::int as won
  from cohort
  where has_origin
  group by ad_key
),
top as (
  select * from ads
  order by leads desc, won desc, last_at desc, ad_key asc
  limit ${ADS_REPORT_MAX_ROWS}
),
amt as (
  select ad_key, currency, (amount_cents is not null) as has_amount,
    count(*)::int as n,
    coalesce(sum(amount_cents), 0)::bigint as cents
  from cohort
  where has_origin and won and ad_key in (select ad_key from top)
  group by 1, 2, 3
)
select top.ad_key, top.source_id, top.source_type, top.headline, top.media_type,
  top.leads, top.won,
  (
    select max(img.image_asset_id) from ${A} img
    where img.organization_id = ${p.organizationId}
      and (img.source_id = top.source_id or img.id = top.ad_key)
  ) as image_asset_id,
  (select count(*)::int from ads) as total,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'currency', amt.currency, 'has_amount', amt.has_amount,
      'won', amt.n, 'cents', amt.cents))
    from amt where amt.ad_key = top.ad_key
  ), '[]'::jsonb) as amounts
from top
order by top.leads desc, top.won desc, top.last_at desc, top.ad_key asc`;
}

export const ADS_REPORT_SQL = {
  conversationsBySourceSql,
  leadsBySourceSql,
  byAdSql,
};

// ── Forma (filas crudas → DTO) ───────────────────────────────────────────

/** Orden fijo de las filas por fuente. */
export const ADS_SOURCE_ORDER: readonly AdSourceKey[] = [...SOURCE_VALUES, "desconocida"];

/**
 * La fuente efectiva de un grupo crudo — EXACTAMENTE `effectiveSource` sobre
 * `tipoDeOrigen` del primer origen. Un valor capturado fuera del catálogo
 * (no debería existir: el CHECK de la columna lo impide) se trata como no
 * capturado.
 */
export function sourceOfGroup(r: Row): AdSourceKey {
  const stored: SourceValue | null = isSourceValue(r.stored_source) ? r.stored_source : null;
  const origen = tipoDeOrigen(
    truthy(r.has_origin) ? { sourceType: str(r.origin_type ?? r.source_type) } : null
  );
  return effectiveSource(stored, origen).value;
}

/**
 * Las seis fuentes en su orden fijo. Se enseñan TODAS (también en cero): el
 * dueño ve que «Referido» existe aunque hoy no tenga nada.
 */
export function shapeBySource(
  convRows: Row[],
  leadRows: Row[],
  currency: string
): AdsBySourceDto {
  const rows = new Map<AdSourceKey, AdsSourceRowDto>(
    ADS_SOURCE_ORDER.map((value) => [
      value,
      {
        value,
        label: SOURCE_LABELS[value],
        conversations: 0,
        leads: 0,
        won: 0,
        winRate: null,
        wonAmount: emptyAmount(currency),
      },
    ])
  );
  for (const r of convRows) {
    rows.get(sourceOfGroup(r))!.conversations += num(r.n);
  }
  for (const r of leadRows) {
    const row = rows.get(sourceOfGroup(r))!;
    const n = num(r.n);
    row.leads += n;
    if (truthy(r.won)) {
      row.won += n;
      addWon(row.wonAmount, {
        currency: str(r.currency),
        hasAmount: truthy(r.has_amount),
        won: n,
        cents: num(r.cents),
      });
    }
  }
  return {
    rows: ADS_SOURCE_ORDER.map((k) => {
      const row = rows.get(k)!;
      sortOthers(row.wonAmount);
      return { ...row, winRate: ratio(row.won, row.leads) };
    }),
  };
}

/** Cifras del resumen a partir del desglose por fuente. */
export function summaryFigures(bySource: AdsBySourceDto, currency: string): AdsSummaryFiguresDto {
  const conversations = bySource.rows.reduce((a, r) => a + r.conversations, 0);
  const ad = bySource.rows.find((r) => r.value === "anuncio");
  return {
    conversations,
    adConversations: ad?.conversations ?? 0,
    adShare: ratio(ad?.conversations ?? 0, conversations),
    adLeads: ad?.leads ?? 0,
    adWon: ad?.won ?? 0,
    adWonAmount: ad?.wonAmount ?? emptyAmount(currency),
  };
}

export function shapeByAd(rows: Row[], currency: string): AdsByAdDto {
  const out: AdRowDto[] = rows.map((r) => {
    const won = num(r.won);
    const leads = num(r.leads);
    const sourceType = str(r.source_type);
    const asset = str(r.image_asset_id);
    const amount = emptyAmount(currency);
    const groups = Array.isArray(r.amounts) ? (r.amounts as Row[]) : [];
    for (const g of groups) {
      addWon(amount, {
        currency: str(g.currency),
        hasAmount: truthy(g.has_amount),
        won: num(g.won),
        cents: num(g.cents),
      });
    }
    return {
      key: String(r.ad_key ?? ""),
      sourceId: str(r.source_id),
      sourceType,
      title: titularDeOrigen(str(r.headline), sourceType),
      mediaType: str(r.media_type),
      imageUrl: asset ? `/api/media/${asset}` : null,
      leads,
      won,
      winRate: ratio(won, leads),
      wonAmount: sortOthers(amount),
    };
  });
  return { rows: out, total: rows.length > 0 ? num(rows[0]?.total) : 0 };
}

// ── Ejecución ────────────────────────────────────────────────────────────

export type AdsReportDeps = {
  /** Transacción de solo lectura con tope por consulta (`run.ts`). */
  runReadOnly: <T>(fn: (exec: ReportExec) => Promise<T>) => Promise<T>;
  blocks?: RunBlocksOptions;
};

const defaultDeps: AdsReportDeps = { runReadOnly };

async function bySourceOf(exec: ReportExec, p: AdsReportParams, currency: string) {
  return shapeBySource(
    await exec(conversationsBySourceSql(p)),
    await exec(leadsBySourceSql(p)),
    currency
  );
}

/**
 * Los tres bloques del reporte de anuncios. `currency` = moneda del negocio
 * (Ajustes → Marca): la principal de los montos. Cada bloque en su
 * transacción; uno caído vuelve `{ ok: false }` y los demás se pintan.
 */
export async function adsReport(
  organizationId: string,
  range: ReportRange,
  currency: string,
  deps: AdsReportDeps = defaultDeps
): Promise<AdsReportDto> {
  const p: AdsReportParams = {
    organizationId,
    fromUtc: range.fromUtc,
    toUtc: range.toUtc,
  };
  const prev = previousRange(range);
  const run = deps.runReadOnly;

  const blocks = await runBlocks(
    {
      summary: () =>
        run(async (exec): Promise<AdsSummaryDto> => {
          const now = summaryFigures(await bySourceOf(exec, p, currency), currency);
          const previous = prev
            ? {
                ...summaryFigures(
                  await bySourceOf(
                    exec,
                    { organizationId, fromUtc: prev.fromUtc, toUtc: prev.toUtc },
                    currency
                  ),
                  currency
                ),
                from: prev.from,
                to: prev.to,
              }
            : null;
          return { ...now, previous };
        }),
      bySource: () => run((exec) => bySourceOf(exec, p, currency)),
      byAd: () => run(async (exec) => shapeByAd(await exec(byAdSql(p)), currency)),
    },
    deps.blocks
  );

  return { range: toRangeDto(range), ...blocks };
}
