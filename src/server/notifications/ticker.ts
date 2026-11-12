import { NOTIFICATIONS_TICK_DEFAULT_MS, safeErrorTag } from "@/lib/notifications";

/**
 * 035 fase B — Reloj in-process de los avisos (recordatorios vencidos y
 * resumen del día): un `setInterval` arrancado desde `instrumentation.ts`,
 * mismo patrón que `src/server/agenda/reminder-ticker.ts`. Sin cola ni cron
 * externos (Constitución II). Seguro con N réplicas: el candado es el UNIQUE
 * de `notification`, no este proceso.
 *
 * - No arranca con `NOTIFICATIONS_TICK_MS=0` (así corre el E2E: el reloj solo
 *   avanza con `POST /api/dev/notifications/tick`).
 * - Guard en `globalThis`: el hot reload de dev no duplica intervalos.
 * - `inFlight`: una vuelta a la vez por proceso.
 * - `try/catch` total: una vuelta fallida solo se registra; la app sigue.
 *
 * Lee `process.env` directo (no `getEnv()`): arrancar el reloj no puede
 * depender de que TODO el entorno valide.
 */

const TICKER_KEY = Symbol.for("vocero.notificationsTicker");

type TickerState = { timer: ReturnType<typeof setInterval>; periodMs: number };
type GlobalWithTicker = typeof globalThis & { [TICKER_KEY]?: TickerState };

/**
 * `NOTIFICATIONS_TICK_MS`: sin valor o ilegible → 60 000; `0` → apagado
 * (`null`); por debajo de 1 s se sube a 1 s (un typo no martilla la BD).
 */
export function parseNotificationsTickMs(raw: string | undefined): number | null {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return NOTIFICATIONS_TICK_DEFAULT_MS;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return NOTIFICATIONS_TICK_DEFAULT_MS;
  if (n === 0) return null;
  return Math.max(1_000, Math.round(n));
}

export type NotificationsTickerDeps = {
  env?: Record<string, string | undefined>;
  /** La vuelta; por defecto `runNotificationTick` (import perezoso). */
  tick?: (now: Date) => Promise<unknown>;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  /** Registro de errores (pruebas). */
  logError?: (msg: string, err: unknown) => void;
};

/** Arranca el reloj si corresponde. Devuelve si quedó corriendo. */
export function startNotificationsTicker(deps: NotificationsTickerDeps = {}): boolean {
  const env = deps.env ?? process.env;
  const periodMs = parseNotificationsTickMs(env.NOTIFICATIONS_TICK_MS);
  if (periodMs === null) return false;

  const g = globalThis as GlobalWithTicker;
  if (g[TICKER_KEY]) return true;

  const tick =
    deps.tick ??
    (async (now: Date) => {
      const { runNotificationTick } = await import("@/server/notifications/tick");
      return runNotificationTick(now);
    });
  const logError =
    deps.logError ??
    ((msg: string, err: unknown) => console.error(`${msg} ${safeErrorTag(err)}`));

  let inFlight = false;
  const run = () => {
    if (inFlight) return;
    inFlight = true;
    let p: Promise<unknown>;
    try {
      p = tick(new Date());
    } catch (err) {
      p = Promise.reject(err);
    }
    void p
      .catch((err: unknown) => {
        logError("[avisos] el tick falló:", err);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const timer = (deps.setInterval ?? setInterval)(run, periodMs);
  (timer as { unref?: () => void }).unref?.();
  g[TICKER_KEY] = { timer, periodMs };
  console.log(`[boot] avisos (recordatorios vencidos y resumen del día): tick cada ${periodMs} ms`);
  return true;
}

/** Detiene el reloj (pruebas). */
export function stopNotificationsTicker(): void {
  const g = globalThis as GlobalWithTicker;
  const state = g[TICKER_KEY];
  if (state) clearInterval(state.timer);
  delete g[TICKER_KEY];
}
