/**
 * 024 — Reportes → Vendedores: cómo la pantalla une los bloques de
 * `GET /api/reports/sellers` (cartera, ventas, citas, embudo). Lógica pura
 * (sin React) para probarla en unit. Semántica en `src/lib/reports.ts`.
 *
 * Regla de unión: las filas con `userId` null significan cosas DISTINTAS por
 * bloque — cartera = «Sin asignar», ventas = «Sin asesor», citas = «Sin
 * vendedor» — así que nunca se mezclan: se unen solo por `userId` no nulo,
 * con la lista de `roster` (todos los miembros, también en cero) como columna
 * vertebral, y cada fila null va aparte con su propia etiqueta.
 */

import {
  NO_BOOKING_SELLER_LABEL,
  type BookingCountsDto,
  type BookingSellerRowDto,
  type SellerRosterRowDto,
  type SellerSalesRowDto,
  type SellersReportDto,
  type WonAmountDto,
} from "@/lib/reports";
import { ratio } from "./format";

/** Bloques que un 200 de `/api/reports/sellers` debe traer (`bookings` es null sin AGENDA). */
export const SELLERS_BLOCKS = [
  "roster",
  "sales",
  "funnel",
] as const satisfies readonly (keyof SellersReportDto)[];

/** Rótulo de la fila de ventas sin asesor (la de Ventas → Por asesor). */
export const NO_ADVISOR_LABEL = "Sin asesor";

/** Ventas de una fila de «Resultados» (las de Ventas → Por asesor). */
export type SellerResultSales = Pick<
  SellerSalesRowDto,
  "won" | "lost" | "closeRate" | "wonAmount" | "averageTicketCents"
>;

/** Citas de una fila de «Resultados» (por el vendedor de la cita). */
export type SellerResultBookings = Pick<
  BookingCountsDto,
  "total" | "realizada" | "noShow" | "cancelada" | "rate"
>;

export type SellerResultRow = {
  /** `user:<id>` · `none:sales` · `none:bookings` · `total`. */
  key: string;
  userId: string | null;
  name: string;
  /** Fila sin persona («Sin asesor», «Sin vendedor»): va atenuada. */
  muted: boolean;
  /** null = este bloque no aplica a la fila (o el bloque no llegó). */
  sales: SellerResultSales | null;
  bookings: SellerResultBookings | null;
};

function emptyAmount(currency: string): WonAmountDto {
  return { currency, amountCents: 0, otherCurrencies: [], wonWithoutAmount: 0 };
}

export function zeroSales(currency: string): SellerResultSales {
  return { won: 0, lost: 0, closeRate: null, wonAmount: emptyAmount(currency), averageTicketCents: null };
}

export function zeroBookings(): SellerResultBookings {
  return { total: 0, realizada: 0, noShow: 0, cancelada: 0, rate: null };
}

function pickBookings(r: BookingSellerRowDto): SellerResultBookings {
  return {
    total: r.total ?? 0,
    realizada: r.realizada,
    noShow: r.noShow,
    cancelada: r.cancelada,
    rate: r.rate,
  };
}

function pickSales(r: SellerSalesRowDto): SellerResultSales {
  return {
    won: r.won,
    lost: r.lost,
    closeRate: r.closeRate,
    wonAmount: r.wonAmount,
    averageTicketCents: r.averageTicketCents,
  };
}

