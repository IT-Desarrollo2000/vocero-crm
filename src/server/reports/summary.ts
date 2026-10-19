import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { titularDeOrigen } from "@/lib/anuncios";
import { CHANNEL_ORDER, isChannel, type Channel } from "@/lib/channels";
import { LEAD_INTAKE_HEADER, LEAD_INTAKE_TYPE } from "@/lib/lead-intake";
import {
  ADS_REPORT_MAX_ROWS,
  LEAD_ORIGIN_LABEL,
  SUMMARY_PENDING_MAX_ROWS,
  ratio,
  type SummaryAdOriginRowDto,
  type SummaryAttentionDto,
  type SummaryAttentionFiguresDto,
  type SummaryByChannelDto,
  type SummaryByHourDto,
  type SummaryByOriginDto,
  type SummaryChannelRowDto,
  type SummaryExternalLeadsDto,
  type SummaryExternalOriginDto,
  type SummaryOriginFiguresDto,
  type SummaryPendingDto,
  type SummaryReportDto,
} from "@/lib/reports";
import { intakeEnabled } from "@/server/intake/flag";
import { responseTimesSql, shapeResponseTimes, type AgentReportParams } from "./agent";
import {
  addWon,
  emptyAmount,
  firstOriginCte,
  num,
  numOrNull,
  sortOthers,
  str,
  truthy,
  ts,
  type Row,
} from "./common";
import { previousRange, toRangeDto, type ReportRange } from "./range";
import { runBlocks, runReadOnly, type ReportExec, type RunBlocksOptions } from "./run";
import { closedCte, closedInRange, salesSummaryOf } from "./sales";

/**
 * 021 — Reportes → Resumen para dirección (solo Propietario, primera
 * pestaña). Mismo marco que Anuncios y Ventas: `runBlocks` + `runReadOnly`,
 * cada bloque en su transacción.
 *
 * Semántica (plan 021 §3.2; documentada también en `src/lib/reports.ts`):
 *  - PERSONA = conversación real (`is_test = false`) con ≥ 1 mensaje
 *    ENTRANTE en `[fromUtc, toUtc)`. NUEVA = su contacto se creó en el rango.
 *  - Salientes que cuentan: las no fallidas, igual que Agente. IA =
 *    `origin = 'ai'`; asesor = `operator` | `manual`; plantilla = `template`.
 *  - CONTESTADA = tiene un saliente posterior a su primer entrante del rango
 *    (aunque saliera después del rango). ATENDIDA POR ASESOR = uno de esos
 *    salientes fue `operator` | `manual`.
 *  - PASADAS A ASESOR = conversaciones con un escalamiento `opened` (sin
 *    `manual_reply`, como Agente M2/M3) en el rango. Se usa la bitácora y no
 *    `conversation.handoff_at` porque éste se limpia al devolver la
 *    conversación a la IA: un periodo cerrado iría perdiendo escalamientos.
 *  - 021b LEAD del rango = contacto (no Laboratorio) que en el rango escribió
 *    O recibió una tarjeta de lead externo; su PRIMER TOQUE del rango = su
 *    primer entrante o tarjeta del rango. CONTACTADO = un saliente no fallido
 *    (asesor, IA o plantilla) posterior a ese primer toque, en cualquier
 *    conversación real del contacto; ATENDIDO POR ASESOR = uno de asesor.
 *  - 021b POR ORIGEN = el PRIMER TOQUE histórico del contacto (D1 de la 020):
 *    el más antiguo entre su primer anuncio (`ad_attribution`, el de la
 *    ficha) y su primera tarjeta (empate → el anuncio). La tarjeta da su
 *    origen por la cabecera (`LEAD_INTAKE_HEADER`, parámetro ligado). Filas:
 *    un anuncio por `source_id` · Sitio web · FastApp · «Sin origen
 *    identificado». Las ventas del periodo (regla de Ventas) se cuelgan del
 *    origen del lead, aunque no haya tocado el rango.
 *  - 021b LEADS EXTERNOS = por origen de tarjeta, contactos con tarjeta en el
 *    rango: contactados, sin contactar, respondieron (entrante que no es
 *    tarjeta posterior) y tiempo de la tarjeta al primer saliente.
 *  - POR HORA = entrantes por hora local; la zona viaja como PARÁMETRO ligado.
 *  - PENDIENTES = personas del rango sin saliente (no fallido) posterior a su
 *    ÚLTIMO entrante (de cualquier fecha): su último mensaje es entrante. La
 *    que más lleva esperando primero.
 *  - TARJETAS de leads externos (011, `type = 'lead_intake'`): entrantes que
 *    no escribió el cliente. Fuera de personas, mensajes, por hora y del
 *    arranque del reloj del asesor; DENTRO de pendientes (un lead sin
 *    atender está pendiente).
 *  - VENTAS y TIEMPOS DE PRIMERA RESPUESTA no se reimplementan: se reutilizan
 *    `salesSummaryOf` (Ventas) y `responseTimesSql` (Agente M4).
 *
 * Reglas que TODAS las consultas cumplen (un unit test las vigila sobre el
 * SQL renderizado): tenant por `scoped`, Laboratorio fuera, límites como
 * texto `::timestamp`, nada de `now()`.
 */

