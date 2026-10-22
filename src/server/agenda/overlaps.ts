import { classify, type BusyItem } from "@/server/agenda/conflicts";

/**
 * 028 (A4) — Traslape en dos niveles para el calendario, PURO.
 *
 * Para cada SESIÓN activa se pregunta: "si hoy la agendaran aquí, ¿qué
 * pasaría con lo que ya ocupa esa hora?". Se usa el mismo motor que decide
 * reservas (`classify`/`isHard` de `conflicts.ts`) en modo `staff` y en el
 * contexto de ESA cita (su tipo, su exclusividad, su vendedor):
 *
 *  - `hard`: traslape que hoy sería RECHAZO (un bloqueo encima, otra cita
 *    del mismo vendedor, el mismo tipo exclusivo). Es un conflicto real.
 *  - `soft`: traslape permitido (otro vendedor, otro tipo no exclusivo).
 *
 * Decisiones:
 *  - SIN margen (`bufferMinutes`): el calendario pinta lo que se toca de
 *    verdad; el margen ya lo aplica la rejilla al ofrecer.
 *  - Solo sesiones llevan atributo: un bloqueo no "choca", cubre. Por eso la
 *    asimetría bloqueo/sesión: la sesión bajo un bloqueo es `hard`; el bloqueo
 *    no aparece en el mapa.
 *  - Canceladas, no-show y citas de prueba no cuentan (ni como víctima ni
 *    como causa). `getBusyIntervals` ya las deja fuera en SQL; aquí se filtran
 *    otra vez si el llamador trae `status`/`isTest`, para que la regla viva
 *    también en la pieza pura.
 */

export type OverlapLevel = "soft" | "hard";
export type OverlapMap = Record<string, OverlapLevel>;

const ACTIVE = new Set(["agendada", "realizada"]);

export type OverlapItem = BusyItem & { status?: string; isTest?: boolean };

export function computeOverlaps(items: readonly OverlapItem[]): OverlapMap {
  const busy = items.filter(
    (b) => b.isTest !== true && (b.status === undefined || ACTIVE.has(b.status))
  );
  // Ordenadas por inicio: para cada cita basta mirar las que empiezan antes
  // de que ella termine (hasta 3 000 citas por rango, nada de n² completo).
  const sorted = [...busy].sort(
    (a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc)
  );
  const starts = sorted.map((b) => Date.parse(b.startUtc));
  const out: OverlapMap = {};
  sorted.forEach((item, i) => {
    if (item.kind !== "session") return;
    const end = Date.parse(item.endUtc);
    const candidates: BusyItem[] = [];
    for (let j = 0; j < sorted.length && starts[j]! < end; j++) {
      if (j !== i) candidates.push(sorted[j]!);
    }
    const { hard, soft } = classify(
      { startUtc: item.startUtc, endUtc: item.endUtc },
      candidates,
      {
        mode: "staff",
        typeId: item.typeId,
        typeExclusive: item.exclusive,
        sellerId: item.assignedUserId,
      },
      0
    );
    if (hard.length > 0) out[item.id] = "hard";
    else if (soft.length > 0) out[item.id] = "soft";
  });
  return out;
}

/** Solo las citas que el viewer ve (el cálculo fue sobre toda la org). */
export function pickOverlaps(
  all: OverlapMap,
  visibleIds: readonly string[]
): OverlapMap {
  const out: OverlapMap = {};
  for (const id of visibleIds) {
    const level = all[id];
    if (level) out[id] = level;
  }
  return out;
}
