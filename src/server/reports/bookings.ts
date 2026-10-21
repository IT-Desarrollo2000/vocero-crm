import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  ratio,
  type AttendanceByReminderDto,
  type AttendanceSliceDto,
  type BookingCountsDto,
  type BookingReportDto,
  type BookingSellerRowDto,
  type BookingsBySellerDto,
  type BookingsByTypeDto,
  type BookingToSalesDto,
  type BookingTypeRowDto,
  type OfferConversionDto,
  NO_APPOINTMENT_TYPE_LABEL,
  NO_BOOKING_SELLER_LABEL,
} from "@/lib/reports";
import { pgTimestamp } from "./agent";
import { addWon, emptyAmount, sortOthers, str } from "./common";
import { toRangeDto, type ReportRange } from "./range";
import { runBlocks, runReadOnly, type ReportExec, type RunBlocksOptions } from "./run";

/**
 * 10 — Reportes → Citas (RF-10-15, «Contrato 10-0»). Mismo marco que el
 * reporte del agente (02): `parseReportRange` + `reportTimezone` en la ruta,
 * y aquí `runBlocks` + `runReadOnly` (`src/server/reports/run.ts`) con un
 * bloque por métrica (`offers`, `attendance`, `byReminder` y, desde la 024,
 * `byType`, `bySeller`, `toSales`), cada uno con su transacción de solo
 * lectura y su tope por consulta.
 *
 * 024 — Por tipo (`appointment_type`), por vendedor de la cita
 * (`booking.assigned_user_id`, origen manual/IA) y citas → ventas: de las
 * REALIZADAS del periodo, los leads distintos (el de la cita, o el del
 * contacto si la cita no lo guardó) hoy en `won` («ganado al generar»).
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
const T = schema.appointmentType;
const L0 = alias(schema.lead, "l0");

function ts(d: Date): SQL {
  return sql`${pgTimestamp(d)}::timestamp`;
}

/**
 * Sesiones reales con la cita dentro del rango. 024: también la usa el
 * Resumen («Equipo»), que no tiene `now`.
 */