export type SummaryReportParams = {
  organizationId: string;
  fromUtc: Date;
  toUtc: Date;
  /** Zona del reporte (IANA), parámetro ligado del corte por hora. */
  tz: string;
};

const m = alias(schema.message, "m");
const c = alias(schema.conversation, "c");
const ct = alias(schema.contact, "ct");
const e = alias(schema.conversationHandoffEvent, "e");

/** Tabla + alias para el FROM/JOIN (como en `agent.ts`). */
const M = sql`${schema.message} ${sql.identifier("m")}`;
const C = sql`${schema.conversation} ${sql.identifier("c")}`;
const CT = sql`${schema.contact} ${sql.identifier("ct")}`;
const E = sql`${schema.conversationHandoffEvent} ${sql.identifier("e")}`;
const MSG = schema.message;

/** Orígenes de saliente que cuentan como atención de un asesor. */
const ADVISOR_ORIGINS = sql.raw(`('operator', 'manual')`);

/** Laboratorio fuera, siempre. */
const notTest = sql`${c.isTest} = false`;

/**
 * 011: la TARJETA de un lead externo es un entrante (`direction = 'in'`)
 * pero no la escribió el cliente: no hace persona, no es volumen ni cuenta
 * en la hora, y no arranca el reloj de la primera respuesta (como en
 * `agent.ts`). Sí cuenta en PENDIENTES: un lead sin atender está pendiente.
 */
const notIntake = sql`${m.type} <> ${sql.raw(`'${LEAD_INTAKE_TYPE}'`)}`;
/** La tarjeta misma (021b: hace LEAD y da el origen externo). */
const isIntake = sql`${m.type} = ${sql.raw(`'${LEAD_INTAKE_TYPE}'`)}`;

/** Orígenes de tarjeta: las claves de `LEAD_INTAKE_HEADER`. */
type CardOrigin = keyof typeof LEAD_INTAKE_HEADER;
const CARD_ORIGINS = Object.keys(LEAD_INTAKE_HEADER) as CardOrigin[];

/**
 * El origen de una tarjeta por la PRIMERA línea de su texto (como
 * `parseLeadCard`). La cabecera viaja como parámetro ligado; el resultado es
 * una clave de `LEAD_INTAKE_HEADER` (constante del código). Cabecera
 * desconocida → NULL (cae en «Sin origen identificado»).
 */
function cardOriginOf(text: SQL): SQL {
  const whens = CARD_ORIGINS.map(
    (k) => sql`when ${LEAD_INTAKE_HEADER[k]} then ${sql.raw(`'${k}'`)}`
  );
  return sql`(case btrim(split_part(replace(${text}, chr(13), ''), chr(10), 1)) ${sql.join(whens, sql` `)} end)`;
}

/**
 * `fc` = la PRIMERA tarjeta de cada contacto (de cualquier fecha, en
 * conversaciones reales), con su origen. Mismo orden que `fa`.
 */
function firstCardCte(p: SummaryReportParams): SQL {
  return sql`fc as (
  select distinct on (${c.contactId}) ${c.contactId} as contact_id,
    ${m.createdAt} as first_card_at,
    ${cardOriginOf(sql`${m.text}`)} as card_origin
  from ${M} join ${C} on ${c.id} = ${m.conversationId}
  where ${scoped(m.organizationId, p.organizationId, notTest, sql`${m.direction} = 'in'`, isIntake)}
  order by ${c.contactId}, ${m.createdAt} asc, ${m.id} asc
)`;
}

/**
 * Origen del primer toque histórico, sobre `fa` y `fc` ya unidos: `'ad'`, la
 * clave de la tarjeta (`'website'` | `'fast_app'`) o NULL. Empate → anuncio.
 */
