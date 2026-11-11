"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { isOwner } from "@/lib/roles";
import { useViewer } from "@/components/viewer-context";
import { templateStatusLabel } from "@/lib/template-sent";
import { dayIsoInTz, addDaysISO } from "@/lib/time/slots";
import {
  DEFAULT_FOLLOW_UP_TIME,
  FOLLOW_UP_GROUP_LABEL,
  FOLLOW_UP_REASONS,
  FOLLOW_UP_REASON_LABEL,
  NO_CONTACT_DAYS,
  NO_REPLY_DAYS,
  POSTPONE_LABEL,
  POSTPONE_PRESETS,
  agoDays,
  betweenLabel,
  clock12,
  dayWordOf,
  groupFollowUps,
  longDate,
  reasonCounts,
  repeatLabel,
  repeatNotice,
  shortDay,
  wallOf,
  type FollowUpDto,
  type FollowUpGroup,
  type FollowUpListDto,
  type FollowUpReason,
  type NoReplyRowDto,
  type PendingDto,
  type PendingRowDto,
  type PostponePreset,
} from "@/lib/follow-ups";
import { apiErrorText, notifyFollowUpsChanged, useFollowUpsChanged } from "./follow-up-events";
import { PILL_CLS, PILL_OFF, PILL_ON, RemindDialog } from "./remind-dialog";

const PRIMARY_CLS =
  "inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-md bg-primary px-3 text-[13px] font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";
const OUTLINE_CLS =
  "inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-md border border-border bg-background px-3 text-[13px] text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";
const FIELD_CLS =
  "rounded-md border border-border bg-background px-2.5 py-1.5 text-[13.5px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const CHIP_CLS = "rounded-full border border-border px-2 text-[11.5px] text-text-2";
const REASON_CHIP_CLS = "rounded-full bg-brand-soft px-2 py-px text-[11.5px] font-semibold text-brand-text";

/** Filas a la vista antes de «Ver los N»; y el alto máximo al abrirla (~8 filas). */
const PREVIEW_ROWS = 3;
const EXPANDED_MAX_H = "max-h-[30rem]";

type Member = { userId: string; name: string };
type NoContactMode = { kind: "days"; days: number } | { kind: "between"; from: string; to: string };

/** Enlace para escribirle: su chat si lo tiene; si no, buscarlo en Contactos. */
function contactHref(contactId: string, name: string, conversationId: string | null): string {
  return conversationId
    ? `/inbox?contact=${encodeURIComponent(contactId)}`
    : `/contacts?q=${encodeURIComponent(name)}`;
}

/**
 * 035 — Seguimiento › Pendientes: lo que tú agendaste («Mis recordatorios») y
 * los clientes que se quedaron sin contacto o sin contestar tu plantilla. El
 * Propietario elige de quién («Vendedor: Todos / …»).
 */
