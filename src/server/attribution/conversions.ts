import { and, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { sendBusinessMessagingEvent } from "@/lib/meta/capi";
import { getCredentialsByOrg } from "@/server/whatsapp/credentials";
import { atribucionEnabled } from "@/server/attribution/flag";
import { getCapiSettings } from "@/server/attribution/settings";
import { getAttributionForConversation } from "@/server/attribution/store";

/**
 * 016 — Reporte de conversiones a Meta.
 *
 * Tres reglas duras, y ninguna es opcional:
 *
 * 1. **Dedup en la base**, no en el código: la fila se inserta ANTES de hablar
 *    con Meta, con `ON CONFLICT DO NOTHING` sobre (org, conversación, evento).
 *    A Meta no se le puede des-enviar una compra.
 * 2. **Best-effort absoluto**: nada de lo que pase aquí —Meta caído, token
 *    vencido, dataset sin configurar— puede impedir que el lead se mueva de
 *    etapa. Se registra el desenlace y se sigue.
 * 3. **Todo intento deja rastro**: `sent`, `failed` o `skipped` con el motivo
 *    escrito. Las filas `skipped` son la respuesta a "¿por qué este lead no
 *    aparece en Meta?", que sin ellas se contesta adivinando.
 *
 * Y un corolario de la 1: reintentar NO inserta otra fila. Reusa la misma (y
 * con ella el mismo `event_id` que viaja a Meta), así que un intento que sí
 * llegó aunque aquí se viera fallar se deduplica del lado de Meta.
 */

/** Los dos eventos que Vocero emite (nombres del catálogo de Meta, tal cual). */
export const QUALIFIED_EVENT = "QualifiedLead";
export const PURCHASE_EVENT = "Purchase";

/** Definitivo: el clic se captura en la ingesta y no aparece después. */
export const NO_CLID_REASON =
  "sin ctwa_clid: la conversación no vino de un anuncio de WhatsApp";
/** Reintentable: el dueño puede conectar el dataset (o WhatsApp) después. */
export const NOT_CONFIGURED_REASON =
  "atribución no configurada: falta el dataset de Meta o la conexión de WhatsApp";
/**
 * Reintentable: Meta exige `value` en un `Purchase`, así que una venta ganada
 * sin monto se retiene en vez de mandarse incompleta. Al capturar el monto de
 * un lead que ya está ganado, esta misma fila se emite sola.
 */
export const NO_AMOUNT_REASON =
  "sin monto: la venta se reporta cuando se capture el monto del trato";

/**
 * Motivos de `skipped` que SÍ se pueden reintentar: los que dependen de algo
 * que el negocio puede completar después. `NO_CLID_REASON` queda fuera a
 * propósito — reintentarlo daría siempre el mismo resultado.
 */
export const RETRYABLE_SKIP_REASONS: readonly string[] = [
  NOT_CONFIGURED_REASON,
  NO_AMOUNT_REASON,
];

/**
 * Eventos que este módulo sabe reconstruir. `custom_data` no se guarda en la
 * fila, así que reintentar un evento propio de un fork no sabría qué mandar:
 * ese fork tendría que reemitirlo por su cuenta.
 */
const RETRYABLE_EVENTS: readonly string[] = [QUALIFIED_EVENT, PURCHASE_EVENT];

/** Tope de "reintentar todas": cada una es una llamada a Meta en serie. */
export const RETRY_ALL_MAX = 50;

type ConversionStatus = "pending" | "sent" | "failed" | "skipped";
type DeliverOutcome = "sent" | "failed" | "skipped";
type EmitOutcome = DeliverOutcome | "dedup" | "error";

/**
 * ¿Esta fila se puede volver a intentar? `failed` siempre (Meta caído, token
 * vencido…); `skipped` solo por un motivo de `RETRYABLE_SKIP_REASONS`.
 * `sent` jamás (a Meta no se le manda dos veces) y `pending` tampoco: hay un
 * envío en curso.
 */
export function isRetryableConversion(row: {
  eventName: string;
  status: ConversionStatus;
  error: string | null;
}): boolean {
  if (!RETRYABLE_EVENTS.includes(row.eventName)) return false;
  if (row.status === "failed") return true;
  return (
    row.status === "skipped" &&
    row.error !== null &&
    RETRYABLE_SKIP_REASONS.includes(row.error)
  );
}

function hasPurchaseValue(customData?: Record<string, unknown>): boolean {
  const value = customData?.value;
  return typeof value === "number" && value > 0;
}

/**
 * Intenta UNA fila ya existente: decide si se omite, la manda y deja escrito el
 * desenlace. La comparten la emisión normal y el reintento para que ambos
 * caminos registren exactamente lo mismo.
 */
async function deliverConversion(input: {
  eventRowId: string;
  organizationId: string;
  conversationId: string;
  eventName: string;
  customData?: Record<string, unknown>;
}): Promise<DeliverOutcome> {
  const db = getDb();
  const attribution = await getAttributionForConversation(
    input.organizationId,
    input.conversationId
  );
  const settings = await getCapiSettings(input.organizationId);
  const credentials = await getCredentialsByOrg(input.organizationId);

  // Orden de los motivos: del más definitivo al que el dueño completa último.
  const skipReason = !attribution?.ctwaClid
    ? NO_CLID_REASON
    : !settings || !credentials
      ? NOT_CONFIGURED_REASON
      : input.eventName === PURCHASE_EVENT && !hasPurchaseValue(input.customData)
        ? NO_AMOUNT_REASON
        : null;

  if (skipReason || !attribution?.ctwaClid || !settings || !credentials) {
    await db
      .update(schema.conversionEvent)
      .set({
        status: "skipped",
        attributionId: attribution?.id ?? null,
        error: skipReason ?? NOT_CONFIGURED_REASON,
      })
      .where(eq(schema.conversionEvent.id, input.eventRowId));
    return "skipped";
  }

  try {
    const ack = await sendBusinessMessagingEvent({
      datasetId: settings.datasetId,
      token: settings.token,
      event: {
        eventName: input.eventName,
        eventId: input.eventRowId,
        eventTime: Math.floor(Date.now() / 1000),
        ctwaClid: attribution.ctwaClid,
        wabaId: credentials.wabaId,
        customData: input.customData,
      },
    });
    await db
      .update(schema.conversionEvent)
      .set({
        status: "sent",
        attributionId: attribution.id,
        sentAt: new Date(),
        fbTraceId: ack.fbTraceId,
        error: null,
      })
      .where(eq(schema.conversionEvent.id, input.eventRowId));
    return "sent";
  } catch (err) {
    await db
      .update(schema.conversionEvent)
      .set({
        status: "failed",
        attributionId: attribution.id,
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(schema.conversionEvent.id, input.eventRowId));
    console.warn(
      `[capi] fallo al reportar ${input.eventName} de ${input.conversationId}: ${err}`
    );
    return "failed";
  }
}

/**
 * Reporta un evento de una conversación. Público para que un fork pueda emitir
 * los suyos (p. ej. el espejo `InitiateCheckout` que documenta la guía) sin
 * reimplementar el dedup ni el manejo del acuse.
 *
 * Un `Purchase` sin `value` positivo NO se manda: queda `skipped` con
 * `NO_AMOUNT_REASON` (Meta exige el valor en una compra).
 */
export async function emitConversion(
  organizationId: string,
  conversationId: string,
  eventName: string,
  customData?: Record<string, unknown>
): Promise<EmitOutcome> {
  try {
    const db = getDb();

    // Dedup atómico: si ya existe ese evento para esta conversación, no-op.
    const inserted = await db
      .insert(schema.conversionEvent)
      .values({
        id: newId("conversionEvent"),
        organizationId,
        conversationId,
        eventName,
      })
      .onConflictDoNothing({
        target: [
          schema.conversionEvent.organizationId,
          schema.conversionEvent.conversationId,
          schema.conversionEvent.eventName,
        ],
      })
      .returning();

    const event = inserted[0];
    if (!event) return "dedup";

    return await deliverConversion({
      eventRowId: event.id,
      organizationId,
      conversationId,
      eventName,
      customData,
    });
  } catch (err) {
    // Best-effort absoluto: ni siquiera un fallo de la base puede tumbar a
    // quien nos llamó (mover un lead de etapa).
    console.warn(`[capi] emitConversion(${eventName}) falló: ${err}`);
    return "error";
  }
}

/**
 * `custom_data` de un `Purchase` a partir del monto del trato. Pura y exportada
 * para fijar en un test la conversión centavos → unidades: Meta espera unidades
 * de la moneda (450.50) y la base guarda centavos enteros (45050).
 *
 * Sin monto (o en cero) devuelve solo la etapa. Mandar `value: 0` no significa
 * "no sé cuánto" — le enseña al optimizador que las ventas de este negocio
 * valen nada. (Y una compra así ya no sale: se retiene con `NO_AMOUNT_REASON`.)
 */
export function purchaseCustomData(amount: {
  amountCents: number | null;
  currency: string | null;
}): Record<string, unknown> {
  const base = { lead_stage: "won" };
  if (amount.amountCents === null || amount.amountCents <= 0) return base;
  return {
    ...base,
    value: amount.amountCents / 100,
    ...(amount.currency ? { currency: amount.currency } : {}),
  };
}

/* ---------------- Reintento ---------------- */

export type RetryConversionResult =
  | { ok: true; outcome: DeliverOutcome }
  | { ok: false; reason: "disabled" | "not_found" | "not_retryable" };

/**
 * Vuelve a intentar una fila `failed` o `skipped`-reintentable. Reusa la MISMA
 * fila y el mismo `event_id` (UPDATE, nunca INSERT), reconstruye `custom_data`
 * con los datos de HOY (p. ej. el monto capturado después) y deja escrito el
 * desenlace igual que la emisión normal. `event_time` es el del reintento: Meta
 * rechaza eventos de hace más de 7 días.
 *
 * Una conversación del Laboratorio (`is_test`) no tiene filas, y si alguna
 * apareciera se trata como inexistente: el reintento tampoco toca el mundo
 * real desde el sandbox.
 */
export async function retryConversion(
  organizationId: string,
  eventRowId: string
): Promise<RetryConversionResult> {
  if (!atribucionEnabled()) return { ok: false, reason: "disabled" };

  const db = getDb();
  const rows = await db
    .select({
      id: schema.conversionEvent.id,
      conversationId: schema.conversionEvent.conversationId,
      eventName: schema.conversionEvent.eventName,
      status: schema.conversionEvent.status,
      error: schema.conversionEvent.error,
      contactId: schema.conversation.contactId,
    })
    .from(schema.conversionEvent)
    .innerJoin(
      schema.conversation,
      and(
        eq(schema.conversation.id, schema.conversionEvent.conversationId),
        eq(schema.conversation.isTest, false)
      )
    )
    .where(
      scoped(
        schema.conversionEvent.organizationId,
        organizationId,
        eq(schema.conversionEvent.id, eventRowId)
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (!isRetryableConversion(row)) return { ok: false, reason: "not_retryable" };

  // Se reclama la fila pasándola a `pending` SOLO si sigue como se leyó: dos
  // reintentos simultáneos (el botón y el enganche del monto) no pueden
  // mandar dos veces. El que pierde la carrera ve "no reintentable".
  const claimed = await db
    .update(schema.conversionEvent)
    .set({ status: "pending" })
    .where(
      scoped(
        schema.conversionEvent.organizationId,
        organizationId,
        and(
          eq(schema.conversionEvent.id, row.id),
          eq(schema.conversionEvent.status, row.status)
        )
      )
    )
    .returning({ id: schema.conversionEvent.id });
  if (!claimed[0]) return { ok: false, reason: "not_retryable" };

  try {
    let customData: Record<string, unknown> = { lead_stage: "qualified" };
    if (row.eventName === PURCHASE_EVENT) {
      const leads = await db
        .select({
          amountCents: schema.lead.amountCents,
          currency: schema.lead.currency,
        })
        .from(schema.lead)
        .where(
          scoped(
            schema.lead.organizationId,
            organizationId,
            eq(schema.lead.contactId, row.contactId)
          )
        )
        .limit(1);
      customData = purchaseCustomData(
        leads[0] ?? { amountCents: null, currency: null }
      );
    }

    const outcome = await deliverConversion({
      eventRowId: row.id,
      organizationId,
      conversationId: row.conversationId,
      eventName: row.eventName,
      customData,
    });
    return { ok: true, outcome };
  } catch (err) {
    // Jamás dejar la fila en `pending`: se marca fallida (reintentable) con
    // el motivo, y quien llamó sigue su camino.
    console.warn(`[capi] retryConversion(${eventRowId}) falló: ${err}`);
    await db
      .update(schema.conversionEvent)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(schema.conversionEvent.id, row.id))
      .catch(() => undefined);
    return { ok: true, outcome: "failed" };
  }
}

/** Ids de las filas reintentables más recientes (tope `RETRY_ALL_MAX`). */
async function listRetryableConversionIds(
  organizationId: string
): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.conversionEvent.id })
    .from(schema.conversionEvent)
    .where(
      scoped(
        schema.conversionEvent.organizationId,
        organizationId,
        and(
          inArray(schema.conversionEvent.eventName, [...RETRYABLE_EVENTS]),
          or(
            eq(schema.conversionEvent.status, "failed"),
            and(
              eq(schema.conversionEvent.status, "skipped"),
              inArray(schema.conversionEvent.error, [...RETRYABLE_SKIP_REASONS])
            )
          )
        )
      )
    )
    .orderBy(desc(schema.conversionEvent.createdAt))
    .limit(RETRY_ALL_MAX);
  return rows.map((r) => r.id);
}