const ORIGIN_KIND = sql`(case
    when fa.attribution_id is not null
      and (fc.first_card_at is null or fa.arrived_at <= fc.first_card_at) then 'ad'
    when fc.first_card_at is not null then fc.card_origin
  end)`;

function msgRange(p: SummaryReportParams): SQL {
  return sql`${m.createdAt} >= ${ts(p.fromUtc)} and ${m.createdAt} < ${ts(p.toUtc)}`;
}

/** ¿Hay un saliente no fallido de la conversación `conv` posterior a `after`? */
function outboundAfter(p: SummaryReportParams, conv: SQL, after: SQL, extra?: SQL): SQL {
  return sql`exists (
    select 1 from ${MSG} rr
    where rr.organization_id = ${p.organizationId}
      and rr.conversation_id = ${conv}
      and rr.direction = 'out' and rr.status <> 'failed'
      and rr.created_at > ${after}${extra ? sql` and ${extra}` : sql``}
  )`;
}

/**
 * `pin` = las personas del rango (primer entrante y entrantes del rango);
 * `persons` = con canal, contacto, ¿nueva?, ¿contestada?, ¿atendida por
 * asesor?
 *
 * Por defecto las tarjetas de leads externos no hacen persona ni arrancan el
 * reloj (`first_in_at`); `withLeadIntake` las incluye (solo PENDIENTES).
 */
function personsCte(
  p: SummaryReportParams,
  opts: { withLeadIntake?: boolean } = {}
): SQL {
  return sql`pin as (
  select ${m.conversationId} as conversation_id,
    min(${m.createdAt}) as first_in_at,
    count(*)::int as inbound
  from ${M} join ${C} on ${c.id} = ${m.conversationId}
  where ${scoped(
    m.organizationId,
    p.organizationId,
    notTest,
    sql`${m.direction} = 'in'`,
    opts.withLeadIntake ? undefined : notIntake,
    msgRange(p)
  )}
  group by ${m.conversationId}
), persons as (
  select pin.conversation_id,
    ${c.contactId} as contact_id,
    ${c.channel} as channel,
    pin.first_in_at,
    pin.inbound,
    (${ct.createdAt} >= ${ts(p.fromUtc)} and ${ct.createdAt} < ${ts(p.toUtc)}) as is_new,
    ${outboundAfter(p, sql`pin.conversation_id`, sql`pin.first_in_at`)} as answered,
    ${outboundAfter(p, sql`pin.conversation_id`, sql`pin.first_in_at`, sql`rr.origin in ${ADVISOR_ORIGINS}`)} as by_advisor
  from pin
  join ${C} on ${c.id} = pin.conversation_id
  join ${CT} on ${ct.id} = ${c.contactId} and ${ct.organizationId} = ${c.organizationId}
  where ${scoped(c.organizationId, p.organizationId)}
)`;
}

/**
 * ¿Hay un mensaje de `dir` (no fallido si es saliente) en alguna conversación
 * REAL del contacto, posterior a `after`? 021b mide al contacto, no a una
 * conversación: la tarjeta y el chat pueden vivir en conversaciones distintas.
 */
function contactMessageAfter(
  p: SummaryReportParams,
  contact: SQL,
  after: SQL,
  dir: "in" | "out",
  extra?: SQL
): SQL {
  const status = dir === "out" ? sql` and rr.status <> 'failed'` : sql``;
  return sql`exists (
    select 1 from ${MSG} rr
    join ${schema.conversation} rc on rc.id = rr.conversation_id
      and rc.organization_id = rr.organization_id
    where rr.organization_id = ${p.organizationId}
      and rc.contact_id = ${contact} and rc.is_test = false
      and rr.direction = ${sql.raw(`'${dir}'`)}${status}
      and rr.created_at > ${after}${extra ? sql` and ${extra}` : sql``}
  )`;
}

/**
 * 021b — `lt` = toques del rango por conversación (entrantes del cliente Y
 * tarjetas); `leads` = uno por CONTACTO: primer toque del rango, personas
 * (conversaciones con mensaje del cliente), mensajes del cliente y ¿nuevo?
 */
