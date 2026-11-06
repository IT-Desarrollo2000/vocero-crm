/**
 * 032 — Zona horaria IANA → cómo se dice en pantalla: «hora de Ciudad de
 * México». Puro. Lo usan Citas («Horarios en hora de …») y Reportes.
 *
 * Mapa a mano de las zonas de México y de las de Latinoamérica (y Madrid) que
 * más se configuran; cualquier otra cae al último segmento con «_» → espacio
 * («America/Port_of_Spain» → «hora de Port of Spain»). Nunca se muestra el
 * identificador IANA crudo.
 */

const PLACE: Record<string, string> = {
  // México
  "America/Mexico_City": "Ciudad de México",
  "America/Monterrey": "Monterrey",
  "America/Merida": "Mérida",
  "America/Cancun": "Cancún",
  "America/Chihuahua": "Chihuahua",
  "America/Ciudad_Juarez": "Ciudad Juárez",
  "America/Hermosillo": "Hermosillo",
  "America/Mazatlan": "Mazatlán",
  "America/Tijuana": "Tijuana",
  "America/Bahia_Banderas": "Bahía de Banderas",
  "America/Matamoros": "Matamoros",
  "America/Ojinaga": "Ojinaga",
  // Latinoamérica y España
  "America/Bogota": "Bogotá",
  "America/Lima": "Lima",
  "America/Santiago": "Santiago de Chile",
  "America/Argentina/Buenos_Aires": "Buenos Aires",
  "America/Buenos_Aires": "Buenos Aires",
  "America/Guatemala": "Guatemala",
  "America/El_Salvador": "El Salvador",
  "America/Costa_Rica": "Costa Rica",
  "America/Panama": "Panamá",
  "America/Caracas": "Caracas",
  "Europe/Madrid": "Madrid",
};

/** El lugar de la zona: «Ciudad de México», o el último segmento legible. */
export function tzPlace(tz: string | null | undefined): string | null {
  const id = tz?.trim();
  if (!id) return null;
  const known = PLACE[id];
  if (known) return known;
  const last = id.split("/").pop()?.replace(/_/g, " ").trim();
  return last || null;
}

/** «hora de Ciudad de México»; null si no hay zona. */
export function tzLabel(tz: string | null | undefined): string | null {
  const place = tzPlace(tz);
  if (!place) return null;
  // «UTC» y «GMT» no son lugares: «hora UTC».
  if (/^(UTC|GMT|Etc\/UTC|Etc\/GMT)$/i.test(tz?.trim() ?? "")) return "hora UTC";
  return `hora de ${place}`;
}
