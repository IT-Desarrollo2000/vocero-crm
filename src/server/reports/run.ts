import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import type { ReportBlock } from "@/lib/reports";

/**
 * 02 — Ejecución de reportes (RF-02-08, «Casos borde y degradación»).
 *
 * - Cada bloque corre en su PROPIA transacción `READ ONLY` con
 *   `SET LOCAL statement_timeout = '15s'`: una consulta lenta se corta en
 *   Postgres, no solo en Node.
 * - Concurrencia LIMITADA a 2 bloques a la vez: el pool es `max: 10`
 *   (`src/lib/db/index.ts`) y compite con el webhook; un reporte no puede
 *   acapararlo.
 * - Cada bloque degrada por separado (`{ ok: false, error }`); solo si TODOS
 *   fallan y alguno por tiempo, el reporte entero es `ReportTimeoutError`
 *   (→ 503 `report_timeout`).
 */

/** Tope por consulta (SET LOCAL statement_timeout). */
export const STATEMENT_TIMEOUT_MS = 15_000;
/** Bloques simultáneos por reporte. */
export const REPORT_CONCURRENCY = 2;
/**
 * Presupuesto total: un bloque que todavía no arrancó al vencerlo se marca
 * `timeout` sin ejecutarse (el peor caso sería 7 bloques × 15 s / 2).
 */
export const REPORT_DEADLINE_MS = 30_000;

/** SQLSTATE 57014 (query_canceled): lo que lanza `statement_timeout`. */
const QUERY_CANCELED = "57014";

export class ReportTimeoutError extends Error {
  constructor(message = "El reporte excedió el tiempo") {
    super(message);
    this.name = "ReportTimeoutError";
  }
}

/** ¿El error (o su causa, si un driver lo envolvió) es un statement_timeout? */
export function isStatementTimeout(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof ReportTimeoutError) return true;
    if (typeof cur === "object" && (cur as { code?: unknown }).code === QUERY_CANCELED) {
      return true;
    }
    cur = typeof cur === "object" ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** Ejecuta una consulta y devuelve sus filas crudas. */
export type ReportExec = <Row extends Record<string, unknown>>(query: SQL) => Promise<Row[]>;

/** Corre `fn` en una transacción de solo lectura con tope por consulta. */
export async function runReadOnly<T>(fn: (exec: ReportExec) => Promise<T>): Promise<T> {
  return getDb().transaction(
    async (tx) => {
      // SET no admite parámetros: el valor es una constante del código.
      await tx.execute(sql.raw(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
      const exec: ReportExec = async <Row extends Record<string, unknown>>(query: SQL) =>
        Array.from(await tx.execute<Row>(query)) as Row[];
      return fn(exec);
    },
    { accessMode: "read only" }
  );
}

export type RunBlocksOptions = {
  concurrency?: number;
  deadlineMs?: number;
  /** Reloj inyectable (pruebas). */
  now?: () => number;
  /** Destino del log de un bloque caído (pruebas). */
  onError?: (key: string, err: unknown) => void;
};

type Tasks<T> = { [K in keyof T]: () => Promise<T[K]> };
type Results<T> = { [K in keyof T]: ReportBlock<T[K]> };

function logBlockError(key: string, err: unknown) {
  // Solo el mensaje: ni parámetros ni filas (pueden traer datos de clientes).
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[reports] bloque "${key}" no disponible: ${msg}`);
}

/**
 * Ejecuta los bloques con concurrencia limitada; cada uno resuelve a
 * `{ ok: true, data }` o `{ ok: false, error }` — nunca rechaza por un bloque.
 * Lanza `ReportTimeoutError` solo si TODOS fallaron y al menos uno por tiempo.
 */
export async function runBlocks<T extends Record<string, unknown>>(
  tasks: Tasks<T>,
  opts: RunBlocksOptions = {}
): Promise<Results<T>> {
  const concurrency = Math.max(1, opts.concurrency ?? REPORT_CONCURRENCY);
  const deadlineMs = opts.deadlineMs ?? REPORT_DEADLINE_MS;
  const now = opts.now ?? Date.now;
  const onError = opts.onError ?? logBlockError;
  const keys = Object.keys(tasks) as (keyof T & string)[];
  const results = {} as Results<T>;
  const startedAt = now();
  let next = 0;

  async function worker() {
    while (next < keys.length) {
      const key = keys[next++]!;
      if (now() - startedAt > deadlineMs) {
        results[key] = { ok: false, error: "timeout" };
        continue;
      }
      try {
        results[key] = { ok: true, data: await tasks[key]() };
      } catch (err) {
        onError(key, err);
        results[key] = {
          ok: false,
          error: isStatementTimeout(err) ? "timeout" : "unavailable",
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, keys.length) }, () => worker())
  );

  const all = keys.map((k) => results[k]);
  if (
    all.length > 0 &&
    all.every((r) => !r.ok) &&
    all.some((r) => !r.ok && r.error === "timeout")
  ) {
    throw new ReportTimeoutError();
  }
  return results;
}