function leadsCte(p: SummaryReportParams): SQL {
  return sql`lt as (
  select ${m.conversationId} as conversation_id,
    ${c.contactId} as contact_id,
    min(${m.createdAt}) as first_at,
    (count(*) filter (where ${notIntake}))::int as inbound
  from ${M} join ${C} on ${c.id} = ${m.conversationId}
  where ${scoped(m.organizationId, p.organizationId, notTest, sql`${m.direction} = 'in'`, msgRange(p))}
  group by ${m.conversationId}, ${c.contactId}
), leads as (
  select lt.contact_id,
    min(lt.first_at) as first_at,
    (count(*) filter (where lt.inbound > 0))::int as wrote,
    coalesce(sum(lt.inbound), 0)::int as inbound,
    bool_or(${ct.createdAt} >= ${ts(p.fromUtc)} and ${ct.createdAt} < ${ts(p.toUtc)}) as is_new
  from lt
  join ${CT} on ${ct.id} = lt.contact_id and ${ct.organizationId} = ${p.organizationId}
  group by lt.contact_id
)`;
}

// ── SQL ──────────────────────────────────────────────────────────────────

/** Mensajes del rango por dirección × origen (salientes fallidos y tarjetas de lead fuera). */
export function messagesSql(p: SummaryReportParams): SQL {
  return sql`select ${m.direction} as direction, ${m.origin} as origin, count(*)::int as n
from ${M} join ${C} on ${c.id} = ${m.conversationId}
where ${scoped(
    m.organizationId,
    p.organizationId,
    notTest,
    notIntake,
    sql`(${m.direction} = 'in' or ${m.status} <> 'failed')`,
    msgRange(p)
  )}
group by 1, 2`;
}

/** Personas del rango: total, nuevas, contestadas, atendidas por asesor. */
export function personsSql(p: SummaryReportParams): SQL {
  return sql`with ${personsCte(p)}
select count(*)::int as persons,
  (count(*) filter (where is_new))::int as new_persons,
  (count(*) filter (where answered))::int as answered,
  (count(*) filter (where by_advisor))::int as by_advisor
from persons`;
}

/**
 * Tiempo hasta que atiende un asesor: por persona atendida por asesor, desde
 * su PRIMER entrante del rango hasta el primer saliente de asesor posterior
 * (aunque antes haya contestado la IA). Mediana y p90 en segundos.
 */
export function advisorFirstReplySql(p: SummaryReportParams): SQL {
  return sql`with ${personsCte(p)}, fr as (
  select persons.conversation_id,
    extract(epoch from (min(rr.created_at) - persons.first_in_at)) as secs
  from persons
  join ${MSG} rr on rr.organization_id = ${p.organizationId}
    and rr.conversation_id = persons.conversation_id
    and rr.direction = 'out' and rr.status <> 'failed'
    and rr.origin in ${ADVISOR_ORIGINS}
    and rr.created_at > persons.first_in_at
  group by persons.conversation_id, persons.first_in_at
)
select count(*)::int as persons,
  percentile_cont(0.5) within group (order by secs) as p50_s,
  percentile_cont(0.9) within group (order by secs) as p90_s
from fr`;
}

/** Conversaciones reales con un escalamiento `opened` (sin manual_reply) en el rango. */
export function handedOffSql(p: SummaryReportParams): SQL {
  return sql`select count(distinct ${e.conversationId})::int as n
from ${E} join ${C} on ${c.id} = ${e.conversationId}
where ${scoped(
    e.organizationId,
    p.organizationId,
    notTest,
    sql`${e.kind} = 'opened'`,
    sql`${e.reason} is distinct from 'manual_reply'`,
    sql`${e.createdAt} >= ${ts(p.fromUtc)}`,
    sql`${e.createdAt} < ${ts(p.toUtc)}`
  )}`;
}

/** 021b — KPI «Leads nuevos»: leads del rango y cuántos son contactos nuevos. */
export function leadsSql(p: SummaryReportParams): SQL {
  return sql`with ${leadsCte(p)}
select count(*)::int as leads,
  (count(*) filter (where is_new))::int as new_leads
from leads`;
}

/**
 * 021b — Leads del rango por ORIGEN del primer toque (grupos crudos:
 * `origin` = 'ad' | clave de tarjeta | NULL; `ad_key` solo en anuncios).
 */
