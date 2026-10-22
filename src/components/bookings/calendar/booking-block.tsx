"use client";

import { useDraggable } from "@dnd-kit/core";
import { AlertTriangle, Ban, Check, Lock, X } from "lucide-react";
import { hhmm, wallClock } from "@/lib/time/calendar";
import { cn } from "@/lib/utils";
import type { OverlapLevel } from "@/server/agenda/overlaps";
import {
  bookingAriaLabel,
  bookingTitle,
  bookingTone,
  OVERLAP_TEXT,
  type Booking,
} from "../booking-look";
import { initials, typeColorIndex } from "./calendar-model";

/**
 * 028 — Un tramo de cita en la rejilla (Semana o Día por vendedor): hora,
 * cliente, punto de color del tipo, iniciales del vendedor e ícono de estado.
 * El traslape es un ATRIBUTO sobre el color del estado (A4): soft ⇒ ⧉
 * discreto; hard ⇒ borde de alerta + ⚠ "Conflicto". Nada se dice solo con
 * color: el `aria-label` lleva todo.
 */

/** "10:00–10:30" en la zona del negocio (aunque el tramo esté partido). */
export function bookingTimeRange(b: Booking, tz: string): string {
  const startMs = Date.parse(b.scheduledAtUtc);
  const start = wallClock(new Date(startMs), tz);
  const end = wallClock(new Date(startMs + b.durationMinutes * 60_000), tz);
  return `${hhmm(start.minutes)}–${hhmm(end.minutes)}`;
}

export function TypeDot({ typeId, className }: { typeId: string | null | undefined; className?: string }) {
  const idx = typeColorIndex(typeId);
  if (!idx) return null;
  return (
    <span
      aria-hidden
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full ring-1 ring-current", className)}
      style={{ backgroundColor: `var(--cal-type-${idx})` }}
    />
  );
}

function StatusIcon({ b }: { b: Booking }) {
  const cls = "h-3 w-3 shrink-0";
  if (b.status === "cancelada") return <Ban className={cls} strokeWidth={2} aria-hidden />;
  if (b.kind === "block") return <Lock className={cls} strokeWidth={2} aria-hidden />;
  if (b.status === "realizada") return <Check className={cls} strokeWidth={2.4} aria-hidden />;
  if (b.status === "no_show") return <X className={cls} strokeWidth={2.4} aria-hidden />;
  return null;
}

/** Clases base de un bloque (en la rejilla y en el `DragOverlay`). */
const BLOCK_BASE =
  "overflow-hidden rounded-sm border px-1.5 text-left text-[11px] leading-tight shadow-sm";

/** Lo de adentro del bloque: igual en la rejilla y mientras se arrastra. */
function BlockContent({
  b,
  tz,
  overlap,
  compact,
}: {
  b: Booking;
  tz: string;
  overlap?: OverlapLevel | null;
  compact: boolean;
}) {
  const range = bookingTimeRange(b, tz);
  const seller = b.kind === "session" ? initials(b.assignedUser?.name) : "";
  return (
    <>
      <span className="flex min-w-0 items-center gap-1">
        <StatusIcon b={b} />
        <span className="shrink-0 font-semibold tabular-nums">{range.split("–")[0]}</span>
        <TypeDot typeId={b.type?.id} />
        <span className="min-w-0 flex-1 truncate">{bookingTitle(b)}</span>
        {overlap === "soft" && (
          <span title={OVERLAP_TEXT.soft} aria-hidden className="shrink-0 text-[11px]">
            ⧉
          </span>
        )}
        {overlap === "hard" && (
          <span
            title={OVERLAP_TEXT.hard}
            className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-destructive px-0.5 text-[10px] font-semibold text-destructive-foreground"
          >
            <AlertTriangle className="h-2.5 w-2.5" strokeWidth={2.4} aria-hidden />
            {!compact && <span aria-hidden>Conflicto</span>}
          </span>
        )}
        {seller && (
          <span aria-hidden className="shrink-0 font-mono text-[10px] opacity-80">
            {seller}
          </span>
        )}
      </span>
      {!compact && b.type && <span className="block truncate opacity-80">{b.type.name}</span>}
    </>
  );
}

/** Lo que flota bajo el puntero mientras se arrastra (`DragOverlay`). */
export function BookingBlockOverlay({
  booking: b,
  tz,
  width,
  height,
  overlap,
}: {
  booking: Booking;
  tz: string;
  width: number;
  height: number;
  overlap?: OverlapLevel | null;
}) {
  return (
    <div
      aria-hidden
      className={cn(BLOCK_BASE, "cursor-grabbing py-0.5 opacity-90 shadow-pop", bookingTone(b, overlap))}
      style={{ width, height }}
    >
      <BlockContent b={b} tz={tz} overlap={overlap} compact={height < 34} />
    </div>
  );
}

/** Datos que viajan con el arrastre (dnd-kit `data`). */
export type DragData = {
  booking: Booking;
  overlap: OverlapLevel | null;
  width: number;
  height: number;
};

export function BookingBlock({
  booking: b,
  tz,
  top,
  height,
  col = 0,
  cols = 1,
  overlap,
  band = false,
  continuesBefore = false,
  continuesAfter = false,
  draggable = false,
  dragKey,
  hidden = false,
  onOpen,
}: {
  booking: Booking;
  tz: string;
  top: number;
  height: number;
  col?: number;
  cols?: number;
  overlap?: OverlapLevel | null;
  /** Bloqueo pintado como franja a todo el ancho (Día por vendedor). */
  band?: boolean;
  continuesBefore?: boolean;
  continuesAfter?: boolean;
  /** 028 (Fase B) — Se puede arrastrar (y soltar en otra hora/columna). */
  draggable?: boolean;
  /** Id único del tramo para dnd-kit (una cita partida tiene dos tramos). */
  dragKey: string;
  /** El original se atenúa mientras su copia flota. */
  hidden?: boolean;
  onOpen: (b: Booking) => void;
}) {
  const range = bookingTimeRange(b, tz);
  const label = bookingAriaLabel(b, range, overlap);
  const compact = height < 34;
  const width = 100 / Math.max(1, cols);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragKey,
    disabled: !draggable,
    data: { booking: b, overlap: overlap ?? null, width: 0, height } satisfies DragData,
  });

  return (
    <button
      ref={setNodeRef}
      type="button"
      {...(draggable ? attributes : {})}
      {...(draggable ? listeners : {})}
      data-testid="cal-booking"
      data-booking-id={b.id}
      data-status={b.status}
      data-kind={b.kind}
      {...(draggable ? { "data-draggable": "true" } : {})}
      {...(overlap ? { "data-overlap": overlap } : {})}
      aria-label={draggable ? `${label}. Arrastra o pulsa Espacio para mover.` : label}
      aria-roledescription={draggable ? "cita arrastrable" : undefined}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(b);
      }}
      className={cn(
        BLOCK_BASE,
        "absolute outline-none transition-[filter] hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring",
        band ? "z-0" : "z-10",
        compact ? "py-0" : "py-0.5",
        continuesBefore && "rounded-t-none",
        continuesAfter && "rounded-b-none",
        draggable && "cursor-grab touch-manipulation",
        (isDragging || hidden) && "opacity-40",
        bookingTone(b, overlap)
      )}
      style={{
        top,
        height,
        left: band ? 0 : `calc(${col * width}% + 1px)`,
        width: band ? "100%" : `calc(${width}% - 2px)`,
      }}
    >
      <BlockContent b={b} tz={tz} overlap={overlap} compact={compact} />
    </button>
  );
}

