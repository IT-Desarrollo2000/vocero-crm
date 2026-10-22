"use client";

import { useEffect, useId } from "react";
import { Button } from "@/components/ui/button";
import { conflictDetail, type SlotConflict } from "../booking-logic";

/**
 * 028 (Fase B) — Confirmación al soltar sobre la cita de otro vendedor (o un
 * bloqueo sobre citas): mismo texto y forma que la advertencia de
 * `BookingDialog` ("Horario ocupado"), con su propio `data-testid`.
 * Confirmar reenvía el `move` con `confirmOverlap`; cancelar devuelve la cita.
 */
export function MoveOverlapDialog({
  message,
  conflicts,
  timezone,
  saving,
  onConfirm,
  onCancel,
}: {
  message: string;
  conflicts: SlotConflict[];
  timezone?: string;
  saving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();

  useEffect(() => {
    document
      .querySelector<HTMLElement>('[data-testid="move-overlap-confirm"]')
      ?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !saving) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [saving, onCancel]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        aria-describedby={`${id}-m`}
        data-testid="move-overlap-dialog"
        className="w-full max-w-sm rounded-lg border bg-card p-4 shadow-pop"
      >
        <h4 id={`${id}-t`} className="font-semibold">
          Horario ocupado
        </h4>
        <p id={`${id}-m`} className="mt-1 text-sm text-text-2">
          {message}
        </p>
        {conflicts.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-sm text-text-2">
            {conflicts.map((c) => (
              <li key={c.bookingId}>· {conflictDetail(c, timezone)}</li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Cancelar
          </Button>
          <Button
            data-testid="move-overlap-confirm"
            disabled={saving}
            onClick={onConfirm}
          >
            {saving ? "Moviendo…" : "Mover de todos modos"}
          </Button>
        </div>
      </div>
    </div>
  );
}
