import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { CHANNEL_ORDER, isChannel, type Channel } from "@/lib/channels";
import { handoffLabel } from "@/lib/handoff-labels";
import {
  ratio,
  type AfterHandoffDto,
  type AgentReportDto,
  type AttentionDto,
  type DeliveryDto,
  type EscalationReasonDto,
  type EscalationSampleDto,
  type EscalationsDto,
  type FailuresDto,
  type ResponderTimesDto,
  type ResponseTimesDto,
  type VolumeDto,
  type VolumeRowDto,
} from "@/lib/reports";
import { CHANNEL_CAPABILITIES } from "@/server/channels/capabilities";
import { toRangeDto, type ReportRange } from "./range";
import { runBlocks, runReadOnly, type ReportExec, type RunBlocksOptions } from "./run";

/**
 * 02 — Reporte del agente: M1–M8 (dev-tasks/02-metricas-del-agente.md,
 * «Definiciones de métricas» + «Contrato 05/02-0»).
 *
 * Reglas que TODAS las consultas cumplen (un unit test las vigila sobre el
 * SQL renderizado):
 * - `join conversation c … c.is_test = false`: el Laboratorio nunca cuenta.
 * - Tenant por `scoped(...)` (Constitución III).
 * - Rango sobre `created_at` (`message_org_created_idx` /
 *   `hoe_org_created_idx`) con límites calculados en Node y enlazados como
 *   texto `::timestamp` — un `Date` viajaría como timestamptz y Postgres
 *   convertiría la columna con el `TimeZone` de la sesión.
 * - `manual_reply` (pausa por respuesta desde el teléfono) queda FUERA de M3,
 *   M5 y del CTE `esc` de M2 (`reason is distinct from 'manual_reply'`: una
 *   fila sembrada sin motivo sigue contando); se reporta aparte como
 *   «Pausas por respuesta manual».
 * - `approximate = true` (siembra de 0017) cuenta para totales, jamás para
 *   tiempos (M5).
 *
 * Los builders `*Sql` son puros (se prueban renderizándolos); los `shape*`
 * convierten filas crudas — con el driver de drizzle los `count` llegan como
 * texto y las fechas sin `Z` — al DTO de `src/lib/reports.ts`.
 */

export type AgentReportParams = {
  organizationId: string;
  fromUtc: Date;
  toUtc: Date;
  tz: string;
  /** Reloj del corte de M7 (ahora − 15 min). */
  now: Date;
};

const m = alias(schema.message, "m");
const r = alias(schema.message, "r");
const c = alias(schema.conversation, "c");
const e = alias(schema.conversationHandoffEvent, "e");
const ct = alias(schema.contact, "ct");

/**
 * Tabla + alias para el FROM/JOIN (`"message" "m"`): dentro de `sql` un alias
 * de drizzle solo rinde su nombre, así que la tabla se nombra explícita.
 */
const M = sql`${schema.message} ${sql.identifier("m")}`;
const R = sql`${schema.message} ${sql.identifier("r")}`;
const C = sql`${schema.conversation} ${sql.identifier("c")}`;
const E = sql`${schema.conversationHandoffEvent} ${sql.identifier("e")}`;
const CT = sql`${schema.contact} ${sql.identifier("ct")}`;

/** Orígenes de saliente que cuentan como respuesta humana (D-02-3: plantillas sí). */
const HUMAN_ORIGINS = sql.raw(`('operator', 'manual', 'template')`);
/** M7 excluye lo que acaba de salir: aún puede estar en vuelo. */
export const DELIVERY_GRACE_MS = 15 * 60 * 1000;
/** M4: un entrante abre sesión si lo anterior tiene ≥ 24 h (o no hay nada). */
const SESSION_GAP_MS = 24 * 60 * 60 * 1000;
/** Muestras de notas por motivo (RF-02-06). */
export const ESCALATION_SAMPLES = 5;
/** Top de errores de M6. */
export const TOP_ERRORS = 5;

