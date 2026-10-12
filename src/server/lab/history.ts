import type { LabRunDiffDto, LabTrendsDto } from "@/lib/lab";
import { labNotImplemented } from "@/server/lab/errors";

/**
 * 08 — Historial del Laboratorio («Contrato 08-0»): tendencia, "qué cambió"
 * y delta comparable. `samePersonaSet` es real; lo demás lo completa 08-A.
 */

type RunSetInfo = {
  personaKeys: string[] | null;
  /** `config_snapshot.personas`, si la corrida lo tiene. */
  personaHashes?: { key: string; hash: string }[] | null;
};

/**
 * RF-08-17: ¿dos corridas son comparables para el delta? Mismas claves (sin
 * importar el orden) y, si las dos tienen snapshot, mismo hash por clave.
 * Corridas anteriores a 08 (`personaKeys` null) solo se comparan entre sí.
 */
export function samePersonaSet(a: RunSetInfo, b: RunSetInfo): boolean {
  if (a.personaKeys === null || b.personaKeys === null) {
    return a.personaKeys === null && b.personaKeys === null;
  }
  const ka = [...a.personaKeys].sort();
  const kb = [...b.personaKeys].sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  if (!a.personaHashes || !b.personaHashes) return true;
  const hb = new Map(b.personaHashes.map((p) => [p.key, p.hash]));
  return a.personaHashes.every((p) => hb.get(p.key) === p.hash);
}

/** RF-08-10: corridas `done` más recientes con conteos por tipo y veredictos. */
export async function runTrends(
  organizationId: string,
  limit: number
): Promise<LabTrendsDto> {
  void organizationId;
  void limit;
  return labNotImplemented("runTrends");
}

/**
 * RF-08-16: diff de snapshots entre `runId` y `againstId` (default: la
 * corrida `done` anterior con snapshot). 404 `LabError("not_found")` si
 * alguna no es de la org; `{ available: false }` si falta snapshot o no hay
 * anterior.
 */
export async function diffRuns(
  organizationId: string,
  runId: string,
  againstId?: string
): Promise<LabRunDiffDto> {
  void organizationId;
  void runId;
  void againstId;
  return labNotImplemented("diffRuns");
}
