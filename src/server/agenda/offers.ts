import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";

/**
 * 015 — Memoria de lo ofrecido a una conversación (requisito INNEGOCIABLE).
 *
 * Sin fila aquí no hay reserva: es lo que impide que un modelo alucine un
 * horario que nunca se le ofreció al cliente. La oferta se reemplaza completa
 * en cada ronda (la vigente es siempre la última) y se limpia al reservar.
 */

export type OfferedSlot = { startUtc: string; label: string };

/** Reemplaza TODA la oferta de la conversación, en una transacción. */
export async function replaceOffers(
  organizationId: string,
  conversationId: string,
  slots: OfferedSlot[]
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.offeredSlot)
      .where(
        scoped(
          schema.offeredSlot.organizationId,
          organizationId,
          eq(schema.offeredSlot.conversationId, conversationId)
        )
      );
    if (slots.length === 0) return;
    await tx.insert(schema.offeredSlot).values(
      slots.map((s) => ({
        id: newId("offeredSlot"),
        organizationId,
        conversationId,
        startUtc: new Date(s.startUtc),
        label: s.label,
      }))
    );
  });

  // 10 — Bitácora de rondas (denominador de "oferta → cita"). DESPUÉS de la
  // transacción y sin relanzar: un fallo del registro jamás revierte ni
  // bloquea la oferta. Una ronda vacía no es una oferta.
  if (slots.length > 0) {
    await logOfferRound(organizationId, conversationId, slots);
  }
}

/** Agrega una fila a `agenda_offer_log`. Nunca lanza. */
export async function logOfferRound(
  organizationId: string,
  conversationId: string,
  slots: OfferedSlot[],
  now: Date = new Date()
): Promise<void> {
  if (slots.length === 0) return;
  try {
    const db = getDb();
    const conv = await db
      .select({ isTest: schema.conversation.isTest })
      .from(schema.conversation)
      .where(
        scoped(
          schema.conversation.organizationId,
          organizationId,
          eq(schema.conversation.id, conversationId)
        )
      )
      .limit(1);
    await db.insert(schema.agendaOfferLog).values({
      id: newId("agendaOfferLog"),
      organizationId,
      conversationId,
      // Sin conversación legible se asume prueba: mejor no contarla que
      // inflar la métrica con una ronda que no sabemos si fue real.
      isTest: conv[0]?.isTest ?? true,
      slots: slots.map((s) => new Date(s.startUtc).toISOString()),
      slotCount: slots.length,
      createdAt: now,
    });
  } catch (err) {
    console.warn("[agenda] no se pudo registrar la ronda de oferta:", err);
  }
}

export async function getOffers(
  organizationId: string,
  conversationId: string
): Promise<OfferedSlot[]> {
  const db = getDb();
  const rows = await db
    .select({
      startUtc: schema.offeredSlot.startUtc,
      label: schema.offeredSlot.label,
    })
    .from(schema.offeredSlot)
    .where(
      scoped(
        schema.offeredSlot.organizationId,
        organizationId,
        eq(schema.offeredSlot.conversationId, conversationId)
      )
    )
    .orderBy(asc(schema.offeredSlot.startUtc));

  return rows.map((r) => ({
    startUtc: r.startUtc.toISOString(),
    label: r.label,
  }));
}

export async function clearOffers(
  organizationId: string,
  conversationId: string
): Promise<void> {
  const db = getDb();
  await db
    .delete(schema.offeredSlot)
    .where(
      scoped(
        schema.offeredSlot.organizationId,
        organizationId,
        eq(schema.offeredSlot.conversationId, conversationId)
      )
    );
}

/**
 * ¿El instante pedido está entre los ofrecidos? Comparación por **epoch
 * exacto**: nada de tolerancias ni de comparar texto. Un ISO con otro offset
 * pero el mismo instante SÍ vale; un minuto de diferencia NO.
 *
 * La tolerancia sería la puerta por donde entra la alucinación: un modelo
 * inventa "el martes a las 10" con facilidad, y comparar exacto convierte eso
 * en un rechazo con la lista de lo que sí se ofreció.
 */
export function findOffered(
  offers: OfferedSlot[],
  whenISO: string
): OfferedSlot | null {
  const target = Date.parse(whenISO);
  if (Number.isNaN(target)) return null;
  return offers.find((o) => Date.parse(o.startUtc) === target) ?? null;
}

/** Igualdad de instante, expuesta para tests. */
export function sameInstant(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return !Number.isNaN(x) && !Number.isNaN(y) && x === y;
}
