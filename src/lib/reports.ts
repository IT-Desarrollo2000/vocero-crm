/**
 * 02 — Reportes: contrato de `GET /api/reports/agent` compartido
 * cliente/servidor (dev-tasks/02-metricas-del-agente.md, "Contrato 05/02-0").
 *
 * Fuente canónica del DTO: los componentes de `src/components/reports/` lo
 * importan de aquí. Sin dependencias de servidor (solo `import type`): el
 * bundle del cliente no arrastra el esquema.
 *
 * Cada bloque viaja por separado: uno que falla llega como `{ ok: false }` y
 * la pantalla pinta «No disponible» solo en esa tarjeta. Proporciones de 0 a
 * 1; `null` cuando el denominador es 0 (la UI pinta «—», nunca NaN ni 0 %).
 */

import type { Channel } from "@/lib/channels";
import type { HANDOFF_REASONS } from "@/lib/db/schema";

export type HandoffReason = (typeof HANDOFF_REASONS)[number];

// ── Rango ────────────────────────────────────────────────────────────────

/** Presets del selector: N días locales que terminan HOY, o personalizado. */
export type ReportPreset = "7d" | "30d" | "90d" | "custom";
/** Días de cada preset fijo. */
export const REPORT_PRESET_DAYS = { "7d": 7, "30d": 30, "90d": 90 } as const;
/** Sin parámetros → 30 días (RF-02-01). */
export const REPORT_DEFAULT_PRESET: Exclude<ReportPreset, "custom"> = "30d";
/** Tope del rango personalizado, en días (`to` inclusive). */
export const REPORT_MAX_DAYS = 366;

/** Rango efectivamente usado (RF-02-04: zona y límites UTC). No es bloque. */
export type ReportRangeDto = {
  preset: ReportPreset;
  /** Primer día local incluido, `YYYY-MM-DD`. */
  from: string;
  /** Último día local incluido, `YYYY-MM-DD` (inclusive). */
  to: string;
  /** Días locales del rango, en orden (`YYYY-MM-DD`; 90 en el preset 90d). */
  days: string[];
  /** Zona horaria del negocio (IANA), p. ej. `America/Mexico_City` (D-02-2). */
  tz: string;
  /** Límites UTC usados por las consultas (`[fromUtc, toUtc)`), ISO-8601. */
  fromUtc: string;
  toUtc: string;
};

// ── Bloques ──────────────────────────────────────────────────────────────

/**
 * Motivo de un bloque no disponible. Hoy: `"timeout"` (superó el tope por
 * consulta) o `"unavailable"` (cualquier otro fallo; el detalle va al log).
 */
export type ReportBlockError = "timeout" | "unavailable";

export type ReportBlock<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** M1 + M2 — conversaciones activas y reparto de atención. */
export type AttentionDto = {
  /** M1: conversaciones con ≥ 1 entrante en el rango. */
  active: number;
  aiOnly: number;
  aiAndHuman: number;
  humanOnly: number;
  /** Sin ningún saliente no fallido en el rango. */
  noReply: number;
  /** `aiOnly / active`, 0..1; `null` si no hay activas. */
  aiOnlyRate: number | null;
};

export type EscalationSampleDto = {
  conversationId: string;
  contactId: string;
  contactName: string | null;
  note: string | null;
  /** Hora del evento, ISO-8601 UTC. */
  occurredAt: string;
};

export type EscalationReasonDto = {
  /** Motivo del catálogo (`HandoffReason`); `"sin_motivo"` en filas sembradas sin él. */
  reason: string;
  /** Etiqueta en español (`src/lib/handoff-labels.ts`). */
  label: string;
  count: number;
  /** Hasta 5 notas recientes del motivo (solo eventos con nota). */
  samples: EscalationSampleDto[];
};

/** M3 — escalamientos por motivo (SIN `manual_reply`, ver Contrato 05/02-0). */
export type EscalationsDto = {
  /** Suma de `byReason[].count` (incluye aproximados). */
  total: number;
  /** Orden: cantidad desc. */
  byReason: EscalationReasonDto[];
  /** «Pausas por respuesta manual» (`reason = 'manual_reply'`): línea aparte. */
  manualReplyPauses: number;
  /** ¿Entran en el rango filas sembradas por la migración 0017? */
  approximate: boolean;
  /**
   * Desde cuándo el registro es exacto (ISO-8601). Hoy el servidor no lo
   * conoce (la siembra no guarda la fecha de la migración) y lo omite.
   */
  exactSince?: string | null;
};

export type ResponderTimesDto = {
  sessions: number;
  /** Segundos; `null` sin sesiones. */
  p50Seconds: number | null;
  p90Seconds: number | null;
};

/** M4 — tiempo a primera respuesta por sesión. */
export type ResponseTimesDto = {
  /** Primera respuesta de la IA (incluye el cerebro externo de /api/bot). */
  ai: ResponderTimesDto;
  /** Primera respuesta humana (operador, teléfono o plantilla). */
  human: ResponderTimesDto;
  /** Sesiones sin respuesta. */
  unanswered: number;
};