export function leadsByOriginSql(p: SummaryReportParams): SQL {
  return sql`with ${firstOriginCte(p)}, ${firstCardCte(p)}, ${leadsCte(p)},
lo as (
  select leads.contact_id, leads.is_new, leads.wrote, leads.inbound,
    ${ORIGIN_KIND} as origin,
    fa.attribution_id, fa.source_id, fa.source_type, fa.headline,
    ${contactMessageAfter(p, sql`leads.contact_id`, sql`leads.first_at`, "out")} as contacted,
    ${contactMessageAfter(p, sql`leads.contact_id`, sql`leads.first_at`, "out", sql`rr.origin in ${ADVISOR_ORIGINS}`)} as by_advisor
  from leads
  left join fa on fa.contact_id = leads.contact_id
  left join fc on fc.contact_id = leads.contact_id
)
select origin,
  case when origin = 'ad' then coalesce(source_id, attribution_id) end as ad_key,
  max(source_id) filter (where origin = 'ad') as source_id,
  max(source_type) filter (where origin = 'ad') as source_type,
  max(headline) filter (where origin = 'ad') as headline,
  count(*)::int as leads,
  (count(*) filter (where is_new))::int as new_leads,
  coalesce(sum(wrote), 0)::int as wrote,
  coalesce(sum(inbound), 0)::int as inbound,
  (count(*) filter (where contacted))::int as contacted,
  (count(*) filter (where by_advisor))::int as by_advisor
from lo
group by 1, 2`;
}

/** Ventas del periodo (regla de Ventas) por ORIGEN del lead × moneda. */
export function salesByOriginSql(p: SummaryReportParams): SQL {
  return sql`with ${firstOriginCte(p)}, ${firstCardCte(p)}, ${closedCte(p)},
so as (
  select ${ORIGIN_KIND} as origin,
    fa.attribution_id, fa.source_id, fa.source_type, fa.headline,
    closed.currency, closed.amount_cents
  from closed
  left join fa on fa.contact_id = closed.contact_id
  left join fc on fc.contact_id = closed.contact_id
  where closed.kind = 'won' and ${closedInRange(p)}
)
select origin,
  case when origin = 'ad' then coalesce(source_id, attribution_id) end as ad_key,
  max(source_id) filter (where origin = 'ad') as source_id,
  max(source_type) filter (where origin = 'ad') as source_type,
  max(headline) filter (where origin = 'ad') as headline,
  currency,
  (amount_cents is not null) as has_amount,
  count(*)::int as n,
  coalesce(sum(amount_cents), 0)::bigint as cents
from so
group by 1, 2, 6, 7`;
}

/**
 * 021b — Leads externos: por contacto y origen de tarjeta, su PRIMERA tarjeta
 * del rango; ¿contactado? (y cuándo), ¿respondió? Por origen, con p50/p90
 * de la tarjeta al primer saliente no fallido.
 */
export function externalLeadsSql(p: SummaryReportParams): SQL {
  const firstOut = sql`(
    select min(rr.created_at) from ${MSG} rr
    join ${schema.conversation} rc on rc.id = rr.conversation_id
      and rc.organization_id = rr.organization_id
    where rr.organization_id = ${p.organizationId}
      and rc.contact_id = cards.contact_id and rc.is_test = false
      and rr.direction = 'out' and rr.status <> 'failed'
      and rr.created_at > cards.card_at
  )`;
  const secs = sql`extract(epoch from (first_out_at - card_at))`;
  return sql`with cards0 as (
  select ${c.contactId} as contact_id,
    ${m.id} as id,
    ${m.createdAt} as card_at,
    ${cardOriginOf(sql`${m.text}`)} as origin
  from ${M} join ${C} on ${c.id} = ${m.conversationId}
  where ${scoped(m.organizationId, p.organizationId, notTest, sql`${m.direction} = 'in'`, isIntake, msgRange(p))}
), cards as (
  select distinct on (contact_id, origin) contact_id, origin, card_at
  from cards0
  where origin is not null
  order by contact_id, origin, card_at asc, id asc
), ext as (
  select cards.origin, cards.card_at,
    ${firstOut} as first_out_at,
    ${contactMessageAfter(p, sql`cards.contact_id`, sql`cards.card_at`, "in", sql`rr.type <> ${sql.raw(`'${LEAD_INTAKE_TYPE}'`)}`)} as replied
  from cards
)
select origin,
  count(*)::int as received,
  count(first_out_at)::int as contacted,
  (count(*) filter (where replied))::int as replied,
  percentile_cont(0.5) within group (order by ${secs}) filter (where first_out_at is not null) as p50_s,
  percentile_cont(0.9) within group (order by ${secs}) filter (where first_out_at is not null) as p90_s
from ext
group by origin`;
}

/** Personas del rango por canal. */
export function byChannelSql(p: SummaryReportParams): SQL {
  return sql`with ${personsCte(p)}
select channel,
  count(*)::int as persons,
  coalesce(sum(inbound), 0)::int as inbound,
  (count(*) filter (where answered))::int as answered,
  (count(*) filter (where by_advisor))::int as by_advisor
from persons
group by 1`;
}

