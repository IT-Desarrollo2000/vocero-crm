"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SellerOption } from "./booking-dialog";
import type { Booking } from "./booking-look";
import { describeReminder, formatDue } from "./reminder-labels";

/**
 * 028 — Las acciones de una cita, COMPARTIDAS por la fila de la Lista y el
 * panel de detalle del calendario (A8): recordatorios (con reintento),
 * reintentar enlace, reprogramar, reasignar (Propietario), realizada / no
 * asistió y cancelar o quitar el bloqueo. Extraídas tal cual de la fila
 * (023/10): mismos textos y mismos `data-testid`, que lee el E2E
 * `scripts/e2e-agenda-presencial-ui.mjs`.
 *
 * El componente no hace fetch: el padre ejecuta y refresca.
 */

export type BookingActionHandlers = {
  /** PATCH `/api/bookings/[id]` con `body` (estado, cancelar, enlace). */
  onAct: (id: string, body: unknown) => void;
  onReschedule: (b: Booking) => void;
  /** Reasignar; `true` si salió bien (cierra el editor). */
  onReassign: (b: Booking, userId: string | null) => Promise<boolean>;
  onRetryReminder: (bookingId: string, reminderId: string) => void;
  /** Limpia el error de la pantalla al abrir un editor (como antes). */
  onClearError: () => void;
};

export function BookingActions({
  booking: b,
  owner,
  sellers,
  busy,
  businessTimezone,
  handlers,
}: {
  booking: Booking;
  owner: boolean;
  sellers: SellerOption[];
  /** Id de la cita con una acción en curso. */
  busy: string | null;
  businessTimezone?: string;
  handlers: BookingActionHandlers;
}) {
  const [reassigning, setReassigning] = useState(false);
  const [reassignTo, setReassignTo] = useState("none");
  const isBusy = busy === b.id;

  return (
    <>
      {/* 10 — Recordatorios de esta cita: un chip por anticipación.
          Un fallo no toca la cita; se reintenta desde aquí. */}
      {b.kind === "session" && (b.reminders ?? []).length > 0 && (
        <ul
          aria-label="Recordatorios de la cita"
          className="flex flex-wrap items-center gap-2"
        >
          {(b.reminders ?? []).map((r) => {
            const view = describeReminder(r, (iso) =>
              formatDue(iso, businessTimezone)
            );
            const reminderId = r.id;
            return (
              <li
                key={`${r.offsetMinutes}-${reminderId ?? "pendiente"}`}
                data-reminder-status={r.status}
                className="flex flex-wrap items-center gap-2"
              >
                <Badge variant={view.tone}>{view.text}</Badge>
                {r.canRetry && reminderId && (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label="Reintentar recordatorio"
                    disabled={isBusy}
                    onClick={() => handlers.onRetryReminder(b.id, reminderId)}
                  >
                    Reintentar recordatorio
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* El proveedor falló al crear la reunión. La cita existe; lo
          único que falta es el enlace, y se reintenta desde aquí — sin
          esto, un hipo del proveedor sería una pérdida silenciosa. */}
      {b.linkPending && b.status !== "cancelada" && (
        <div className="flex flex-wrap items-center gap-2 rounded-sm bg-subtle p-2">
          <span className="text-sm text-text-2">
            Esta cita quedó sin enlace: el proveedor no respondió.
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={isBusy}
            onClick={() => handlers.onAct(b.id, { action: "retry_link" })}
          >
            Reintentar enlace
          </Button>
        </div>
      )}

      {b.status === "agendada" && (
        <div className="flex flex-wrap gap-2">
          {/* Un bloqueo no se "realiza" ni tiene quien falte: solo se
              mueve o se quita. */}
          <Button
            size="sm"
            variant="secondary"
            disabled={isBusy}
            onClick={() => handlers.onReschedule(b)}
          >
            Reprogramar
          </Button>
          {owner && b.kind === "session" && (
            <Button
              size="sm"
              variant="secondary"
              data-testid="booking-reassign"
              aria-expanded={reassigning}
              disabled={isBusy}
              onClick={() => {
                handlers.onClearError();
                setReassignTo(b.assignedUser?.id ?? "none");
                setReassigning((r) => !r);
              }}
            >
              Reasignar
            </Button>
          )}
          {b.kind === "session" && (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={isBusy}
                onClick={() =>
                  handlers.onAct(b.id, { action: "status", status: "realizada" })
                }
              >
                Realizada
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={isBusy}
                onClick={() =>
                  handlers.onAct(b.id, { action: "status", status: "no_show" })
                }
              >
                No asistió
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={isBusy}
            onClick={() => handlers.onAct(b.id, { action: "cancel" })}
          >
            {b.kind === "block" ? "Quitar bloqueo" : "Cancelar"}
          </Button>
        </div>
      )}

      {reassigning && owner && (
        <div className="flex flex-wrap items-center gap-2 rounded-sm bg-subtle p-2">
          <label htmlFor={`reassign-${b.id}`} className="text-sm text-text-2">
            Vendedor
          </label>
          <select
            id={`reassign-${b.id}`}
            data-testid="booking-reassign-select"
            value={reassignTo}
            onChange={(e) => setReassignTo(e.target.value)}
            className="h-8 rounded-md border border-input bg-card px-2 text-sm"
          >
            {sellers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value="none">Sin asignar</option>
          </select>
          <Button
            size="sm"
            data-testid="booking-reassign-save"
            disabled={isBusy}
            onClick={() =>
              void handlers
                .onReassign(b, reassignTo === "none" ? null : reassignTo)
                .then((ok) => {
                  if (ok) setReassigning(false);
                })
            }
          >
            {isBusy ? "Guardando…" : "Guardar"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={isBusy}
            onClick={() => setReassigning(false)}
          >
            Cancelar
          </Button>
        </div>
      )}
    </>
  );
}
