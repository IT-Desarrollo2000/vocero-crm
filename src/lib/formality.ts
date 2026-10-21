/**
 * 025 — Trato con el cliente (perfil del agente): tú o usted.
 *
 * Una sola fuente para el enum: la columna `agent_profile.formality`, la API
 * del perfil, el prompt, los textos del motor de agenda y los respaldos de
 * recordatorios lo leen de aquí.
 */
export const FORMALITIES = ["tu", "usted"] as const;

export type Formality = (typeof FORMALITIES)[number];

/** Lo que no sea exactamente "usted" es tú (el default histórico). */
export function normalizeFormality(v: unknown): Formality {
  return v === "usted" ? "usted" : "tu";
}
