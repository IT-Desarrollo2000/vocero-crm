"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { isOwner, type Role } from "@/lib/roles";
import {
  conflictDetail,
  conflictsTitle,
  groupSlotsByDay,
  parseBookingError,
  type SlotConflict,
  type StaffSlot,
} from "./booking-logic";

/**
 * 023 — Agendar (o reprogramar) una cita: tipo → día → horario → vendedor →
 * notas. Compartido por Citas ("Nueva cita", "Reprogramar") y la Bandeja
 * ("Agendar").
 *
 * La rejilla viene del servidor en modo staff: lo bloqueado de verdad (mismo
 * tipo exclusivo, citas del propio vendedor, bloqueos) ya no aparece; lo que
 * trae `conflicts` es "Ocupado" y pide confirmación al guardar. La regla final
 * la vuelve a aplicar el servidor bajo candado: un 409 `slot_taken` recarga
 * la rejilla y un 409 `overlap_warning` abre la confirmación.
 */

export type BookingTypeOption = {
  id: string;
  name: string;
  durationMinutes: number;
  exclusive: boolean;
  position?: number;
  active?: boolean;
};

export type SellerOption = { id: string; name: string };

export type BookingDialogProps = {
  viewer: { userId: string; role: Role };
  /** Contacto ya elegido (desde la Bandeja); sin él, se muestra el buscador. */
  contact?: { id: string; name: string } | null;
  conversationId?: string | null;
  /** Vendedor por omisión (el asignado a la conversación); si no, el viewer. */
  defaultSellerId?: string | null;
  /** Tipos activos; si no vienen, el diálogo los pide. */
  types?: BookingTypeOption[];
  /** Vendedores para el Propietario (`{id: userId, name}`). */
  sellers?: SellerOption[];
  /** Zona del negocio, para la hora del detalle de un choque. */
  timezone?: string;
  /**
   * Reprogramar: la cita a mover. El tipo, la duración y el vendedor salen de
   * ella (A7); aquí solo se elige el nuevo horario.
   */
  reschedule?: {
    bookingId: string;
    typeName: string | null;
    contactName?: string | null;
    isBlock?: boolean;
  };
  onClose: () => void;
  onDone: (result: { label: string }) => void;
};

type ContactHit = { id: string; name: string; phone?: string | null };

const NONE = "none";

