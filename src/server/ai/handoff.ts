import type { Formality } from "@/lib/formality";

/**
 * Patrón de RESPALDO de intención de escalado (FR-022). Se evalúa sobre el
 * mensaje del cliente ANTES del LLM: si matchea, el handoff ocurre aunque el
 * modelo no lo detecte. Diseñado para exigir un verbo de contacto cerca del
 * objeto humano — "somos 4 personas" NO matchea (test unitario).
 */
export const HANDOFF_BACKUP_REGEX =
  /(hablar|comunicar|contactar)[\s\S]{0,40}?(asesor|humano|persona|alguien)|un asesor|atenci[oó]n humana/i;

export function matchesHandoffIntent(text: string): boolean {
  return HANDOFF_BACKUP_REGEX.test(text);
}

/**
 * 030 — Aviso fijo al cliente cuando el patrón de respaldo escala (US-4): sin
 * él, quien pidió un humano no recibía nada. Solo para ese camino; el handoff
 * del modelo usa su propia despedida y los de ventana/error no avisan.
 */
export const HANDOFF_ACK_USTED =
  "Con gusto. Le comunico con un asesor; le responderá por este mismo chat lo antes posible.";
export const HANDOFF_ACK_TU =
  "Con gusto. Te comunico con un asesor; te responderá por este mismo chat lo antes posible.";

/** 030 — Texto del aviso según el trato del perfil. */
export function handoffAckText(formality: Formality): string {
  return formality === "usted" ? HANDOFF_ACK_USTED : HANDOFF_ACK_TU;
}

/** Tope de la nota libre de handoff: es contexto para el humano, no un transcript. */
export const HANDOFF_NOTE_MAX = 500;

/**
 * Normaliza la explicación libre de quien escala (el agente o el cerebro
 * externo): recortada a `HANDOFF_NOTE_MAX`; vacía o ausente → null.
 */
export function toHandoffNote(raw: string | null | undefined): string | null {
  const v = raw?.trim() ?? "";
  return v ? v.slice(0, HANDOFF_NOTE_MAX) : null;
}
