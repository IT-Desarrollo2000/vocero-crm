"use client";

import { soundAllowed } from "@/lib/alerts";

/**
 * Sonido de alerta (RF-05-09) con Web Audio: dos tonos cortos generados, sin
 * archivos de audio ni terceros. Los navegadores bloquean el audio hasta un
 * gesto del usuario, así que cada pestaña escucha su primer `pointerdown` /
 * `keydown` para crear o reanudar el `AudioContext` (`installAudioUnlock`).
 * Si al sonar sigue `suspended`, se omite en silencio.
 */

type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;
let lastPlayedAt: number | null = null;

function audioCtor(): AudioCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: AudioCtor;
    webkitAudioContext?: AudioCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Crea o reanuda el contexto. Llamar SOLO dentro de un gesto del usuario. */
export function unlockAudio(): void {
  try {
    if (!ctx) {
      const Ctor = audioCtor();
      if (!Ctor) return;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  } catch {
    // Sin audio: las alertas siguen sin sonido.
  }
}

/** Listener único por pestaña; se quita solo cuando el audio ya corre. */
export function installAudioUnlock(): () => void {
  if (typeof window === "undefined") return () => {};
  const onGesture = () => {
    unlockAudio();
    if (ctx?.state === "running") remove();
  };
  const remove = () => {
    window.removeEventListener("pointerdown", onGesture, true);
    window.removeEventListener("keydown", onGesture, true);
  };
  window.addEventListener("pointerdown", onGesture, true);
  window.addEventListener("keydown", onGesture, true);
  return remove;
}

/**
 * Dos tonos (~150 ms). Respeta el máximo de uno cada 3 s salvo `force`
 * (botón «Probar»). Devuelve si sonó.
 */
export function playAlertSound(opts: { force?: boolean } = {}): boolean {
  const now = Date.now();
  if (!opts.force && !soundAllowed(lastPlayedAt, now)) return false;
  if (!ctx || ctx.state !== "running") return false;
  try {
    const t0 = ctx.currentTime;
    const tones: [number, number][] = [
      [880, 0],
      [1320, 0.09],
    ];
    for (const [freq, offset] of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + offset + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.08);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.09);
    }
    lastPlayedAt = now;
    return true;
  } catch {
    return false;
  }
}