export function PendientesView({ viewSwitch }: { viewSwitch: React.ReactNode }) {
  const me = useViewer();
  const owner = isOwner(me);
  const [tz, setTz] = useState("America/Mexico_City");
  const [now, setNow] = useState(() => new Date());
  const [members, setMembers] = useState<Member[]>([]);
  const [seller, setSeller] = useState<string>("all");
  const [followUps, setFollowUps] = useState<FollowUpDto[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reason, setReason] = useState<FollowUpReason | "all">("all");
  const [open, setOpen] = useState<Record<"week" | "later", boolean>>({ week: false, later: false });
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [mode, setMode] = useState<NoContactMode>({ kind: "days", days: 30 });
  const [includeLost, setIncludeLost] = useState(false);
  const [replyDays, setReplyDays] = useState<number>(3);
  const [pending, setPending] = useState<PendingDto | null>(null);
  const [remindFor, setRemindFor] = useState<{ id: string; name: string; conversationId: string | null } | null>(null);

  const userParam = owner ? (seller === "all" ? null : seller) : null;

  useEffect(() => {
    if (!owner) return;
    let cancelled = false;
    fetch("/api/settings/team")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { members?: Member[] } | null) => {
        if (!cancelled && d?.members) setMembers(d.members.map((m) => ({ userId: m.userId, name: m.name })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [owner]);

  const loadFollowUps = useCallback(async () => {
    const qs = new URLSearchParams();
    if (userParam) qs.set("userId", userParam);
    const res = await fetch(`/api/follow-ups?${qs}`).catch(() => null);
    const data = res?.ok ? ((await res.json().catch(() => null)) as FollowUpListDto | null) : null;
    if (!data) {
      setLoadError(true);
      return;
    }
    setTz(data.businessTimezone);
    setFollowUps(data.followUps);
    setNow(new Date());
    setLoadError(false);
  }, [userParam]);

  // Las respuestas viejas no pisan a las nuevas (cambiar de filtro rápido).
  const pendingReq = useRef(0);
  const loadPending = useCallback(async () => {
    const id = ++pendingReq.current;
    const qs = new URLSearchParams();
    if (userParam) qs.set("userId", userParam);
    if (mode.kind === "days") qs.set("days", String(mode.days));
    else {
      qs.set("from", mode.from);
      qs.set("to", mode.to);
    }
    if (includeLost) qs.set("includeLost", "1");
    qs.set("replyDays", String(replyDays));
    const res = await fetch(`/api/follow-ups/pending?${qs}`).catch(() => null);
    const data = res?.ok ? ((await res.json().catch(() => null)) as PendingDto | null) : null;
    if (id !== pendingReq.current) return;
    if (data) setPending(data);
  }, [userParam, mode, includeLost, replyDays]);

  useEffect(() => {
    void loadFollowUps();
  }, [loadFollowUps]);
  useEffect(() => {
    void loadPending();
  }, [loadPending]);
  useFollowUpsChanged(
    useCallback(() => {
      void loadFollowUps();
      void loadPending();
    }, [loadFollowUps, loadPending])
  );
  // «Hoy» pasa a «Vencidos» con el reloj, sin pedir nada.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const counts = useMemo(() => reasonCounts(followUps ?? []), [followUps]);
  const visible = useMemo(
    () => (followUps ?? []).filter((f) => reason === "all" || f.reason === reason),
    [followUps, reason]
  );
  const groups = useMemo(() => groupFollowUps(visible, now, tz), [visible, now, tz]);
  const overdueAll = useMemo(() => groupFollowUps(followUps ?? [], now, tz).overdue.length, [followUps, now, tz]);

  async function patch(fu: FollowUpDto, body: object, failMsg: string): Promise<boolean> {
    const res = await fetch(`/api/follow-ups/${fu.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res?.ok) {
      setNotice({ tone: "error", text: await apiErrorText(res, failMsg) });
      void loadFollowUps();
      return false;
    }
    const data = (await res.json().catch(() => null)) as { next?: FollowUpDto | null } | null;
    if ("action" in body && body.action === "done") {
      setNotice({
        tone: "ok",
        text: data?.next
          ? `Listo. El siguiente recordatorio de ${fu.contact.name} quedó para el ${longDate(wallOf(data.next.dueAt, tz).day)}.`
          : `Listo. Quedó en el historial de ${fu.contact.name}.`,
      });
    } else {
      setNotice({ tone: "ok", text: `Recordatorio de ${fu.contact.name} movido.` });
    }
    notifyFollowUpsChanged();
    return true;
  }

  const sellerName = owner && seller !== "all" ? members.find((m) => m.userId === seller)?.name : null;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3 sm:px-6 sm:py-4">
        <div className="min-w-0 flex-[1_1_280px] space-y-0.5">
          <h2 className="font-semibold">Seguimiento</h2>
          <p className="text-[13px] text-text-2">
            A quién te toca volver a escribir: lo que tú agendaste y quien lleva tiempo sin contacto.
          </p>
        </div>
        {viewSwitch}
      </header>

      <div className="flex flex-col gap-4 p-4 sm:px-6">
        {owner && (
          <label className="flex flex-wrap items-center gap-2 text-[13px] text-text-2">
            Vendedor:
            <select
              value={seller}
              onChange={(e) => setSeller(e.target.value)}
              className={FIELD_CLS}
              data-testid="pending-seller"
            >
              <option value="all">Todos</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.userId === me.userId ? `${m.name} (tú)` : m.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {notice && (
          <div
            role={notice.tone === "error" ? "alert" : "status"}
            className={cn(
              "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
              notice.tone === "error"
                ? "border-danger-soft bg-danger-tint text-danger-text"
                : "border-success-soft bg-success-tint text-success-text"
            )}
          >
            <p className="flex-1">{notice.text}</p>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Cerrar el aviso"
              className="rounded p-0.5 hover:bg-background/60"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-start gap-5">
          {/* ── Mis recordatorios ── */}
          <section
            aria-labelledby="rec-titulo"
            className="flex min-w-0 flex-[3_1_560px] flex-col gap-3"
            data-testid="my-follow-ups"
          >
            <h2 id="rec-titulo" className="text-base font-semibold">
              {owner && seller === "all"
                ? "Recordatorios del equipo"
                : sellerName && seller !== me.userId
                  ? `Recordatorios de ${sellerName}`
                  : "Mis recordatorios"}
            </h2>
            <div role="group" aria-label="Motivo" className="flex flex-wrap gap-1.5">
              {(["all", ...FOLLOW_UP_REASONS] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={reason === r}
                  onClick={() => setReason(r)}
                  className={cn(PILL_CLS, "min-h-8 px-2.5 py-1 text-[12.5px]", reason === r ? PILL_ON : PILL_OFF)}
                >
                  {r === "all" ? "Todos" : FOLLOW_UP_REASON_LABEL[r]} · {counts[r]}
                </button>
              ))}
            </div>

            {loadError && followUps === null && (
              <div role="alert" className="rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text">
                No se pudieron cargar los recordatorios.{" "}
                <button type="button" className="font-semibold underline" onClick={() => void loadFollowUps()}>
                  Reintentar
                </button>
              </div>
            )}
            {followUps === null && !loadError && (
              <div aria-busy="true" className="space-y-2">
                <span className="sr-only">Cargando recordatorios…</span>
                <div className="h-16 animate-pulse rounded-lg bg-secondary" />
                <div className="h-16 animate-pulse rounded-lg bg-secondary" />
              </div>
            )}
            {followUps !== null && visible.length === 0 && (
              <p className="rounded-lg border border-dashed px-4 py-4 text-[13px] text-text-2">
                {followUps.length === 0
                  ? "No hay recordatorios abiertos. Créalos con «Recordarme» desde el chat, el trato en el Tablero o Contactos."
                  : "Ningún recordatorio con ese motivo."}
              </p>
            )}

            {(["overdue", "today"] as const).map((g) =>
              groups[g].length > 0 ? (
                <GroupList
                  key={g}
                  group={g}
                  items={groups[g]}
                  now={now}
                  tz={tz}
                  showOwner={owner && seller === "all"}
                  onPatch={patch}
                />
              ) : null
            )}

            {(groups.week.length > 0 || groups.later.length > 0) && (
              <div className="flex flex-col gap-3">
                {(["week", "later"] as const).map((g) =>
                  groups[g].length > 0 ? (
                    <div key={g} className="flex flex-col gap-2">
                      <button
                        type="button"
                        aria-expanded={open[g]}
                        onClick={() => setOpen((o) => ({ ...o, [g]: !o[g] }))}
                        className="self-start rounded text-[13px] font-semibold text-brand-text underline-offset-2 hover:underline"
                        data-testid={`group-toggle-${g}`}
                      >
                        {FOLLOW_UP_GROUP_LABEL[g]} · {groups[g].length} {open[g] ? "▴" : "▾"}
                      </button>
                      {open[g] && (
                        <GroupList
                          group={g}
                          items={groups[g]}
                          now={now}
                          tz={tz}
                          showOwner={owner && seller === "all"}
                          onPatch={patch}
                          hideHeading
                        />
                      )}
                    </div>
                  ) : null
                )}
              </div>
            )}
            {followUps !== null && overdueAll > 0 && reason !== "all" && groups.overdue.length === 0 && (
              <p className="text-[12.5px] text-danger-text">
                Tienes {overdueAll} {overdueAll === 1 ? "vencido" : "vencidos"} con otro motivo.
              </p>
            )}
          </section>

          {/* ── Columna derecha ── */}
          <div className="flex min-w-0 flex-[2_1_360px] flex-col gap-4">
            <NoContactBox
              data={pending?.noContact ?? null}
              tz={tz}
              now={now}
              mode={mode}
              onMode={setMode}
              includeLost={includeLost}
              onIncludeLost={setIncludeLost}
              showAssignee={owner && seller === "all"}
              onRemind={(r) => setRemindFor({ id: r.contact.id, name: r.contact.name, conversationId: r.conversationId })}
            />
            <NoReplyBox
              data={pending?.noReply ?? null}
              tz={tz}
              now={now}
              days={replyDays}
              onDays={setReplyDays}
              showAssignee={owner && seller === "all"}
              onRemind={(r) => setRemindFor({ id: r.contact.id, name: r.contact.name, conversationId: r.conversationId })}
            />
          </div>
        </div>
      </div>

      {remindFor && (
        <RemindDialog
          contact={{ id: remindFor.id, name: remindFor.name }}
          conversationId={remindFor.conversationId}
          onClose={() => setRemindFor(null)}
          onSaved={() => setNotice({ tone: "ok", text: `Recordatorio de ${remindFor.name} guardado.` })}
        />
      )}
    </div>
  );
}

/* ───────────────────────── Mis recordatorios ───────────────────────── */

function GroupList({
  group,
  items,
  now,
  tz,
  showOwner,
  onPatch,
  hideHeading = false,
}: {
  group: FollowUpGroup;
  items: FollowUpDto[];
  now: Date;
  tz: string;
  showOwner: boolean;
  onPatch: (fu: FollowUpDto, body: object, failMsg: string) => Promise<boolean>;
  hideHeading?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid={`group-${group}`}>
      {!hideHeading && (
        <h3 className={cn("mt-1.5 text-[13px] font-semibold", group === "overdue" && "text-danger-text")}>
          {FOLLOW_UP_GROUP_LABEL[group]} · {items.length}
        </h3>
      )}
      <ul className="flex flex-col gap-2">
        {items.map((fu) => (
          <FollowUpRow
            key={fu.id}
            fu={fu}
            overdue={group === "overdue"}
            now={now}
            tz={tz}
            showOwner={showOwner}
            onPatch={onPatch}
          />
        ))}
      </ul>
    </div>
  );
}

function FollowUpRow({
  fu,
  overdue,
  now,
  tz,
  showOwner,
  onPatch,
}: {
  fu: FollowUpDto;
  overdue: boolean;
  now: Date;
  tz: string;
  showOwner: boolean;
  onPatch: (fu: FollowUpDto, body: object, failMsg: string) => Promise<boolean>;
}) {
  const [panel, setPanel] = useState<null | "done" | "postpone" | "custom">(null);
  const [doneNote, setDoneNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [customDay, setCustomDay] = useState(() => addDaysISO(dayIsoInTz(now, tz), 1));
  const [customTime, setCustomTime] = useState(() => wallOf(fu.dueAt, tz).time || DEFAULT_FOLLOW_UP_TIME);
  const menuRef = useRef<HTMLDivElement>(null);

  // El menú de posponer se cierra al tocar fuera.
  useEffect(() => {
    if (panel !== "postpone") return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setPanel(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [panel]);

  async function run(body: object, failMsg: string) {
    setBusy(true);
    const okDone = await onPatch(fu, body, failMsg);
    setBusy(false);
    if (okDone) setPanel(null);
  }

  return (
    <li
      data-testid="follow-up-row"
      data-follow-up={fu.id}
      className={cn(
        "flex flex-col gap-2.5 rounded-lg border px-3.5 py-3",
        overdue ? "border-danger-soft bg-danger-tint" : "border-border bg-background"
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex w-[92px] shrink-0 flex-col">
          <strong className={cn("text-[13px]", overdue && "text-danger-text")}>{dayWordOf(fu.dueAt, now, tz)}</strong>
          <span className="whitespace-nowrap text-xs text-text-2">{clock12(fu.dueAt, tz)}</span>
        </div>
        <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <strong className="min-w-0 break-words" data-testid="follow-up-name">
              {fu.contact.name}
            </strong>
            {fu.stageName && <span className={CHIP_CLS}>{fu.stageName}</span>}
            <span className={REASON_CHIP_CLS}>{FOLLOW_UP_REASON_LABEL[fu.reason]}</span>
            {fu.repeatMonths && (
              <span className="inline-flex items-center gap-1 text-[11.5px] text-text-2">
                <RepeatIcon />
                {repeatLabel(fu.repeatMonths)}
              </span>
            )}
          </span>
          {fu.note && <span className="break-words text-[13px] text-text-2">{fu.note}</span>}
          {showOwner && <span className="text-xs text-text-3">De {fu.user.name}</span>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Link href={contactHref(fu.contact.id, fu.contact.name, fu.conversationId)} className={PRIMARY_CLS}>
            {fu.conversationId ? "Contactar" : "Escribir primero"}
          </Link>
          <button
            type="button"
            className={OUTLINE_CLS}
            aria-expanded={panel === "done"}
            onClick={() => setPanel(panel === "done" ? null : "done")}
          >
            Hecho
          </button>
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              className={OUTLINE_CLS}
              aria-expanded={panel === "postpone"}
              aria-haspopup="menu"
              onClick={() => setPanel(panel === "postpone" ? null : "postpone")}
            >
              Posponer ▾
            </button>
            {panel === "postpone" && (
              <div
                role="menu"
                className="absolute right-0 z-20 mt-1 flex w-56 flex-col rounded-md border bg-background p-1 shadow-pop"
              >
                {POSTPONE_PRESETS.map((p: PostponePreset) => (
                  <button
                    key={p}
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    onClick={() => void run({ action: "postpone", preset: p }, "No se pudo posponer")}
                    className="rounded px-2.5 py-2 text-left text-[13px] hover:bg-accent"
                  >
                    {POSTPONE_LABEL[p]}
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setPanel("custom")}
                  className="rounded px-2.5 py-2 text-left text-[13px] hover:bg-accent"
                >
                  Otra fecha y hora…
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {panel === "done" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run({ action: "done", note: doneNote }, "No se pudo marcar como hecho");
          }}
          className={cn(
            "flex flex-wrap items-end gap-2 border-t pt-2.5",
            overdue ? "border-danger-soft" : "border-border"
          )}
        >
          <label className="flex min-w-0 flex-[1_1_260px] flex-col gap-1 text-[12.5px] text-text-2">
            <span>
              ¿Qué pasó? <span className="text-text-3">(opcional: queda en su historial)</span>
            </span>
            <input
              type="text"
              autoFocus
              value={doneNote}
              maxLength={500}
              onChange={(e) => setDoneNote(e.target.value)}
              className={cn(FIELD_CLS, "text-sm")}
            />
          </label>
          <button type="button" className={OUTLINE_CLS} onClick={() => setPanel(null)}>
            Cancelar
          </button>
          <button type="submit" className={PRIMARY_CLS} disabled={busy}>
            {busy ? "Guardando…" : "Marcar como hecho"}
          </button>
          {fu.repeatMonths && (
            <p className="basis-full text-[12.5px] text-brand-text" data-testid="repeat-notice">
              {repeatNotice(fu.dueAt, fu.repeatMonths, tz)}
            </p>
          )}
        </form>
      )}

      {panel === "custom" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run({ action: "reschedule", day: customDay, time: customTime }, "No se pudo mover");
          }}
          className="flex flex-wrap items-end gap-2 border-t border-border pt-2.5"
        >
          <label className="flex flex-col gap-1 text-[12.5px] text-text-2">
            Día
            <input
              type="date"
              value={customDay}
              min={dayIsoInTz(now, tz)}
              onChange={(e) => setCustomDay(e.target.value)}
              className={FIELD_CLS}
            />
          </label>
          <label className="flex flex-col gap-1 text-[12.5px] text-text-2">
            Hora
            <input type="time" value={customTime} onChange={(e) => setCustomTime(e.target.value)} className={FIELD_CLS} />
          </label>
          <button type="button" className={OUTLINE_CLS} onClick={() => setPanel(null)}>
            Cancelar
          </button>
          <button type="submit" className={PRIMARY_CLS} disabled={busy || !customDay || !customTime}>
            Mover
          </button>
        </form>
      )}
    </li>
  );
}

function RepeatIcon() {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12a8 8 0 0 1 14-5.3L20 9" />
      <path d="M20 4v5h-5" />
      <path d="M20 12a8 8 0 0 1-14 5.3L4 15" />
      <path d="M4 20v-5h5" />
    </svg>
  );
}

/* ───────────────────────── Recuadros de la derecha ───────────────────────── */

/**
 * 3 a la vista y «Ver los N». Abierta, la lista se desplaza DENTRO del recuadro
 * (hasta ~8 filas): el recuadro de abajo no se mueve más de ese alto.
 */
function ExpandableList<T>({
  rows,
  total,
  render,
  testId,
}: {
  rows: T[];
  total: number;
  render: (row: T, last: boolean) => React.ReactNode;
  testId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, PREVIEW_ROWS);
  return (
    <>
      <ul
        data-testid={testId}
        className={cn("flex flex-col", expanded && cn(EXPANDED_MAX_H, "overflow-y-auto overscroll-contain pr-1"))}
      >
        {shown.map((r, i) => render(r, i === shown.length - 1))}
      </ul>
      {total > PREVIEW_ROWS && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className={cn(OUTLINE_CLS, "w-full font-semibold text-brand-text")}
          data-testid={`${testId}-more`}
        >
          {expanded ? "Ver solo los 3 primeros ▴" : `Ver los ${total} (del más antiguo al más reciente) ▾`}
        </button>
      )}
      {expanded && total > rows.length && (
        <p className="text-[12.5px] text-text-2">Se muestran los primeros {rows.length} de {total}.</p>
      )}
    </>
  );
}

function DaysPills({
  label,
  values,
  active,
  onPick,
  extra,
}: {
  label: string;
  values: readonly number[];
  active: number | null;
  onPick: (n: number) => void;
  extra?: React.ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <span className="text-[13px] text-text-2">{label}:</span>
      {values.map((d) => (
        <button
          key={d}
          type="button"
          aria-pressed={active === d}
          onClick={() => onPick(d)}
          className={cn(PILL_CLS, "min-h-8 px-2.5 py-1 text-[12.5px]", active === d ? PILL_ON : PILL_OFF)}
        >
          +{d} días
        </button>
      ))}
      {extra}
    </div>
  );
}

function RowShell({ last, children }: { last: boolean; children: React.ReactNode }) {
  return (
    <li
      data-testid="pending-row"
      className={cn("flex flex-wrap items-center gap-2.5 py-2.5", !last && "border-b border-border")}
    >
      {children}
    </li>
  );
}

function NoContactBox({
  data,
  tz,
  now,
  mode,
  onMode,
  includeLost,
  onIncludeLost,
  showAssignee,
  onRemind,
}: {
  data: PendingDto["noContact"] | null;
  tz: string;
  now: Date;
  mode: NoContactMode;
  onMode: (m: NoContactMode) => void;
  includeLost: boolean;
  onIncludeLost: (v: boolean) => void;
  showAssignee: boolean;
  onRemind: (r: PendingRowDto) => void;
}) {
  const today = dayIsoInTz(now, tz);
  return (
    <section
      aria-labelledby="sin-titulo"
      data-testid="no-contact"
      className="flex min-w-0 flex-col gap-3 rounded-lg border px-4 py-3.5"
    >
      <div className="space-y-0.5">
        <h2 id="sin-titulo" className="text-base font-semibold">
          Sin contacto <span className="font-normal text-text-2">· {data?.total ?? "…"}</span>
        </h2>
        <p className="text-[13px] text-text-2">
          Tus clientes sin mensajes, de ningún lado, desde hace tiempo. Se arma sola.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <DaysPills
          label="Último mensaje"
          values={NO_CONTACT_DAYS}
          active={mode.kind === "days" ? mode.days : null}
          onPick={(d) => onMode({ kind: "days", days: d })}
          extra={
            <button
              type="button"
              aria-pressed={mode.kind === "between"}
              onClick={() =>
                mode.kind !== "between" &&
                onMode({ kind: "between", from: addDaysISO(today, -60), to: addDaysISO(today, -30) })
              }
              className={cn(PILL_CLS, "min-h-8 px-2.5 py-1 text-[12.5px]", mode.kind === "between" ? PILL_ON : PILL_OFF)}
            >
              Entre fechas
            </button>
          }
        />
        {mode.kind === "between" && (
          <div className="flex flex-wrap items-end gap-2 rounded-md bg-secondary p-2.5">
            <label className="flex min-w-[130px] flex-[1_1_130px] flex-col gap-1 text-[12.5px] text-text-2">
              Desde
              <input
                type="date"
                value={mode.from}
                max={mode.to}
                onChange={(e) => e.target.value && onMode({ ...mode, from: e.target.value })}
                className={FIELD_CLS}
                data-testid="between-from"
              />
            </label>
            <label className="flex min-w-[130px] flex-[1_1_130px] flex-col gap-1 text-[12.5px] text-text-2">
              Hasta
              <input
                type="date"
                value={mode.to}
                min={mode.from}
                onChange={(e) => e.target.value && onMode({ ...mode, to: e.target.value })}
                className={FIELD_CLS}
                data-testid="between-to"
              />
            </label>
            <p className="basis-full text-[12.5px] text-text-2" data-testid="between-summary">
              Clientes cuyo último mensaje fue entre {betweenLabel(mode.from, mode.to)} · {data?.total ?? "…"}
            </p>
          </div>
        )}
        <label className="flex items-center gap-1.5 text-[13px]">
          <input
            type="checkbox"
            checked={includeLost}
            onChange={(e) => onIncludeLost(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          Incluir perdidos
        </label>
      </div>
      {data && data.total === 0 && (
        <p className="text-[13px] text-text-2">Nadie de tus clientes lleva tanto tiempo sin mensajes.</p>
      )}
      {data && data.rows.length > 0 && (
        <ExpandableList
          rows={data.rows}
          total={data.total}
          testId="no-contact-list"
          render={(r, last) => (
            <RowShell key={r.conversationId} last={last}>
              <div className="flex min-w-0 flex-[1_1_180px] flex-col gap-0.5">
                <strong className="break-words">{r.contact.name}</strong>
                <span className="text-[12.5px] text-text-2">
                  {r.stageName ?? "Sin etapa"} · último mensaje {agoDays(r.lastAt, now)}
                  {showAssignee && ` · ${r.assignedTo?.name ?? "sin asignar"}`}
                  {r.openFollowUpAt && (
                    <>
                      {" · "}
                      <span className="font-semibold text-brand-text">recordatorio el {shortDay(r.openFollowUpAt, tz)}</span>
                    </>
                  )}
                </span>
              </div>
              <Link href={contactHref(r.contact.id, r.contact.name, r.conversationId)} className={PRIMARY_CLS}>
                Contactar
              </Link>
              {!r.openFollowUpAt && (
                <button type="button" className={OUTLINE_CLS} onClick={() => onRemind(r)}>
                  Recordarme
                </button>
              )}
            </RowShell>
          )}
        />
      )}
      <p className="text-[12.5px] text-text-2">
        «Contactar» abre su chat; si pasaron más de 24 horas, ya viene listo para mandar una plantilla.
      </p>
    </section>
  );
}

function NoReplyBox({
  data,
  tz,
  now,
  days,
  onDays,
  showAssignee,
  onRemind,
}: {
  data: PendingDto["noReply"] | null;
  tz: string;
  now: Date;
  days: number;
  onDays: (n: number) => void;
  showAssignee: boolean;
  onRemind: (r: NoReplyRowDto) => void;
}) {
  return (
    <section
      aria-labelledby="norespuesta-titulo"
      data-testid="no-reply"
      className="flex min-w-0 flex-col gap-3 rounded-lg border px-4 py-3.5"
    >
      <div className="space-y-0.5">
        <h2 id="norespuesta-titulo" className="text-base font-semibold">
          Sin respuesta a tu plantilla <span className="font-normal text-text-2">· {data?.total ?? "…"}</span>
        </h2>
        <p className="text-[13px] text-text-2">Les mandaste una plantilla y no han contestado.</p>
      </div>
      <DaysPills label="Desde hace" values={NO_REPLY_DAYS} active={days} onPick={onDays} />
      {data && data.total === 0 && (
        <p className="text-[13px] text-text-2">Nadie tiene una plantilla tuya sin contestar desde hace tanto.</p>
      )}
      {data && data.rows.length > 0 && (
        <ExpandableList
          rows={data.rows}
          total={data.total}
          testId="no-reply-list"
          render={(r, last) => (
            <RowShell key={r.conversationId} last={last}>
              <div className="flex min-w-0 flex-[1_1_180px] flex-col gap-0.5">
                <strong className="break-words">{r.contact.name}</strong>
                <span className="text-[12.5px] text-text-2">
                  {r.templateName ? `«${r.templateName}» · ` : "Plantilla · "}
                  {templateStatusLabel(r.templateStatus).toLowerCase()} · {agoDays(r.lastAt, now)}
                  {showAssignee && ` · ${r.assignedTo?.name ?? "sin asignar"}`}
                  {r.openFollowUpAt && (
                    <>
                      {" · "}
                      <span className="font-semibold text-brand-text">recordatorio el {shortDay(r.openFollowUpAt, tz)}</span>
                    </>
                  )}
                </span>
              </div>
              <Link href={contactHref(r.contact.id, r.contact.name, r.conversationId)} className={PRIMARY_CLS}>
                Dar seguimiento
              </Link>
              {!r.openFollowUpAt && (
                <button type="button" className={OUTLINE_CLS} onClick={() => onRemind(r)}>
                  Recordarme
                </button>
              )}
            </RowShell>
          )}
        />
      )}
      <p className="text-[12.5px] text-text-2">
        «Leída» quiere decir que la vio y no contestó: prueba con otra plantilla o con una llamada.
      </p>
    </section>
  );
}