/** Entrantes del rango por hora local (la zona es un parámetro ligado). */
export function byHourSql(p: SummaryReportParams): SQL {
  return sql`select extract(hour from ((${m.createdAt} at time zone 'UTC') at time zone ${p.tz}))::int as hora,
  count(*)::int as n
from ${M} join ${C} on ${c.id} = ${m.conversationId}
where ${scoped(m.organizationId, p.organizationId, notTest, notIntake, sql`${m.direction} = 'in'`, msgRange(p))}
group by 1`;
}

/**
 * Pendientes de respuesta: personas del rango sin saliente no fallido
 * posterior a su ÚLTIMO entrante. La que más lleva esperando primero; `total`
 * = todas (la ventana se calcula antes del LIMIT).
 */
export function pendingSql(p: SummaryReportParams): SQL {
  // Con las tarjetas: un lead externo sin atender SÍ está pendiente.
  return sql`with ${firstOriginCte(p)}, ${personsCte(p, { withLeadIntake: true })},
pend as (
  select persons.conversation_id, persons.contact_id, persons.channel,
    li.last_in_at
  from persons
  join lateral (
    select max(li1.created_at) as last_in_at from ${MSG} li1
    where li1.organization_id = ${p.organizationId}
      and li1.conversation_id = persons.conversation_id and li1.direction = 'in'
  ) li on true
  where not ${outboundAfter(p, sql`persons.conversation_id`, sql`li.last_in_at`)}
)
select pend.conversation_id, pend.contact_id, pend.channel,
  ${ct.name} as contact_name,
  to_char(pend.last_in_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_in_at,
  (fa.attribution_id is not null) as has_ad,
  fa.headline, fa.source_type,
  (count(*) over ())::int as total
from pend
join ${CT} on ${ct.id} = pend.contact_id and ${ct.organizationId} = ${p.organizationId}
left join fa on fa.contact_id = pend.contact_id
order by pend.last_in_at asc, pend.conversation_id asc
limit ${SUMMARY_PENDING_MAX_ROWS}`;
}

/** Todos los builders (el test de vigilancia recorre esta lista). */
export const SUMMARY_REPORT_SQL = {
  messagesSql,
  personsSql,
  advisorFirstReplySql,
  handedOffSql,
  leadsSql,
  leadsByOriginSql,
  salesByOriginSql,
  externalLeadsSql,
  byChannelSql,
  byHourSql,
  pendingSql,
} as const;

// ── Forma (filas crudas → DTO) ───────────────────────────────────────────

export function shapeAttentionFigures(
  messageRows: Row[],
  personRows: Row[],
  handoffRows: Row[],
  firstReplyRows: Row[] = [],
  leadRows: Row[] = []
): SummaryAttentionFiguresDto {
  let inbound = 0;
  const byOrigin = { ai: 0, advisor: 0, template: 0 };
  for (const r of messageRows) {
    const n = num(r.n);
    if (r.direction === "in") inbound += n;
    else if (r.direction === "out") {
      if (r.origin === "ai") byOrigin.ai += n;
      else if (r.origin === "operator" || r.origin === "manual") byOrigin.advisor += n;
      else if (r.origin === "template") byOrigin.template += n;
    }
  }
  const row = personRows[0] ?? {};
  const persons = num(row.persons);
  const answered = num(row.answered);
  const attendedByAdvisor = num(row.by_advisor);
  return {
    inbound,
    outbound: byOrigin.ai + byOrigin.advisor + byOrigin.template,
    outboundByOrigin: byOrigin,
    persons,
    newPersons: num(row.new_persons),
    answered,
    answeredRate: ratio(answered, persons),
    attendedByAdvisor,
    attendedByAdvisorRate: ratio(attendedByAdvisor, persons),
    handedOff: num(handoffRows[0]?.n),
    advisorFirstReply: (() => {
      const fr = firstReplyRows[0];
      const n = num(fr?.persons);
      return {
        persons: n,
        p50Seconds: n ? numOrNull(fr?.p50_s) : null,
        p90Seconds: n ? numOrNull(fr?.p90_s) : null,
      };
    })(),
    leads: num(leadRows[0]?.leads),
    newLeads: num(leadRows[0]?.new_leads),
  };
}

function emptyOriginFigures(currency: string): SummaryOriginFiguresDto {
  return {
    leads: 0,
    newLeads: 0,
    wrote: 0,
    inbound: 0,
    contacted: 0,
    attendedByAdvisor: 0,
    won: 0,
    wonAmount: emptyAmount(currency),
  };
}

