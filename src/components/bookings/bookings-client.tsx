"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarPlus, Info, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEvents } from "@/components/use-events";
import { useViewer } from "@/components/viewer-context";
import { isOwner } from "@/lib/roles";
import type { BookingReminderDto } from "@/lib/reminders";
import { describeReminder, formatDue, retryErrorMessage } from "./reminder-labels";
import {
  BookingDialog,
  type BookingTypeOption,
  type SellerOption,
} from "./booking-dialog";
import {
  applyClientFilter,
  bookingsQuery,
  parseBookingError,
  type SellerFilter,
} from "./booking-logic";

/**
 * 015 — Citas: lo agendado por el operador y por la IA, con sus acciones.
 *
 * 023 — Agenda presencial: "Nueva cita" y "Reprogramar" abren el diálogo
 * compartido (rejilla por tipo y vendedor, con advertencia de choque);
 * filtros por vendedor y tipo; tipo y vendedor en cada fila; el Propietario
 * reasigna.
 */

type Booking = {
  id: string;
  kind: "session" | "block";
  status: "agendada" | "realizada" | "no_show" | "cancelada";
  source: "manual" | "ai";
  scheduledAtUtc: string;
  durationMinutes: number;
  date: string;
  time: string;
  weekday: string;
  contact: { id: string; name: string } | null;
  conversationId: string | null;
  connector: string | null;
  meetingLink: string | null;
  linkPending: boolean;
  isTest: boolean;
  notes: string | null;
  /**
   * 10 — Recordatorios de la hora vigente, uno por anticipación (vacío si
   * están apagados o la cita no es `session`).
   */
  reminders: BookingReminderDto[];
  /** 023 — Tipo de cita; null en bloqueos y en citas de la 015. */
  type: { id: string; name: string } | null;
  /** 023 — Vendedor; null ⇒ "Sin asignar". */
  assignedUser: { id: string; name: string } | null;
  createdByUserId: string | null;
  exclusive: boolean;
};

type DialogState =
  | { mode: "create" }
  | { mode: "reschedule"; booking: Booking }
  | null;

const REASSIGN_TAKEN = "Ese vendedor ya tiene una cita a esa hora";

const STATUS_LABEL: Record<Booking["status"], string> = {
  agendada: "Agendada",
  realizada: "Realizada",
  no_show: "No asistió",
  cancelada: "Cancelada",
};

