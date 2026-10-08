/**
 * Datos variables de las páginas legales públicas (/privacidad, /terminos,
 * /eliminacion-datos). Las páginas leen de aquí y no hardcodean nada.
 */
export const LEGAL = {
  /** Nombre comercial del producto. */
  productName: "FUTURA CRM",
  /** Marca con la que el negocio atiende al público. */
  businessName: "Futura México",
  /** Razón social del responsable del tratamiento. */
  legalName: "DELFIN9, S.A. de C.V.",
  /** Correo de contacto para privacidad y solicitudes ARCO. */
  privacyEmail: "contacto@delfin9.com",
  /** Domicilio del responsable. */
  address: "Calle 4 #70, Fracc. Nances II, Centro, Villahermosa, Tabasco",
  /** Última actualización (ISO, AAAA-MM-DD). */
  lastUpdated: "2026-10-08",
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
