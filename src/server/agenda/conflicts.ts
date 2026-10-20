import type { SlotUtc } from "@/lib/time/slots";

/**
 * 023 — Motor de choques, PURO (sin BD ni reloj): dado un hueco candidato y lo
 * que ya ocupa la agenda, decide qué lo BLOQUEA (hard) y qué solo merece una
 * ADVERTENCIA (soft).
 *
 *  - `strict` (agente de IA y bot): todo traslape es hard. Nadie lee una
 *    advertencia del otro lado, así que la IA no pisa nada (decisión 4).
 *  - `staff` (humanos): un bloqueo, el mismo tipo exclusivo o una cita del
 *    mismo vendedor son hard; cualquier otra cita es soft — dos vendedores
 *    pueden atender a la vez, pero deben enterarse.
 *
 * El margen entre citas (`bufferMinutes`, A6) se aplica al choque: tanto lo
 * ocupado como el candidato cuentan como `[inicio, fin + margen)`. Así la
 * regla es simétrica: nadie empieza antes de que el otro termine + margen.
 */

export type BusyItem = {
  id: string;
  kind: "session" | "block";
  startUtc: string;
  endUtc: string;
  typeId: string | null;
  exclusive: boolean;
  assignedUserId: string | null;
  typeName: string | null;
  sellerName: string | null;
};

export type ConflictContext =
  | { mode: "strict" }
  | {
      mode: "staff";
      typeId: string | null;
      typeExclusive: boolean;
      sellerId: string | null;
    };

export const STRICT: ConflictContext = { mode: "strict" };

export type Classification = { hard: BusyItem[]; soft: BusyItem[] };

/** ¿Se traslapan, con el margen aplicado al final de ambos? */
export function overlapsWithBuffer(
  candidate: SlotUtc,
  item: Pick<BusyItem, "startUtc" | "endUtc">,
  bufferMinutes: number
): boolean {
  const buf = Math.max(0, bufferMinutes) * 60_000;
  const cStart = Date.parse(candidate.startUtc);
  const cEnd = Date.parse(candidate.endUtc) + buf;
  const iStart = Date.parse(item.startUtc);
  const iEnd = Date.parse(item.endUtc) + buf;
  return cStart < iEnd && iStart < cEnd;
}

/** ¿Este ocupado, ya traslapado, bloquea en este contexto? */
export function isHard(item: BusyItem, ctx: ConflictContext): boolean {
  if (ctx.mode === "strict") return true;
  if (item.kind === "block") return true;
  if (
    ctx.typeId !== null &&
    item.typeId === ctx.typeId &&
    (ctx.typeExclusive || item.exclusive)
  ) {
    return true;
  }
  if (ctx.sellerId !== null && item.assignedUserId === ctx.sellerId) {
    return true;
  }
  return false;
}

export function classify(
  candidate: SlotUtc,
  busy: readonly BusyItem[],
  ctx: ConflictContext,
  bufferMinutes = 0
): Classification {
  const hard: BusyItem[] = [];
  const soft: BusyItem[] = [];
  for (const item of busy) {
    if (!overlapsWithBuffer(candidate, item, bufferMinutes)) continue;
    (isHard(item, ctx) ? hard : soft).push(item);
  }
  return { hard, soft };
}
