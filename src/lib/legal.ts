/**
 * Datos variables de las páginas legales públicas (/privacidad, /terminos,
 * /eliminacion-datos). Las páginas leen de aquí y no hardcodean nada.
 */
export const LEGAL = {
  /** Nombre comercial del producto. */
  productName: "FUTURA CRM",
  /** Marca con la que el negocio atiende al público. */
  businessName: "FUTURA City Cars",
  /** Razón social del responsable del tratamiento. */
  legalName: "DELFIN9, S.A.P.I. de C.V.",
  /** Correo de contacto para privacidad y solicitudes ARCO. */
  privacyEmail: "contacto@delfin9.com",
  /** Domicilio del responsable. */
  address: "Calle 4 #70, Fracc. Nances II, Centro, Villahermosa, Tabasco",
  /** Última actualización (ISO, AAAA-MM-DD). */
  lastUpdated: "2026-10-13",
  /** Plazo máximo para atender una eliminación de datos, en días. */
  deletionDays: 30,
  /** Frase que el usuario puede escribir por el canal para pedir la baja. */
  deletionPhrase: "ELIMINAR MIS DATOS",
  /**
   * Encargados que tratan datos por cuenta del Responsable. Debe coincidir
   * con lo declarado a Meta en la revisión de la app ("data processors").
   */
  processors: [
    {
      name: "Supabase, Inc.",
      role: "base de datos administrada donde se almacenan las conversaciones, los datos de contacto y las credenciales cifradas",
      location: "Estados Unidos",
    },
    {
      name: "Hostinger International Ltd.",
      role: "servidor privado virtual (VPS) donde se ejecuta el sistema y se guardan los archivos adjuntos",
      location: null,
    },
    {
      name: "MiniMax",
      role: "proveedor de modelos de inteligencia artificial, consumido por API, al que se envía el texto necesario de la conversación y el nombre del cliente para generar las respuestas del asistente (nunca credenciales ni tokens)",
      location: null,
    },
  ],
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
