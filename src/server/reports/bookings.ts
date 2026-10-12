import { sql, type SQL } from "drizzle-orm";
import { schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  ratio,
  type AttendanceByReminderDto,
  type AttendanceSliceDto,
  type BookingAttendanceDto,
  type BookingReportDto,
  type OfferConversionDto,
} from "@/lib/reports";
import { pgTimestamp } from "./agent";
import { toRangeDto, type ReportRange } from "./range";
import { runBlocks, runReadOnly, type ReportExec, type RunBlocksOptions } from "./run";

/**
 * 10 — Reportes → Citas (RF-10-15, «Contrato 10-0»). Mismo marco que el
 * reporte del agente (02): `parseReportRange` + `reportTimezone` en la ruta,
 * y aquí `runBlocks` + `runReadOnly` (`src/server/reports/run.ts`) con un
 * bloque por métrica (`offers`, `attendance`, `byReminder`), cada uno con su
 * transacción de solo lectura y su tope por consulta.
 *
 * Reglas que TODAS las consultas cumplen (un unit test las vigila sobre el
 * SQL renderizado):
 *  - Excluyen SIEMPRE `is_test` (citas y bitácora de ofertas) y `kind='block'`.
 *  - Los límites `[range.fromUtc, range.toUtc)` y `now` viajan como texto
 *    `::timestamp`; nada de `now()` en SQL (columnas `timestamp` sin zona).
 *  - Toda consulta filtrada por `organization_id` (`scoped`).
 */

export type BookingReportParams = {
  organizationId: string;
  fromUtc: Date;
  toUtc: Date;
  now: Date;
};

const B = schema.booking;
const L = schema.agendaOfferLog;
const C = schema.conversation;
const R = schema.bookingReminder;

function ts(d: Date): SQL {
  return sql`${pgTimestamp(d)}::timestamp`;
}

/** Sesiones reales con la cita dentro del rango. */
function sessionsInRange(p: BookingReportParams): SQL {
  return scoped(
    B.organizationId,
    p.organizationId,
    sql`${B.kind} = 'session'`,
    sql`${B.isTest} = false`,
    sql`${B.scheduledAt} >= ${ts(p.fromUtc)}`,
    sql`${B.scheduledAt} < ${ts(p.toUtc)}`
  );
}

// ── SQL ──────────────────────────────────────────────────────────────────

/**
 * Oferta → cita: conversaciones REALES con ≥ 1 ronda en el rango; convertidas
 * = con una cita `source='ai'` (sesión, no prueba) creada después de su
 * primera ronda del rango.
 */
export function offersSql(p: BookingReportParams): SQL {
  return sql`with f as (
  select ${L.conversationId} as conversation_id,
    min(${L.createdAt}) as first_at,
    count(*)::int as rounds
  from ${L} join ${C} on ${C.id} = ${L.conversationId}
  where ${scoped(
    L.organizationId,
    p.organizationId,
    sql`${L.isTest} = false`,
    sql`${C.isTest} = false`,
    sql`${L.createdAt} >= ${ts(p.fromUtc)}`,
    sql`${L.createdAt} < ${ts(p.toUtc)}`
  )}
  group by ${L.conversationId}
)
select count(*)::int as conversations,
  (count(*) filter (where exists (
    select 1 from ${B}
    where ${scoped(
      B.organizationId,
      p.organizationId,
      sql`${B.conversationId} = f.conversation_id`,
      sql`${B.source} = 'ai'`,
      sql`${B.kind} = 'session'`,
      sql`${B.isTest} = false`,
      sql`${B.createdAt} >= f.first_at`
    )}
  )))::int as converted,
  coalesce(sum(f.rounds), 0)::int as rounds
from f`;
}

/** Desde cuándo hay bitácora de ofertas (sin rango: es el aviso de la UI). */
export function offersSinceSql(p: BookingReportParams): SQL {
  return sql`select to_char(min(${L.createdAt}), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as since
from ${L}
where ${scoped(L.organizationId, p.organizationId)}`;
}

