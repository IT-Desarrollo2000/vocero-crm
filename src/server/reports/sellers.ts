import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  NO_ASSIGNEE_LABEL,
  ratio,
  type BookingsBySellerDto,
  type ReportBlock,
  type SellerFunnelRowDto,
  type SellerRosterFiguresDto,
  type SellerRosterRowDto,
  type SellersFunnelDto,
  type SellersReportDto,
  type SellersRosterDto,
  type SellersSalesDto,
  type SalesFunnelDto,
} from "@/lib/reports";
import { agendaEnabled } from "@/server/agenda/flag";
import { bySellerSql, shapeBySeller, type BookingReportParams } from "./bookings";
import { notLabContact, num, numOrNull, str, truthy, wonInMainCurrency, type Row } from "./common";
import { toRangeDto, type ReportRange } from "./range";
import { runBlocks, runReadOnly, type ReportExec, type RunBlocksOptions } from "./run";
import { byAdvisorSql, funnelSql, shapeByAdvisor, shapeFunnel, type SalesReportParams } from "./sales";
import { rosterSql } from "./summary";

/**
 * 024 — Reportes → Vendedores (solo Propietario). Mismo marco que Ventas y
 * Resumen: `runBlocks` + `runReadOnly`, cada bloque en su transacción.
 *
 * Semántica (plan 024 §3; documentada también en `src/lib/reports.ts`):
 *  - VENDEDORES = todos los miembros (tabla `member`, vendedores y
 *    propietarios), también en cero, + quien tenga datos sin ser ya miembro,
 *    + «Sin asignar».
 *  - CARTERA = conversaciones reales cuyo responsable VIGENTE es él
 *    (`conversation.assigned_user_id`): «según la asignación actual».
 *  - `roster` = `rosterSql` (en `summary.ts`): construido sobre los MISMOS CTE
 *    del Resumen (personas, atendidas, pendientes con tarjetas, tiempo hasta
 *    asesor, leads externos), así la suma de filas = los totales del Resumen.
 *  - `sales` = Ventas → Por asesor TAL CUAL (`byAdvisorSql` + `shapeByAdvisor`,
 *    D1 + D2), más el ticket promedio.
 *  - `bookings` (solo con AGENDA) = Citas → Por vendedor (`bySellerSql`).
 *  - `funnel` = foto actual, vendedor × etapa (responsable vigente de la
 *    conversación real del contacto; sin ella, «Sin asignar»), con las etapas
 *    y totales del Embudo de Ventas.
 *
 * Reglas que TODAS las consultas cumplen (un unit test las vigila sobre el
 * SQL renderizado y otro las ejecuta contra Postgres): tenant por `scoped`,
 * Laboratorio fuera, límites como texto `::timestamp`, nada de `now()`.
 */

export type SellersReportParams = SalesReportParams;

const L = schema.lead;
const fc = alias(schema.conversation, "fc");

/**
 * Embudo de la cartera (foto actual): leads no Laboratorio por responsable
 * vigente de la conversación REAL del contacto (una por contacto) × etapa,
 * con el monto en la moneda principal.
 */
export function funnelBySellerSql(p: { organizationId: string }, currency: string): SQL {
  const main = sql`coalesce(${L.currency}, ${currency}) = ${currency}`;
  return sql`select ${fc.assignedUserId} as user_id,
  coalesce(nullif(u.name, ''), u.email) as name,
  ${L.stageId} as stage_id,
  count(*)::int as leads,
  coalesce(sum(${L.amountCents}) filter (where ${L.amountCents} is not null and ${main}), 0)::bigint as cents
from ${L}
left join ${schema.conversation} ${sql.identifier("fc")} on ${fc.contactId} = ${L.contactId}
  and ${fc.organizationId} = ${L.organizationId} and ${fc.isTest} = false
left join ${schema.user} u on u.id = ${fc.assignedUserId}
where ${scoped(L.organizationId, p.organizationId, notLabContact(p))}
group by 1, 2, 3`;
}

/** Los builders con rango (el test de vigilancia recorre esta lista). */
export const SELLERS_REPORT_SQL = { rosterSql } as const;

// ── Forma (filas crudas → DTO) ───────────────────────────────────────────

function emptyFigures(): SellerRosterFiguresDto {
  return {
    portfolio: 0,
    assignedInRange: 0,
    activePortfolio: 0,
    persons: 0,
    attended: 0,
    attendedRate: null,
    pending: 0,
    externalNotContacted: 0,
  };
}

/**
 * Miembros por nombre, luego ex-miembros por nombre, «Sin asignar» siempre al
 * final (aunque la consulta no lo trajera). `totals` = suma de las filas.
 */
export function shapeRoster(rows: Row[]): SellersRosterDto {
  let unassigned: SellerRosterRowDto | null = null;
  const sellers: SellerRosterRowDto[] = [];
  const totals = emptyFigures();
  for (const r of rows) {
    const userId = str(r.user_id);
    const frN = num(r.fr_n);
    const row: SellerRosterRowDto = {
      userId,
      name: userId ? (str(r.name) ?? userId) : NO_ASSIGNEE_LABEL,
      role: userId ? str(r.role) : null,
      isMember: userId ? truthy(r.is_member) : false,
      portfolio: num(r.portfolio),
      assignedInRange: num(r.assigned),
      activePortfolio: num(r.active),
      persons: num(r.persons),
      attended: num(r.attended),
      attendedRate: ratio(num(r.attended), num(r.persons)),
      pending: num(r.pending),
      externalNotContacted: num(r.not_contacted),
      advisorFirstReply: {
        persons: frN,
        p50Seconds: frN ? numOrNull(r.p50_s) : null,
        p90Seconds: frN ? numOrNull(r.p90_s) : null,
      },
    };
    totals.portfolio += row.portfolio;
    totals.assignedInRange += row.assignedInRange;
    totals.activePortfolio += row.activePortfolio;
    totals.persons += row.persons;
    totals.attended += row.attended;
    totals.pending += row.pending;
    totals.externalNotContacted += row.externalNotContacted;
    if (userId) sellers.push(row);
    else unassigned = row;
  }
  totals.attendedRate = ratio(totals.attended, totals.persons);
  sellers.sort(
    (a, b) => Number(b.isMember) - Number(a.isMember) || a.name.localeCompare(b.name, "es")
  );
  return {
    rows: [
      ...sellers,
      unassigned ?? {
        userId: null,
        name: NO_ASSIGNEE_LABEL,
        role: null,
        isMember: false,
        ...emptyFigures(),
        advisorFirstReply: { persons: 0, p50Seconds: null, p90Seconds: null },
      },
    ],
    totals,
  };
}

