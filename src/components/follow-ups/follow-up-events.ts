"use client";

import { useEffect } from "react";

/**
 * 035 — «Cambió un recordatorio» dentro de la pestaña: el número rojo del menú
 * y Pendientes se ponen al día sin esperar a su siguiente vuelta. Fase B: el
 * proveedor de avisos reenvía aquí el SSE `follow_ups.changed` (otra pestaña,
 * o el Propietario tocó uno tuyo), así todos escuchan un solo evento.
 */
const EVENT = "vocero:follow-ups-changed";

export function notifyFollowUpsChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function useFollowUpsChanged(cb: () => void): void {
  useEffect(() => {
    window.addEventListener(EVENT, cb);
    return () => window.removeEventListener(EVENT, cb);
  }, [cb]);
}

/** Mensaje de error de la API (`{ error: { message } }`) o uno genérico. */
export async function apiErrorText(res: Response | null, fallback: string): Promise<string> {
  if (!res) return `${fallback}: sin conexión con el servidor.`;
  const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return data?.error?.message ? `${fallback}: ${data.error.message}.` : `${fallback}.`;
}