function isCardOrigin(v: unknown): v is CardOrigin {
  return typeof v === "string" && (CARD_ORIGINS as string[]).includes(v);
}

/**
 * 021b — Une leads y ventas por origen. Un anuncio con ventas del periodo y
 * sin leads también sale. Anuncios: orden leads, ventas, monto; tope
 * `ADS_REPORT_MAX_ROWS`. `totals` suma TODOS los grupos antes del tope.
 */
export function shapeSummaryByOrigin(
  leadRows: Row[],
  salesRows: Row[],
  currency: string
): SummaryByOriginDto {
  const unidentified = emptyOriginFigures(currency);
  const cards: Record<CardOrigin, SummaryOriginFiguresDto> = {
    website: emptyOriginFigures(currency),
    fast_app: emptyOriginFigures(currency),
  };
  const totals = emptyOriginFigures(currency);
  const ads = new Map<string, SummaryAdOriginRowDto>();
  const rowOf = (r: Row): SummaryOriginFiguresDto => {
    const origin = str(r.origin);
    if (isCardOrigin(origin)) return cards[origin];
    const key = origin === "ad" ? str(r.ad_key) : null;
    if (!key) return unidentified;
    let row = ads.get(key);
    if (!row) {
      const sourceType = str(r.source_type);
      row = {
        key,
        sourceId: str(r.source_id),
        sourceType,
        title: titularDeOrigen(str(r.headline), sourceType),
        ...emptyOriginFigures(currency),
      };
      ads.set(key, row);
    }
    return row;
  };
  for (const r of leadRows) {
    for (const row of [rowOf(r), totals]) {
      row.leads += num(r.leads);
      row.newLeads += num(r.new_leads);
      row.wrote += num(r.wrote);
      row.inbound += num(r.inbound);
      row.contacted += num(r.contacted);
      row.attendedByAdvisor += num(r.by_advisor);
    }
  }
  for (const r of salesRows) {
    const n = num(r.n);
    for (const row of [rowOf(r), totals]) {
      row.won += n;
      addWon(row.wonAmount, {
        currency: str(r.currency),
        hasAmount: truthy(r.has_amount),
        won: n,
        cents: num(r.cents),
      });
    }
  }
  const sorted = <T extends SummaryOriginFiguresDto>(f: T): T => ({
    ...f,
    wonAmount: sortOthers(f.wonAmount),
  });
  const all = [...ads.values()].map(sorted);
  all.sort(
    (a, b) =>
      b.leads - a.leads ||
      b.won - a.won ||
      b.wonAmount.amountCents - a.wonAmount.amountCents ||
      a.key.localeCompare(b.key)
  );
  return {
    rows: all.slice(0, ADS_REPORT_MAX_ROWS),
    total: all.length,
    website: sorted(cards.website),
    fastApp: sorted(cards.fast_app),
    unidentified: sorted(unidentified),
    totals: sorted(totals),
  };
}

/** 021b — Siempre las dos filas (Sitio web, FastApp), también en cero. */
export function shapeExternalLeads(rows: Row[]): SummaryExternalLeadsDto {
  return {
    rows: CARD_ORIGINS.map((origin): SummaryExternalOriginDto => {
      const r = rows.find((x) => x.origin === origin) ?? {};
      const received = num(r.received);
      const contacted = num(r.contacted);
      return {
        origin,
        label: LEAD_ORIGIN_LABEL[origin],
        received,
        contacted,
        notContacted: Math.max(0, received - contacted),
        replied: num(r.replied),
        firstContact: {
          measured: contacted,
          p50Seconds: contacted ? numOrNull(r.p50_s) : null,
          p90Seconds: contacted ? numOrNull(r.p90_s) : null,
        },
      };
    }),
  };
}

/** WhatsApp siempre + los canales con personas, en orden fijo. */
export function shapeSummaryByChannel(rows: Row[]): SummaryByChannelDto {
  const by = new Map<Channel, SummaryChannelRowDto>();
  const rowOf = (channel: Channel) => {
    let row = by.get(channel);
    if (!row) {
      row = { channel, persons: 0, inbound: 0, answered: 0, attendedByAdvisor: 0 };
      by.set(channel, row);
    }
    return row;
  };
  rowOf("whatsapp");
  for (const r of rows) {
    const ch = String(r.channel);
    if (!isChannel(ch)) continue;
    const row = rowOf(ch);
    row.persons += num(r.persons);
    row.inbound += num(r.inbound);
    row.answered += num(r.answered);
    row.attendedByAdvisor += num(r.by_advisor);
  }
  return { rows: CHANNEL_ORDER.filter((ch) => by.has(ch)).map((ch) => by.get(ch)!) };
}

