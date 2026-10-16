/**
 * 020 — Cómo se nombra el origen en pantalla (adaptado de upstream 018). Sin
 * dependencias de servidor: lo usan la fila de la Bandeja, el panel del
 * contacto, el cajón del trato y la fuente deducida.
 *
 * Meta marca `source_type: "post"` cuando el clic vino de una publicación y no
 * de un anuncio. Llamarlo "anuncio" haría pasar por pagado algo que no lo fue.
 */
export function etiquetaDeOrigen(sourceType: string | null | undefined): string {
  return sourceType === "post" ? "Publicación" : "Anuncio";
}

/**
 * ¿Cuenta como anuncio? Una publicación se enseña en la Bandeja igual, pero no
 * deduce la fuente "Anuncio" ni entra en el filtro Origen → "De anuncio".
 */
export function cuentaComoAnuncio(
  anuncio: { sourceType: string | null } | null | undefined
): boolean {
  return !!anuncio && anuncio.sourceType !== "post";
}

/**
 * De dónde llegó una conversación o un contacto: un anuncio pagado, una
 * PUBLICACIÓN orgánica con botón de WhatsApp (`source_type: "post"`) o nada
 * que Meta haya dicho. Es la misma partición del filtro Origen de la Bandeja.
 */
export type TipoDeOrigen = "ad" | "post" | "none";

export function tipoDeOrigen(
  anuncio: { sourceType: string | null } | null | undefined
): TipoDeOrigen {
  if (!anuncio) return "none";
  return anuncio.sourceType === "post" ? "post" : "ad";
}

/** Titular a enseñar cuando Meta no mandó ninguno. */
export function titularDeOrigen(
  headline: string | null | undefined,
  sourceType: string | null | undefined
): string {
  if (headline) return headline;
  return sourceType === "post" ? "Publicación sin título" : "Anuncio sin título";
}