export type RetryAllResult = {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
};

/**
 * "Reintentar todas": las reintentables más recientes, en serie y con tope.
 * Pensado para "acabo de conectar el dataset" o "Meta estuvo caído".
 */
export async function retryAllConversions(
  organizationId: string
): Promise<RetryAllResult | null> {
  if (!atribucionEnabled()) return null;
  const ids = await listRetryableConversionIds(organizationId);
  const result: RetryAllResult = { attempted: 0, sent: 0, failed: 0, skipped: 0 };
  for (const id of ids) {
    const r = await retryConversion(organizationId, id);
    if (!r.ok) continue;
    result.attempted += 1;
    result[r.outcome] += 1;
  }
  return result;
}

/* ---------------- Enganches con el Pipeline ---------------- */

/**
 * Punto de entrada desde la puerta única de etapas.
 *
 * Vive aquí y no en `stage-history.ts` para que aquel archivo siga siendo lo
 * que dice ser: la puerta que escribe `stage_id`. Y cuelga de esa puerta —y no
 * de donde el bot escribe la ficha, como en el fork del que viene esta idea—
 * porque así reportan IGUAL los cuatro caminos que mueven un lead: el dueño
 * arrastrando, el agente incluido, un cerebro externo por `/api/bot/*` y
 * cualquier quinto camino que alguien agregue mañana.
 */
