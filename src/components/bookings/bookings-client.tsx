"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarPlus, Info, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEvents } from "@/components/use-events";
import { useViewer } from "@/components/viewer-context";
import { isOwner } from "@/lib/roles";
import {
  blockStartUtc,
  calendarVisible,
  coalesce,
  datesOf,
  rangeLabel,
  shiftRange,
  visibleRange,
  type DateRange,
} from "@/lib/time/calendar";
import { todayInTz } from "@/lib/time/slots";
import type { OverlapMap } from "@/server/agenda/overlaps";
import {
  BookingDialog,
  type BookingTypeOption,
  type SellerOption,
} from "./booking-dialog";
import { BookingActions, type BookingActionHandlers } from "./booking-actions";
import { BookingClientCard } from "./booking-client-card";
import { BookingDetailPanel } from "./booking-detail-panel";
import { STATUS_LABEL, type Booking } from "./booking-look";
import {
  applyClientFilter,
  bookingsQuery,
  parseBookingError,
  type SellerFilter,
  type SlotConflict,
} from "./booking-logic";
import { CalendarLegend } from "./calendar/calendar-legend";
import {
  defaultView,
  parseStoredView,
  sellerColumns,
  VIEW_STORAGE_KEY,
  type CalendarHours,
  type CalView,
} from "./calendar/calendar-model";
import { CalendarDnd } from "./calendar/calendar-dnd";
import { CalendarToolbar } from "./calendar/calendar-toolbar";
import { DaySellersView } from "./calendar/day-sellers-view";
import {
  applyOverride,
  moveRequest,
  parseMoveResponse,
  wallLabel,
  type DropPreview,
  type MoveOverride,
} from "./calendar/drag-model";
import { MoveOverlapDialog } from "./calendar/move-overlap-dialog";
import { WeekView } from "./calendar/week-view";
import { retryErrorMessage } from "./reminder-labels";

/**
 * 015 — Citas: lo agendado por el operador y por la IA, con sus acciones.
 *
 * 023 — Agenda presencial: "Nueva cita" y "Reprogramar" abren el diálogo
 * compartido (rejilla por tipo y vendedor, con advertencia de choque);
 * filtros por vendedor y tipo; tipo y vendedor en cada fila; el Propietario
 * reasigna.
 *
 * 028 — Calendario: Semana (por defecto en computadora), Día por vendedor
 * (por defecto en celular) y la Lista de siempre. La vista se recuerda en
 * `localStorage`. Semana y Día piden `GET /api/bookings?from=&to=` (todo en la
 * zona del NEGOCIO, con `hours` y `overlaps`); la Lista, lo de siempre. Los
 * filtros de vendedor y tipo aplican a las tres. Clic en un hueco ⇒ Nueva
 * cita con esa hora; clic en una cita ⇒ panel de detalle con las MISMAS
 * acciones que la fila (`BookingActions`).
 */

type DialogState =
  | {
      mode: "create";
      initialDayIso?: string;
      initialStartUtc?: string;
      sellerId?: string;
    }
  | { mode: "reschedule"; booking: Booking }
  | null;

/** Lo último que respondió `GET /api/bookings` (Lista o rango). */
type Loaded =
  | { mode: "list"; bookings: Booking[] }
  | {
      mode: "range";
      bookings: Booking[];
      hours: CalendarHours;
      overlaps: OverlapMap;
      truncated: boolean;
      range: DateRange;
    };

const REASSIGN_TAKEN = "Ese vendedor ya tiene una cita a esa hora";

/** Ráfagas de `booking.updated` (la IA agenda en varios pasos): una recarga. */
const SSE_COALESCE_MS = 250;

function readStoredView(): CalView | null {
  try {
    return parseStoredView(window.localStorage.getItem(VIEW_STORAGE_KEY));
  } catch {
    return null;
  }
}

function storeView(v: CalView) {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, v);
  } catch {
    // Modo privado o almacenamiento lleno: la vista simplemente no se recuerda.
  }
}

/** Fecha de hoy en la zona del navegador: solo hasta conocer la del negocio. */
function browserToday(): string {
  return todayInTz(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone);
}

