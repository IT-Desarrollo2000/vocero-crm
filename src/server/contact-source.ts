import type { TipoDeOrigen } from "@/lib/anuncios";
import type { SourceDto, SourceValue } from "@/lib/types";

/**
 * Fuente del prospecto.
 *
 * Lo que el dueño captura MANDA; lo que no, se marca como deducido. Por eso
 * `contact.source` nace NULL: nadie tiene que capturar a mano la fuente de los
 * cientos de contactos que ya existían, ni marcarlos en falso con un backfill.
 * La UI distingue las dos cosas para no presentar una suposición como un dato.
 */

export const SOURCE_VALUES: readonly SourceValue[] = [
  "anuncio",
  "organico",
  "referido",
  "conocido",
  // 011: los pone la entrada de leads externos si nadie capturó otra.
  "web",
  "promotor",
  "otro",
];

export const SOURCE_LABELS: Record<SourceValue | "desconocida", string> = {
  anuncio: "Anuncio",
  organico: "Contenido orgánico",
  referido: "Referido",
  conocido: "Conocido",
  web: "Sitio web",
  promotor: "Promotor",
  otro: "Otro",
  desconocida: "Sin identificar",
};

export function isSourceValue(v: unknown): v is SourceValue {
  return typeof v === "string" && SOURCE_VALUES.includes(v as SourceValue);
}

/**
 * Un contacto que llegó solo por WhatsApp no dice de dónde salió, y el CRM no
 * lo inventa: queda "sin identificar" hasta que alguien lo capture.
 *
 * 020 — Salvo que Meta lo haya dicho: si el primer origen del contacto es un
 * ANUNCIO, la fuente se DEDUCE "anuncio"; si es una PUBLICACIÓN orgánica con
 * botón de WhatsApp, "organico". Lo capturado a mano sigue mandando (D3), y
 * borrar la captura (`PATCH source: null`) vuelve a esta deducción.
 */
export function effectiveSource(
  stored: SourceValue | null,
  origen: TipoDeOrigen = "none"
): SourceDto {
  if (stored) return { value: stored, source: "capturada" };
  if (origen === "ad") return { value: "anuncio", source: "deducida" };
  if (origen === "post") return { value: "organico", source: "deducida" };
  return { value: "desconocida", source: "deducida" };
}