export async function reportStageChange(input: {
  organizationId: string;
  leadId: string;
  contactId: string;
  toStageId: string;
  toStageKind: "open" | "won" | "lost";
}): Promise<void> {
  if (!atribucionEnabled()) return;

  try {
    const settings = await getCapiSettings(input.organizationId);
    const isQualified =
      settings?.qualifiedStageId != null &&
      settings.qualifiedStageId === input.toStageId;
    const isWon = input.toStageKind === "won";
    if (!isQualified && !isWon) return;

    const db = getDb();
    // La conversación REAL del contacto (índice único parcial: una por
    // contacto). Las del Laboratorio (`is_test`) no entran aquí — mismo
    // guardrail que el sender: una conversación de prueba jamás toca el
    // mundo real.
    const rows = await db
      .select({
        conversationId: schema.conversation.id,
        amountCents: schema.lead.amountCents,
        currency: schema.lead.currency,
      })
      .from(schema.lead)
      .innerJoin(
        schema.conversation,
        and(
          eq(schema.conversation.organizationId, schema.lead.organizationId),
          eq(schema.conversation.contactId, schema.lead.contactId),
          eq(schema.conversation.isTest, false)
        )
      )
      .where(
        scoped(
          schema.lead.organizationId,
          input.organizationId,
          eq(schema.lead.id, input.leadId)
        )
      )
      .limit(1);

    const row = rows[0];
    // Sin conversación de WhatsApp no hay `ctwa_clid` posible ni nada que
    // atribuir (p. ej. un prospecto capturado a mano que nunca escribió).
    if (!row) return;

    if (isWon) {
      // Sin monto, `emitConversion` deja la fila `skipped` con
      // NO_AMOUNT_REASON; `reportAmountChange` la emite cuando llegue.
      await emitConversion(
        input.organizationId,
        row.conversationId,
        PURCHASE_EVENT,
        purchaseCustomData(row)
      );
      return;
    }

    await emitConversion(
      input.organizationId,
      row.conversationId,
      QUALIFIED_EVENT,
      { lead_stage: "qualified" }
    );
  } catch (err) {
    console.warn(`[capi] reportStageChange(${input.leadId}) falló: ${err}`);
  }
}