/** Las 24 horas locales, también en cero. */
export function shapeSummaryByHour(rows: Row[]): SummaryByHourDto {
  const counts = new Array<number>(24).fill(0);
  for (const r of rows) {
    const h = num(r.hora);
    if (Number.isInteger(h) && h >= 0 && h < 24) counts[h] = (counts[h] ?? 0) + num(r.n);
  }
  return { rows: counts.map((inbound, hour) => ({ hour, inbound })) };
}

export function shapePending(rows: Row[]): SummaryPendingDto {
  const out: SummaryPendingDto["rows"] = [];
  for (const r of rows) {
    const ch = String(r.channel);
    if (!isChannel(ch)) continue;
    out.push({
      conversationId: String(r.conversation_id ?? ""),
      contactId: String(r.contact_id ?? ""),
      contactName: str(r.contact_name),
      channel: ch,
      adTitle: truthy(r.has_ad) ? titularDeOrigen(str(r.headline), str(r.source_type)) : null,
      lastInboundAt: String(r.last_in_at ?? ""),
    });
  }
  return {
    total: rows.length > 0 ? num(rows[0]?.total) : 0,
    rows: out.slice(0, SUMMARY_PENDING_MAX_ROWS),
  };
}

// ── Ejecución ────────────────────────────────────────────────────────────

export type SummaryReportDeps = {
  /** Transacción de solo lectura con tope por consulta (`run.ts`). */
  runReadOnly: <T>(fn: (exec: ReportExec) => Promise<T>) => Promise<T>;
  /** Reloj que pide `AgentReportParams` (M4 no lo usa). */
  now: () => Date;
  blocks?: RunBlocksOptions;
  /** 021b — bandera `LEADS_EXTERNOS` (por defecto, la del entorno). */
  intakeEnabled?: () => boolean;
};

const defaultDeps: SummaryReportDeps = { runReadOnly, now: () => new Date(), intakeEnabled };

function paramsOf(organizationId: string, range: ReportRange): SummaryReportParams {
  return { organizationId, fromUtc: range.fromUtc, toUtc: range.toUtc, tz: range.tz };
}

async function attentionOf(exec: ReportExec, p: SummaryReportParams) {
  return shapeAttentionFigures(
    await exec(messagesSql(p)),
    await exec(personsSql(p)),
    await exec(handedOffSql(p)),
    await exec(advisorFirstReplySql(p)),
    await exec(leadsSql(p))
  );
}

/**
 * Los ocho bloques del Resumen. `currency` = moneda del negocio (Ajustes →
 * Marca). Cada bloque en su transacción; uno caído vuelve `{ ok: false }` y
 * los demás se pintan.
 */
export async function summaryReport(
  organizationId: string,
  range: ReportRange,
  currency: string,
  deps: SummaryReportDeps = defaultDeps
): Promise<SummaryReportDto> {
  const p = paramsOf(organizationId, range);
  const prev = previousRange(range);
  const run = deps.runReadOnly;
  const agentParams: AgentReportParams = { ...p, now: deps.now() };

  const blocks = await runBlocks(
    {
      attention: () =>
        run(async (exec): Promise<SummaryAttentionDto> => {
          const now = await attentionOf(exec, p);
          const previous = prev
            ? {
                ...(await attentionOf(exec, paramsOf(organizationId, prev))),
                from: prev.from,
                to: prev.to,
              }
            : null;
          return { ...now, previous };
        }),
      byOrigin: () =>
        run(async (exec) =>
          shapeSummaryByOrigin(
            await exec(leadsByOriginSql(p)),
            await exec(salesByOriginSql(p)),
            currency
          )
        ),
      external: () => run(async (exec) => shapeExternalLeads(await exec(externalLeadsSql(p)))),
      byChannel: () => run(async (exec) => shapeSummaryByChannel(await exec(byChannelSql(p)))),
      byHour: () => run(async (exec) => shapeSummaryByHour(await exec(byHourSql(p)))),
      pending: () => run(async (exec) => shapePending(await exec(pendingSql(p)))),
      sales: () => run((exec) => salesSummaryOf(exec, organizationId, range, currency)),
      responseTimes: () =>
        run((exec) => exec(responseTimesSql(agentParams)).then(shapeResponseTimes)),
    },
    deps.blocks
  );

  return {
    range: toRangeDto(range),
    intakeEnabled: (deps.intakeEnabled ?? intakeEnabled)(),
    ...blocks,
  };
}
