"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import { hhmm, wallClock, type DaySegment } from "@/lib/time/calendar";
import { cn } from "@/lib/utils";
import type { OverlapLevel } from "@/server/agenda/overlaps";
import type { Booking } from "../booking-look";
import { BookingBlock } from "./booking-block";
import {
  instantAt,
  rowStarts,
  segmentBox,
  type MinuteRange,
} from "./calendar-model";
import type { DropPreview } from "./drag-model";

/**
 * 028 — Rejilla de horas compartida por Semana y Día por vendedor: una
 * columna por día o por vendedor, filas de `slotMinutes`, bandas fuera de
 * horario (`--cal-off`), celdas libres clicables (abren "Nueva cita" con la
 * hora), tramos proporcionales lado a lado (`layoutOverlaps`) y la línea de
 * la hora actual. Todo en la zona del NEGOCIO.
 *
 * Fase B (A6): cada columna es UN droppable de dnd-kit; el minuto destino lo
 * calcula el padre por la coordenada Y con `minuteAtOffset` + snap, con los
 * datos de la columna (`rangeStart`, `px`). La vista previa se pinta en la
 * columna destino.
 *
 * Desplazamiento: horizontal y vertical DENTRO del contenedor (nunca de la
 * página); al abrir se coloca en la apertura (A3).
 */

export type GridItem = {
  booking: Booking;
  seg: DaySegment;
  col: number;
  cols: number;
  overlap?: OverlapLevel | null;
  /** Franja a todo el ancho (bloqueos en Día por vendedor). */
  band?: boolean;
};

export type GridColumn = {
  key: string;
  dayIso: string;
  header: ReactNode;
  testId: "cal-day-column" | "cal-seller-column";
  data: Record<string, string>;
  items: GridItem[];
  offBands: { startMin: number; endMin: number }[];
  /** Tramos hábiles: solo ahí hay celdas para crear. */
  workBands: { startMin: number; endMin: number }[];
};

/** Datos de cada columna droppable (dnd-kit `data`). */
export type ColumnDropData = {
  columnKey: string;
  dayIso: string;
  rangeStart: number;
  rangeEnd: number;
  px: number;
};

/** Lo que la rejilla necesita saber del arrastre en curso. */
export type GridDrag = {
  canDrag: (it: GridItem) => boolean;
  /** Cita que se está arrastrando (su original se atenúa). */
  activeBookingId: string | null;
  preview: DropPreview | null;
  /** Duración de lo que se arrastra (alto de la vista previa). */
  previewMinutes: number;
};

/** Alto de una fila: al menos 22 px para que se pueda tocar. */
export function pxPerMinute(slotMinutes: number): number {
  return Math.max(0.8, 22 / Math.max(5, slotMinutes));
}

const PREVIEW_TONE: Record<DropPreview["state"], string> = {
  free: "border-brand bg-brand-tint text-brand-text",
  soft: "border-warning bg-warning-tint text-warning-text",
  reject: "booking-hatch border-danger text-danger-text",
};