/** Cita → asistencia por `scheduled_at` en el rango. */
export function attendanceSql(p: BookingReportParams): SQL {
  return sql`select
  (count(*) filter (where ${B.status} = 'realizada'))::int as realizada,
  (count(*) filter (where ${B.status} = 'no_show'))::int as no_show,
  (count(*) filter (where ${B.status} = 'agendada' and ${B.scheduledAt} < ${ts(p.now)}))::int as pending_to_mark,
  (count(*) filter (where ${B.status} = 'cancelada'))::int as cancelada
from ${B}
where ${sessionsInRange(p)}`;
}

/** Asistencia con vs sin recordatorio `sent` para la hora vigente. */
export function byReminderSql(p: BookingReportParams): SQL {
  return sql`select
  exists (
    select 1 from ${R}
    where ${scoped(
      R.organizationId,
      p.organizationId,
      sql`${R.bookingId} = ${B.id}`,
      sql`${R.scheduledFor} = ${B.scheduledAt}`,
      sql`${R.status} = 'sent'`
    )}
  ) as with_reminder,
  (count(*) filter (where ${B.status} = 'realizada'))::int as realizada,
  (count(*) filter (where ${B.status} = 'no_show'))::int as no_show
from ${B}
where ${sessionsInRange(p)}
group by 1`;
}

export const BOOKING_REPORT_SQL = {
  offersSql,
  offersSinceSql,
  attendanceSql,
  byReminderSql,
};

// ── Forma (filas crudas → DTO) ───────────────────────────────────────────

type Row = Record<string, unknown>;

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function truthy(v: unknown): boolean {
  return v === true || v === "t" || v === "true" || v === 1;
}

export function shapeOffers(rows: Row[], sinceRows: Row[]): OfferConversionDto {
  const r = rows[0] ?? {};
  const conversationsWithOffer = num(r.conversations);
  const converted = num(r.converted);
  const since = sinceRows[0]?.since;
  return {
    conversationsWithOffer,
    converted,
    rate: ratio(converted, conversationsWithOffer),
    offerRounds: num(r.rounds),
    dataSince: since === null || since === undefined ? null : String(since),
  };
}

function slice(realizada: number, noShow: number): AttendanceSliceDto {
  return { realizada, noShow, rate: ratio(realizada, realizada + noShow) };
}

export function shapeAttendance(rows: Row[]): BookingAttendanceDto {
  const r = rows[0] ?? {};
  return {
    ...slice(num(r.realizada), num(r.no_show)),
    pendingToMark: num(r.pending_to_mark),
    cancelada: num(r.cancelada),
  };
}

export function shapeByReminder(rows: Row[]): AttendanceByReminderDto {
  const pick = (want: boolean) => {
    const r = rows.find((x) => truthy(x.with_reminder) === want);
    return slice(num(r?.realizada), num(r?.no_show));
  };
  return { withReminder: pick(true), withoutReminder: pick(false) };
}

// ── Ejecución ────────────────────────────────────────────────────────────

export type BookingReportDeps = {
  /** Transacción de solo lectura con tope por consulta (`run.ts`). */
  runReadOnly: <T>(fn: (exec: ReportExec) => Promise<T>) => Promise<T>;
  blocks?: RunBlocksOptions;
};

const defaultDeps: BookingReportDeps = { runReadOnly };

/**
 * Las tres métricas de citas de una organización en un rango. Cada bloque en
 * su transacción; uno caído vuelve `{ ok: false }` y los demás se pintan.
 * Lanza `ReportTimeoutError` si TODO el reporte excede el tiempo.
 */
export async function bookingReport(
  organizationId: string,
  range: ReportRange,
  now: Date,
  deps: BookingReportDeps = defaultDeps
): Promise<BookingReportDto> {
  const p: BookingReportParams = {
    organizationId,
    fromUtc: range.fromUtc,
    toUtc: range.toUtc,
    now,
  };
  const run = deps.runReadOnly;

  const blocks = await runBlocks(
    {
      offers: () =>
        run(async (exec) =>
          shapeOffers(await exec(offersSql(p)), await exec(offersSinceSql(p)))
        ),
      attendance: () => run((exec) => exec(attendanceSql(p)).then(shapeAttendance)),
      byReminder: () => run((exec) => exec(byReminderSql(p)).then(shapeByReminder)),
    },
    deps.blocks
  );

  return { range: toRangeDto(range), ...blocks };
}
