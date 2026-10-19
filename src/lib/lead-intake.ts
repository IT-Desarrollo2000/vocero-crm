/**
 * 011 — La TARJETA de un lead externo (mensaje `type: "lead_intake"`).
 *
 * Un solo punto de verdad, sin columna nueva: el `text` del mensaje es un
 * resumen legible cuya PRIMERA línea dice el origen («Lead del sitio web» /
 * «Lead de promotor (FastApp)») y cada línea siguiente es un campo
 * («Correo: …»). Así lo leen igual la lista de la Bandeja (vista previa), el
 * hilo (que lo pinta como tarjeta) y el historial del agente (etiquetado,
 * nunca como si el cliente lo hubiera escrito en el chat).
 *
 * Sin dependencias de servidor: lo importan el hilo (cliente) y `ai/history`.
 */

export const LEAD_INTAKE_TYPE = "lead_intake";

/** Prefijo del `wa_message_id` de la tarjeta (`intake:<lead_id>`, UNIQUE). */
export const LEAD_INTAKE_WAMID_PREFIX = "intake:";

export const LEAD_INTAKE_HEADER = {
  website: "Lead del sitio web",
  fast_app: "Lead de promotor (FastApp)",
} as const;

export type LeadCard = {
  /** Primera línea: de dónde vino. */
  header: string;
  /** Origen reconocido por la cabecera; null si el texto no la trae. */
  origin: keyof typeof LEAD_INTAKE_HEADER | null;
  /** Un campo por línea (`Etiqueta: valor`); sin etiqueta → `label: null`. */
  fields: { label: string | null; value: string }[];
};

/** Lee la tarjeta desde el `text` del mensaje. Tolerante: nunca lanza. */
export function parseLeadCard(text: string | null | undefined): LeadCard {
  const lines = (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const header = lines[0] ?? "Lead externo";
  const origin =
    header === LEAD_INTAKE_HEADER.website
      ? "website"
      : header === LEAD_INTAKE_HEADER.fast_app
        ? "fast_app"
        : null;
  const fields = lines.slice(1).map((line) => {
    const i = line.indexOf(": ");
    return i > 0
      ? { label: line.slice(0, i), value: line.slice(i + 2) }
      : { label: null, value: line };
  });
  return { header, origin, fields };
}

/**
 * Cómo lo ve el agente en su historial: «[Lead del sitio web] Nombre: … ·
 * Correo: …». La cabecera sin el paréntesis («[Lead de promotor] …»).
 */
export function leadCardForAgent(text: string | null | undefined): string {
  const card = parseLeadCard(text);
  const tag = card.header.replace(/\s*\([^)]*\)\s*$/, "");
  const body = card.fields
    .map((f) => (f.label ? `${f.label}: ${f.value}` : f.value))
    .join(" · ");
  return body ? `[${tag}] ${body}` : `[${tag}]`;
}