export function TimeGrid({
  columns,
  range,
  slotMinutes,
  tz,
  now,
  minColumnWidth,
  scrollKey,
  drag,
  onOpenBooking,
  onEmptyCell,
}: {
  columns: GridColumn[];
  range: MinuteRange;
  slotMinutes: number;
  tz: string;
  now: Date;
  minColumnWidth: number;
  /** Cambia al navegar: vuelve a colocar el scroll en la apertura. */
  scrollKey: string;
  drag?: GridDrag;
  onOpenBooking: (b: Booking) => void;
  onEmptyCell: (cell: { dayIso: string; startUtc: string; columnKey: string }) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const px = pxPerMinute(slotMinutes);
  const height = (range.endMin - range.startMin) * px;
  const rows = rowStarts(range, slotMinutes);

  // A3 — Al abrir (y al navegar), el scroll en la apertura.
  const scrollTop = Math.max(0, (range.scrollMin - range.startMin) * px - 8);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollTop;
    // Solo al cambiar de semana/día/vista, no en cada refresco del SSE.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey]);

  const hourLabels = rows.filter((m) => m % 60 === 0);

  return (
    <div
      ref={scrollRef}
      data-testid="cal-grid"
      className="relative max-h-[70vh] min-h-[320px] overflow-auto rounded-md border"
    >
      <div
        className="grid"
        style={{
          gridTemplateColumns: `3rem repeat(${columns.length}, minmax(${minColumnWidth}px, 1fr))`,
          minWidth: `calc(3rem + ${columns.length * minColumnWidth}px)`,
        }}
      >
        {/* Encabezados (fijos arriba) */}
        <div className="sticky left-0 top-0 z-30 border-b bg-background" />
        {columns.map((c) => (
          <div
            key={`h-${c.key}`}
            className="sticky top-0 z-20 border-b border-l bg-background px-1 py-1.5 text-center text-xs"
          >
            {c.header}
          </div>
        ))}

        {/* Horas (fijas a la izquierda) */}
        <div className="sticky left-0 z-20 bg-background" style={{ height }} aria-hidden>
          {hourLabels.map((m) => (
            <span
              key={m}
              className="absolute right-1 -translate-y-1/2 text-[10.5px] tabular-nums text-text-3"
              style={{ top: (m - range.startMin) * px }}
            >
              {m === range.startMin ? "" : hhmm(m)}
            </span>
          ))}
        </div>

        {columns.map((c) => (
          <Column
            key={c.key}
            column={c}
            range={range}
            rows={rows}
            slotMinutes={slotMinutes}
            px={px}
            height={height}
            tz={tz}
            now={now}
            drag={drag}
            onOpenBooking={onOpenBooking}
            onEmptyCell={onEmptyCell}
          />
        ))}
      </div>
    </div>
  );
}

function Column({
  column: c,
  range,
  rows,
  slotMinutes,
  px,
  height,
  tz,
  now,
  drag,
  onOpenBooking,
  onEmptyCell,
}: {
  column: GridColumn;
  range: MinuteRange;
  rows: number[];
  slotMinutes: number;
  px: number;
  height: number;
  tz: string;
  now: Date;
  drag?: GridDrag;
  onOpenBooking: (b: Booking) => void;
  onEmptyCell: (cell: { dayIso: string; startUtc: string; columnKey: string }) => void;
}) {
  const { setNodeRef } = useDroppable({
    id: `col:${c.key}`,
    disabled: !drag,
    data: {
      columnKey: c.key,
      dayIso: c.dayIso,
      rangeStart: range.startMin,
      rangeEnd: range.endMin,
      px,
    } satisfies ColumnDropData,
  });
  const rowPx = Math.max(5, slotMinutes) * px;
  const nowWall = wallClock(now, tz);
  const nowVisible = nowWall.minutes >= range.startMin && nowWall.minutes < range.endMin;
  const preview = drag?.preview?.columnKey === c.key ? drag.preview : null;

  return (
    <div
      ref={setNodeRef}
      data-testid={c.testId}
      {...Object.fromEntries(Object.entries(c.data).map(([k, v]) => [`data-${k}`, v]))}
      className="cal-rows relative border-l"
      style={{ height, ["--cal-row" as string]: `${rowPx}px` }}
    >
      {c.offBands.map((b) => {
        const top = Math.max(b.startMin, range.startMin);
        const end = Math.min(b.endMin, range.endMin);
        if (end <= top) return null;
        return (
          <div
            key={`off-${b.startMin}`}
            data-testid="cal-off-band"
            aria-hidden
            className="cal-off absolute inset-x-0"
            style={{ top: (top - range.startMin) * px, height: (end - top) * px }}
          />
        );
      })}

      {rows
        .filter((m) => c.workBands.some((b) => m >= b.startMin && m < b.endMin))
        .map((m) => {
          const startUtc = instantAt(c.dayIso, m, tz);
          if (!startUtc) return null;
          return (
            <button
              key={`cell-${m}`}
              type="button"
              data-testid="cal-empty-cell"
              data-start={startUtc}
              aria-label={`Nueva cita a las ${hhmm(m)}`}
              onClick={() => onEmptyCell({ dayIso: c.dayIso, startUtc, columnKey: c.key })}
              className="absolute inset-x-0 outline-none hover:bg-brand-tint focus-visible:bg-brand-tint"
              style={{ top: (m - range.startMin) * px, height: rowPx }}
            />
          );
        })}

      {c.items.map((it) => {
        const box = segmentBox(it.seg, range, px);
        const dragKey = `${it.booking.id}|${it.seg.day}|${c.key}|${it.band ? "band" : "b"}`;
        return (
          <BookingBlock
            key={dragKey}
            dragKey={dragKey}
            booking={it.booking}
            tz={tz}
            top={box.top}
            height={Math.max(2, box.height - 1)}
            col={it.col}
            cols={it.cols}
            overlap={it.overlap}
            band={it.band}
            continuesBefore={it.seg.continuesBefore}
            continuesAfter={it.seg.continuesAfter}
            draggable={drag ? drag.canDrag(it) : false}
            hidden={drag?.activeBookingId === it.booking.id}
            onOpen={onOpenBooking}
          />
        );
      })}

      {preview && (
        <div
          data-testid="cal-drop-preview"
          data-state={preview.state}
          data-start={preview.startUtc ?? undefined}
          role="status"
          aria-live="polite"
          className={cn(
            "pointer-events-none absolute inset-x-0.5 z-30 overflow-hidden rounded-sm border-2 border-dashed px-1 text-[10.5px] font-medium leading-tight",
            PREVIEW_TONE[preview.state]
          )}
          style={{
            top: Math.max(0, (preview.minute - range.startMin) * px),
            height: Math.max(18, (drag?.previewMinutes ?? slotMinutes) * px),
          }}
        >
          {preview.label}
        </div>
      )}

      {nowVisible && c.dayIso === nowWall.day && (
        <div
          data-testid="cal-now"
          aria-hidden
          className="pointer-events-none absolute inset-x-0 z-20 h-0.5 bg-destructive"
          style={{ top: (nowWall.minutes - range.startMin) * px }}
        />
      )}
    </div>
  );
}
