"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_ALERT_PREFS,
  loadAlertPrefs,
  saveAlertPrefs,
  type AlertPrefs,
  type PrefsStorage,
} from "@/lib/alerts";
import { useViewer } from "@/components/viewer-context";

/**
 * Preferencias de alertas por usuario y dispositivo (RF-05-10) en
 * `localStorage` (`vocero.alerts.v1.<userId>`). Un cambio se propaga a los
 * demás consumidores de la pestaña por un evento propio y a las otras
 * pestañas por el evento `storage` del navegador.
 */

const CHANGE_EVENT = "vocero:alerts-prefs";

function safeStorage(): PrefsStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

// Respaldo en memoria si `localStorage` no está disponible o no deja guardar:
// las preferencias duran lo que la pestaña.
const memory = new Map<string, AlertPrefs>();

export function readAlertPrefs(userId: string): AlertPrefs {
  const kept = memory.get(userId);
  if (kept) return { ...kept };
  return loadAlertPrefs(userId, safeStorage());
}

export function writeAlertPrefs(userId: string, prefs: AlertPrefs): void {
  if (saveAlertPrefs(userId, prefs, safeStorage())) memory.delete(userId);
  else memory.set(userId, { ...prefs });
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { userId, prefs } }));
  } catch {
    // sin window: nada que avisar
  }
}

/** Escucha cambios (esta pestaña u otras) de las preferencias del usuario. */
export function onAlertPrefsChange(
  userId: string,
  cb: (prefs: AlertPrefs) => void
): () => void {
  if (typeof window === "undefined") return () => {};
  const local = (e: Event) => {
    const d = (e as CustomEvent<{ userId: string; prefs: AlertPrefs }>).detail;
    if (d?.userId === userId) cb(d.prefs);
  };
  const remote = () => cb(readAlertPrefs(userId));
  window.addEventListener(CHANGE_EVENT, local);
  window.addEventListener("storage", remote);
  return () => {
    window.removeEventListener(CHANGE_EVENT, local);
    window.removeEventListener("storage", remote);
  };
}

export function useAlertPrefs(): [AlertPrefs, (patch: Partial<AlertPrefs>) => void] {
  const { userId } = useViewer();
  // Defaults en el primer render (igual que el servidor) y lo guardado tras
  // montar: así no hay diferencias de hidratación.
  const [prefs, setPrefs] = useState<AlertPrefs>(DEFAULT_ALERT_PREFS);
  // Base de cada cambio: lo que hay en memoria (si `localStorage` está
  // bloqueado, releerlo devolvería defaults y se perdería lo anterior).
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    setPrefs(readAlertPrefs(userId));
    return onAlertPrefsChange(userId, setPrefs);
  }, [userId]);

  const update = useCallback(
    (patch: Partial<AlertPrefs>) => {
      const next = { ...prefsRef.current, ...patch };
      prefsRef.current = next;
      setPrefs(next);
      writeAlertPrefs(userId, next);
    },
    [userId]
  );

  return [prefs, update];
}
