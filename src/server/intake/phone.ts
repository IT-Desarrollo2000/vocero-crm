import { normalizeMx } from "@/lib/meta/client";

/**
 * 011 (RF-4) — Teléfono de un lead externo → identidad de WhatsApp.
 *
 * El formulario web y FastApp capturan el número como lo escribe una persona
 * en México: casi siempre 10 dígitos, a veces con `+52`, espacios o guiones.
 * Aquí se lleva a la MISMA forma que el `from` de Meta (`52` + 10, ya sin el
 * `1` de celular, ver `normalizeMx`), para que cuando el prospecto escriba por
 * WhatsApp caiga en el mismo contacto.
 *
 * La suposición «10 dígitos = México» es LOCAL a este endpoint: el ERP que lo
 * alimenta es mexicano. `POST /api/contacts` sigue exigiendo lada a propósito.
 *
 * Orden: longitud primero, prefijo después. Un `52` + 10 que empiece por `1`
 * (`521…`, 12 dígitos) es un número válido y NO pierde ese 1; solo los 13
 * dígitos `521` + 10 lo pierden.
 *
 * @returns `52` + 10 dígitos, o `null` si no es un número mexicano reconocible.
 */
export function normalizeIntakePhone(raw: string): string | null {
  // Solo se toleran los adornos de una captura a mano; letras u otros
  // símbolos no son "un número con formato", son otra cosa.
  if (!/^[\d\s+\-().]+$/.test(raw.trim())) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `52${digits}`;
  if (digits.length === 12 && digits.startsWith("52")) return digits;
  if (digits.length === 13 && digits.startsWith("521")) return normalizeMx(digits);
  return null;
}

/** Últimos 4 del teléfono: lo único de él que puede ir a un log. */
export function phoneLast4(phone: string): string {
  return phone.slice(-4);
}
