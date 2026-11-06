"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { keepClockTogether } from "@/lib/pipeline-card";
import {
  outcomeQuestion,
  outcomeWhen,
  todayTitle,
  tomorrowLine,
  unassignedLine,
  unassignedTitle,
  type BookingsTodo,
} from "@/lib/bookings-todo";
import type { SellerOption } from "./booking-dialog";
import type { Booking } from "./booking-look";

/**
 * 032 — Citas «que se explican solas»: la franja «Lo que te toca» arriba del
 * calendario (diseño `specs/032-modulos-claros/diseno/Citas.dc.html`).
 *
 *  - «¿Cómo le fue a X?»: la cita pasada sin resultado más reciente, con «Sí,
 *    llegó» (= Realizada), «No asistió» y «Reprogramar»; si hay más, «y N más»
 *    lleva a la Lista.
 *  - Hoy / mañana.
 *  - «N citas sin vendedor» con «Tomarla» (Vendedor) o «Asignar» (Propietario).
 *
 * OJO: ningún encabezado de esta sección puede empezar con «Citas» (los E2E
 * ubican la Lista por un `<section>` con encabezado `/^Citas/`): aquí no hay
 * `<h*>`, solo `<strong>`.
 *
 * El componente no hace fetch: el padre ejecuta y refresca.
 */
export function BookingsTodoStrip({
  todo,
  owner,
  tz,
  now,
  busy,
  sellers,
  onOutcome,
  onReschedule,
  onTake,
  onAssign,
  onShowList,
}: {
  todo: BookingsTodo<Booking>;
  owner: boolean;
  tz: string;
  now: number;
  busy: string | null;
  sellers: SellerOption[];
  onOutcome: (b: Booking, status: "realizada" | "no_show") => void;
  onReschedule: (b: Booking) => void;
  onTake: (b: Booking) => void;
  /** Propietario: asigna (o deja sin vendedor); `true` si salió bien. */
  onAssign: (b: Booking, userId: string | null) => Promise<boolean>;
  onShowList: () => void;
}) {
  const pending = todo.pending[0];
  const more = todo.pending.length - 1;
  const free = todo.unassigned[0];
  const card = "flex min-w-0 flex-col gap-1.5 rounded-lg border px-3.5 py-3";

  return (
    <section
      aria-label="Lo que te toca"
      data-testid="bookings-todo"
      className="flex flex-wrap gap-2.5"
    >
      {pending && (
        <div
          data-testid="bookings-todo-outcome"
          data-booking-id={pending.id}
          className={`${card} flex-[2_1_420px] gap-2 border-warning-soft bg-warning-tint`}
        >
          <strong className="text-sm font-semibold text-foreground">
            {outcomeQuestion(pending)}
          </strong>
          <span className="text-[13px] text-text-2">
            {keepClockTogether(outcomeWhen(pending, now, tz))}. Marca si llegó; así sabes a quién
            falta atender.
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              data-testid="bookings-todo-arrived"
              disabled={busy === pending.id}
              onClick={() => onOutcome(pending, "realizada")}
            >
              Sí, llegó
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="bookings-todo-noshow"
              disabled={busy === pending.id}
              onClick={() => onOutcome(pending, "no_show")}
            >
              No asistió
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy === pending.id}
              onClick={() => onReschedule(pending)}
            >
              Reprogramar
            </Button>
            {more > 0 && (
              <button
                type="button"
                data-testid="bookings-todo-more"
                onClick={onShowList}
                className="text-[13px] font-medium text-brand-text hover:underline"
              >
                y {more} más sin resultado
              </button>
            )}
          </div>
        </div>
      )}

      <div
        data-testid="bookings-todo-today"
        className={`${card} flex-[1_1_240px] border-info-soft bg-info-tint`}
      >
        <strong className="text-sm font-semibold text-foreground">
          {keepClockTogether(todayTitle(todo, owner, tz))}
        </strong>
        <span className="text-[13px] text-text-2">{keepClockTogether(tomorrowLine(todo, owner, tz))}</span>
      </div>

      {free && (
        <UnassignedCard
          key={free.id}
          booking={free}
          count={todo.unassigned.length}
          owner={owner}
          tz={tz}
          now={now}
          busy={busy === free.id}
          sellers={sellers}
          onTake={onTake}
          onAssign={onAssign}
          onShowList={onShowList}
        />
      )}
    </section>
  );
}

function UnassignedCard({
  booking: b,
  count,
  owner,
  tz,
  now,
  busy,
  sellers,
  onTake,
  onAssign,
  onShowList,
}: {
  booking: Booking;
  count: number;
  owner: boolean;
  tz: string;
  now: number;
  busy: boolean;
  sellers: SellerOption[];
  onTake: (b: Booking) => void;
  onAssign: (b: Booking, userId: string | null) => Promise<boolean>;
  onShowList: () => void;
}) {
  const [assigning, setAssigning] = useState(false);
  const [to, setTo] = useState(sellers[0]?.id ?? "");
  const selectId = `todo-assign-${b.id}`;
  return (
    <div
      data-testid="bookings-todo-unassigned"
      data-booking-id={b.id}
      className="flex min-w-0 flex-[1_1_240px] flex-col gap-1.5 rounded-lg border px-3.5 py-3"
    >
      <strong className="text-sm font-semibold text-foreground">{unassignedTitle(count)}</strong>
      <span className="text-[13px] text-text-2">{keepClockTogether(unassignedLine(b, now, tz))}</span>
      <div className="flex flex-wrap items-center gap-2">
        {owner ? (
          assigning ? (
            <>
              <label htmlFor={selectId} className="text-[13px] text-text-2">
                Vendedor
              </label>
              <select
                id={selectId}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-8 min-w-0 rounded-md border border-input bg-card px-2 text-sm"
              >
                {sellers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={busy || !to}
                onClick={() =>
                  void onAssign(b, to).then((ok) => {
                    if (ok) setAssigning(false);
                  })
                }
              >
                {busy ? "Guardando…" : "Guardar"}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAssigning(false)}>
                Cancelar
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              data-testid="bookings-todo-assign"
              disabled={busy || sellers.length === 0}
              onClick={() => setAssigning(true)}
            >
              Asignar
            </Button>
          )
        ) : (
          <Button
            size="sm"
            variant="outline"
            data-testid="bookings-todo-take"
            disabled={busy}
            onClick={() => onTake(b)}
          >
            {busy ? "Tomando…" : "Tomarla"}
          </Button>
        )}
        {count > 1 && (
          <button
            type="button"
            onClick={onShowList}
            className="text-[13px] font-medium text-brand-text hover:underline"
          >
            Ver las {count}
          </button>
        )}
      </div>
      {owner && sellers.length === 0 && (
        <span className="text-xs text-text-3">
          Aún no hay vendedores: invítalos en Ajustes → Equipo.
        </span>
      )}
    </div>
  );
}