export function BookingDialog({
  viewer,
  contact: initialContact,
  conversationId,
  defaultSellerId,
  types: typesProp,
  sellers,
  timezone,
  reschedule,
  onClose,
  onDone,
}: BookingDialogProps) {
  const owner = isOwner(viewer);
  const rescheduling = Boolean(reschedule);
  // El id (no el objeto): el padre arma `reschedule` en cada render y un
  // objeto nuevo no debe borrar el horario elegido ni recargar la rejilla.
  const rescheduleId = reschedule?.bookingId ?? null;
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  const [contact, setContact] = useState<{ id: string; name: string } | null>(
    initialContact ?? null
  );
  const [types, setTypes] = useState<BookingTypeOption[] | null>(
    typesProp ?? null
  );
  const [typesError, setTypesError] = useState(false);
  const [typeId, setTypeId] = useState("");
  const [sellerValue, setSellerValue] = useState<string>(
    defaultSellerId ?? viewer.userId
  );
  const [slots, setSlots] = useState<StaffSlot[] | null>(null);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [dayIso, setDayIso] = useState<string | null>(null);
  const [slotStart, setSlotStart] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overlap, setOverlap] = useState<{
    message: string;
    conflicts: SlotConflict[];
  } | null>(null);
  const loadSeq = useRef(0);

  // Tipos: los del padre o los activos del catálogo.
  useEffect(() => {
    if (typesProp) {
      setTypes(typesProp);
      return;
    }
    if (rescheduling) return;
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/calendar/types").catch(() => null);
      if (cancelled) return;
      if (!res?.ok) {
        setTypesError(true);
        setTypes([]);
        return;
      }
      const data = (await res.json().catch(() => null)) as {
        types?: BookingTypeOption[];
      } | null;
      setTypes((data?.types ?? []).filter((t) => t.active !== false));
    })();
    return () => {
      cancelled = true;
    };
  }, [typesProp, rescheduling]);

  // Con un solo tipo no hay nada que preguntar.
  useEffect(() => {
    if (!typeId && types?.length === 1 && types[0]) setTypeId(types[0].id);
  }, [types, typeId]);

  const loadSlots = useCallback(async () => {
    const seq = ++loadSeq.current;
    const params = new URLSearchParams();
    if (rescheduleId) {
      params.set("excludeBookingId", rescheduleId);
    } else {
      if (!typeId) {
        setSlots(null);
        return;
      }
      params.set("typeId", typeId);
      if (owner) params.set("sellerId", sellerValue);
    }
    setSlots(null);
    setSlotsError(null);
    // Sin `from`/`to`: el servidor usa toda la ventana abierta de la agenda
    // (el Vendedor no puede leer `maxDaysAhead`).
    const res = await fetch(`/api/calendar/availability?${params}`).catch(
      () => null
    );
    if (seq !== loadSeq.current) return;
    if (!res?.ok) {
      const body: unknown = res ? await res.json().catch(() => null) : null;
      const msg =
        (body as { error?: { message?: string } } | null)?.error?.message ??
        (res ? "No se pudieron cargar los horarios." : "Sin conexión con el servidor.");
      setSlotsError(msg);
      setSlots([]);
      return;
    }
    const data = (await res.json().catch(() => null)) as {
      slots?: StaffSlot[];
    } | null;
    if (seq !== loadSeq.current) return;
    setSlots(
      (data?.slots ?? []).map((s) => ({ ...s, conflicts: s.conflicts ?? [] }))
    );
  }, [rescheduleId, typeId, owner, sellerValue]);

  // Cambiar tipo o vendedor invalida día y horario: la rejilla es otra.
  useEffect(() => {
    setDayIso(null);
    setSlotStart(null);
    void loadSlots();
  }, [loadSlots]);

  const days = useMemo(() => groupSlotsByDay(slots ?? []), [slots]);
  const activeDay = days.find((d) => d.dayIso === dayIso) ?? days[0] ?? null;
  const selectedSlot =
    activeDay?.slots.find((s) => s.startUtc === slotStart) ?? null;
  const selectedType = types?.find((t) => t.id === typeId) ?? null;

  // Foco: al abrir, al primer control; al cerrar, de vuelta a quien abrió.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = dialogRef.current?.querySelector<HTMLElement>(
      "[data-autofocus]"
    );
    (first ?? dialogRef.current)?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    if (!overlap) return;
    document
      .querySelector<HTMLElement>('[data-testid="booking-overlap-confirm"]')
      ?.focus();
  }, [overlap]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (overlap) setOverlap(null);
      else if (!saving) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlap, saving, onClose]);

  const canSave =
    !saving &&
    Boolean(selectedSlot) &&
    (rescheduling || (Boolean(contact) && Boolean(typeId)));

  async function save(confirmOverlap: boolean) {
    if (!selectedSlot) return;
    if (!rescheduling && (!contact || !typeId)) return;
    setSaving(true);
    setError(null);
    const startUtc = selectedSlot.startUtc;
    const res = reschedule
      ? await fetch(`/api/bookings/${reschedule.bookingId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "reschedule",
            startUtc,
            ...(confirmOverlap ? { confirmOverlap: true } : {}),
          }),
        }).catch(() => null)
      : await fetch("/api/bookings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "session",
            contactId: contact!.id,
            conversationId: conversationId ?? null,
            startUtc,
            notes: notes.trim() || null,
            typeId,
            // Solo el Propietario elige vendedor: el servidor responde 403 si
            // un Vendedor manda la llave, así que ni se incluye.
            ...(owner
              ? { assignedUserId: sellerValue === NONE ? null : sellerValue }
              : {}),
            ...(confirmOverlap ? { confirmOverlap: true } : {}),
          }),
        }).catch(() => null);
    setSaving(false);

    if (!res) {
      setOverlap(null);
      setError("Sin conexión con el servidor. Intenta de nuevo.");
      return;
    }
    const body: unknown = await res.json().catch(() => null);
    if (res.ok) {
      setOverlap(null);
      const label =
        (body as { label?: unknown } | null)?.label &&
        typeof (body as { label?: unknown }).label === "string"
          ? (body as { label: string }).label
          : selectedSlot.label;
      onDone({ label });
      return;
    }
    const failure = parseBookingError(
      res.status,
      body,
      rescheduling ? "No se pudo reprogramar la cita." : "No se pudo guardar la cita."
    );
    if (failure.kind === "overlap_warning") {
      setOverlap({ message: failure.message, conflicts: failure.conflicts });
      return;
    }
    setOverlap(null);
    setError(failure.message);
    if (failure.kind === "slot_taken") {
      // Alguien más lo ocupó: la rejilla de ahora ya no es verdad.
      setSlotStart(null);
      void loadSlots();
    }
  }

  const sellerOptions = useMemo(() => {
    const list = [...(sellers ?? [])];
    if (
      sellerValue !== NONE &&
      !list.some((s) => s.id === sellerValue)
    ) {
      list.unshift({
        id: sellerValue,
        name: sellerValue === viewer.userId ? "Yo" : "Vendedor actual",
      });
    }
    return list;
  }, [sellers, sellerValue, viewer.userId]);

  const title = rescheduling
    ? reschedule?.isBlock
      ? "Mover bloqueo"
      : "Reprogramar cita"
    : "Nueva cita";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-overlay sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving && !overlap) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="booking-dialog"
        className="flex max-h-[92vh] w-full flex-col rounded-t-lg border bg-card shadow-pop outline-none sm:max-w-lg sm:rounded-lg"
      >
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <h3 id={titleId} className="font-semibold">
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Cerrar"
            className="rounded p-1 text-text-3 hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {/* Contacto */}
          {rescheduling ? (
            <p className="text-sm text-text-2">
              {reschedule?.isBlock
                ? "Bloqueo"
                : (reschedule?.typeName ?? "Cita")}
              {reschedule?.contactName ? ` · ${reschedule.contactName}` : ""}
            </p>
          ) : contact ? (
            <div className="space-y-1.5">
              <p className="text-sm font-medium leading-none text-foreground/90">
                Contacto
              </p>
              <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <span className="truncate" data-testid="booking-contact">
                  {contact.name}
                </span>
                {!initialContact && (
                  <button
                    type="button"
                    onClick={() => setContact(null)}
                    className="shrink-0 text-xs text-brand-text hover:underline"
                  >
                    Cambiar
                  </button>
                )}
              </div>
            </div>
          ) : (
            <ContactSearch onPick={setContact} />
          )}

          {/* Tipo */}
          {!rescheduling && (
            <div className="space-y-1.5">
              <Label htmlFor={`${titleId}-type`}>Tipo de cita</Label>
              <select
                id={`${titleId}-type`}
                data-testid="booking-type"
                data-autofocus={initialContact ? true : undefined}
                value={typeId}
                onChange={(e) => setTypeId(e.target.value)}
                disabled={!types || types.length === 0}
                className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
              >
                <option value="">
                  {types === null ? "Cargando…" : "Elige un tipo"}
                </option>
                {(types ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.durationMinutes} min
                    {t.exclusive ? " · exclusivo" : ""}
                  </option>
                ))}
              </select>
              {typesError && (
                <p className="text-xs text-destructive">
                  No se pudieron cargar los tipos de cita.
                </p>
              )}
              {types?.length === 0 && !typesError && (
                <p className="text-xs text-text-3">
                  No hay tipos de cita activos. El Propietario los configura en
                  Ajustes → Agenda.
                </p>
              )}
              {selectedType?.exclusive && (
                <p className="text-xs text-text-3">
                  Exclusivo: solo una a la vez en todo el negocio.
                </p>
              )}
            </div>
          )}

          {/* Vendedor (solo el Propietario elige) */}
          {!rescheduling && owner && (
            <div className="space-y-1.5">
              <Label htmlFor={`${titleId}-seller`}>Vendedor</Label>
              <select
                id={`${titleId}-seller`}
                data-testid="booking-seller"
                value={sellerValue}
                onChange={(e) => setSellerValue(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
              >
                {sellerOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                <option value={NONE}>Sin asignar</option>
              </select>
            </div>
          )}

          {/* Día y horario */}
          {(rescheduling || typeId) && (
            <div className="space-y-2">
              <p
                id={`${titleId}-days`}
                className="text-sm font-medium leading-none text-foreground/90"
              >
                Día
              </p>
              {slots === null && (
                <p className="text-sm text-text-3">Buscando horarios…</p>
              )}
              {slotsError && (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm text-destructive">{slotsError}</p>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void loadSlots()}
                  >
                    Reintentar
                  </Button>
                </div>
              )}
              {slots && !slotsError && days.length === 0 && (
                <p className="text-sm text-text-3">
                  No hay horarios disponibles. Revisa el horario de atención o
                  prueba con otro tipo.
                </p>
              )}
              {days.length > 0 && (
                <div
                  role="group"
                  aria-labelledby={`${titleId}-days`}
                  className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
                >
                  {days.map((d) => {
                    const active = d.dayIso === activeDay?.dayIso;
                    return (
                      <button
                        key={d.dayIso}
                        type="button"
                        data-testid="booking-day"
                        data-day={d.dayIso}
                        aria-pressed={active}
                        onClick={() => {
                          setDayIso(d.dayIso);
                          setSlotStart(null);
                        }}
                        className={cn(
                          "shrink-0 rounded-sm border px-2.5 py-1.5 text-left text-xs font-medium transition-colors",
                          active
                            ? "border-brand bg-brand-tint text-brand-text"
                            : "border-border hover:bg-accent"
                        )}
                      >
                        <span className="block whitespace-nowrap">
                          {d.dayLabel}
                        </span>
                        {!d.hasFree && (
                          <span className="block text-[10.5px] font-normal text-warning-text">
                            todo ocupado
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {activeDay && (
                <>
                  <p
                    id={`${titleId}-slots`}
                    className="pt-1 text-sm font-medium leading-none text-foreground/90"
                  >
                    Horario
                  </p>
                  <div
                    role="group"
                    aria-labelledby={`${titleId}-slots`}
                    className="grid grid-cols-3 gap-1.5 sm:grid-cols-4"
                  >
                    {activeDay.slots.map((s) => {
                      const busy = s.conflicts.length > 0;
                      const active = s.startUtc === slotStart;
                      const detail = busy
                        ? conflictsTitle(s.conflicts, timezone, s.time)
                        : undefined;
                      return (
                        <button
                          key={s.startUtc}
                          type="button"
                          data-testid="booking-slot"
                          data-start={s.startUtc}
                          data-busy={busy ? "true" : undefined}
                          aria-pressed={active}
                          aria-label={
                            busy ? `${s.time}, ocupado: ${detail}` : s.time
                          }
                          title={detail}
                          onClick={() => setSlotStart(s.startUtc)}
                          className={cn(
                            "rounded-sm border px-2 py-1.5 text-sm transition-colors",
                            active
                              ? "border-brand bg-brand-tint font-semibold text-brand-text"
                              : busy
                                ? "border-warning-soft bg-warning-tint text-warning-text hover:opacity-90"
                                : "border-border hover:bg-accent"
                          )}
                        >
                          <span className="block">{s.time}</span>
                          {busy && (
                            <span className="block text-[10.5px] font-medium">
                              Ocupado
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {selectedSlot && selectedSlot.conflicts.length > 0 && (
                    <div
                      data-testid="booking-slot-conflicts"
                      className="flex gap-2 rounded-sm border border-warning-soft bg-warning-tint p-2 text-xs text-warning-text"
                    >
                      <AlertTriangle
                        className="mt-0.5 h-3.5 w-3.5 shrink-0"
                        strokeWidth={2}
                        aria-hidden
                      />
                      <div>
                        <p className="font-medium">
                          A esa hora ya hay otra cita:
                        </p>
                        <ul>
                          {selectedSlot.conflicts.map((c) => (
                            <li key={c.bookingId}>
                              {conflictDetail(c, timezone, selectedSlot.time)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Notas */}
          {!rescheduling && (
            <div className="space-y-1.5">
              <Label htmlFor={`${titleId}-notes`}>Notas (opcional)</Label>
              <Textarea
                id={`${titleId}-notes`}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                maxLength={1000}
              />
            </div>
          )}

          {error && (
            <p
              role="alert"
              data-testid="booking-error"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button
            data-testid="booking-save"
            disabled={!canSave}
            onClick={() => void save(false)}
          >
            {saving ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </div>

      {overlap && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`${titleId}-overlap`}
            aria-describedby={`${titleId}-overlap-msg`}
            data-testid="booking-overlap-dialog"
            className="w-full max-w-sm rounded-lg border bg-card p-4 shadow-pop"
          >
            <h4 id={`${titleId}-overlap`} className="font-semibold">
              Horario ocupado
            </h4>
            <p id={`${titleId}-overlap-msg`} className="mt-1 text-sm text-text-2">
              {overlap.message}
            </p>
            {overlap.conflicts.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-sm text-text-2">
                {overlap.conflicts.map((c) => (
                  <li key={c.bookingId}>
                    · {conflictDetail(c, timezone, selectedSlot?.time)}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setOverlap(null)}
                disabled={saving}
              >
                Cancelar
              </Button>
              <Button
                data-testid="booking-overlap-confirm"
                disabled={saving}
                onClick={() => void save(true)}
              >
                {saving ? "Guardando…" : "Agendar de todos modos"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Buscador de contactos (misma búsqueda tolerante que el directorio). */
function ContactSearch({
  onPick,
}: {
  onPick: (c: { id: string; name: string }) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ContactHit[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void (async () => {
        const params = new URLSearchParams({ q, limit: "8" });
        const res = await fetch(`/api/contacts?${params}`).catch(() => null);
        if (cancelled) return;
        if (!res?.ok) {
          setFailed(true);
          setHits([]);
          return;
        }
        const data = (await res.json().catch(() => null)) as {
          contacts?: ContactHit[];
        } | null;
        if (cancelled) return;
        setFailed(false);
        setHits(data?.contacts ?? []);
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${id}-q`}>Contacto</Label>
      <div className="relative">
        <Search
          className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
          aria-hidden
        />
        <Input
          id={`${id}-q`}
          data-testid="booking-contact-search"
          data-autofocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por nombre o teléfono…"
          className="pl-8"
          autoComplete="off"
        />
      </div>
      {failed && (
        <p className="text-xs text-destructive">
          No se pudo buscar. Intenta de nuevo.
        </p>
      )}
      {hits && hits.length === 0 && !failed && (
        <p className="text-xs text-text-3">Sin coincidencias.</p>
      )}
      {hits && hits.length > 0 && (
        <ul
          aria-label="Resultados de la búsqueda"
          className="max-h-44 divide-y overflow-y-auto rounded-md border"
        >
          {hits.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                data-testid="booking-contact-option"
                onClick={() => onPick({ id: c.id, name: c.name })}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
              >
                <span className="truncate">{c.name}</span>
                {c.phone && (
                  <span className="shrink-0 text-xs text-text-3">{c.phone}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