/**
 * Se capturó el monto de un lead. Si ese lead YA está ganado y su `Purchase`
 * quedó retenida por falta de monto, se emite ahora (misma fila, vía
 * `retryConversion`). Una compra que ya salió no se toca: Meta deduplica y no
 * hay forma de corregirle el valor. Best-effort: guardar el monto jamás
 * depende de esto.
 */
export async function reportAmountChange(input: {
  organizationId: string;
  leadId: string;
}): Promise<void> {
  if (!atribucionEnabled()) return;

  try {
    const db = getDb();
    const rows = await db
      .select({
        eventRowId: schema.conversionEvent.id,
        stageKind: schema.pipelineStage.kind,
        amountCents: schema.lead.amountCents,
      })
      .from(schema.lead)
      .innerJoin(
        schema.pipelineStage,
        eq(schema.pipelineStage.id, schema.lead.stageId)
      )
      .innerJoin(
        schema.conversation,
        and(
          eq(schema.conversation.organizationId, schema.lead.organizationId),
          eq(schema.conversation.contactId, schema.lead.contactId),
          eq(schema.conversation.isTest, false)
        )
      )
      .innerJoin(
        schema.conversionEvent,
        and(
          eq(schema.conversionEvent.organizationId, schema.lead.organizationId),
          eq(schema.conversionEvent.conversationId, schema.conversation.id),
          eq(schema.conversionEvent.eventName, PURCHASE_EVENT),
          eq(schema.conversionEvent.status, "skipped"),
          eq(schema.conversionEvent.error, NO_AMOUNT_REASON)
        )
      )
      .where(
        scoped(
          schema.lead.organizationId,
          input.organizationId,
          eq(schema.lead.id, input.leadId)
        )
      )
      .limit(1);

    const row = rows[0];
    if (!row || row.stageKind !== "won") return;
    if (row.amountCents === null || row.amountCents <= 0) return;

    await retryConversion(input.organizationId, row.eventRowId);
  } catch (err) {
    console.warn(`[capi] reportAmountChange(${input.leadId}) falló: ${err}`);
  }
}

