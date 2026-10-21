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

/**
 * Presets del selector: N días locales que terminan HOY (`today` = solo hoy,
 * 021), o personalizado.
 */
export type ReportPreset = "today" | "7d" | "30d" | "90d" | "custom";
/** Días de cada preset fijo. */
export const REPORT_PRESET_DAYS = { today: 1, "7d": 7, "30d": 30, "90d": 90 } as const;
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
 * 024 — Conteos de un conjunto de citas (sesiones no prueba con
 * `scheduled_at` en el rango): la asistencia más el total y las agendadas.
 * El bloque `attendance` de Citas ya los trae (superconjunto compatible).
 */
export type BookingCountsDto = BookingAttendanceDto & {
  /** Citas del periodo en CUALQUIER estado («N agendadas» del Resumen). */
  total: number;
  /** De esas, las que siguen en estado `agendada` (por venir o sin marcar). */
  scheduled: number;
};

/** 024 — Rótulos de las filas sin dato. */
export const NO_APPOINTMENT_TYPE_LABEL = "Sin tipo";
export const NO_BOOKING_SELLER_LABEL = "Sin vendedor";
export const NO_ASSIGNEE_LABEL = "Sin asignar";

/**
 * 024 — Por tipo de cita: TODOS los tipos activos (también en cero), los
 * inactivos solo si tienen citas en el rango, y siempre «Sin tipo»
 * (`appointment_type_id` NULL: citas de la 015 o tipo borrado) al final.
 * Orden: `position`, nombre.
 */
export type BookingTypeRowDto = BookingCountsDto & {
  /** null = «Sin tipo». */
  typeId: string | null;
  name: string;
  active: boolean;
};
export type BookingsByTypeDto = { rows: BookingTypeRowDto[] };

/**
 * 024 — Por vendedor de la cita (`booking.assigned_user_id`): todos los
 * miembros (también en cero), quien tenga citas sin ser miembro ya y siempre
 * «Sin vendedor» al final. `bySource` = cómo se agendaron (de `total`).
 */
export type BookingSellerRowDto = BookingCountsDto & {
  /** null = «Sin vendedor». */
  userId: string | null;
  name: string;
  isMember: boolean;
  bySource: { manual: number; ai: number };
};
export type BookingsBySellerDto = { rows: BookingSellerRowDto[] };

/**
 * 024 — Citas → ventas: de las citas REALIZADAS del periodo, los leads
 * distintos (el de la cita o, si no lo guardó, el del contacto) y cuántos
 * están HOY en una etapa `won` («ganado al momento de generar el reporte»:
 * el ganado puede ser de otro periodo).
 */
