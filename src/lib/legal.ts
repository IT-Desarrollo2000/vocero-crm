/**
 * Datos variables de las páginas legales públicas (/privacidad, /terminos,
 * /eliminacion-datos). Todo lo que el dueño debe completar lleva el prefijo
 * `REEMPLAZA_`; las páginas leen de aquí y no hardcodean nada.
 */
export const LEGAL = {
  /** Nombre comercial del producto. */
  productName: "FUTURA CRM",
  /** Negocio dueño de la app en Meta. */
  businessName: "Futura - City Cars",
  /** Razón social del responsable del tratamiento. */
  legalName: "REEMPLAZA_RAZON_SOCIAL",
  /** Correo de contacto para privacidad y solicitudes ARCO. */
  privacyEmail: "REEMPLAZA_CORREO_PRIVACIDAD",
  /** Domicilio del responsable. */
  address: "REEMPLAZA_DOMICILIO",
  /** Última actualización (ISO, AAAA-MM-DD). */
  lastUpdated: "2026-10-07",
  /** Plazo máximo para atender una eliminación de datos, en días. */
  deletionDays: 30,
  /** Frase que el usuario puede escribir por el canal para pedir la baja. */
  deletionPhrase: "ELIMINAR MIS DATOS",
} as const;

const MESES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/** "2026-10-07" -> "7 de octubre de 2026" (sin zonas horarias). */
export function formatLegalDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const mes = MESES[(m ?? 1) - 1] ?? "";
  return `${d} de ${mes} de ${y}`;
}
