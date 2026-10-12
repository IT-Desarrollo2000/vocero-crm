import { REMINDER_TICK_DEFAULT_MS } from "@/lib/reminders";
import { parseAgendaFlag } from "@/server/agenda/flag";

/**
 * 10 — Reloj in-process de los recordatorios (D-10-01): un `setInterval`
 * arrancado desde `instrumentation.ts`. Sin cola ni cron externos
 * (Constitución II). Seguro con N réplicas: el claim es el UNIQUE de
 * `booking_reminder`, no este proceso.
 *
 * - No arranca con AGENDA apagada ni con `AGENDA_REMINDER_TICK_MS=0`.
 * - Guard en `globalThis`: el hot reload de dev re-ejecuta `register()` y no
 *   debe duplicar intervalos.
 * - `inFlight`: un tick a la vez por proceso (uno lento no se solapa consigo
 *   mismo; dos réplicas sí pueden, y el UNIQUE lo resuelve).
 * - `try/catch` total: un tick fallido solo se loguea.
 *
 * Igual que `agendaEnabled()`, lee `process.env` directo y no `getEnv()`:
 * arrancar el reloj no puede depender de que TODO el entorno valide.
 */

const TICKER_KEY = Symbol.for("vocero.reminderTicker");

type TickerState = { timer: ReturnType<typeof setInterval>; periodMs: number };
type GlobalWithTicker = typeof globalThis & { [TICKER_KEY]?: TickerState };

/**
 * `AGENDA_REMINDER_TICK_MS`: sin valor o ilegible → 60 000; `0` → apagado
 * (`null`); por debajo de 1 s se sube a 1 s (un typo no martilla la BD).
 */
export function parseReminderTickMs(raw: string | undefined): number | null {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return REMINDER_TICK_DEFAULT_MS;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return REMINDER_TICK_DEFAULT_MS;
  if (n === 0) return null;
  return Math.max(1_000, Math.round(n));
}

export type ReminderTickerDeps = {
  env?: Record<string, string | undefined>;
  /** La vuelta; por defecto `runReminderTick` (import perezoso). */
  tick?: (now: Date) => Promise<unknown>;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
};

/** Arranca el reloj si corresponde. Devuelve si quedó corriendo. */
export function startReminderTicker(deps: ReminderTickerDeps = {}): boolean {
  const env = deps.env ?? process.env;
  if (!parseAgendaFlag(env.AGENDA)) return false;
  const periodMs = parseReminderTickMs(env.AGENDA_REMINDER_TICK_MS);
  if (periodMs === null) return false;

  const g = globalThis as GlobalWithTicker;
  if (g[TICKER_KEY]) return true;

  const tick =
    deps.tick ??
    (async (now: Date) => {
      const { runReminderTick } = await import("@/server/agenda/reminders");
      return runReminderTick(now);
    });

  let inFlight = false;
  const run = () => {
    if (inFlight) return;
    inFlight = true;
    void tick(new Date())
      .catch((err: unknown) => {
        console.error("[reminders] el tick falló:", err);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const timer = (deps.setInterval ?? setInterval)(run, periodMs);
  (timer as { unref?: () => void }).unref?.();
  g[TICKER_KEY] = { timer, periodMs };
  console.log(`[boot] recordatorios de citas: tick cada ${periodMs} ms`);
  return true;
}

/** Detiene el reloj (pruebas). */
export function stopReminderTicker(): void {
  const g = globalThis as GlobalWithTicker;
  const state = g[TICKER_KEY];
  if (state) clearInterval(state.timer);
  delete g[TICKER_KEY];
}
