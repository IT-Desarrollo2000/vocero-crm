/**
 * 02 — DTO que la pantalla de Reportes → Agente espera de
 * `GET /api/reports/agent`.
 *
 * PROVISIONAL: el contrato canónico vive en `src/lib/reports.ts`, que crea el
 * paso 02-A (servidor). Mientras no exista, la UI declara aquí lo que espera
 * según dev-tasks/02 (M1–M8) para poder trabajar en paralelo; al integrar se
 * reemplaza este archivo por un re-export de `@/lib/reports`.
 *
 * Cada bloque viaja por separado (`Promise.allSettled` en el servidor): uno
 * que falla llega como `{ ok: false }` y la pantalla pinta "No disponible"
 * solo en esa tarjeta.
 */

import type { Channel } from "@/lib/channels";

export type ReportBlock<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export type ReportPreset = "7d" | "30d" | "90d" | "custom";

export type ReportRangeDto = {
  preset: ReportPreset;
  /** Primer día local incluido, `YYYY-MM-DD`. */
  from: string;
  /** Último día local incluido, `YYYY-MM-DD` (inclusive). */
  to: string;
  /** Días locales del rango, en orden (`YYYY-MM-DD`). */
  days: string[];
  /** Zona horaria del negocio (IANA), p. ej. `America/Mexico_City`. */
  tz: string;
  /** Límites UTC usados por las consultas (`[fromUtc, toUtc)`), ISO-8601. */
  fromUtc: string;
  toUtc: string;
};

/** M1 + M2 — conversaciones activas y reparto de atención. */
export type AttentionDto = {
  active: number;
  aiOnly: number;
  aiAndHuman: number;
  humanOnly: number;
  noReply: number;
  /** `aiOnly / active`, 0..1; `null` si no hay activas. */
  aiOnlyRate: number | null;
};

export type EscalationSampleDto = {
  conversationId: string;
  contactId: string;
  contactName: string | null;
  note: string | null;
  /** ISO-8601. */
  occurredAt: string;
};

export type EscalationReasonDto = {
  reason: string;
  label: string;
  count: number;
  /** Hasta 5 notas recientes del motivo. */
  samples: EscalationSampleDto[];
};

/** M3 — escalamientos por motivo (sin `manual_reply`, ver Contrato 05/02-0). */
export type EscalationsDto = {
  total: number;
  byReason: EscalationReasonDto[];
  /** Pausas por respuesta manual (`reason = 'manual_reply'`): línea aparte. */
  manualReplyPauses: number;
  /** ¿Entran en el rango filas sembradas por la migración 0017? */
  approximate: boolean;
  /**
   * Desde cuándo el registro es exacto (ISO-8601; fecha de la migración
   * 0017). Opcional: sin ella el aviso no da fecha.
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
  ai: ResponderTimesDto;
  human: ResponderTimesDto;
  /** Sesiones sin respuesta. */
  unanswered: number;
};

/** M5 — tiempo humano tras escalamiento (solo eventos exactos). */
export type AfterHandoffDto = {
  attended: number;
  unattended: number;
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
  byOrigin: (FailureSliceDto & { origin: string })[];
  byChannel: (FailureSliceDto & { channel: Channel })[];
  topErrors: { error: string; count: number }[];
};

/** M7 — entrega y lectura (solo canales con acuse de entrega). */
export type DeliveryDto = {
  /** Canales que cuentan (los de `deliveryReceipts = true`). */
  channels: Channel[];
  base: number;
  delivered: number;
  read: number;
  /** Salientes `pending`: ni entregadas ni fallidas. */
  unconfirmed: number;
  /** 0..1 o `null`. */
  deliveryRate: number | null;
  readRate: number | null;
};

export type VolumeRowDto = {
  /** Día local `YYYY-MM-DD`. */
  day: string;
  channel: Channel;
  inbound: number;
  outbound: number;
};

/** M8 — volumen por día local × canal. */
export type VolumeDto = { rows: VolumeRowDto[] };

export type AgentReportDto = {
  range: ReportRangeDto;
  attention: ReportBlock<AttentionDto>;
  escalations: ReportBlock<EscalationsDto>;
  responseTimes: ReportBlock<ResponseTimesDto>;
  afterHandoff?: ReportBlock<AfterHandoffDto>;
  failures: ReportBlock<FailuresDto>;
  delivery: ReportBlock<DeliveryDto>;
  volume: ReportBlock<VolumeDto>;
};