/** M5 — tiempo humano tras escalamiento (solo eventos exactos, sin manual_reply). */
export type AfterHandoffDto = {
  /** Escalamientos con saliente humano posterior. */
  attended: number;
  /** Escalamientos sin saliente humano posterior (todavía). */
  unattended: number;
  /** Segundos, sobre los atendidos; `null` si no hay. */
  p50Seconds: number | null;
  p90Seconds: number | null;
};

export type FailureSliceDto = { total: number; failed: number };

/** M6 — salientes fallidas. */
export type FailuresDto = {
  total: number;
  failed: number;
  /** `failed / total`, 0..1; `null` sin salientes. */
  rate: number | null;
  /** Por origen (`ai` | `operator` | `manual` | `template`). */
  byOrigin: (FailureSliceDto & { origin: string })[];
  byChannel: (FailureSliceDto & { channel: Channel })[];
  /** Top 5 de `message.error`. */
  topErrors: { error: string; count: number }[];
};

/** M7 — entrega y lectura (canales con acuses; sin `manual`; sin los últimos 15 min). */
export type DeliveryDto = {
  /** Canales que cuentan (los de `deliveryReceipts = true`; hoy solo WhatsApp). */
  channels: Channel[];
  /** sent + delivered + read + failed. */
  base: number;
  /** delivered + read. */
  delivered: number;
  read: number;
  /** Salientes `pending`: ni entregadas ni fallidas. */
  unconfirmed: number;
  /** `delivered / base`, 0..1 o `null`. */
  deliveryRate: number | null;
  /** `read / delivered`, 0..1 o `null` — cota inferior. */
  readRate: number | null;
};

export type VolumeRowDto = {
  /** Día local `YYYY-MM-DD`. */
  day: string;
  channel: Channel;
  inbound: number;
  outbound: number;
};

/**
 * M8 — volumen por día local × canal. Una fila por cada día del rango ×
 * cada canal presente (WhatsApp siempre), también en cero (RF-02-07).
 */
export type VolumeDto = { rows: VolumeRowDto[] };

/** Respuesta 200 de `GET /api/reports/agent`. */
export type AgentReportDto = {
  range: ReportRangeDto;
  attention: ReportBlock<AttentionDto>;
  escalations: ReportBlock<EscalationsDto>;
  responseTimes: ReportBlock<ResponseTimesDto>;
  /** Siempre presente hoy (V2); opcional en el tipo por compatibilidad. */
  afterHandoff?: ReportBlock<AfterHandoffDto>;
  failures: ReportBlock<FailuresDto>;
  delivery: ReportBlock<DeliveryDto>;
  volume: ReportBlock<VolumeDto>;
};

// ── Reportes → Citas (tarea 10, «Contrato 10-0») ────────────────────────

/**
 * Oferta → cita (RF-10-15). Conversaciones REALES (no `is_test`) con ≥ 1
 * ronda en `agenda_offer_log` dentro del rango; convertidas = las que tienen
 * una cita `source='ai'` (no prueba) creada DESPUÉS de su primera oferta del
 * rango.
 */
export type OfferConversionDto = {
  conversationsWithOffer: number;
  converted: number;
  /** `converted / conversationsWithOffer`; null sin ofertas. */
  rate: number | null;
  /** Rondas registradas en el rango (informativo). */
  offerRounds: number;
  /**
   * Primera fila de `agenda_offer_log` de la organización (ISO-8601), o null
   * si no hay ninguna: la UI avisa que antes de la migración 0018 no hay
   * datos de oferta.
   */
  dataSince: string | null;
};

/** Asistencia de un conjunto de citas `session` no prueba. */
export type AttendanceSliceDto = {
  realizada: number;
  noShow: number;
  /** `realizada / (realizada + noShow)`; null si ninguna está marcada. */
  rate: number | null;
};

/** Cita → asistencia, por `scheduled_at` en el rango. */
export type BookingAttendanceDto = AttendanceSliceDto & {
  /** `agendada` con `scheduled_at < now`: aún sin marcar (aparte). */
  pendingToMark: number;
  cancelada: number;
};

/**
 * Asistencia con vs sin recordatorio: «con» = la cita tiene ≥ 1
 * `booking_reminder` `sent` para su hora vigente (`scheduled_for =
 * scheduled_at`); «sin» = el resto.
 */
export type AttendanceByReminderDto = {
  withReminder: AttendanceSliceDto;
  withoutReminder: AttendanceSliceDto;
};

/** Respuesta 200 de `GET /api/reports/bookings` (solo Propietario, AGENDA). */
export type BookingReportDto = {
  range: ReportRangeDto;
  offers: ReportBlock<OfferConversionDto>;
  attendance: ReportBlock<BookingAttendanceDto>;
  byReminder: ReportBlock<AttendanceByReminderDto>;
};