export function BookingsClient() {
  const viewer = useViewer();
  const owner = isOwner(viewer);
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [types, setTypes] = useState<BookingTypeOption[]>([]);
  const [sellers, setSellers] = useState<SellerOption[]>([]);
  const [sellerFilter, setSellerFilter] = useState<SellerFilter>("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reassigning, setReassigning] = useState<string | null>(null);
  const [reassignTo, setReassignTo] = useState("none");
  // 10 — Zona del negocio (de `GET /api/bookings`) para la hora de envío de
  // los recordatorios; sin ella, la del navegador.
  const [businessTimezone, setBusinessTimezone] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blockStart, setBlockStart] = useState("");
  const [blockMinutes, setBlockMinutes] = useState(60);

  // Los filtros viven también en un ref: `refresh` lo llaman el SSE y las
  // acciones, y siempre debe pedir con los filtros VIGENTES.
  const query = bookingsQuery(sellerFilter, typeFilter);
  const queryRef = useRef(query);
  queryRef.current = query;
  const loadSeq = useRef(0);

  useEffect(() => {
    void refresh();
  }, [query]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // La agenda cambia también cuando agenda la IA: SSE mantiene la vista viva.
  useEvents({ onBookingUpdated: () => void refresh() });

  async function refresh() {
    const seq = ++loadSeq.current;
    const list = await fetch(queryRef.current).catch(() => null);
    if (seq !== loadSeq.current) return;
    if (list?.ok) {
      const data = (await list.json()) as {
        bookings: Booking[];
        businessTimezone?: string;
        types?: BookingTypeOption[];
        sellers?: SellerOption[];
      };
      if (seq !== loadSeq.current) return;
      setBookings(data.bookings);
      setBusinessTimezone(data.businessTimezone || undefined);
      if (data.types) setTypes(data.types);
      if (data.sellers) setSellers(data.sellers);
    } else {
      setBookings((b) => b ?? []);
    }
  }

  async function act(id: string, body: unknown) {
    setBusy(id);
    setError(null);
    const res = await fetch(`/api/bookings/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      const data = (await res?.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(data?.error?.message ?? "No se pudo completar la acción");
      return;
    }
    await refresh();
  }

  /** 023 — Reasignar (Propietario). Un choque del nuevo vendedor es 409. */
  async function reassign(b: Booking) {
    setBusy(b.id);
    setError(null);
    const res = await fetch(`/api/bookings/${b.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "assign",
        userId: reassignTo === "none" ? null : reassignTo,
      }),
    }).catch(() => null);
    setBusy(null);
    if (!res) {
      setError("Sin conexión con el servidor.");
      return;
    }
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      const failure = parseBookingError(
        res.status,
        body,
        "No se pudo reasignar la cita."
      );
      setError(failure.kind === "slot_taken" ? REASSIGN_TAKEN : failure.message);
      return;
    }
    setReassigning(null);
    setNotice("Cita reasignada.");
    await refresh();
  }

  // 10 — Reintento manual (a lo sumo uno) de un recordatorio fallido. La
  // respuesta trae la fila ya resuelta; se recarga la lista igual que tras
  // cualquier acción (y el SSE `booking.updated` también llegará).
  async function retryReminder(bookingId: string, reminderId: string) {
    setBusy(bookingId);
    setError(null);
    const res = await fetch(
      `/api/bookings/${bookingId}/reminders/${reminderId}/retry`,
      { method: "POST" }
    ).catch(() => null);
    setBusy(null);
    const body: unknown = res ? await res.json().catch(() => null) : null;
    const message = res
      ? retryErrorMessage(res.status, body)
      : "No se pudo reintentar el recordatorio.";
    if (message) setError(message);
    await refresh();
  }

  async function createBlock() {
    if (!blockStart) return;
    setError(null);
    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "block",
        // El input datetime-local da hora local del navegador.
        startUtc: new Date(blockStart).toISOString(),
        durationMinutes: blockMinutes,
      }),
    }).catch(() => null);
    if (res?.status !== 201) {
      const data = (await res?.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(data?.error?.message ?? "No se pudo bloquear ese rango");
      return;
    }
    setBlockStart("");
    await refresh();
  }

  if (!bookings) return <p className="text-sm text-text-3">Cargando…</p>;

  const visible = applyClientFilter(bookings, sellerFilter, viewer.userId);
  const filtered = sellerFilter !== "all" || typeFilter !== "all";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          data-testid="bookings-new"
          onClick={() => {
            setError(null);
            setDialog({ mode: "create" });
          }}
        >
          <CalendarPlus className="h-4 w-4" strokeWidth={1.8} aria-hidden />
          Nueva cita
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <select
            data-testid="bookings-seller-filter"
            aria-label="Filtrar por vendedor"
            value={sellerFilter}
            onChange={(e) => setSellerFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-card px-2 text-sm"
          >
            {owner ? (
              <>
                <option value="all">Todos los vendedores</option>
                {sellers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                <option value="none">Sin asignar</option>
              </>
            ) : (
              <>
                <option value="all">Todas</option>
                <option value="mine">Mías</option>
                <option value="none">Sin asignar</option>
              </>
            )}
          </select>
          <select
            data-testid="bookings-type-filter"
            aria-label="Filtrar por tipo de cita"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-card px-2 text-sm"
          >
            <option value="all">Todo tipo</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Bloquear un rango</h3>
        <p className="text-sm text-text-3">
          Para compromisos que viven fuera del CRM: ese tiempo deja de
          ofrecerse.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="block-start">Inicio</Label>
            <Input
              id="block-start"
              type="datetime-local"
              value={blockStart}
              onChange={(e) => setBlockStart(e.target.value)}
              className="w-56"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="block-min">Minutos</Label>
            <Input
              id="block-min"
              type="number"
              min={10}
              max={480}
              value={blockMinutes}
              onChange={(e) => setBlockMinutes(Number(e.target.value))}
              className="w-24"
            />
          </div>
          <Button
            variant="secondary"
            onClick={createBlock}
            disabled={!blockStart}
          >
            Bloquear
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">
          Citas <span className="text-text-3">({visible.length})</span>
        </h3>
        {visible.length === 0 &&
          (filtered ? (
            <p className="text-sm text-text-3">No hay citas con estos filtros.</p>
          ) : (
            <p className="text-sm text-text-3">
              Todavía no hay nada agendado. Configura tu horario en Ajustes →
              Agenda para empezar a recibir citas.
            </p>
          ))}
        <ul className="divide-y rounded-md border">
          {visible.map((b) => (
            <li key={b.id} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">
                  {b.weekday} {b.date} · {b.time}
                </span>
                <span className="text-xs text-text-3">
                  {b.durationMinutes} min
                </span>
                <Badge
                  variant={b.status === "cancelada" ? "secondary" : "default"}
                >
                  {STATUS_LABEL[b.status]}
                </Badge>
                {b.type && <Badge variant="outline">{b.type.name}</Badge>}
                {b.kind === "block" ? (
                  <Badge variant="secondary">Bloqueo</Badge>
                ) : (
                  <Badge variant="secondary">
                    {b.source === "ai" ? "Agendó la IA" : "Manual"}
                  </Badge>
                )}
                {b.isTest && <Badge variant="secondary">Prueba</Badge>}
                {b.linkPending && b.status !== "cancelada" && (
                  <Badge variant="secondary">Sin enlace</Badge>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3 text-sm text-text-3">
                {b.contact && <span>{b.contact.name}</span>}
                {b.kind === "session" && (
                  <span data-testid="booking-seller-name">
                    {b.assignedUser?.name || "Sin asignar"}
                  </span>
                )}
                {b.meetingLink && (
                  <a
                    href={b.meetingLink}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-brand-text hover:underline"
                  >
                    Enlace de la reunión
                  </a>
                )}
                {b.notes && <span>{b.notes}</span>}
              </div>

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
                            disabled={busy === b.id}
                            onClick={() => retryReminder(b.id, reminderId)}
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
                    disabled={busy === b.id}
                    onClick={() => act(b.id, { action: "retry_link" })}
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
                    disabled={busy === b.id}
                    onClick={() => {
                      setError(null);
                      setDialog({ mode: "reschedule", booking: b });
                    }}
                  >
                    Reprogramar
                  </Button>
                  {owner && b.kind === "session" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      data-testid="booking-reassign"
                      aria-expanded={reassigning === b.id}
                      disabled={busy === b.id}
                      onClick={() => {
                        setError(null);
                        setReassignTo(b.assignedUser?.id ?? "none");
                        setReassigning((r) => (r === b.id ? null : b.id));
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
                        disabled={busy === b.id}
                        onClick={() =>
                          act(b.id, { action: "status", status: "realizada" })
                        }
                      >
                        Realizada
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy === b.id}
                        onClick={() =>
                          act(b.id, { action: "status", status: "no_show" })
                        }
                      >
                        No asistió
                      </Button>
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === b.id}
                    onClick={() => act(b.id, { action: "cancel" })}
                  >
                    {b.kind === "block" ? "Quitar bloqueo" : "Cancelar"}
                  </Button>
                </div>
              )}

              {reassigning === b.id && owner && (
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
                    disabled={busy === b.id}
                    onClick={() => void reassign(b)}
                  >
                    {busy === b.id ? "Guardando…" : "Guardar"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === b.id}
                    onClick={() => setReassigning(null)}
                  >
                    Cancelar
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {dialog && (
        <BookingDialog
          viewer={viewer}
          types={types}
          sellers={owner ? sellers : undefined}
          timezone={businessTimezone}
          reschedule={
            dialog.mode === "reschedule"
              ? {
                  bookingId: dialog.booking.id,
                  typeName: dialog.booking.type?.name ?? null,
                  contactName: dialog.booking.contact?.name ?? null,
                  isBlock: dialog.booking.kind === "block",
                }
              : undefined
          }
          onClose={() => setDialog(null)}
          onDone={({ label }) => {
            const verb =
              dialog.mode === "reschedule"
                ? dialog.booking.kind === "block"
                  ? "Bloqueo movido a"
                  : "Cita reprogramada para"
                : "Cita agendada para";
            setDialog(null);
            setNotice(`${verb} ${label}`);
            void refresh();
          }}
        />
      )}

      {notice && (
        <div
          role="status"
          data-testid="bookings-notice"
          className="fixed inset-x-3 bottom-4 z-40 mx-auto flex max-w-md items-start gap-2 rounded-md border bg-background px-3 py-2.5 text-sm shadow-pop md:bottom-6"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand" strokeWidth={1.7} />
          <p className="flex-1">{notice}</p>
          <button
            onClick={() => setNotice(null)}
            aria-label="Cerrar aviso"
            className="shrink-0 rounded p-0.5 text-text-3 hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
      )}
    </div>
  );
}
