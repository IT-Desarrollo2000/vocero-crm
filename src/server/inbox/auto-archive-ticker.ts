/**
 * 022 — Reloj in-process del auto-archivo de la Bandeja: un `setInterval`
 * arrancado desde `instrumentation.ts`, mismo patrón que la purga de adjuntos
 * (`src/server/media/purge-ticker.ts`). Sin cola ni cron externos
 * (Constitución II). Seguro con N réplicas: archivar es idempotente (la
 * condición exige `archived_at IS NULL`).
 *
 * - Arranca SIEMPRE (núcleo, sin bandera): cada vuelta solo toca las
 *   organizaciones con el interruptor encendido en Ajustes → Bandeja.
 *   `INBOX_AUTO_ARCHIVE_TICK_MS=0` lo apaga.
 * - Guard en `globalThis`: el hot reload de dev re-ejecuta `register()` y no
 *   debe duplicar intervalos.
 * - `inFlight`: una vuelta a la vez por proceso.
 * - `try/catch` total: una vuelta fallida solo se loguea.
 *
 * Lee `process.env` directo y no `getEnv()`: arrancar el reloj no puede
 * depender de que TODO el entorno valide.
 */

export const INBOX_AUTO_ARCHIVE_TICK_DEFAULT_MS = 60 * 60 * 1000;

const TICKER_KEY = Symbol.for("vocero.inboxAutoArchiveTicker");

type TickerState = { timer: ReturnType<typeof setInterval>; periodMs: number };
type GlobalWithTicker = typeof globalThis & { [TICKER_KEY]?: TickerState };

/**
 * `INBOX_AUTO_ARCHIVE_TICK_MS`: sin valor o ilegible → 1 h; `0` → apagado
 * (`null`); por debajo de 1 min se sube a 1 min (un typo no martilla la BD).
 */
export function parseAutoArchiveTickMs(raw: string | undefined): number | null {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return INBOX_AUTO_ARCHIVE_TICK_DEFAULT_MS;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return INBOX_AUTO_ARCHIVE_TICK_DEFAULT_MS;
  if (n === 0) return null;
  return Math.max(60_000, Math.round(n));
}

export type AutoArchiveTickerDeps = {
  env?: Record<string, string | undefined>;
  /** La vuelta; por defecto `runAutoArchive` (import perezoso). */
  tick?: (now: Date) => Promise<unknown>;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
};

/** Arranca el reloj si corresponde. Devuelve si quedó corriendo. */
export function startAutoArchiveTicker(deps: AutoArchiveTickerDeps = {}): boolean {
  const env = deps.env ?? process.env;
  const periodMs = parseAutoArchiveTickMs(env.INBOX_AUTO_ARCHIVE_TICK_MS);
  if (periodMs === null) return false;

  const g = globalThis as GlobalWithTicker;
  if (g[TICKER_KEY]) return true;

  const tick =
    deps.tick ??
    (async (now: Date) => {
      const { runAutoArchive } = await import("@/server/inbox/archive");
      return runAutoArchive(now);
    });

  let inFlight = false;
  const run = () => {
    if (inFlight) return;
    inFlight = true;
    void tick(new Date())
      .catch((err: unknown) => {
        console.error("[auto-archive] la vuelta falló:", err);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const timer = (deps.setInterval ?? setInterval)(run, periodMs);
  (timer as { unref?: () => void }).unref?.();
  g[TICKER_KEY] = { timer, periodMs };
  console.log(`[boot] auto-archivo de la Bandeja: vuelta cada ${periodMs} ms`);
  return true;
}

/** Detiene el reloj (pruebas). */
export function stopAutoArchiveTicker(): void {
  const g = globalThis as GlobalWithTicker;
  const state = g[TICKER_KEY];
  if (state) clearInterval(state.timer);
  delete g[TICKER_KEY];
}