// ── Reportes → Anuncios (020 fase B) ────────────────────────────────────

/**
 * Semántica (plan 020 §8.5), la misma en los tres bloques:
 *  - Un LEAD (uno por contacto) entra al rango en su FECHA DE LLEGADA: la de su
 *    PRIMER anuncio de origen si llegó por uno (D1), o la de alta del lead si
 *    no. Un contacto viejo que vuelve hoy por un anuncio cuenta para ese
 *    anuncio hoy.
 *  - GANADO = de esos leads, los que HOY están en una etapa `won`. Un ganado
 *    que luego se movió fuera fue una corrección y deja de contar.
 *  - MONTO = suma de `amount_cents` de los ganados, por moneda (sin moneda =
 *    la del negocio). Nunca se suman monedas distintas. Un ganado sin monto
 *    cuenta como venta pero no suma.
 *  - CONVERSACIONES = conversaciones reales creadas en el rango.
 *  - FUENTE = la efectiva del contacto (`effectiveSource`): la capturada
 *    manda; si no, la deducida por su primer origen.
 *  - Excluye el Laboratorio (conversaciones `is_test` y contactos cuya única
 *    conversación es de prueba).
 */

/** Monto ganado de un conjunto de leads. */
export type WonAmountDto = {
  /** Moneda principal: la del negocio (Ajustes → Marca). */
  currency: string;
  /** Suma en la moneda principal, en centavos. */
  amountCents: number;
  /** Ganados con monto en OTRA moneda: aparte, nunca sumados a la principal. */
  otherCurrencies: { currency: string; amountCents: number; won: number }[];
  /** Ganados sin monto capturado (cuentan como venta, no suman). */
  wonWithoutAmount: number;
};

export type AdSourceKey =
  | "anuncio"
  | "organico"
  | "referido"
  | "conocido"
  | "otro"
  | "desconocida";

export type AdsSourceRowDto = {
  value: AdSourceKey;
  label: string;
  conversations: number;
  leads: number;
  won: number;
  /** `won / leads`; null sin leads. */
  winRate: number | null;
  wonAmount: WonAmountDto;
};

/** Cifras del resumen de un rango. */
export type AdsSummaryFiguresDto = {
  conversations: number;
  /** Conversaciones cuya fuente efectiva es «Anuncio». */
  adConversations: number;
  /** `adConversations / conversations`; null sin conversaciones. */
  adShare: number | null;
  adLeads: number;
  adWon: number;
  adWonAmount: WonAmountDto;
};

export type AdsSummaryDto = AdsSummaryFiguresDto & {
  /** El rango inmediatamente anterior, del mismo número de días. */
  previous: (AdsSummaryFiguresDto & { from: string; to: string }) | null;
};

export type AdsBySourceDto = { rows: AdsSourceRowDto[] };

export type AdRowDto = {
  /** `source_id`, o el id de la fila de atribución si Meta no mandó ninguno. */
  key: string;
  sourceId: string | null;
  /** `"ad"` | `"post"` (null = anuncio). */
  sourceType: string | null;
  /** Ya resuelto con `titularDeOrigen`. */
  title: string;
  mediaType: string | null;
  /** `/api/media/<id>` o null. */
  imageUrl: string | null;
  leads: number;
  won: number;
  winRate: number | null;
  wonAmount: WonAmountDto;
};

export type AdsByAdDto = {
  /** Ordenadas por leads; como mucho `ADS_REPORT_MAX_ROWS`. */
  rows: AdRowDto[];
  /** Anuncios/publicaciones distintos en el rango (puede pasar de las filas). */
  total: number;
};

/** Filas máximas de la tabla por anuncio. */
export const ADS_REPORT_MAX_ROWS = 50;

/** Respuesta 200 de `GET /api/reports/ads` (solo Propietario). */
export type AdsReportDto = {
  range: ReportRangeDto;
  summary: ReportBlock<AdsSummaryDto>;
  bySource: ReportBlock<AdsBySourceDto>;
  byAd: ReportBlock<AdsByAdDto>;
};

/** Mensaje del 503 `report_timeout` (RF-02-08). */
export const REPORT_TIMEOUT_MESSAGE = "Prueba un rango más corto";

// ── Utilidades de formato ────────────────────────────────────────────────

/** Proporción segura: denominador 0 → null (la UI pinta «—», nunca NaN). */
export function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator <= 0) return null;
  return numerator / denominator;
}

/** `0.25` → «25 %»; null → «—». Hasta un decimal si no es entero. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const pct = Math.round(value * 1000) / 10;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1)} %`;
}

/**
 * Duración legible: «4 s», «12 min», «1 h 5 min», «2 d 3 h»; null → «—».
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const totalMin = Math.round(s / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const totalH = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (totalH < 24) return min ? `${totalH} h ${min} min` : `${totalH} h`;
  const d = Math.floor(totalH / 24);
  const h = totalH % 24;
  return h ? `${d} d ${h} h` : `${d} d`;
}