/** Suma montos sin mezclar monedas: la principal con la principal, el resto aparte. */
export function sumWonAmounts(currency: string, list: readonly WonAmountDto[]): WonAmountDto {
  const out = emptyAmount(currency);
  const others = new Map<string, { amountCents: number; won: number }>();
  for (const a of list) {
    out.wonWithoutAmount += a.wonWithoutAmount;
    if (a.currency === currency) out.amountCents += a.amountCents;
    else {
      const o = others.get(a.currency) ?? { amountCents: 0, won: 0 };
      o.amountCents += a.amountCents;
      others.set(a.currency, o);
    }
    for (const x of a.otherCurrencies) {
      if (x.currency === currency) {
        out.amountCents += x.amountCents;
        continue;
      }
      const o = others.get(x.currency) ?? { amountCents: 0, won: 0 };
      o.amountCents += x.amountCents;
      o.won += x.won;
      others.set(x.currency, o);
    }
  }
  out.otherCurrencies = [...others.entries()]
    .map(([c, o]) => ({ currency: c, ...o }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
  return out;
}

/** Ventas con monto en la moneda principal (para el ticket del total). */
function wonInMain(s: SellerResultSales): number {
  const other = s.wonAmount.otherCurrencies.reduce((a, o) => a + o.won, 0);
  return Math.max(0, s.won - s.wonAmount.wonWithoutAmount - other);
}

export type SellerResults = {
  rows: SellerResultRow[];
  total: SellerResultRow;
  /** ¿Llegó el bloque de ventas? Si no, sus columnas dicen «No disponible». */
  salesOk: boolean;
  /** ¿Hay columnas de citas? (AGENDA y el bloque llegó). */
  bookingsOk: boolean;
};

/**
 * «Resultados»: una fila por vendedor del roster (también en cero), más los
 * que aparezcan en ventas/citas sin estar en el roster (ex-miembros), y al
 * final «Sin asesor» (ventas) y «Sin vendedor» (citas) cada una por su lado.
 * Si el roster no llegó, las filas salen solo de ventas y citas.
 */
export function sellerResults(report: SellersReportDto): SellerResults {
  const salesOk = report.sales.ok;
  const salesRows = report.sales.ok ? report.sales.data.rows : [];
  const bookingsOk = report.agendaEnabled && !!report.bookings?.ok;
  const bookingRows = report.bookings?.ok ? report.bookings.data.rows : [];
  const currency = report.funnel.ok
    ? report.funnel.data.currency
    : (salesRows[0]?.wonAmount.currency ?? "MXN");

  const salesBy = new Map<string, SellerSalesRowDto>();
  for (const r of salesRows) if (r.userId) salesBy.set(r.userId, r);
  const bookingsBy = new Map<string, BookingSellerRowDto>();
  for (const r of bookingRows) if (r.userId) bookingsBy.set(r.userId, r);

  const rows: SellerResultRow[] = [];
  const seen = new Set<string>();
  const push = (userId: string, name: string) => {
    seen.add(userId);
    const s = salesBy.get(userId);
    const b = bookingsBy.get(userId);
    rows.push({
      key: `user:${userId}`,
      userId,
      name,
      muted: false,
      sales: salesOk ? (s ? pickSales(s) : zeroSales(currency)) : null,
      bookings: bookingsOk ? (b ? pickBookings(b) : zeroBookings()) : null,
    });
  };
  for (const r of rosterRows(report)) if (r.userId) push(r.userId, r.name);
  for (const r of salesRows) if (r.userId && !seen.has(r.userId)) push(r.userId, r.name);
  for (const r of bookingRows) if (r.userId && !seen.has(r.userId)) push(r.userId, r.name);

  const noAdvisor = salesRows.find((r) => r.userId === null);
  if (noAdvisor && noAdvisor.won + noAdvisor.lost > 0) {
    rows.push({
      key: "none:sales",
      userId: null,
      name: noAdvisor.name || NO_ADVISOR_LABEL,
      muted: true,
      sales: pickSales(noAdvisor),
      bookings: null,
    });
  }
  const noSeller = bookingRows.find((r) => r.userId === null);
  if (bookingsOk && noSeller && (noSeller.total ?? 0) > 0) {
    rows.push({
      key: "none:bookings",
      userId: null,
      name: noSeller.name || NO_BOOKING_SELLER_LABEL,
      muted: true,
      sales: null,
      bookings: pickBookings(noSeller),
    });
  }

  let total: SellerResultRow = { key: "total", userId: null, name: "Total", muted: false, sales: null, bookings: null };
  if (salesOk) {
    const won = salesRows.reduce((a, r) => a + r.won, 0);
    const lost = salesRows.reduce((a, r) => a + r.lost, 0);
    const wonAmount = sumWonAmounts(currency, salesRows.map((r) => r.wonAmount));
    const t: SellerResultSales = { won, lost, closeRate: ratio(won, won + lost), wonAmount, averageTicketCents: null };
    const n = wonInMain(t);
    t.averageTicketCents = n > 0 ? Math.round(wonAmount.amountCents / n) : null;
    total = { ...total, sales: t };
  }
  if (bookingsOk) {
    const b = zeroBookings();
    for (const r of bookingRows) {
      b.total += r.total ?? 0;
      b.realizada += r.realizada;
      b.noShow += r.noShow;
      b.cancelada += r.cancelada;
    }
    b.rate = ratio(b.realizada, b.realizada + b.noShow);
    total = { ...total, bookings: b };
  }
  return { rows, total, salesOk, bookingsOk };
}

/** Filas de «Cartera y atención»: el roster tal cual («Sin asignar» al final). */
export function rosterRows(report: SellersReportDto): SellerRosterRowDto[] {
  return report.roster.ok ? report.roster.data.rows : [];
}