export type BookingToSalesDto = {
  /** Citas realizadas del periodo. */
  bookingsDone: number;
  /** Leads distintos con cita realizada. */
  leads: number;
  /** Citas realizadas sin lead (ni en la cita ni en el contacto). */
  withoutLead: number;
  /** De `leads`, los que hoy están en `won`. */
  won: number;
  /** `won / leads`; null sin leads. */
  rate: number | null;
  wonAmount: WonAmountDto;
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
  /** 024 — Por tipo de cita. */
  byType: ReportBlock<BookingsByTypeDto>;
  /** 024 — Por vendedor de la cita. */
  bySeller: ReportBlock<BookingsBySellerDto>;
  /** 024 — Citas realizadas → leads hoy ganados. */
  toSales: ReportBlock<BookingToSalesDto>;
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
  | "web"
  | "promotor"
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

// ── Reportes → Ventas (021) ─────────────────────────────────────────────

/**
 * Semántica (plan 021 §3.1):
 *  - VENTA = lead que HOY está en una etapa `won`; su fecha es el
 *    `occurred_at` de su ÚLTIMO evento `to_stage_kind = 'won'` en
 *    `lead_stage_event` (D1), y cuenta en el periodo si esa fecha cae en el
 *    rango. Un ganado reabierto o perdido deja de ser venta: el reporte de un
 *    mes pasado puede cambiar si después se reabre uno de sus leads.
 *  - Un lead en `won` SIN evento `won` (anomalía) no entra a ningún periodo:
 *    se cuenta en `withoutDate`. No se usa `updated_at` (se mueve con
 *    cualquier edición).
 *  - PERDIDA = análogo con `lost`; motivo = `loss_reason` de ese evento.
 *  - ASESOR (D2) = quien movió el lead (`actor_user_id`); si fue el bot o el
 *    sistema, el asignado de la conversación real más reciente del contacto
 *    (por fecha de creación); si no hay, «Sin asesor».
 *  - Excluye el Laboratorio (contactos cuyas conversaciones son todas de
 *    prueba).
 */

/** Cifras de ventas de un rango. */
export type SalesFiguresDto = {
  /** Ventas del periodo (último evento `won` en el rango). */
  won: number;
  /** Perdidas del periodo (último evento `lost` en el rango). */
  lost: number;
  /** `won / (won + lost)`; null sin cierres. */
  closeRate: number | null;
  /** Monto de las ventas, por moneda (nunca sumadas). */
  wonAmount: WonAmountDto;
  /**
   * Monto principal / ventas con monto en la moneda principal, en centavos;
   * null si ninguna venta tiene monto en esa moneda.
   */
  averageTicketCents: number | null;
  /**
   * Cierres del periodo (ganadas + perdidas) cuya fecha la SEMBRÓ la
   * migración (`approximate = true`): cuentan, y la UI lo avisa.
   */
  approximateCount: number;
};

export type SalesSummaryDto = SalesFiguresDto & {
  /** Leads hoy en `won` sin ningún evento `won`: fuera de todo periodo. */
  withoutDate: number;
  /** El rango inmediatamente anterior, del mismo número de días. */
  previous: (SalesFiguresDto & { from: string; to: string }) | null;
};

export type SalesAdvisorRowDto = {
  /** null = «Sin asesor». */
  userId: string | null;
  /** `user.name` (o su email si no tiene); «Sin asesor» si `userId` es null. */
  name: string;
  won: number;
  lost: number;
  closeRate: number | null;
  wonAmount: WonAmountDto;
};

/** Orden: ventas desc, monto principal desc, nombre; «Sin asesor» al final. */
export type SalesByAdvisorDto = { rows: SalesAdvisorRowDto[] };

export type SalesLossReasonRowDto = {
  /** `LossReason`, o `"sin_motivo"` (perdidas sembradas sin motivo). */
  reason: string;
  /** Etiqueta en español (`LOSS_REASON_LABEL`). */
  label: string;
  count: number;
};

export type SalesLossReasonsDto = {
  /** Perdidas del periodo. */
  total: number;
  /** Orden: cantidad desc. */
  rows: SalesLossReasonRowDto[];
};

export type SalesFunnelStageDto = {
  stageId: string;
  name: string;
  kind: "open" | "won" | "lost";
  position: number;
  /** Leads (no Laboratorio) HOY en la etapa. */
  leads: number;
  /** Suma de sus montos en la moneda principal (sin moneda = la principal). */
  amountCents: number;
  /** Leads sin monto capturado. */
  leadsWithoutAmount: number;
  /** Leads con monto en otra moneda (no suman a `amountCents`). */
  leadsOtherCurrency: number;
};

/**
 * Embudo: FOTO ACTUAL por etapa (orden `position`); no depende del rango
 * («Estado al momento de generar el reporte»).
 */
export type SalesFunnelDto = {
  currency: string;
  stages: SalesFunnelStageDto[];
  totalLeads: number;
};

/**
 * Tiempo de cierre de las ventas del periodo = fecha de venta − llegada del
 * lead (primer anuncio de origen, o alta del lead). Las de fecha aproximada
 * (sembrada) NO entran a los tiempos; una llegada posterior a la venta cuenta
 * como 0 días.
 */
export type SalesTimeToCloseDto = {
  /** Ventas medidas (con fecha exacta). */
  sales: number;
  /** Ventas del periodo fuera de la medición por fecha aproximada. */
  excludedApproximate: number;
  /** Días; null sin ventas medidas. */
  p50Days: number | null;
  p75Days: number | null;
};

export type SalesDayRowDto = {
  /** Día local `YYYY-MM-DD`. */
  day: string;
  won: number;
  /** Monto en la moneda principal (las otras monedas van solo en el resumen). */
  amountCents: number;
};

/** Ventas por día local: una fila por cada día del rango, también en cero. */
export type SalesByDayDto = { currency: string; rows: SalesDayRowDto[] };

/**
 * 021b — Una fila de «Ventas por origen»: la FUENTE EFECTIVA del contacto (la
 * misma de Anuncios → Por fuente: la capturada manda; si no, la deducida),
 * con la regla de Ventas (D1) para ganadas y perdidas.
 */
export type SalesSourceRowDto = {
  value: AdSourceKey;
  /** `SOURCE_LABELS` («Sitio web», «Promotor», «Sin identificar»…). */
  label: string;
  won: number;
  lost: number;
  /** `won / (won + lost)`; null sin cierres. */
  closeRate: number | null;
  wonAmount: WonAmountDto;
};

/** Todas las fuentes en el orden fijo de Anuncios (también en cero). */
export type SalesBySourceDto = { rows: SalesSourceRowDto[] };

/** Respuesta 200 de `GET /api/reports/sales` (solo Propietario). */
export type SalesReportDto = {
  range: ReportRangeDto;
  summary: ReportBlock<SalesSummaryDto>;
  byAdvisor: ReportBlock<SalesByAdvisorDto>;
  lossReasons: ReportBlock<SalesLossReasonsDto>;
  funnel: ReportBlock<SalesFunnelDto>;
  timeToClose: ReportBlock<SalesTimeToCloseDto>;
  byDay: ReportBlock<SalesByDayDto>;
  /** 021b — Ventas por fuente efectiva del contacto. */
  bySource: ReportBlock<SalesBySourceDto>;
};

// ── Reportes → Resumen para dirección (021) ─────────────────────────────

/**
 * Semántica (plan 021 §3.2). Unidad = PERSONA = conversación real
 * (`is_test = false`) con ≥ 1 mensaje entrante en el rango.
 *  - Salientes que cuentan: las no fallidas (`status <> 'failed'`), igual que
 *    Agente. IA = `origin = 'ai'`; asesor = `operator` | `manual`;
 *    plantilla = `template`.
 *  - CONTESTADA = recibió un saliente posterior a su primer entrante del
 *    rango (aunque haya salido después del rango). ATENDIDA POR ASESOR = uno
 *    de esos salientes fue `operator` | `manual`.
 *  - PASADAS A ASESOR = conversaciones con un escalamiento (`opened`, sin
 *    `manual_reply`) en el rango, según la bitácora de escalamientos
 *    (`handoff_at` se limpia al devolverla a la IA).
 *  - Las TARJETAS de leads externos (011, `type = 'lead_intake'`) no son
 *    mensajes del cliente: no hacen persona ni son entrantes, y no arrancan
 *    el reloj del asesor; sí cuentan en PENDIENTES.
 *  - 021b — LEAD del rango = contacto que escribió O recibió una tarjeta en
 *    el rango; agrupado «Por origen» por su primer toque histórico (anuncio,
 *    sitio web, FastApp o sin origen). Ver plan 021 §6.
 */

export type SummaryAttentionFiguresDto = {
  /** Mensajes entrantes en el rango. */
  inbound: number;
  /** Salientes no fallidos en el rango (`ai + advisor + template`). */
  outbound: number;
  outboundByOrigin: { ai: number; advisor: number; template: number };
  /** Conversaciones reales con ≥ 1 entrante en el rango. */
  persons: number;
  /** De esas, las de un contacto creado en el rango. */
  newPersons: number;
  answered: number;
  /** `answered / persons`; null sin personas. */
  answeredRate: number | null;
  attendedByAdvisor: number;
  /** `attendedByAdvisor / persons`; null sin personas. */
  attendedByAdvisorRate: number | null;
  handedOff: number;
  /**
   * Tiempo hasta que atiende un asesor: por persona ATENDIDA POR ASESOR, desde
   * su primer entrante del rango hasta el primer saliente de asesor
   * (`operator` | `manual`, no fallido) posterior, aunque antes haya
   * contestado la IA. No es M4 de Agente (que solo mide al humano cuando
   * respondió antes que la IA). Segundos; null sin personas.
   */
  advisorFirstReply: { persons: number; p50Seconds: number | null; p90Seconds: number | null };
  /**
   * 021b — LEADS del rango: contactos (no Laboratorio) que en el rango
   * escribieron O recibieron una tarjeta de lead externo (011).
   */
  leads: number;
  /** 021b — «Leads nuevos»: de esos, los de un contacto creado en el rango. */
  newLeads: number;
};

export type SummaryAttentionDto = SummaryAttentionFiguresDto & {
  previous: (SummaryAttentionFiguresDto & { from: string; to: string }) | null;
};

/**
 * 021b — Columnas de una fila de «Por origen». Unidad = LEAD del rango
 * (contacto que escribió o recibió una tarjeta en el rango); su PRIMER TOQUE
 * del rango = su primer entrante o tarjeta del rango.
 */
export type SummaryOriginFiguresDto = {
  leads: number;
  /** Leads cuyo contacto se creó en el rango. */
  newLeads: number;
  /** Personas (conversaciones con un mensaje del cliente en el rango). */
  wrote: number;
  /** Mensajes del cliente en el rango (sin tarjetas). */
  inbound: number;
  /** Leads con un saliente no fallido posterior a su primer toque del rango. */
  contacted: number;
  /** Leads con un saliente de asesor (`operator` | `manual`) tras su primer toque. */
  attendedByAdvisor: number;
  /** Ventas del periodo (regla de Ventas) cuyo lead tiene este origen. */
  won: number;
  wonAmount: WonAmountDto;
};

export type SummaryAdOriginRowDto = SummaryOriginFiguresDto & {
  /** `source_id`, o el id de la fila de atribución si Meta no mandó ninguno. */
  key: string;
  sourceId: string | null;
  /** `"ad"` | `"post"` (null = anuncio). */
  sourceType: string | null;
  /** Ya resuelto con `titularDeOrigen`. */
  title: string;
};

/**
 * 021b — «Por origen» = el PRIMER TOQUE histórico del contacto (D1 de la
 * 020): el más antiguo entre su primer anuncio y su primera tarjeta de lead
 * externo (empate → el anuncio). La tarjeta da «Sitio web» o «FastApp» por su
 * cabecera.
 */
export type SummaryByOriginDto = {
  /**
   * Una fila por anuncio (`source_id`); un anuncio con ventas del periodo y
   * sin leads también sale; orden leads desc; ≤ `ADS_REPORT_MAX_ROWS`.
   */
  rows: SummaryAdOriginRowDto[];
  /** Anuncios distintos (puede pasar de las filas). */
  total: number;
  /** Primer toque = tarjeta del formulario del sitio web. */
  website: SummaryOriginFiguresDto;
  /** Primer toque = tarjeta de FastApp (promotores). */
  fastApp: SummaryOriginFiguresDto;
  /** «Sin origen identificado»: orgánico, clientes previos, IG/Messenger sin dato. */
  unidentified: SummaryOriginFiguresDto;
  /** Suma de TODOS los grupos (también los anuncios fuera del tope de filas). */
  totals: SummaryOriginFiguresDto;
};

/**
 * 021b — Leads externos de un origen (Sitio web o FastApp) cuya tarjeta llegó
 * en el rango. Unidad = contacto distinto; reloj desde su PRIMERA tarjeta
 * del rango de ese origen.
 */
export type SummaryExternalOriginDto = {
  origin: "website" | "fast_app";
  label: string;
  /** Contactos distintos con tarjeta de este origen en el rango. */
  received: number;
  /** Con un saliente no fallido (asesor, IA o plantilla) posterior a la tarjeta. */
  contacted: number;
  /** `received - contacted`, al momento de generar el reporte. */
  notContacted: number;
  /** El cliente escribió (entrante que no es tarjeta) después de la tarjeta. */
  replied: number;
  /** Tarjeta → primer saliente no fallido, en segundos; null sin contactados. */
  firstContact: { measured: number; p50Seconds: number | null; p90Seconds: number | null };
};

/** Siempre las dos filas (Sitio web, FastApp), también en cero. */
export type SummaryExternalLeadsDto = { rows: SummaryExternalOriginDto[] };

/** 021b — Rótulos de los orígenes externos (claves de `LEAD_INTAKE_HEADER`). */
export const LEAD_ORIGIN_LABEL: Record<SummaryExternalOriginDto["origin"], string> = {
  website: "Sitio web",
  fast_app: "FastApp (promotores)",
};

/** 021b — Fila de «Por origen» sin anuncio ni tarjeta. */
export const NO_ORIGIN_LABEL = "Sin origen identificado";

export type SummaryChannelRowDto = {
  channel: Channel;
  persons: number;
  inbound: number;
  answered: number;
  attendedByAdvisor: number;
};

/** WhatsApp siempre + los canales con personas, en orden fijo. */
export type SummaryByChannelDto = { rows: SummaryChannelRowDto[] };

/** Entrantes por hora local (0–23), sumando los días del rango: 24 filas. */
export type SummaryByHourDto = { rows: { hour: number; inbound: number }[] };

export type SummaryPendingRowDto = {
  conversationId: string;
  contactId: string;
  contactName: string | null;
  channel: Channel;
  /** Titular del primer anuncio del contacto; null sin anuncio. */
  adTitle: string | null;
  /** Llegada del último entrante sin respuesta, ISO-8601 UTC. */
  lastInboundAt: string;
};

/**
 * Personas del rango cuyo último mensaje es ENTRANTE: no tienen saliente (no
 * fallido) posterior a su último entrante, al momento de generar. La que más
 * lleva esperando primero; como mucho `SUMMARY_PENDING_MAX_ROWS`.
 */
export type SummaryPendingDto = { total: number; rows: SummaryPendingRowDto[] };

/** Filas máximas de «Pendientes de respuesta». */
export const SUMMARY_PENDING_MAX_ROWS = 20;

/** Respuesta 200 de `GET /api/reports/summary` (solo Propietario). */
export type SummaryReportDto = {
  range: ReportRangeDto;
  /**
   * 021b — ¿Esta instancia recibe leads externos (bandera `LEADS_EXTERNOS`)?
   * Apagada y sin datos, la UI no menciona el formulario ni FastApp.
   */
  intakeEnabled: boolean;
  attention: ReportBlock<SummaryAttentionDto>;
  /** 021b — antes `byAd` («Por anuncio»). */
  byOrigin: ReportBlock<SummaryByOriginDto>;
  /** 021b — «Leads del formulario y FastApp». */
  external: ReportBlock<SummaryExternalLeadsDto>;
  byChannel: ReportBlock<SummaryByChannelDto>;
  byHour: ReportBlock<SummaryByHourDto>;
  pending: ReportBlock<SummaryPendingDto>;
  /** El mismo resumen que Ventas (con periodo anterior). */
  sales: ReportBlock<SalesSummaryDto>;
  /** El mismo bloque de Agente (M4, por sesión de 24 h). */
  responseTimes: ReportBlock<ResponseTimesDto>;
  /** 024 — ¿Esta instancia tiene agenda (bandera `AGENDA`)? */
  agendaEnabled: boolean;
  /** 024 — «Equipo»: por vendedor. */
  team: ReportBlock<SummaryTeamDto>;
  /** 024 — Citas del periodo (la misma consulta que Citas → asistencia); null sin AGENDA. */
  bookings: ReportBlock<BookingCountsDto> | null;
};

/**
 * 024 — Una fila de «Equipo». Cartera = responsable VIGENTE de la
 * conversación («según la asignación actual»); ventas por la regla D2 de
 * Ventas; citas por el vendedor de la cita.
 */
export type SummaryTeamFiguresDto = {
  /** Conversaciones de su cartera con `assigned_at` en el rango. */
  assignedInRange: number;
  /** Pendientes de su cartera (la regla de «Pendientes de respuesta»). */
  pending: number;
  /** Personas de su cartera atendidas por asesor (CRM o teléfono compartido). */
  attended: number;
  /** Citas realizadas del periodo; null sin AGENDA. */
  bookingsDone: number | null;
  /** Ventas del periodo (D1 + D2). */
  won: number;
  /** Monto de esas ventas en la moneda principal (las otras no se suman). */
  wonAmountCents: number;
};

export type SummaryTeamRowDto = SummaryTeamFiguresDto & {
  /** null = «Sin asignar» (sin responsable, sin asesor D2 o sin vendedor). */
  userId: string | null;
  name: string;
};

/** Filas máximas de vendedores en «Equipo» (el resto va en «Otros»). */
export const SUMMARY_TEAM_MAX_ROWS = 10;

export type SummaryTeamDto = {
  currency: string;
  /**
   * Vendedores (miembros, también en cero, y ex-miembros con datos), orden
   * ventas, monto, pendientes, atendidas, nombre; ≤ `SUMMARY_TEAM_MAX_ROWS`.
   */
  rows: SummaryTeamRowDto[];
  /** Los vendedores que no caben, sumados; null si caben todos. */
  others: (SummaryTeamFiguresDto & { sellers: number }) | null;
  /** «Sin asignar», siempre (aunque sea cero). */
  unassigned: SummaryTeamRowDto;
  /**
   * Suma de TODO (vendedores + Sin asignar): pendientes y atendidas = los del
   * Resumen; ventas = las de Ventas del periodo.
   */
  totals: SummaryTeamFiguresDto;
  /**
   * El vendedor (no «Sin asignar») con más pendientes, de entre TODOS, para
   * la viñeta de «Lectura rápida»; null si nadie tiene. La UI decide el umbral.
   */
  topPending: { userId: string; name: string; pending: number; ofTotal: number } | null;
};

// ── Reportes → Vendedores (024) ─────────────────────────────────────────

/**
 * Semántica (plan 024 §3). VENDEDORES = todos los miembros de la organización
 * (vendedores y propietarios), aunque estén en cero, más quien aparezca con
 * datos sin ser miembro ya (ex-miembro), más «Sin asignar». CARTERA = las
 * conversaciones reales cuyo responsable VIGENTE es él («según la asignación
 * actual»). La respuesta humana pudo salir del CRM o del teléfono compartido:
 * no se atribuye a una persona. Laboratorio fuera. Cada bloque trae sus filas
 * con `userId` (null = sin responsable): la UI las une por `userId`, con la
 * lista de `roster` como columna vertebral.
 */

export type SellerRosterFiguresDto = {
  /** Conversaciones reales asignadas hoy (foto). */
  portfolio: number;
  /** De su cartera, con `assigned_at` en el rango. */
  assignedInRange: number;
  /** De su cartera, no archivadas y con el lead en etapa `open` (foto). */
  activePortfolio: number;
  /** Personas del rango (regla del Resumen) de su cartera. */
  persons: number;
  /** De esas, atendidas por asesor (`operator` | `manual`). */
  attended: number;
  /** `attended / persons`; null sin personas. */
  attendedRate: number | null;
  /** Pendientes (regla del Resumen, con tarjetas 011) de su cartera (foto). */
  pending: number;
  /**
   * Leads externos (tarjetas del rango, por contacto y origen) de su cartera
   * todavía sin contactar; misma regla que «Leads del formulario y FastApp».
   */
  externalNotContacted: number;
};

export type SellerRosterRowDto = SellerRosterFiguresDto & {
  /** null = «Sin asignar». */
  userId: string | null;
  /** `user.name`, si no el email; «Sin asignar» si `userId` es null. */
  name: string;
  /** Rol de la membresía (`owner` | `member`); null si ya no es miembro. */
  role: string | null;
  isMember: boolean;
  /** `advisorFirstReply` del Resumen restringido a su cartera. Segundos. */
  advisorFirstReply: { persons: number; p50Seconds: number | null; p90Seconds: number | null };
};

export type SellersRosterDto = {
  /** Miembros por nombre, luego ex-miembros, «Sin asignar» siempre al final. */
  rows: SellerRosterRowDto[];
  /** Suma de las filas: personas/atendidas/pendientes = totales del Resumen. */
  totals: SellerRosterFiguresDto;
};

/** Ventas → Por asesor (D1 + D2) con el ticket promedio. */
export type SellerSalesRowDto = SalesAdvisorRowDto & {
  /** Monto principal ÷ ventas con monto en la moneda principal; null si ninguna. */
  averageTicketCents: number | null;
};

/** Las filas de Ventas → Por asesor tal cual (solo quien tiene cierres; «Sin asesor» al final). */
export type SellersSalesDto = { rows: SellerSalesRowDto[] };

export type SellerFunnelCellDto = {
  stageId: string;
  leads: number;
  /** Monto en la moneda principal (sin moneda = la principal). */
  amountCents: number;
};

export type SellerFunnelRowDto = {
  /** null = «Sin asignar» (sin conversación real asignada). */
  userId: string | null;
  name: string;
  /** Una celda por etapa, en el orden de `stages`. */
  cells: SellerFunnelCellDto[];
  /** Leads en etapas `open` y su monto (moneda principal). */
  openLeads: number;
  openAmountCents: number;
};

/**
 * Embudo de la cartera: FOTO ACTUAL, vendedor × etapa (responsable vigente
 * de la conversación real del contacto). Solo filas con leads.
 */
export type SellersFunnelDto = {
  currency: string;
  /** Las etapas del Embudo de Ventas (mismo orden y totales). */
  stages: SalesFunnelStageDto[];
  rows: SellerFunnelRowDto[];
};

/** Respuesta 200 de `GET /api/reports/sellers` (solo Propietario). */
export type SellersReportDto = {
  range: ReportRangeDto;
  /** ¿Bandera `AGENDA`? Apagada: sin bloque de citas. */
  agendaEnabled: boolean;
  roster: ReportBlock<SellersRosterDto>;
  sales: ReportBlock<SellersSalesDto>;
  /** Citas por vendedor de la cita (Citas → Por vendedor); null sin AGENDA. */
  bookings: ReportBlock<BookingsBySellerDto> | null;
  funnel: ReportBlock<SellersFunnelDto>;
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
