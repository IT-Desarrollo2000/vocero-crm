"use client";

import { offHoursBands, workingBands } from "@/lib/time/calendar";
import type { OverlapMap } from "@/server/agenda/overlaps";
import type { Booking } from "../booking-look";
import {
  columnOf,
  initials,
  NO_SELLER,
  visibleMinuteRange,
  type CalendarHours,
  type SellerColumn,
} from "./calendar-model";
import { TimeGrid, type GridColumn, type GridDrag, type GridItem } from "./time-grid";
import { laneItems, segmentsByDay } from "./week-view";

/**
 * 028 — Día por vendedor: un día, una columna por vendedor (Propietario: todo
 * el equipo; Vendedor: él + lo que puede ver) y "Sin asignar". Los bloqueos
 * no son de nadie: se pintan como franja en TODAS las columnas, debajo de las
 * citas.
 */
export function DaySellersView({
  day,
  columns: sellerCols,
  bookings,
  hours,
  overlaps,
  now,
  scrollKey,
  drag,
  onOpenBooking,
  onEmptyCell,
}: {
  day: string;
  columns: SellerColumn[];
  bookings: Booking[];
  hours: CalendarHours;
  overlaps: OverlapMap;
  now: Date;
  scrollKey: string;
  drag?: GridDrag;
  onOpenBooking: (b: Booking) => void;
  onEmptyCell: (cell: { dayIso: string; startUtc: string; columnKey: string }) => void;
}) {
  const tz = hours.timezone;
  const segs = segmentsByDay(bookings, tz).get(day) ?? [];
  const range = visibleMinuteRange(hours.weeklyHours, [day], segs.map((s) => s.seg));
  const blocks: GridItem[] = segs
    .filter((s) => s.booking.kind === "block")
    .map((s) => ({ booking: s.booking, seg: s.seg, col: 0, cols: 1, band: true }));
  const offBands = offHoursBands(hours.weeklyHours, day);
  const workBands = workingBands(hours.weeklyHours, day);

  const columns: GridColumn[] = sellerCols.map((c) => {
    const mine = segs.filter(
      (s) => s.booking.kind === "session" && columnOf(s.booking) === c.id
    );
    return {
      key: c.id,
      dayIso: day,
      testId: "cal-seller-column",
      data: { seller: c.id },
      header: (
        <span className="flex items-center justify-center gap-1.5">
          {c.id !== NO_SELLER && (
            <span
              aria-hidden
              className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-tint px-1 font-mono text-[10px] text-brand-text"
            >
              {initials(c.name)}
            </span>
          )}
          <span className="truncate font-medium">{c.name}</span>
        </span>
      ),
      items: [...blocks, ...laneItems(mine, overlaps)],
      offBands,
      workBands,
    };
  });

  return (
    <TimeGrid
      columns={columns}
      range={range}
      slotMinutes={hours.slotMinutes}
      tz={tz}
      now={now}
      minColumnWidth={140}
      scrollKey={scrollKey}
      drag={drag}
      onOpenBooking={onOpenBooking}
      onEmptyCell={onEmptyCell}
    />
  );
}