/** `Date` → literal `timestamp` sin zona, en UTC (`YYYY-MM-DD HH:MM:SS.mmm`). */
export function pgTimestamp(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

function ts(d: Date): SQL {
  return sql`${pgTimestamp(d)}::timestamp`;
}

/** Laboratorio fuera, siempre. */
const notTest = sql`${c.isTest} = false`;

function msgRange(from: Date, to: Date): SQL {
  return sql`${m.createdAt} >= ${ts(from)} and ${m.createdAt} < ${ts(to)}`;
}

function eventRange(p: AgentReportParams): SQL {
  return sql`${e.createdAt} >= ${ts(p.fromUtc)} and ${e.createdAt} < ${ts(p.toUtc)}`;
}

const notManualReply = sql`${e.reason} is distinct from 'manual_reply'`;

/** Canales con acuses de entrega/lectura: salen del código, no se hardcodean. */
export function deliveryChannels(): Channel[] {
  return CHANNEL_ORDER.filter((ch) => CHANNEL_CAPABILITIES[ch].deliveryReceipts);
}

/** Corte de M7: min(to, ahora − 15 min). */
export function deliveryCutoff(toUtc: Date, now: Date): Date {
  return new Date(Math.min(toUtc.getTime(), now.getTime() - DELIVERY_GRACE_MS));
}

// ── SQL ──────────────────────────────────────────────────────────────────

/** M1 + M2 — reparto de atención de las conversaciones activas. */
export function attentionSql(p: AgentReportParams): SQL {
  return sql`with act as (
  select ${m.conversationId} as conversation_id,
    bool_or(${m.direction} = 'in') as has_in,
    bool_or(${m.direction} = 'out' and ${m.origin} = 'ai' and ${m.status} <> 'failed') as has_ai,
    bool_or(${m.direction} = 'out' and ${m.origin} in ${HUMAN_ORIGINS} and ${m.status} <> 'failed') as has_human
  from ${M} join ${C} on ${c.id} = ${m.conversationId}
  where ${scoped(m.organizationId, p.organizationId, notTest, msgRange(p.fromUtc, p.toUtc))}
  group by ${m.conversationId}
), esc as (
  select distinct ${e.conversationId} as conversation_id
  from ${E} join ${C} on ${c.id} = ${e.conversationId}
  where ${scoped(e.organizationId, p.organizationId, notTest, sql`${e.kind} = 'opened'`, notManualReply, eventRange(p))}
)
select
  count(*)::int as active,
  (count(*) filter (where act.has_ai and not act.has_human and esc.conversation_id is null))::int as ai_only,
  (count(*) filter (where act.has_ai and (act.has_human or esc.conversation_id is not null)))::int as ai_and_human,
  (count(*) filter (where not act.has_ai and act.has_human))::int as human_only,
  (count(*) filter (where not act.has_ai and not act.has_human))::int as unanswered
from act left join esc on esc.conversation_id = act.conversation_id
where act.has_in`;
}

/** M3 — eventos `opened` por motivo (manual_reply incluido: se separa al dar forma). */
export function escalationCountsSql(p: AgentReportParams): SQL {
  return sql`select ${e.reason} as reason,
  count(*)::int as n,
  (count(*) filter (where ${e.approximate}))::int as approx
from ${E} join ${C} on ${c.id} = ${e.conversationId}
where ${scoped(e.organizationId, p.organizationId, notTest, sql`${e.kind} = 'opened'`, eventRange(p))}
group by ${e.reason}`;
}

/** M3 — hasta 5 notas recientes por motivo (sin manual_reply), con el contacto. */
export function escalationSamplesSql(p: AgentReportParams): SQL {
  return sql`select reason, conversation_id, contact_id, contact_name, note, occurred_at
from (
  select ${e.reason} as reason, ${e.conversationId} as conversation_id,
    ${ct.id} as contact_id, ${ct.name} as contact_name, ${e.note} as note,
    to_char(${e.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at,
    row_number() over (partition by ${e.reason} order by ${e.createdAt} desc, ${e.id} desc) as rn
  from ${E}
    join ${C} on ${c.id} = ${e.conversationId}
    join ${CT} on ${ct.id} = ${c.contactId} and ${ct.organizationId} = ${p.organizationId}
  where ${scoped(e.organizationId, p.organizationId, notTest, sql`${e.kind} = 'opened'`, notManualReply, sql`${e.note} is not null`, eventRange(p))}
) s
where s.rn <= ${ESCALATION_SAMPLES}
order by s.reason, s.occurred_at desc`;
}

/** M4 — tiempo a primera respuesta por sesión, agrupado por quién respondió. */
export function responseTimesSql(p: AgentReportParams): SQL {
  const lookback = new Date(p.fromUtc.getTime() - SESSION_GAP_MS);
  return sql`with msgs as (
  select ${m.conversationId} as conversation_id, ${m.direction} as direction, ${m.createdAt} as created_at,
    lag(${m.createdAt}) over (partition by ${m.conversationId} order by ${m.createdAt}) as prev_at
  from ${M} join ${C} on ${c.id} = ${m.conversationId}
  where ${scoped(m.organizationId, p.organizationId, notTest, msgRange(lookback, p.toUtc))}
), ses as (
  select conversation_id, created_at as started_at from msgs
  where direction = 'in' and created_at >= ${ts(p.fromUtc)}
    and (prev_at is null or created_at - prev_at >= interval '24 hours')
), fr as (
  select ses.started_at, fr1.created_at as replied_at, fr1.origin
  from ses left join lateral (
    select ${r.createdAt} as created_at, ${r.origin} as origin from ${R}
    where ${scoped(r.organizationId, p.organizationId, sql`${r.conversationId} = ses.conversation_id`, sql`${r.direction} = 'out'`, sql`${r.status} <> 'failed'`, sql`${r.createdAt} > ses.started_at`)}
    order by ${r.createdAt} limit 1
  ) fr1 on true
)
select case when origin is null then 'sin_respuesta'
            when origin = 'ai' then 'ia' else 'humano' end as quien,
  count(*)::int as sesiones,
  percentile_cont(0.5) within group (order by extract(epoch from replied_at - started_at)) as p50_s,
  percentile_cont(0.9) within group (order by extract(epoch from replied_at - started_at)) as p90_s
from fr group by 1`;
}

/** M5 — del escalamiento exacto (sin manual_reply) al primer saliente humano. */
export function afterHandoffSql(p: AgentReportParams): SQL {
  return sql`with ev as (
  select ${e.conversationId} as conversation_id, ${e.createdAt} as opened_at
  from ${E} join ${C} on ${c.id} = ${e.conversationId}
  where ${scoped(e.organizationId, p.organizationId, notTest, sql`${e.kind} = 'opened'`, notManualReply, sql`${e.approximate} = false`, eventRange(p))}
), rr as (
  select ev.opened_at, h.created_at as replied_at
  from ev left join lateral (
    select ${r.createdAt} as created_at from ${R}
    where ${scoped(r.organizationId, p.organizationId, sql`${r.conversationId} = ev.conversation_id`, sql`${r.direction} = 'out'`, sql`${r.origin} in ${HUMAN_ORIGINS}`, sql`${r.status} <> 'failed'`, sql`${r.createdAt} > ev.opened_at`)}
    order by ${r.createdAt} limit 1
  ) h on true
)
select count(*)::int as escalations,
  count(replied_at)::int as answered,
  percentile_cont(0.5) within group (order by extract(epoch from replied_at - opened_at)) as p50_s,
  percentile_cont(0.9) within group (order by extract(epoch from replied_at - opened_at)) as p90_s
from rr`;
}

/** M6 — salientes por canal × origen, total y fallidas. */
export function failuresSql(p: AgentReportParams): SQL {
  return sql`select ${c.channel} as channel, ${m.origin} as origin,
  count(*)::int as total,
  (count(*) filter (where ${m.status} = 'failed'))::int as failed
from ${M} join ${C} on ${c.id} = ${m.conversationId}
where ${scoped(m.organizationId, p.organizationId, notTest, sql`${m.direction} = 'out'`, msgRange(p.fromUtc, p.toUtc))}
group by 1, 2
order by 1, 2`;
}

/** M6 — top 5 de motivos de falla. */
export function failureErrorsSql(p: AgentReportParams): SQL {
  return sql`select ${m.error} as error, count(*)::int as n
from ${M} join ${C} on ${c.id} = ${m.conversationId}
where ${scoped(m.organizationId, p.organizationId, notTest, sql`${m.direction} = 'out'`, sql`${m.status} = 'failed'`, sql`${m.error} is not null`, msgRange(p.fromUtc, p.toUtc))}
group by 1
order by n desc, 1
limit ${TOP_ERRORS}`;
}

/** M7 — entrega y lectura en canales con acuses. */
export function deliverySql(p: AgentReportParams, channels: Channel[]): SQL {
  const cutoff = deliveryCutoff(p.toUtc, p.now);
  const list = sql.join(
    channels.map((ch) => sql`${ch}`),
    sql`, `
  );
  return sql`select
  (count(*) filter (where ${m.status} in ('delivered', 'read')))::int as delivered,
  (count(*) filter (where ${m.status} = 'read'))::int as read,
  (count(*) filter (where ${m.status} in ('sent', 'delivered', 'read', 'failed')))::int as base,
  (count(*) filter (where ${m.status} = 'pending'))::int as unconfirmed
from ${M} join ${C} on ${c.id} = ${m.conversationId}
where ${scoped(m.organizationId, p.organizationId, notTest, sql`${m.direction} = 'out'`, sql`${m.origin} <> 'manual'`, sql`${c.channel} in (${list})`, msgRange(p.fromUtc, cutoff))}`;
}

/** M8 — mensajes por día local × canal × dirección (los días vacíos se rellenan en Node). */
export function volumeSql(p: AgentReportParams): SQL {
  return sql`select to_char(((${m.createdAt} at time zone 'UTC') at time zone ${p.tz})::date, 'YYYY-MM-DD') as dia,
  ${c.channel} as channel, ${m.direction} as direction, count(*)::int as n
from ${M} join ${C} on ${c.id} = ${m.conversationId}
where ${scoped(m.organizationId, p.organizationId, notTest, msgRange(p.fromUtc, p.toUtc))}
group by 1, 2, 3`;
}

/** Todos los builders (el test de vigilancia recorre esta lista). */
export const AGENT_REPORT_SQL = {
  attentionSql,
  escalationCountsSql,
  escalationSamplesSql,
  responseTimesSql,
  afterHandoffSql,
  failuresSql,
  failureErrorsSql,
  deliverySql: (p: AgentReportParams) => deliverySql(p, deliveryChannels()),
  volumeSql,
} as const;

// ── Forma (filas crudas → DTO) ───────────────────────────────────────────

type Row = Record<string, unknown>;

/** count/int que el driver puede entregar como texto. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** percentile_cont: número, texto o null. */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Texto o null (columnas opcionales). */
function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export function shapeAttention(rows: Row[]): AttentionDto {
  const row = rows[0] ?? {};
  const active = num(row.active);
  const aiOnly = num(row.ai_only);
  return {
    active,
    aiOnly,
    aiAndHuman: num(row.ai_and_human),
    humanOnly: num(row.human_only),
    noReply: num(row.unanswered),
    aiOnlyRate: ratio(aiOnly, active),
  };
}

/** Motivo de una fila sembrada sin `handoff_reason`. */
export const NO_REASON = "sin_motivo";

function reasonKey(v: unknown): string {
  return typeof v === "string" && v ? v : NO_REASON;
}

/** Aplica la regla de `manual_reply`: fuera de M3, como línea aparte. */
export function shapeEscalations(countRows: Row[], sampleRows: Row[]): EscalationsDto {
  const samples = new Map<string, EscalationSampleDto[]>();
  for (const s of sampleRows) {
    const reason = reasonKey(s.reason);
    if (reason === "manual_reply") continue;
    const list = samples.get(reason) ?? [];
    if (list.length >= ESCALATION_SAMPLES) continue;
    list.push({
      conversationId: String(s.conversation_id ?? ""),
      contactId: String(s.contact_id ?? ""),
      contactName: strOrNull(s.contact_name),
      note: strOrNull(s.note),
      occurredAt: String(s.occurred_at ?? ""),
    });
    samples.set(reason, list);
  }

  let manualReplyPauses = 0;
  let approximate = 0;
  const byReason: EscalationReasonDto[] = [];
  for (const row of countRows) {
    const reason = reasonKey(row.reason);
    const count = num(row.n);
    // Aproximados: cuentan para totales (M3 y la línea aparte).
    approximate += num(row.approx);
    if (reason === "manual_reply") {
      manualReplyPauses += count;
      continue;
    }
    if (count === 0) continue;
    byReason.push({
      reason,
      label: handoffLabel(reason === NO_REASON ? null : reason),
      count,
      samples: samples.get(reason) ?? [],
    });
  }
  byReason.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return {
    total: byReason.reduce((acc, x) => acc + x.count, 0),
    byReason,
    manualReplyPauses,
    approximate: approximate > 0,
  };
}

export function shapeResponseTimes(rows: Row[]): ResponseTimesDto {
  const by = new Map(rows.map((row) => [String(row.quien), row]));
  const stats = (key: string): ResponderTimesDto => {
    const row = by.get(key);
    const sessions = num(row?.sesiones);
    return {
      sessions,
      p50Seconds: sessions ? numOrNull(row?.p50_s) : null,
      p90Seconds: sessions ? numOrNull(row?.p90_s) : null,
    };
  };
  return {
    ai: stats("ia"),
    human: stats("humano"),
    unanswered: num(by.get("sin_respuesta")?.sesiones),
  };
}

export function shapeAfterHandoff(rows: Row[]): AfterHandoffDto {
  const row = rows[0] ?? {};
  const escalations = num(row.escalations);
  const attended = num(row.answered);
  return {
    attended,
    unattended: Math.max(0, escalations - attended),
    p50Seconds: attended ? numOrNull(row.p50_s) : null,
    p90Seconds: attended ? numOrNull(row.p90_s) : null,
  };
}

const ORIGINS = ["ai", "operator", "manual", "template"] as const;

/** Filas canal × origen → totales, corte por origen y por canal. */
export function shapeFailures(sliceRows: Row[], errorRows: Row[]): FailuresDto {
  const byOrigin = new Map<string, { total: number; failed: number }>();
  const byChannel = new Map<Channel, { total: number; failed: number }>();
  let total = 0;
  let failed = 0;
  for (const row of sliceRows) {
    const channel = String(row.channel);
    const origin = String(row.origin);
    if (!isChannel(channel)) continue;
    const t = num(row.total);
    const f = num(row.failed);
    total += t;
    failed += f;
    const o = byOrigin.get(origin) ?? { total: 0, failed: 0 };
    o.total += t;
    o.failed += f;
    byOrigin.set(origin, o);
    const ch = byChannel.get(channel) ?? { total: 0, failed: 0 };
    ch.total += t;
    ch.failed += f;
    byChannel.set(channel, ch);
  }
  const originRank = (o: string) => {
    const i = (ORIGINS as readonly string[]).indexOf(o);
    return i === -1 ? ORIGINS.length : i;
  };
  return {
    total,
    failed,
    rate: ratio(failed, total),
    byOrigin: [...byOrigin.entries()]
      .sort(([a], [b]) => originRank(a) - originRank(b) || a.localeCompare(b))
      .map(([origin, v]) => ({ origin, ...v })),
    byChannel: CHANNEL_ORDER.filter((ch) => byChannel.has(ch)).map((channel) => ({
      channel,
      ...byChannel.get(channel)!,
    })),
    topErrors: errorRows
      .filter((row) => typeof row.error === "string" && row.error)
      .slice(0, TOP_ERRORS)
      .map((row) => ({ error: String(row.error), count: num(row.n) })),
  };
}

export function shapeDelivery(rows: Row[], channels: Channel[]): DeliveryDto {
  const row = rows[0] ?? {};
  const base = num(row.base);
  const delivered = num(row.delivered);
  const read = num(row.read);
  return {
    channels,
    base,
    delivered,
    read,
    unconfirmed: num(row.unconfirmed),
    deliveryRate: ratio(delivered, base),
    readRate: ratio(read, delivered),
  };
}

/**
 * Una fila por día del rango × canal (RF-02-07), también en cero. Canales:
 * WhatsApp siempre + los que tengan mensajes en el rango, en orden fijo.
 */
export function shapeVolume(rows: Row[], days: string[]): VolumeDto {
  const present = new Set<Channel>(["whatsapp"]);
  const counts = new Map<string, { inbound: number; outbound: number }>();
  for (const row of rows) {
    const ch = String(row.channel);
    if (!isChannel(ch)) continue;
    present.add(ch);
    const key = `${String(row.dia)}|${ch}`;
    const cell = counts.get(key) ?? { inbound: 0, outbound: 0 };
    if (row.direction === "in") cell.inbound += num(row.n);
    else if (row.direction === "out") cell.outbound += num(row.n);
    counts.set(key, cell);
  }
  const channels = CHANNEL_ORDER.filter((ch) => present.has(ch));
  const out: VolumeRowDto[] = [];
  for (const day of days) {
    for (const channel of channels) {
      const cell = counts.get(`${day}|${channel}`);
      out.push({ day, channel, inbound: cell?.inbound ?? 0, outbound: cell?.outbound ?? 0 });
    }
  }
  return { rows: out };
}

// ── Ejecución ────────────────────────────────────────────────────────────

export type AgentReportDeps = {
  /** Transacción de solo lectura con tope por consulta (`run.ts`). */
  runReadOnly: <T>(fn: (exec: ReportExec) => Promise<T>) => Promise<T>;
  now: () => Date;
  blocks?: RunBlocksOptions;
};

const defaultDeps: AgentReportDeps = { runReadOnly, now: () => new Date() };

/**
 * M1–M8 de una organización en un rango. Cada bloque en su transacción, de
 * 2 en 2; un bloque caído vuelve `{ ok: false }` y los demás se pintan.
 * Lanza `ReportTimeoutError` si TODO el reporte excede el tiempo.
 */
export async function agentReport(
  organizationId: string,
  range: ReportRange,
  deps: AgentReportDeps = defaultDeps
): Promise<AgentReportDto> {
  const now = deps.now();
  const p: AgentReportParams = {
    organizationId,
    fromUtc: range.fromUtc,
    toUtc: range.toUtc,
    tz: range.tz,
    now,
  };
  const run = deps.runReadOnly;
  const channels = deliveryChannels();
  const cutoff = deliveryCutoff(p.toUtc, now);

  const blocks = await runBlocks(
    {
      attention: () => run((exec) => exec(attentionSql(p)).then(shapeAttention)),
      escalations: () =>
        run(async (exec) =>
          shapeEscalations(
            await exec(escalationCountsSql(p)),
            await exec(escalationSamplesSql(p))
          )
        ),
      responseTimes: () => run((exec) => exec(responseTimesSql(p)).then(shapeResponseTimes)),
      afterHandoff: () => run((exec) => exec(afterHandoffSql(p)).then(shapeAfterHandoff)),
      failures: () =>
        run(async (exec) =>
          shapeFailures(await exec(failuresSql(p)), await exec(failureErrorsSql(p)))
        ),
      delivery: () =>
        // Sin canales con acuses o con la ventana entera dentro de la gracia:
        // no hay nada que medir (y `in ()` no es SQL válido).
        channels.length === 0 || cutoff.getTime() <= p.fromUtc.getTime()
          ? Promise.resolve(shapeDelivery([], channels))
          : run((exec) =>
              exec(deliverySql(p, channels)).then((rows) => shapeDelivery(rows, channels))
            ),
      volume: () => run((exec) => exec(volumeSql(p)).then((rows) => shapeVolume(rows, range.days))),
    },
    deps.blocks
  );

  return { range: toRangeDto(range), ...blocks };
}
