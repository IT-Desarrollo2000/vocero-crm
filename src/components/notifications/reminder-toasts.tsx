"use client";

import { useState } from "react";
import Link from "next/link";
import { AlarmClock, X } from "lucide-react";
import { toastCopy, type NotificationDto } from "@/lib/notifications";
import { contactLink, useNotifications } from "./notifications-provider";

/**
 * 035 B — Aviso emergente de un recordatorio vencido (abajo a la derecha,
 * superficie invertida, `role="status"`). Llega en vivo por SSE; se apilan
 * hasta 3 y se quedan hasta que la persona actúa o los cierra:
 *   Posponer 1 h → mueve el recordatorio (el servidor marca leído el aviso)
 *   Contactar    → marca leído y abre su chat (o Contactos si no tiene)
 *   ×            → solo lo cierra aquí; en la campana sigue sin leer.
 */
export function ReminderToasts() {
  const ctx = useNotifications();
  if (!ctx || ctx.toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[380px] max-w-[calc(100vw-2rem)] flex-col gap-2 print:hidden sm:bottom-6 sm:right-6"
    >
      {ctx.toasts.map((n) => (
        <ReminderToast key={n.id} n={n} />
      ))}
    </div>
  );
}

function ReminderToast({ n }: { n: NotificationDto }) {
  const ctx = useNotifications()!;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const text = toastCopy(n);
  return (
    <div
      role="status"
      data-testid="reminder-toast"
      data-notification={n.id}
      className="pointer-events-auto flex flex-col gap-2 rounded-lg bg-foreground px-4 py-3.5 text-background shadow-pop"
    >
      <div className="flex items-start gap-2.5">
        <AlarmClock aria-hidden className="mt-0.5 h-[18px] w-[18px] shrink-0 opacity-80" strokeWidth={2} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="break-words font-semibold">{text.title}</p>
          {text.body && <p className="break-words text-[13px] opacity-80">{text.body}</p>}
          {failed && <p className="text-[12.5px] opacity-80">No se pudo posponer. Vuelve a intentarlo.</p>}
        </div>
        <button
          type="button"
          aria-label="Cerrar aviso"
          onClick={() => ctx.dismissToast(n.id)}
          className="-mr-1.5 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-text-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setFailed(false);
            const ok = await ctx.postpone(n, "1h");
            setBusy(false);
            if (!ok) setFailed(true);
          }}
          className="inline-flex min-h-[34px] items-center rounded-sm border border-text-2 px-2.5 text-[12.5px] hover:bg-text-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          Posponer 1 h
        </button>
        <Link
          href={contactLink(n)}
          onClick={() => {
            void ctx.markRead([n.id]);
            ctx.dismissToast(n.id);
          }}
          className="inline-flex min-h-[34px] items-center rounded-sm bg-background px-2.5 text-[12.5px] font-semibold text-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Contactar
        </Link>
      </div>
    </div>
  );
}