/* ---------------- Actividad reciente ---------------- */

export type ConversionActivityRow = {
  id: string;
  conversationId: string;
  eventName: string;
  /** Nombre del contacto; null si la conversación ya no existe. */
  contactName: string | null;
  /** Titular del anuncio de origen, si se capturó. */
  adHeadline: string | null;
  status: ConversionStatus;
  /** Momento a mostrar: el envío si ocurrió, si no la creación. */
  at: string;
  fbTraceId: string | null;
  error: string | null;
  /** Si el panel debe ofrecer "Reintentar" (ver `isRetryableConversion`). */
  retryable: boolean;
};

/** Tope duro: es un panel de monitoreo, no un export. */
const ACTIVITY_MAX_LIMIT = 50;
export const ACTIVITY_DEFAULT_LIMIT = 25;

/** Pura y exportada para probar el fallback de fecha sin tocar la base. */
export function toConversionActivityRow(row: {
  id: string;
  conversationId: string;
  eventName: string;
  status: ConversionStatus;
  error: string | null;
  fbTraceId: string | null;
  sentAt: Date | null;
  createdAt: Date;
  contactName: string | null;
  adHeadline: string | null;
}): ConversionActivityRow {
  return {
    id: row.id,
    conversationId: row.conversationId,
    eventName: row.eventName,
    contactName: row.contactName,
    adHeadline: row.adHeadline,
    status: row.status,
    at: (row.sentAt ?? row.createdAt).toISOString(),
    fbTraceId: row.fbTraceId,
    error: row.error,
    retryable: isRetryableConversion(row),
  };
}

async function selectActivity(
  organizationId: string,
  where: SQL | undefined,
  limit: number
): Promise<ConversionActivityRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.conversionEvent.id,
      conversationId: schema.conversionEvent.conversationId,
      eventName: schema.conversionEvent.eventName,
      status: schema.conversionEvent.status,
      error: schema.conversionEvent.error,
      fbTraceId: schema.conversionEvent.fbTraceId,
      sentAt: schema.conversionEvent.sentAt,
      createdAt: schema.conversionEvent.createdAt,
      contactName: schema.contact.name,
      adHeadline: schema.adAttribution.headline,
    })
    .from(schema.conversionEvent)
    .leftJoin(
      schema.conversation,
      eq(schema.conversation.id, schema.conversionEvent.conversationId)
    )
    .leftJoin(
      schema.contact,
      eq(schema.contact.id, schema.conversation.contactId)
    )
    .leftJoin(
      schema.adAttribution,
      eq(schema.adAttribution.conversationId, schema.conversionEvent.conversationId)
    )
    .where(scoped(schema.conversionEvent.organizationId, organizationId, where))
    .orderBy(desc(schema.conversionEvent.createdAt))
    .limit(limit);

  return rows.map(toConversionActivityRow);
}

/** Últimas conversiones de la organización, la más reciente primero. */
export async function listConversionActivity(
  organizationId: string,
  limit = ACTIVITY_DEFAULT_LIMIT
): Promise<ConversionActivityRow[]> {
  return selectActivity(
    organizationId,
    undefined,
    Math.min(Math.max(limit, 1), ACTIVITY_MAX_LIMIT)
  );
}

/** Una fila de la actividad (para refrescarla tras un reintento). */
export async function getConversionActivityRow(
  organizationId: string,
  eventRowId: string
): Promise<ConversionActivityRow | null> {
  const rows = await selectActivity(
    organizationId,
    eq(schema.conversionEvent.id, eventRowId),
    1
  );
  return rows[0] ?? null;
}
