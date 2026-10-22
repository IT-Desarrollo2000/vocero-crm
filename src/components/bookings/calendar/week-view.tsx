"use client";

import {
  bookingSegments,
  dayHeading,
  layoutOverlaps,
  offHoursBands,
  workingBands,
  type DaySegment,
} from "@/lib/time/calendar";
import { todayInTz } from "@/lib/time/slots";
import { cn } from "@/lib/utils";
import type { OverlapMap } from "@/server/agenda/overlaps";
import type { Booking } from "../booking-look";
import {
  visibleMinuteRange,
  type CalendarHours,
} from "./calendar-model";
import { TimeGrid, type GridColumn, type GridDrag, type GridItem } from "./time-grid";

/**
 * 028 — Vista Semana: columnas lun–dom en la zona del NEGOCIO; cada cita en
 * su día (partida en dos si cruza la medianoche) y lo que se traslapa, lado a
 * lado.
 */

type Seg = { booking: Booking; seg: DaySegment };

/** Los tramos de cada cita, agrupados por día del negocio. */
export function segmentsByDay(bookings: readonly Booking[], tz: string): Map<string, Seg[]> {
  const out = new Map<string, Seg[]>();
  for (const b of bookings) {
    for (const seg of bookingSegments(b.scheduledAtUtc, b.durationMinutes, tz)) {
      const list = out.get(seg.day);
      if (list) list.push({ booking: b, seg });
      else out.set(seg.day, [{ booking: b, seg }]);
    }
  }
  return out;
}

/** Tramos → posiciones con carriles para lo que se traslapa. */
export function laneItems(segs: readonly Seg[], overlaps: OverlapMap): GridItem[] {
  return layoutOverlaps(
    segs.map((s) => ({ ...s, startMin: s.seg.startMin, endMin: s.seg.endMin }))
  ).map((s) => ({
    booking: s.booking,
    seg: s.seg,
    col: s.col,
    cols: s.cols,
    overlap: overlaps[s.booking.id] ?? null,
  }));
}

export function WeekView({
  days,
  bookings,
  hours,
  overlaps,
  now,
  scrollKey,
  drag,
  onOpenBooking,
  onEmptyCell,
}: {
  days: string[];
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
  const byDay = segmentsByDay(bookings, tz);
  const range = visibleMinuteRange(
    hours.weeklyHours,
    days,
    [...byDay.values()].flat().map((s) => s.seg)
  );
  const todayIso = todayInTz(now, tz);

  const columns: GridColumn[] = days.map((d) => {
    const h = dayHeading(d);
    const isToday = d === todayIso;
    return {
      key: d,
      dayIso: d,
      testId: "cal-day-column",
      data: { day: d },
      header: (
        <span className="flex flex-col items-center leading-tight">
          <span className="text-[10.5px] uppercase text-text-3">{h.weekday}</span>
          <span
            className={cn(
              "mt-0.5 inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-sm font-semibold",
              isToday && "bg-brand text-brand-fg"
            )}
          >
            {h.day}
          </span>
        </span>
      ),
      items: laneItems(byDay.get(d) ?? [], overlaps),
      offBands: offHoursBands(hours.weeklyHours, d),
      workBands: workingBands(hours.weeklyHours, d),
    };
  });

  return (
    <TimeGrid
      columns={columns}
      range={range}
      slotMinutes={hours.slotMinutes}
      tz={tz}
      now={now}
      minColumnWidth={96}
      scrollKey={scrollKey}
      drag={drag}
      onOpenBooking={onOpenBooking}
      onEmptyCell={onEmptyCell}
    />
  );
}
