/**
 * 10 — Cómo se lee el recordatorio de una cita en «Citas». Lógica pura (sin
 * React) para probarla en unit: etiquetas de estado, motivo, entrega y los
 * errores del reintento manual.
 *
 * 032 — En palabras llanas: el error crudo del proveedor (inglés, códigos
 * «(#131026)») se cambia por una frase, y al Vendedor lo que solo arregla el
 * Propietario (plantilla, número conectado) se le dice como «pídele al
 * propietario que …».
 */

import {
  REMINDER_INTERRUPTED_ERROR,
  type BookingReminderDto,
  type BookingReminderSkipReason,
  type ReminderDeliveryStatus,
} from "@/lib/reminders";

/** Tono del chip (= variante de `Badge`). */
export type ReminderTone = "secondary" | "warning" | "success" | "destructive";

export const SKIP_REASON_LABEL: Record<BookingReminderSkipReason, string> = {
  template_not_approved: "la plantilla ya no está aprobada",
  template_missing: "no hay plantilla elegida",
  channel_not_whatsapp: "el contacto no es de WhatsApp",
  not_connected: "no hay número de WhatsApp conectado",
  reconnect_required: "hay que reconectar el número de WhatsApp",
  no_recipient: "el contacto no tiene número de WhatsApp",
};

export const DELIVERY_LABEL: Record<ReminderDeliveryStatus, string> = {
  pending: "sin confirmar",
  sent: "enviado",
  delivered: "entregado",
  read: "leído",
  failed: "no entregado",
};

/**
 * 032 — Lo mismo para el Vendedor, que no entra a Ajustes: lo arregla el
 * Propietario. Solo los motivos que dependen de Ajustes; los del contacto se
 * dicen igual.
 */
export const SKIP_REASON_LABEL_MEMBER: Partial<Record<BookingReminderSkipReason, string>> = {
  template_not_approved:
    "la plantilla ya no está aprobada; pídele al propietario que elija otra",
  template_missing: "no hay plantilla elegida; pídele al propietario que elija una",
  not_connected:
    "no hay número de WhatsApp conectado; pídele al propietario que lo conecte",
  reconnect_required: "pídele al propietario que vuelva a conectar el número de WhatsApp",
};

/** Para quién se escribe el texto (por defecto, el Propietario). */
export type ReminderAudience = { owner: boolean };

/** 1440 → «24 h»; 90 → «1 h 30 min»; 45 → «45 min». */
export function offsetLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest} min`;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/**
 * Hora corta en la zona del NEGOCIO («12 oct, 10:00»): la que devuelve
 * `GET /api/bookings` como `businessTimezone`. Sin zona o con una inválida,
 * cae a la del navegador.
 */
export function formatDue(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const opts: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  };
  try {
    return date.toLocaleString("es-MX", { ...opts, timeZone });
  } catch {
    return date.toLocaleString("es-MX", opts);
  }
}

/**
 * 032 — ¿Es un error técnico del proveedor (código, inglés, JSON)? Entonces
 * no se muestra tal cual. Lo ya escrito en español se respeta.
 */
export function isTechnicalError(text: string): boolean {
  const t = text.trim();
  if (/\(#\d+\)|oauth|exception|graph|https?:\/\/|^[{[]|\b[A-Z][A-Z_]{7,}\b/i.test(t)) {
    return true;
  }
  if (/[áéíóúñ¿¡]/i.test(t)) return false;
  return /\b(the|failed|failure|error|invalid|message|request|recipient|parameter|undeliverable|unknown|not)\b/i.test(
    t
  );
}

/** Error de envío legible: el `interrumpido` del rescate se explica. */
export function reminderErrorLabel(error: string | null): string {
  if (!error || !error.trim()) return "error desconocido";
  if (error === REMINDER_INTERRUPTED_ERROR) {
    return "el envío se interrumpió; puedes reintentarlo";
  }
  if (isTechnicalError(error)) return "WhatsApp no aceptó el mensaje";
  return error;
}

/** 032 — Por qué no llegó un mensaje enviado, en palabras llanas. */
export function deliveryErrorLabel(error: string | null | undefined): string | null {
  const t = error?.trim();
  if (!t) return null;
  return isTechnicalError(t) ? "WhatsApp no pudo entregarlo al cliente" : t;
}

export function skipReasonLabel(
  reason: BookingReminderSkipReason | null,
  audience: ReminderAudience = { owner: true }
): string {
  if (!reason) return "motivo desconocido";
  if (!audience.owner) {
    const member = SKIP_REASON_LABEL_MEMBER[reason];
    if (member) return member;
  }
  return SKIP_REASON_LABEL[reason] ?? reason;
}

/**
 * Texto y tono de un recordatorio, p. ej.
 * «Recordatorio 24 h: enviado · leído» o
 * «Recordatorio 2 h: pendiente (sale el 12 oct, 10:00)».
 */
export function describeReminder(
  r: BookingReminderDto,
  format: (iso: string) => string = formatDue,
  audience: ReminderAudience = { owner: true }
): { text: string; tone: ReminderTone } {
  const prefix = `Recordatorio ${offsetLabel(r.offsetMinutes)}`;
  switch (r.status) {
    case "pending":
      return { text: `${prefix}: pendiente (sale el ${format(r.dueAt)})`, tone: "secondary" };
    case "sending":
      return { text: `${prefix}: enviando…`, tone: "secondary" };
    case "sent": {
      if (r.delivery === "failed") {
        const plain = deliveryErrorLabel(r.deliveryError);
        const why = plain ? `: ${plain}` : "";
        return { text: `${prefix}: enviado · no entregado${why}`, tone: "destructive" };
      }
      const delivery =
        r.delivery && r.delivery !== "sent" && r.delivery !== "pending"
          ? ` · ${DELIVERY_LABEL[r.delivery]}`
          : "";
      return { text: `${prefix}: enviado${delivery}`, tone: "success" };
    }
    case "failed":
      return { text: `${prefix}: falló: ${reminderErrorLabel(r.error)}`, tone: "destructive" };
    case "skipped":
      return { text: `${prefix}: omitido: ${skipReasonLabel(r.reason, audience)}`, tone: "warning" };
    default:
      return { text: prefix, tone: "secondary" };
  }
}

/** Mensajes del reintento manual por código de error de la API. */
export const RETRY_ERROR_MESSAGE: Record<string, string> = {
  not_retryable: "Ese recordatorio ya no está fallido: otro reintento lo resolvió.",
  retry_exhausted: "Ya se usó el reintento de este recordatorio.",
  booking_not_active: "La cita ya no está agendada o está por empezar: no se reintenta.",
  not_found: "Ese recordatorio ya no existe.",
  not_implemented: "Disponible pronto: el reintento de recordatorios aún no está activo.",
};

/** `status` + cuerpo del POST de reintento → null si salió bien, o el mensaje. */
export function retryErrorMessage(status: number, body: unknown): string | null {
  if (status >= 200 && status < 300) return null;
  const err =
    body && typeof body === "object"
      ? ((body as { error?: { code?: unknown; message?: unknown } }).error ?? null)
      : null;
  const code = typeof err?.code === "string" ? err.code : null;
  if (status === 501) return RETRY_ERROR_MESSAGE.not_implemented!;
  if (code && RETRY_ERROR_MESSAGE[code]) return RETRY_ERROR_MESSAGE[code]!;
  if (typeof err?.message === "string" && err.message.trim()) return err.message;
  return "No se pudo reintentar el recordatorio.";
}
