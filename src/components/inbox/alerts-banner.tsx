"use client";

import { useEffect, useState } from "react";
import { BellRing, X } from "lucide-react";
import { useAlertsActivation } from "@/components/alerts-menu";
import { useViewer } from "@/components/viewer-context";

/**
 * 05 (T-05-07) — Aviso único y descartable en la Bandeja mientras el permiso
 * de notificaciones esté en `default`: «Activar avisos» corre el mismo flujo
 * que el panel de alertas (`useAlertsActivation`: permiso pedido SOLO en el
 * clic + audio desbloqueado en el mismo gesto). Sin soporte, bloqueado o ya
 * concedido no se muestra (el panel de «Mi cuenta» explica cada caso).
 * Descartarlo se recuerda por usuario y dispositivo.
 */

const DISMISS_PREFIX = "vocero.alertsBanner.v1";

function readDismissed(userId: string): boolean {
  try {
    return window.localStorage.getItem(`${DISMISS_PREFIX}.${userId}`) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(userId: string): void {
  try {
    window.localStorage.setItem(`${DISMISS_PREFIX}.${userId}`, "1");
  } catch {
    // Sin almacenamiento: se oculta solo en esta visita.
  }
}

export function AlertsBanner() {
  const { userId } = useViewer();
  const { support, ready, asking, activate, notice } = useAlertsActivation();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setDismissed(readDismissed(userId));
  }, [userId]);

  if (!ready || dismissed || support !== "default") return null;

  return (
    <div
      role="region"
      aria-label="Activar avisos"
      className="flex items-start gap-2 border-b bg-brand-tint px-4 py-2.5 text-[12.5px]"
    >
      <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-brand" strokeWidth={1.7} />
      <div className="min-w-0 flex-1">
        <p className="text-text-2">
          Activa las alertas para enterarte aunque estés en otra pestaña.
        </p>
        {notice && <p className="mt-1 text-text-3">{notice}</p>}
        <button
          type="button"
          onClick={() => void activate()}
          disabled={asking}
          className="mt-1.5 rounded-full border border-brand bg-brand px-2.5 py-[3px] text-[12px] font-medium text-brand-fg disabled:opacity-60"
        >
          {asking ? "Esperando tu respuesta…" : "Activar avisos"}
        </button>
      </div>
      <button
        type="button"
        onClick={() => {
          writeDismissed(userId);
          setDismissed(true);
        }}
        aria-label="Descartar el aviso de alertas"
        className="shrink-0 rounded p-0.5 text-text-3 hover:bg-accent hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}