export function sessionsInRange(
  p: Pick<BookingReportParams, "organizationId" | "fromUtc" | "toUtc">
): SQL {
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

/** Conteos por estado (sobre `booking`, ya filtrado a sesiones del rango). */
function statusCounts(p: BookingReportParams): SQL {
  return sql`count(*)::int as total,
  (count(*) filter (where ${B.status} = 'agendada'))::int as agendada,
  (count(*) filter (where ${B.status} = 'realizada'))::int as realizada,
  (count(*) filter (where ${B.status} = 'no_show'))::int as no_show,
  (count(*) filter (where ${B.status} = 'agendada' and ${B.scheduledAt} < ${ts(p.now)}))::int as pending_to_mark,
  (count(*) filter (where ${B.status} = 'cancelada'))::int as cancelada`;
}

/** Cita → asistencia por `scheduled_at` en el rango (024: + total y agendadas). */
export function attendanceSql(p: BookingReportParams): SQL {
  return sql`select count(*)::int as total,
  (count(*) filter (where ${B.status} = 'agendada'))::int as agendada,
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

/** 024 — Citas del rango por tipo (NULL = «Sin tipo»). */
export function byTypeSql(p: BookingReportParams): SQL {
  return sql`select ${B.appointmentTypeId} as type_id,
  ${statusCounts(p)}
from ${B}
where ${sessionsInRange(p)}
group by 1`;
}

/** 024 — Los tipos de cita de la organización (sin rango: es el catálogo). */
export function appointmentTypesSql(p: Pick<BookingReportParams, "organizationId">): SQL {
  return sql`select ${T.id} as id, ${T.name} as name, ${T.active} as active, ${T.position} as position
from ${T}
where ${scoped(T.organizationId, p.organizationId)}
order by ${T.position} asc, ${T.name} asc, ${T.id} asc`;
}

/**
 * 024 — Citas del rango por vendedor de la cita × origen, unidas a TODOS los
 * miembros (también sin citas). La fila con `user_id` NULL es «Sin vendedor».
 */
export function bySellerSql(p: BookingReportParams): SQL {
  return sql`with bs as (
  select ${B.assignedUserId} as user_id, ${B.source} as source,
    ${statusCounts(p)}
  from ${B}
  where ${sessionsInRange(p)}
  group by 1, 2
), mem as (
  select ${schema.member.userId} as user_id from ${schema.member}
  where ${scoped(schema.member.organizationId, p.organizationId)}
)
select coalesce(bs.user_id, mem.user_id) as user_id,
  coalesce(nullif(u.name, ''), u.email) as name,
  (mem.user_id is not null) as is_member,
  bs.source, bs.total, bs.agendada, bs.realizada, bs.no_show, bs.pending_to_mark, bs.cancelada
from bs
full join mem on mem.user_id = bs.user_id
left join ${schema.user} u on u.id = coalesce(bs.user_id, mem.user_id)`;
}

/**
 * 024 — Citas → ventas. `rb` = citas REALIZADAS del rango con su lead (el de
 * la cita o, si no lo guardó, el del contacto: un lead por contacto); por
 * cada lead distinto, ¿hoy en `won`?, moneda y monto. Siempre sale una fila
 * con los totales de citas aunque no haya leads (LEFT JOIN LATERAL).
 */
export function toSalesSql(p: BookingReportParams): SQL {
  return sql`with rb as (
  select ${B.id} as id,
    coalesce(${B.leadId}, (
      select ${L0.id} from ${schema.lead} ${sql.identifier("l0")}
      where ${scoped(L0.organizationId, p.organizationId, sql`${L0.contactId} = ${B.contactId}`)}
      limit 1
    )) as lead_id
  from ${B}
  where ${sessionsInRange(p)} and ${B.status} = 'realizada'
), rl as (
  select distinct lead_id from rb where lead_id is not null
)
select t.bookings, t.without_lead, g.won, g.currency, g.has_amount, g.n, g.cents
from (
  select count(*)::int as bookings,
    (count(*) filter (where lead_id is null))::int as without_lead
  from rb
) t
left join lateral (
  select (s.kind = 'won') as won,
    case when s.kind = 'won' then l.currency end as currency,
    (s.kind = 'won' and l.amount_cents is not null) as has_amount,
    count(*)::int as n,
    coalesce(sum(case when s.kind = 'won' then l.amount_cents end), 0)::bigint as cents
  from rl
  join ${schema.lead} l on l.id = rl.lead_id and l.organization_id = ${p.organizationId}
  join ${schema.pipelineStage} s on s.id = l.stage_id and s.organization_id = l.organization_id
  group by 1, 2, 3
) g on true`;
}

export const BOOKING_REPORT_SQL = {
  offersSql,
  offersSinceSql,
  attendanceSql,
  byReminderSql,
  byTypeSql,
  bySellerSql,
  toSalesSql,
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

/** Conteos por estado de una fila (`statusCounts` / `attendanceSql`). */
function countsOf(r: Row): BookingCountsDto {
  return {
    ...slice(num(r.realizada), num(r.no_show)),
    pendingToMark: num(r.pending_to_mark),
    cancelada: num(r.cancelada),
    total: num(r.total),
    scheduled: num(r.agendada),
  };
}

function addCounts(acc: BookingCountsDto, r: Row): void {
  acc.realizada += num(r.realizada);
  acc.noShow += num(r.no_show);
  acc.pendingToMark += num(r.pending_to_mark);
  acc.cancelada += num(r.cancelada);
  acc.total += num(r.total);
  acc.scheduled += num(r.agendada);
  acc.rate = ratio(acc.realizada, acc.realizada + acc.noShow);
}

export function shapeAttendance(rows: Row[]): BookingCountsDto {
  return countsOf(rows[0] ?? {});
}

/**
 * 024 — Tipos activos siempre (también en cero), inactivos solo con citas,
 * «Sin tipo» siempre al final. Una cita cuyo tipo no está en el catálogo (no
 * debería: ON DELETE SET NULL) cae en «Sin tipo».
 */
export function shapeByType(countRows: Row[], typeRows: Row[]): BookingsByTypeDto {
  const byId = new Map<string, BookingTypeRowDto>();
  const none: BookingTypeRowDto = {
    typeId: null,
    name: NO_APPOINTMENT_TYPE_LABEL,
    active: true,
    ...countsOf({}),
  };
  for (const t of typeRows) {
    const id = str(t.id);
    if (!id) continue;
    byId.set(id, { typeId: id, name: String(t.name ?? ""), active: truthy(t.active), ...countsOf({}) });
  }
  for (const r of countRows) {
    const id = str(r.type_id);
    addCounts((id ? byId.get(id) : undefined) ?? none, r);
  }
  const rows = [...byId.values()].filter((t) => t.active || t.total > 0);
  return { rows: [...rows, none] };
}

/**
 * 024 — Una fila por vendedor (miembros también en cero) y ex-miembro con
 * citas; «Sin vendedor» siempre al final. Orden: citas desc, nombre.
 */
export function shapeBySeller(rows: Row[]): BookingsBySellerDto {
  const by = new Map<string, BookingSellerRowDto>();
  const none: BookingSellerRowDto = {
    userId: null,
    name: NO_BOOKING_SELLER_LABEL,
    isMember: false,
    bySource: { manual: 0, ai: 0 },
    ...countsOf({}),
  };
  for (const r of rows) {
    const userId = str(r.user_id);
    let row = userId ? by.get(userId) : none;
    if (!row && userId) {
      row = {
        userId,
        name: str(r.name) ?? userId,
        isMember: false,
        bySource: { manual: 0, ai: 0 },
        ...countsOf({}),
      };
      by.set(userId, row);
    }
    if (!row) continue;
    if (userId && truthy(r.is_member)) row.isMember = true;
    if (r.source === null || r.source === undefined) continue; // miembro sin citas
    addCounts(row, r);
    if (r.source === "ai") row.bySource.ai += num(r.total);
    else row.bySource.manual += num(r.total);
  }
  const out = [...by.values()].sort(
    (a, b) => b.total - a.total || a.name.localeCompare(b.name, "es")
  );
  return { rows: [...out, none] };
}

/** 024 — Citas → ventas; monto con las reglas de siempre (monedas nunca sumadas). */
export function shapeToSales(rows: Row[], currency: string): BookingToSalesDto {
  const first = rows[0] ?? {};
  let leads = 0;
  let won = 0;
  const wonAmount = emptyAmount(currency);
  for (const r of rows) {
    if (r.n === null || r.n === undefined) continue; // sin leads: solo los totales
    const n = num(r.n);
    leads += n;
    if (truthy(r.won)) {
      won += n;
      addWon(wonAmount, {
        currency: str(r.currency),
        hasAmount: truthy(r.has_amount),
        won: n,
        cents: num(r.cents),
      });
    }
  }
  return {
    bookingsDone: num(first.bookings),
    leads,
    withoutLead: num(first.without_lead),
    won,
    rate: ratio(won, leads),
    wonAmount: sortOthers(wonAmount),
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
 * Las métricas de citas de una organización en un rango. `currency` = moneda
 * del negocio (Ajustes → Marca), la principal del monto de citas → ventas.
 * Cada bloque en su transacción; uno caído vuelve `{ ok: false }` y los demás
 * se pintan. Lanza `ReportTimeoutError` si TODO el reporte excede el tiempo.
 */
export async function bookingReport(
  organizationId: string,
  range: ReportRange,
  now: Date,
  currency: string,
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
      byType: () =>
        run(async (exec) =>
          shapeByType(await exec(byTypeSql(p)), await exec(appointmentTypesSql(p)))
        ),
      bySeller: () => run((exec) => exec(bySellerSql(p)).then(shapeBySeller)),
      toSales: () => run(async (exec) => shapeToSales(await exec(toSalesSql(p)), currency)),
    },
    deps.blocks
  );

  return { range: toRangeDto(range), ...blocks };
}
