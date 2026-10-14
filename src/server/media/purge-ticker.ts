/**
 * 018 — Reloj in-process de la caché de adjuntos (FR-815): un `setInterval`
 * arrancado desde `instrumentation.ts`, mismo patrón que el de recordatorios
 * (`src/server/agenda/reminder-ticker.ts`). Sin cola ni cron externos
 * (Constitución II). Seguro con N réplicas: la purga es idempotente.
 *
 * - Arranca SIEMPRE (no depende de banderas): todo adjunto de todo canal
 *   expira a los `MEDIA_RETENTION_DAYS` días. `MEDIA_PURGE_TICK_MS=0` lo apaga.
 * - Guard en `globalThis`: el hot reload de dev re-ejecuta `register()` y no
 *   debe duplicar intervalos.
 * - `inFlight`: una vuelta a la vez por proceso.
 * - `try/catch` total: una vuelta fallida solo se loguea.
 *
 * Lee `process.env` directo y no `getEnv()`: arrancar el reloj no puede
 * depender de que TODO el entorno valide.
 */

import { parseRetentionDays } from "@/server/media/purge";

export const MEDIA_PURGE_TICK_DEFAULT_MS = 60 * 60 * 1000;

const TICKER_KEY = Symbol.for("vocero.mediaPurgeTicker");

type TickerState = { timer: ReturnType<typeof setInterval>; periodMs: number };
type GlobalWithTicker = typeof globalThis & { [TICKER_KEY]?: TickerState };

/**
 * `MEDIA_PURGE_TICK_MS`: sin valor o ilegible → 1 h; `0` → apagado (`null`);
 * por debajo de 1 min se sube a 1 min (un typo no martilla la BD ni el disco).
 */
export function parsePurgeTickMs(raw: string | undefined): number | null {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return MEDIA_PURGE_TICK_DEFAULT_MS;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return MEDIA_PURGE_TICK_DEFAULT_MS;
  if (n === 0) return null;
  return Math.max(60_000, Math.round(n));
}

export type MediaPurgeTickerDeps = {
  env?: Record<string, string | undefined>;
  /** La vuelta; por defecto `runMediaPurge` (import perezoso). */
  tick?: (now: Date, retentionDays: number) => Promise<unknown>;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
};

/** Arranca el reloj si corresponde. Devuelve si quedó corriendo. */
export function startMediaPurgeTicker(deps: MediaPurgeTickerDeps = {}): boolean {
  const env = deps.env ?? process.env;
  const periodMs = parsePurgeTickMs(env.MEDIA_PURGE_TICK_MS);
  if (periodMs === null) return false;
  const retentionDays = parseRetentionDays(env.MEDIA_RETENTION_DAYS);

  const g = globalThis as GlobalWithTicker;
  if (g[TICKER_KEY]) return true;

  const tick =
    deps.tick ??
    (async (now: Date, days: number) => {
      const { runMediaPurge } = await import("@/server/media/purge");
      return runMediaPurge(now, days);
    });

  let inFlight = false;
  const run = () => {
    if (inFlight) return;
    inFlight = true;
    void tick(new Date(), retentionDays)
      .catch((err: unknown) => {
        console.error("[media-purge] la vuelta falló:", err);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const timer = (deps.setInterval ?? setInterval)(run, periodMs);
  (timer as { unref?: () => void }).unref?.();
  g[TICKER_KEY] = { timer, periodMs };
  console.log(
    `[boot] caché de adjuntos: purga cada ${periodMs} ms, retención ${retentionDays} días`
  );
  return true;
}

/** Detiene el reloj (pruebas). */
export function stopMediaPurgeTicker(): void {
  const g = globalThis as GlobalWithTicker;
  const state = g[TICKER_KEY];
  if (state) clearInterval(state.timer);
  delete g[TICKER_KEY];
}
