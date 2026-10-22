"use client";

import { useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import type { Booking } from "../booking-look";
import { BookingBlockOverlay, type DragData } from "./booking-block";
import { minuteAtOffset, type CalendarHours, type CalView } from "./calendar-model";
import {
  canDragBooking,
  DRAG_OVERLAY_STYLE,
  dropPreview,
  type DropPreview,
} from "./drag-model";
import { pxPerMinute, type ColumnDropData, type GridDrag } from "./time-grid";

/**
 * 028 (Fase B, A6) — Arrastrar para mover, con `@dnd-kit/core`.
 *
 *  - Sensores: puntero con `distance: 6` (un clic sigue abriendo el panel,
 *    como en el Pipeline) SOLO para mouse/pluma; en táctil, `TouchSensor` con
 *    pulsación larga (`delay: 250, tolerance: 8`), así deslizar el dedo sigue
 *    desplazando el calendario; teclado con Espacio para tomar/soltar y las
 *    flechas avanzando UN paso de rejilla (arriba/abajo) o una columna.
 *  - UN droppable por columna (`time-grid.tsx`); el minuto sale de la
 *    coordenada Y del bloque con `minuteAtOffset` + el ajuste del modelo.
 *  - La vista previa (`dropPreview`) se calcula con lo que el usuario ve; la
 *    verdad la da el servidor al soltar (lo hace el padre con `onDrop`).
 */

/** Puntero solo para mouse/pluma: el dedo lo maneja `TouchSensor`. */
class MousePointerSensor extends PointerSensor {
  static activators: typeof PointerSensor.activators = [
    {
      eventName: "onPointerDown",
      handler: ({ nativeEvent: event }, { onActivation }) => {
        if (!event.isPrimary || event.button !== 0 || event.pointerType === "touch") {
          return false;
        }
        onActivation?.({ event });
        return true;
      },
    },
  ];
}

export function CalendarDnd({
  view,
  owner,
  hours,
  now,
  bookings,
  onDraggingChange,
  onDrop,
  onRejected,
  children,
}: {
  view: CalView;
  owner: boolean;
  hours: CalendarHours;
  now: Date;
  /** Lo que se ve en el calendario (para la vista previa de choques). */
  bookings: Booking[];
  /** Al empezar/terminar: el padre pausa el SSE mientras tanto. */
  onDraggingChange: (dragging: boolean) => void;
  onDrop: (booking: Booking, preview: DropPreview) => void;
  onRejected: (message: string) => void;
  children: (drag: GridDrag) => ReactNode;
}) {
  const [active, setActive] = useState<DragData | null>(null);
  const [preview, setPreview] = useState<DropPreview | null>(null);
  const previewRef = useRef<DropPreview | null>(null);
  // Paso del teclado: alto de un paso de rejilla y ancho de una columna.
  const stepRef = useRef({ x: 96, y: 24 });

  const coordinateGetter: KeyboardCoordinateGetter = (event, { currentCoordinates }) => {
    const { x, y } = stepRef.current;
    switch (event.code) {
      case "ArrowDown":
        return { ...currentCoordinates, y: currentCoordinates.y + y };
      case "ArrowUp":
        return { ...currentCoordinates, y: currentCoordinates.y - y };
      case "ArrowRight":
        return { ...currentCoordinates, x: currentCoordinates.x + x };
      case "ArrowLeft":
        return { ...currentCoordinates, x: currentCoordinates.x - x };
    }
    return undefined;
  };

  const sensors = useSensors(
    useSensor(MousePointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter,
      // Enter sigue abriendo el panel (clic del botón); Espacio toma y suelta.
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    })
  );

  function compute(event: DragMoveEvent | DragEndEvent): DropPreview | null {
    const data = event.active.data.current as DragData | undefined;
    const over = event.over;
    const col = over?.data.current as ColumnDropData | undefined;
    const rect = event.active.rect.current.translated;
    if (!data || !over || !col || !rect) return null;
    const rawMinute = minuteAtOffset(
      rect.top - over.rect.top,
      { startMin: col.rangeStart, endMin: col.rangeEnd },
      col.px
    );
    return dropPreview({
      booking: data.booking,
      view,
      owner,
      target: { columnKey: col.columnKey, dayIso: col.dayIso, rawMinute },
      hours,
      now,
      bookings,
    });
  }

  function setLive(next: DropPreview | null) {
    const prev = previewRef.current;
    previewRef.current = next;
    if (
      prev?.label === next?.label &&
      prev?.state === next?.state &&
      prev?.columnKey === next?.columnKey
    ) {
      return;
    }
    setPreview(next);
  }

  function onDragStart(e: DragStartEvent) {
    const data = e.active.data.current as DragData | undefined;
    if (!data) return;
    const initial = e.active.rect.current.initial;
    const px = pxPerMinute(hours.slotMinutes);
    const step =
      data.booking.kind === "block"
        ? hours.slotMinutes
        : hours.slotMinutes + Math.max(0, hours.bufferMinutes);
    const column = document.querySelector<HTMLElement>(
      '[data-testid="cal-grid"] [data-testid="cal-day-column"], [data-testid="cal-grid"] [data-testid="cal-seller-column"]'
    );
    stepRef.current = { x: column?.getBoundingClientRect().width ?? 96, y: step * px };
    setActive({
      ...data,
      width: initial?.width ?? 120,
      height: initial?.height ?? data.height,
    });
    onDraggingChange(true);
  }

  function finish() {
    setActive(null);
    previewRef.current = null;
    setPreview(null);
    onDraggingChange(false);
  }

  function onDragEnd(e: DragEndEvent) {
    const data = e.active.data.current as DragData | undefined;
    const final = compute(e) ?? previewRef.current;
    finish();
    if (!data || !final) return;
    if (final.state === "reject") {
      onRejected(`No se puede mover ahí: ${final.label}.`);
      return;
    }
    onDrop(data.booking, final);
  }

  const drag: GridDrag = {
    canDrag: (it) =>
      !it.band &&
      canDragBooking(it.booking, { view, now, continuesBefore: it.seg.continuesBefore }),
    activeBookingId: active?.booking.id ?? null,
    preview,
    previewMinutes: active?.booking.durationMinutes ?? hours.slotMinutes,
  };

  return (
    <DndContext
      sensors={sensors}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "Pulsa Espacio para tomar la cita, flechas para moverla un paso de la rejilla o de columna, Espacio para soltarla y Escape para cancelar.",
        },
        announcements: {
          onDragStart: () => "Cita tomada.",
          onDragOver: () => previewRef.current?.label ?? undefined,
          onDragEnd: () => "Cita soltada.",
          onDragCancel: () => "Movimiento cancelado; la cita volvió a su lugar.",
        },
      }}
      onDragStart={onDragStart}
      onDragMove={(e) => setLive(compute(e))}
      onDragOver={(e) => setLive(compute(e))}
      onDragEnd={onDragEnd}
      onDragCancel={finish}
    >
      {children(drag)}
      <DragOverlay dropAnimation={null} style={DRAG_OVERLAY_STYLE}>
        {active ? (
          <BookingBlockOverlay
            booking={active.booking}
            tz={hours.timezone}
            width={active.width}
            height={active.height}
            overlap={active.overlap}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
