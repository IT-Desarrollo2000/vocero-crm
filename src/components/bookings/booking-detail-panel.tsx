"use client";

import { useEffect, useId, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { OverlapLevel } from "@/server/agenda/overlaps";
import type { SellerOption } from "./booking-dialog";
import { BookingActions, type BookingActionHandlers } from "./booking-actions";
import { BookingClientCard } from "./booking-client-card";
import { bookingTitle, OVERLAP_TEXT, statusLabel, type Booking } from "./booking-look";
import { bookingTimeRange, TypeDot } from "./calendar/booking-block";

/**
 * R2 — ¿Escape cierra el panel? No mientras haya un diálogo encima
 * (Reprogramar, choque al mover): ese Escape es del diálogo. Ambos escuchan
 * `document` y el orden de registro no está garantizado, así que no basta con
 * `stopPropagation` en el diálogo.
 */
export function panelClosesOnEscape(key: string, covered: boolean): boolean {
  return key === "Escape" && !covered;
}

/**
 * 028 — Panel de detalle de una cita del calendario: lo que dice la fila de
 * la Lista y sus MISMAS acciones (`BookingActions`). Lateral en computadora,
 * hoja inferior en celular; Escape o la ✕ lo cierran y el foco vuelve a quien
 * lo abrió.
 */
export function BookingDetailPanel({
  booking: b,
  overlap,
  owner,
  sellers,
  busy,
  error,
  businessTimezone,
  handlers,
  covered = false,
  onClose,
}: {
  booking: Booking;
  overlap?: OverlapLevel | null;
  owner: boolean;
  sellers: SellerOption[];
  busy: string | null;
  error: string | null;
  businessTimezone: string;
  handlers: BookingActionHandlers;
  /** Hay un diálogo abierto encima: su Escape no cierra el panel. */
  covered?: boolean;
  onClose: () => void;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const coveredRef = useRef(covered);
  coveredRef.current = covered;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // `coveredRef`: el valor del último render, aunque el diálogo se cierre
      // en este mismo evento (su setState aún no se aplicó).
      if (panelClosesOnEscape(e.key, coveredRef.current)) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-end bg-overlay sm:items-stretch"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="booking-detail-panel"
        data-booking-id={b.id}
        className="flex max-h-[85vh] w-full flex-col rounded-t-lg border bg-card shadow-pop outline-none sm:max-h-none sm:max-w-md sm:rounded-none sm:border-y-0 sm:border-r-0"
      >
        <div className="flex items-start justify-between gap-2 border-b px-4 py-3">
          <div className="min-w-0">
            <h3 id={titleId} className="truncate font-semibold">
              {bookingTitle(b)}
            </h3>
            <p className="text-sm text-text-2">
              {b.weekday} {b.date} · {bookingTimeRange(b, businessTimezone)} ·{" "}
              {b.durationMinutes} min
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="shrink-0 rounded p-1 text-text-3 hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={b.status === "cancelada" ? "secondary" : "default"}>
              {statusLabel(b)}
            </Badge>
            {b.type && (
              <Badge variant="outline" className="gap-1.5">
                <TypeDot typeId={b.type.id} className="text-border-strong" />
                {b.type.name}
              </Badge>
            )}
            {b.kind === "session" && (
              <Badge variant="secondary">
                {b.source === "ai" ? "Agendó la IA" : "Manual"}
              </Badge>
            )}
            {b.isTest && <Badge variant="secondary">Prueba</Badge>}
            {b.linkPending && b.status !== "cancelada" && (
              <Badge variant="secondary">Sin enlace</Badge>
            )}
          </div>

          {overlap && (
            <p
              data-testid="booking-detail-overlap"
              className={
                overlap === "hard"
                  ? "flex items-start gap-1.5 rounded-sm border border-danger-soft bg-danger-tint p-2 text-sm text-danger-text"
                  : "flex items-start gap-1.5 rounded-sm border bg-subtle p-2 text-sm text-text-2"
              }
            >
              {overlap === "hard" ? (
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
              ) : (
                <span aria-hidden>⧉</span>
              )}
              <span>
                {OVERLAP_TEXT[overlap]}
                {overlap === "hard"
                  ? ": choca con un bloqueo, otra cita del mismo vendedor o el mismo tipo exclusivo."
                  : ": a esa hora hay otra cita de otro vendedor."}
              </span>
            </p>
          )}

          {/* 029 — Sección Cliente: se pide al abrir la cita (`key`: otra
              cita, otra carga). Los bloqueos no tienen cliente. */}
          {b.contact && (
            <section aria-label="Cliente" className="space-y-1.5">
              <h4 className="text-xs font-medium uppercase tracking-wide text-text-3">
                Cliente
              </h4>
              <BookingClientCard key={b.id} bookingId={b.id} />
            </section>
          )}

          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
            {b.kind === "session" && (
              <>
                <dt className="text-text-3">Vendedor</dt>
                <dd>{b.assignedUser?.name || "Sin asignar"}</dd>
              </>
            )}
            {b.meetingLink && (
              <>
                <dt className="text-text-3">Reunión</dt>
                <dd>
                  <a
                    href={b.meetingLink}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-brand-text hover:underline"
                  >
                    Enlace de la reunión
                  </a>
                </dd>
              </>
            )}
            {b.notes && (
              <>
                <dt className="text-text-3">Notas</dt>
                <dd className="whitespace-pre-wrap">{b.notes}</dd>
              </>
            )}
          </dl>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="space-y-2">
            <BookingActions
              booking={b}
              owner={owner}
              sellers={sellers}
              busy={busy}
              businessTimezone={businessTimezone}
              handlers={handlers}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