/** Ventas → Por asesor tal cual, más el ticket promedio (regla de Ventas). */
export function shapeSellerSales(rows: Row[], currency: string): SellersSalesDto {
  return {
    rows: shapeByAdvisor(rows, currency).rows.map((row) => {
      const n = wonInMainCurrency(row.won, row.wonAmount);
      return { ...row, averageTicketCents: n > 0 ? Math.round(row.wonAmount.amountCents / n) : null };
    }),
  };
}

/**
 * Vendedor × etapa sobre las etapas del Embudo (mismo orden). Solo filas con
 * leads; orden leads abiertos desc, nombre; «Sin asignar» al final.
 */
export function shapeSellerFunnel(
  stageRows: Row[],
  cellRows: Row[],
  currency: string
): SellersFunnelDto {
  const funnel: SalesFunnelDto = shapeFunnel(stageRows, currency);
  const kindOf = new Map(funnel.stages.map((s) => [s.stageId, s.kind]));
  const by = new Map<string, SellerFunnelRowDto>();
  for (const r of cellRows) {
    const userId = str(r.user_id);
    const key = userId ?? "";
    let row = by.get(key);
    if (!row) {
      row = {
        userId,
        name: userId ? (str(r.name) ?? userId) : NO_ASSIGNEE_LABEL,
        cells: funnel.stages.map((s) => ({ stageId: s.stageId, leads: 0, amountCents: 0 })),
        openLeads: 0,
        openAmountCents: 0,
      };
      by.set(key, row);
    }
    const stageId = String(r.stage_id ?? "");
    const cell = row.cells.find((c) => c.stageId === stageId);
    if (!cell) continue; // etapa de otra organización: imposible con el JOIN, por si acaso
    cell.leads += num(r.leads);
    cell.amountCents += num(r.cents);
    if (kindOf.get(stageId) === "open") {
      row.openLeads += num(r.leads);
      row.openAmountCents += num(r.cents);
    }
  }
  const rows = [...by.values()].sort(
    (a, b) =>
      Number(a.userId === null) - Number(b.userId === null) ||
      b.openLeads - a.openLeads ||
      a.name.localeCompare(b.name, "es")
  );
  return { currency, stages: funnel.stages, rows };
}

// ── Ejecución ────────────────────────────────────────────────────────────

export type SellersReportDeps = {
  /** Transacción de solo lectura con tope por consulta (`run.ts`). */
  runReadOnly: <T>(fn: (exec: ReportExec) => Promise<T>) => Promise<T>;
  /** Reloj de «pendientes de marcar» de las citas. */
  now: () => Date;
  blocks?: RunBlocksOptions;
  /** Bandera `AGENDA` (por defecto, la del entorno). */
  agendaEnabled?: () => boolean;
};

const defaultDeps: SellersReportDeps = { runReadOnly, now: () => new Date(), agendaEnabled };

type SellersBlocks = {
  roster: SellersRosterDto;
  sales: SellersSalesDto;
  bookings?: BookingsBySellerDto;
  funnel: SellersFunnelDto;
};

/**
 * Los bloques de Vendedores (tres, cuatro con AGENDA). `currency` = moneda del
 * negocio (Ajustes → Marca). Sin AGENDA el bloque de citas ni se ejecuta.
 */
export async function sellersReport(
  organizationId: string,
  range: ReportRange,
  currency: string,
  deps: SellersReportDeps = defaultDeps
): Promise<SellersReportDto> {
  const p: SellersReportParams = {
    organizationId,
    fromUtc: range.fromUtc,
    toUtc: range.toUtc,
    tz: range.tz,
  };
  const bookingParams: BookingReportParams = { ...p, now: deps.now() };
  const agenda = (deps.agendaEnabled ?? agendaEnabled)();
  const run = deps.runReadOnly;

  const { bookings, ...blocks } = await runBlocks<SellersBlocks>(
    {
      roster: () => run(async (exec) => shapeRoster(await exec(rosterSql(p)))),
      sales: () => run(async (exec) => shapeSellerSales(await exec(byAdvisorSql(p)), currency)),
      ...(agenda
        ? { bookings: () => run((exec) => exec(bySellerSql(bookingParams)).then(shapeBySeller)) }
        : {}),
      funnel: () =>
        run(async (exec) =>
          shapeSellerFunnel(
            await exec(funnelSql(p, currency)),
            await exec(funnelBySellerSql(p, currency)),
            currency
          )
        ),
    },
    deps.blocks
  );

  return {
    range: toRangeDto(range),
    agendaEnabled: agenda,
    ...blocks,
    bookings: (bookings as ReportBlock<BookingsBySellerDto> | undefined) ?? null,
  };
}