export function BookingsClient() {
  const viewer = useViewer();
  const owner = isOwner(viewer);
  // La vista y la fecha se resuelven en el cliente (localStorage, ancho de
  // pantalla): en el primer render no existen, para no desfasar la hidratación.
  const [view, setView] = useState<CalView | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const navigated = useRef(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [types, setTypes] = useState<BookingTypeOption[]>([]);
  const [sellers, setSellers] = useState<SellerOption[]>([]);
  const [sellerFilter, setSellerFilter] = useState<SellerFilter>("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [showCancelled, setShowCancelled] = useState(false);
  const [showTests, setShowTests] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 10 — Zona del negocio (de `GET /api/bookings`) para la hora de envío de
  // los recordatorios; sin ella, la del navegador.
  const [businessTimezone, setBusinessTimezone] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blockStart, setBlockStart] = useState("");
  const [blockMinutes, setBlockMinutes] = useState(60);
  const [now, setNow] = useState(() => new Date());
  // 028 (Fase B) — Movimiento optimista, error del arrastre y confirmación.
  const [override, setOverride] = useState<MoveOverride | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moveConfirm, setMoveConfirm] = useState<{
    booking: Booking;
    body: NonNullable<ReturnType<typeof moveRequest>>;
    message: string;
    conflicts: SlotConflict[];
  } | null>(null);
  const [moving, setMoving] = useState(false);
  // R1 — La carga falló (500, 422, red): se dice y se ofrece reintentar, en
  // vez de quedarse en "Cargando…" para siempre.
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const isWide = window.matchMedia?.("(min-width: 768px)").matches ?? true;
    setView(readStoredView() ?? defaultView(isWide));
    setAnchor(browserToday());
  }, []);

  // La línea de la hora actual avanza sola.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const calView = view === "semana" || view === "dia" ? view : null;
  const range = calView && anchor ? visibleRange(calView, anchor) : null;

  // Los filtros y el rango viven también en un ref: `refresh` lo llaman el
  // SSE y las acciones, y siempre debe pedir con lo VIGENTE.
  const listQuery = bookingsQuery(sellerFilter, typeFilter);
  const query = view === null ? null : range ? withRange(listQuery, range) : listQuery;
  const queryRef = useRef(query);
  queryRef.current = query;
  const loadSeq = useRef(0);

  useEffect(() => {
    if (query) void refresh();
  }, [query]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // La agenda cambia también cuando agenda la IA: SSE mantiene la vista viva
  // (el rango visible), y una ráfaga de avisos cuesta una sola recarga.
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  refreshRef.current = refresh;
  const sse = useMemo(
    () => coalesce(() => void refreshRef.current(), SSE_COALESCE_MS),
    []
  );
  useEffect(() => () => sse.cancel(), [sse]);
  // 028 (A6) — Mientras se arrastra, el SSE se guarda y se aplica al soltar:
  // una recarga a media maniobra movería la rejilla bajo el puntero.
  const dragging = useRef(false);
  const ssePending = useRef(false);
  useEvents({
    onBookingUpdated: () => {
      if (dragging.current) ssePending.current = true;
      else sse.trigger();
    },
  });

  async function refresh() {
    const url = queryRef.current;
    if (!url) return;
    const seq = ++loadSeq.current;
    const list = await fetch(url).catch(() => null);
    if (seq !== loadSeq.current) return;
    if (list?.ok) {
      setLoadError(null);
      const data = (await list.json()) as {
        bookings: Booking[];
        businessTimezone?: string;
        types?: BookingTypeOption[];
        sellers?: SellerOption[];
        hours?: CalendarHours;
        overlaps?: OverlapMap;
        truncated?: boolean;
        range?: DateRange;
      };
      if (seq !== loadSeq.current) return;
      setLoaded(
        data.hours && data.range
          ? {
              mode: "range",
              bookings: data.bookings,
              hours: data.hours,
              overlaps: data.overlaps ?? {},
              truncated: data.truncated === true,
              range: data.range,
            }
          : { mode: "list", bookings: data.bookings }
      );
      const tz = data.businessTimezone || undefined;
      setBusinessTimezone(tz);
      if (data.types) setTypes(data.types);
      if (data.sellers) setSellers(data.sellers);
      // La fecha inicial salió del navegador; si el negocio ya va en otro
      // día (otra zona), se corrige mientras nadie haya navegado.
      if (tz && !navigated.current) {
        const today = todayInTz(new Date(), tz);
        setAnchor((a) => (a === today ? a : today));
      }
    } else {
      const body = (await list?.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setLoadError(
        list
          ? (body?.error?.message ?? "No se pudieron cargar las citas.")
          : "Sin conexión con el servidor."
      );
      setLoaded((l) => l ?? { mode: "list", bookings: [] });
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
  async function reassign(b: Booking, userId: string | null): Promise<boolean> {
    setBusy(b.id);
    setError(null);
    const res = await fetch(`/api/bookings/${b.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "assign", userId }),
    }).catch(() => null);
    setBusy(null);
    if (!res) {
      setError("Sin conexión con el servidor.");
      return false;
    }
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      const failure = parseBookingError(
        res.status,
        body,
        "No se pudo reasignar la cita."
      );
      setError(failure.kind === "slot_taken" ? REASSIGN_TAKEN : failure.message);
      return false;
    }
    setNotice("Cita reasignada.");
    await refresh();
    return true;
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
    if (!blockStart || !businessTimezone) return;
    setError(null);
    // 028 (A8) — El campo da día y hora "de pared"; se leen en la zona del
    // NEGOCIO, no en la del navegador (antes: `new Date(valor)`).
    const [day = "", time = ""] = blockStart.split("T");
    const startUtc = blockStartUtc(day, time.slice(0, 5), businessTimezone);
    if (!startUtc) {
      setError("Fecha u hora inválida.");
      return;
    }
    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "block",
        startUtc,
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

  /** 028 (A6) — Inicio/fin del arrastre: pausa y reanuda el SSE. */
  function onDraggingChange(on: boolean) {
    dragging.current = on;
    if (on) {
      setMoveError(null);
      return;
    }
    if (ssePending.current) {
      ssePending.current = false;
      sse.trigger();
    }
  }

  /** 028 — Soltar: movimiento optimista y `PATCH move`. */
  function onDrop(b: Booking, preview: DropPreview) {
    if (!calView) return;
    const body = moveRequest(b, preview, { view: calView });
    if (!body || !preview.startUtc) return;
    const sellerChanged = body.userId !== undefined;
    setOverride({
      id: b.id,
      scheduledAtUtc: preview.startUtc,
      assignedUser: sellerChanged
        ? body.userId
          ? {
              id: body.userId,
              name: sellers.find((s) => s.id === body.userId)?.name ?? "",
            }
          : null
        : b.assignedUser,
    });
    void sendMove(b, body);
  }

  async function sendMove(
    b: Booking,
    body: NonNullable<ReturnType<typeof moveRequest>>
  ) {
    setMoving(true);
    setMoveError(null);
    const res = await fetch(`/api/bookings/${b.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    const json: unknown = res ? await res.json().catch(() => null) : null;
    setMoving(false);
    const outcome = parseMoveResponse(res ? res.status : null, json);
    if (outcome.kind === "overlap_warning") {
      setMoveConfirm({
        booking: b,
        body,
        message: outcome.message,
        conflicts: outcome.conflicts,
      });
      return;
    }
    setMoveConfirm(null);
    if (outcome.kind === "error") {
      setOverride(null);
      setMoveError(outcome.message);
      await refresh();
      return;
    }
    const label =
      outcome.label ||
      (businessTimezone && body.startUtc
        ? wallLabel(body.startUtc, businessTimezone)
        : "");
    setNotice(
      body.startUtc
        ? `${b.kind === "block" ? "Bloqueo movido a" : "Cita movida a"} ${label}`
        : "Cita reasignada."
    );
    await refresh();
    setOverride(null);
  }

  const handlers: BookingActionHandlers = {
    onAct: (id, body) => void act(id, body),
    onReschedule: (b) => {
      setError(null);
      setDialog({ mode: "reschedule", booking: b });
    },
    onReassign: reassign,
    onRetryReminder: (id, reminderId) => void retryReminder(id, reminderId),
    onClearError: () => setError(null),
  };

  function changeView(v: CalView) {
    setView(v);
    storeView(v);
    setDetailId(null);
  }

  function navigate(dir: 1 | -1) {
    if (!calView || !anchor) return;
    navigated.current = true;
    setAnchor(shiftRange(calView, anchor, dir).anchor);
  }

  function goToday() {
    navigated.current = false;
    setAnchor(
      businessTimezone ? todayInTz(new Date(), businessTimezone) : browserToday()
    );
  }

  const ready =
    view !== null &&
    loaded !== null &&
    (view === "lista" ? loaded.mode === "list" : loaded.mode === "range");

  const filtered = sellerFilter !== "all" || typeFilter !== "all";
  const allLoaded = loaded?.bookings ?? [];
  const visible = applyClientFilter(allLoaded, sellerFilter, viewer.userId);
  const calBookings = calendarVisible(applyOverride(visible, override), {
    showCancelled,
    showTests,
  });
  const detail = detailId ? allLoaded.find((b) => b.id === detailId) ?? null : null;
  const overlaps = loaded?.mode === "range" ? loaded.overlaps : {};
  const scrollKey = `${view}:${anchor}`;

  const blockSection = (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">Bloquear un rango</h3>
      <p className="text-sm text-text-3">
        Para compromisos que viven fuera del CRM: ese tiempo deja de
        ofrecerse.
        {businessTimezone && ` Hora del negocio (${businessTimezone}).`}
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
          disabled={!blockStart || !businessTimezone}
        >
          Bloquear
        </Button>
      </div>
    </section>
  );

  return (
    <div className="min-w-0 space-y-6">
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

      {view && (
        <CalendarToolbar
          view={view}
          title={calView && anchor ? rangeLabel(calView, anchor) : ""}
          showCancelled={showCancelled}
          showTests={showTests}
          onView={changeView}
          onPrev={() => navigate(-1)}
          onNext={() => navigate(1)}
          onToday={goToday}
          onShowCancelled={setShowCancelled}
          onShowTests={setShowTests}
        />
      )}

      {error && !detail && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {loadError && (
        <div
          role="alert"
          data-testid="cal-load-error"
          className="flex flex-wrap items-center gap-2 rounded-sm border border-danger-soft bg-danger-tint p-2 text-sm text-danger-text"
        >
          <p className="flex-1">{loadError}</p>
          <Button size="sm" variant="secondary" onClick={() => void refresh()}>
            Reintentar
          </Button>
        </div>
      )}

      {!ready && !loadError && <p className="text-sm text-text-3">Cargando…</p>}

      {ready && loaded?.mode === "range" && range && (
        <section aria-label="Calendario de citas" className="min-w-0 space-y-3">
          <CalendarLegend types={types} />
          {loaded.truncated && (
            <p className="text-sm text-warning-text">
              Hay demasiadas citas en este rango: se muestran las primeras.
            </p>
          )}
          {moveError && (
            <div
              role="alert"
              data-testid="cal-move-error"
              className="flex items-start gap-2 rounded-sm border border-danger-soft bg-danger-tint p-2 text-sm text-danger-text"
            >
              <p className="flex-1">{moveError}</p>
              <button
                type="button"
                onClick={() => setMoveError(null)}
                aria-label="Cerrar aviso"
                className="shrink-0 rounded p-0.5 hover:bg-accent"
              >
                <X className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
            </div>
          )}
          {moving && (
            <p role="status" className="text-xs text-text-3">
              Moviendo…
            </p>
          )}
          <CalendarDnd
            view={view === "semana" ? "semana" : "dia"}
            owner={owner}
            hours={loaded.hours}
            now={now}
            bookings={calBookings}
            onDraggingChange={onDraggingChange}
            onDrop={onDrop}
            onRejected={(message) => setMoveError(message)}
          >
            {(drag) =>
              view === "semana" ? (
              <WeekView
                days={datesOf(range)}
                bookings={calBookings}
                hours={loaded.hours}
                overlaps={overlaps}
                now={now}
                scrollKey={scrollKey}
                drag={drag}
                onOpenBooking={(b) => setDetailId(b.id)}
                onEmptyCell={(cell) =>
                  setDialog({
                    mode: "create",
                    initialDayIso: cell.dayIso,
                    initialStartUtc: cell.startUtc,
                  })
                }
              />
            ) : (
              <DaySellersView
                day={range.from}
                columns={sellerColumns({
                  owner,
                  viewerId: viewer.userId,
                  sellers,
                  bookings: calBookings,
                  filter: sellerFilter,
                })}
                bookings={calBookings}
                hours={loaded.hours}
                overlaps={overlaps}
                now={now}
                scrollKey={scrollKey}
                drag={drag}
                onOpenBooking={(b) => setDetailId(b.id)}
                onEmptyCell={(cell) =>
                  setDialog({
                    mode: "create",
                    initialDayIso: cell.dayIso,
                    initialStartUtc: cell.startUtc,
                    // El Propietario agenda en la columna que tocó.
                    sellerId: owner ? cell.columnKey : undefined,
                  })
                }
              />
            )}
          </CalendarDnd>
          {calBookings.length === 0 && (
            <p className="text-sm text-text-3">
              {filtered
                ? "No hay citas con estos filtros en este rango."
                : "No hay citas en este rango. Toca un horario libre para agendar."}
            </p>
          )}
        </section>
      )}

      {ready && view === "lista" && blockSection}

      {ready && view === "lista" && (
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

                {b.contact && <ListClientToggle bookingId={b.id} />}

                <BookingActions
                  booking={b}
                  owner={owner}
                  sellers={sellers}
                  busy={busy}
                  businessTimezone={businessTimezone}
                  handlers={handlers}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {ready && view !== "lista" && blockSection}

      {detail && businessTimezone && view !== "lista" && (
        <BookingDetailPanel
          booking={detail}
          overlap={overlaps[detail.id] ?? null}
          owner={owner}
          sellers={sellers}
          busy={busy}
          error={error}
          businessTimezone={businessTimezone}
          handlers={handlers}
          covered={dialog !== null || moveConfirm !== null}
          onClose={() => {
            setDetailId(null);
            setError(null);
          }}
        />
      )}

      {moveConfirm && (
        <MoveOverlapDialog
          message={moveConfirm.message}
          conflicts={moveConfirm.conflicts}
          timezone={businessTimezone}
          saving={moving}
          onConfirm={() =>
            void sendMove(moveConfirm.booking, {
              ...moveConfirm.body,
              confirmOverlap: true,
            })
          }
          onCancel={() => {
            // Cancelar devuelve la cita a su lugar.
            setMoveConfirm(null);
            setOverride(null);
          }}
        />
      )}

      {dialog && (
        <BookingDialog
          viewer={viewer}
          types={types}
          sellers={owner ? sellers : undefined}
          timezone={businessTimezone}
          defaultSellerId={dialog.mode === "create" ? dialog.sellerId : undefined}
          initialDayIso={dialog.mode === "create" ? dialog.initialDayIso : undefined}
          initialStartUtc={
            dialog.mode === "create" ? dialog.initialStartUtc : undefined
          }
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

/** `GET /api/bookings?…` + el rango visible del calendario. */
function withRange(listQuery: string, range: DateRange): string {
  const url = new URL(listQuery, "http://x");
  url.searchParams.set("from", range.from);
  url.searchParams.set("to", range.to);
  return `${url.pathname}?${url.searchParams.toString()}`;
}

/**
 * 029 — En la Lista, el cliente va plegado: así la fila no crece y no se
 * disparan N peticiones al cargar (la tarjeta pide sus datos al abrirse).
 */
function ListClientToggle({ bookingId }: { bookingId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <button
        type="button"
        data-testid="booking-client-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="text-xs font-medium text-brand-text hover:underline"
      >
        {open ? "Ocultar cliente" : "Ver cliente"}
      </button>
      {open && <BookingClientCard bookingId={bookingId} />}
    </div>
  );
}
