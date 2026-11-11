"use client";

import { useCallback, useEffect, useState } from "react";
import { AlarmClock } from "lucide-react";
import {
  FOLLOW_UP_REASON_LABEL,
  shortDay,
  whenShort,
  type FollowUpDto,
  type FollowUpListDto,
} from "@/lib/follow-ups";
import { useFollowUpsChanged } from "./follow-up-events";
import { RemindDialog } from "./remind-dialog";

/** Hechos que se enseñan en el cajón (lo demás vive en Pendientes). */
const HISTORY_MAX = 5;

/**
 * 035 — Sección «Recordatorios» del cajón del trato: «Recordarme», los
 * abiertos y el historial de los hechos con su «¿Qué pasó?». El Vendedor ve
 * los suyos; el Propietario, los de todos (lo decide la API).
 */
export function FollowUpHistory({
  contact,
  conversationId,
}: {
  contact: { id: string; name: string };
  conversationId: string | null;
}) {
  const [tz, setTz] = useState("America/Mexico_City");
  const [openOnes, setOpenOnes] = useState<FollowUpDto[]>([]);
  const [done, setDone] = useState<FollowUpDto[]>([]);
  const [dialog, setDialog] = useState(false);

  const load = useCallback(async () => {
    const get = (status: "open" | "done") =>
      fetch(`/api/follow-ups?${new URLSearchParams({ contactId: contact.id, status })}`)
        .then((r) => (r.ok ? (r.json() as Promise<FollowUpListDto>) : null))
        .catch(() => null);
    const [o, d] = await Promise.all([get("open"), get("done")]);
    if (o) {
      setTz(o.businessTimezone);
      setOpenOnes(o.followUps);
    }
    if (d) setDone(d.followUps.slice(0, HISTORY_MAX));
  }, [contact.id]);

  useEffect(() => {
    void load();
  }, [load]);
  useFollowUpsChanged(load);

  const now = new Date();
  return (
    <section className="border-b p-4" aria-label="Recordatorios" data-testid="lead-follow-ups">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-text-3">Recordatorios</p>
        <button
          type="button"
          onClick={() => setDialog(true)}
          className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12.5px] font-medium hover:bg-accent"
        >
          <AlarmClock className="h-3.5 w-3.5" strokeWidth={1.8} /> Recordarme
        </button>
      </div>
      {openOnes.length === 0 && done.length === 0 && (
        <p className="text-xs text-text-2">Sin recordatorios con este cliente.</p>
      )}
      <ul className="space-y-1.5">
        {openOnes.map((fu) => (
          <li key={fu.id} className="text-[12.5px]">
            <span className="font-semibold">{whenShort(fu.dueAt, now, tz)}</span>
            <span className="text-text-2"> · {FOLLOW_UP_REASON_LABEL[fu.reason]}</span>
            {fu.note && <span className="block break-words text-text-2">{fu.note}</span>}
          </li>
        ))}
        {done.map((fu) => (
          <li key={fu.id} className="text-[12.5px] text-text-2" data-testid="lead-follow-up-done">
            <span>
              Hecho el {fu.doneAt ? shortDay(fu.doneAt, tz) : "—"} · {FOLLOW_UP_REASON_LABEL[fu.reason]}
            </span>
            {fu.doneNote && <span className="block break-words text-foreground">«{fu.doneNote}»</span>}
          </li>
        ))}
      </ul>
      {dialog && (
        <RemindDialog
          contact={contact}
          conversationId={conversationId}
          onClose={() => setDialog(false)}
        />
      )}
    </section>
  );
}
