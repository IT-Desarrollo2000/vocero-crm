import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { wallClock } from "@/lib/time/calendar";
import { labelInTz } from "@/lib/time/slots";
import { CONNECTOR_META, type ConnectorId } from "@/lib/agenda-connectors";
import {
  computeAvailability,
  conflictsAt,
  findSlot,
} from "@/server/agenda/availability";
import {
  STRICT,
  type BusyItem,
  type ConflictContext,
} from "@/server/agenda/conflicts";
import type { AgendaDb, AgendaTx } from "@/server/agenda/db";
import { getSettings, type CalendarSettings } from "@/server/agenda/settings";
import {
  clearOffers,
  findOffered,
  getOffers,
  replaceOffers,
  type OfferedSlot,
} from "@/server/agenda/offers";
import {
  getType,
  listTypes,
  resolveFallbackType,
  type AppointmentType,
} from "@/server/agenda/types-store";
import {
  bindConnector,
  markConnectorAuthError,
} from "@/server/agenda/connectors";
import { ConnectorError } from "@/server/agenda/connectors/types";
import { moveLeadToStage } from "@/server/leads/stage-history";
import { publish } from "@/server/events/bus";

/**
 * 015 — Ciclo de vida de la cita y las dos reglas INNEGOCIABLES:
 *
 *  1. Quien conduce la conversación (agente in-process o cerebro externo) solo
 *     puede reservar un instante que ya se ofreció a ESA conversación
 *     (`offered_slot`, comparación por epoch exacto).
 *  2. Al confirmar se re-valida el hueco; si se ocupó, se responde
 *     `slot_taken` con alternativas frescas y NO se crea nada. Nunca se
 *     confirma una reserva que no se creó.
 *
 * 023 — Agenda presencial: tipos de cita, vendedores y choques.
 *
 *  - Toda escritura que OCUPA agenda (crear sesión, bloqueo, reprogramar,
 *    reactivar, reasignar) corre bajo un candado consultivo por organización
 *    (`withAgendaLock`). Dentro van SOLO las lecturas con `tx` y el
 *    INSERT/UPDATE (A1); alternativas frescas, limpiar la oferta, conector,
 *    etapa del lead y SSE van DESPUÉS del commit. Así se cierran los traslapes
 *    parciales y la carrera de dos reservas de IA, que un índice único no ve.
 *    Si el candado no llega en 5 s (`lock_timeout`, 55P03) el error se
 *    propaga tal cual (500): es un síntoma de algo atorado, no un choque.
 *  - Modo `strict` (IA y bot): todo traslape bloquea. Modo `staff` (humanos):
 *    bloqueo, mismo tipo exclusivo o mismo vendedor bloquean; el resto pide
 *    confirmación (`overlap_warning`).
 *
 * Y una regla de honestidad: la entrega de la reunión (el conector) corre
 * DESPUÉS de escribir la verdad del CRM y es best-effort. Si el proveedor está
 * caído, la cita se crea igual con el enlace pendiente — un tercero no puede
 * costarnos la conversión, ni hacernos prometer un enlace que no existe.
 */

export type BookingErrorCode =
  | "slot_taken"
  | "slot_not_offered"
  | "not_found"
  | "invalid"
  | "overlap_warning"
  /** 028 — `move` con `expectedStartUtc`: otra persona ya la movió. */
  | "stale";

/** 028 — Mensaje del 409 `stale`. */
export const STALE_MESSAGE = "Otra persona ya movió esta cita";

export class BookingError extends Error {
  code: BookingErrorCode;
  /**
   * Horarios para re-ofrecer. En `slot_taken` son alternativas frescas YA
   * registradas como la nueva oferta de la conversación; en `slot_not_offered`
   * es lo que sí se había ofrecido.
   */
  slots: OfferedSlot[];
  /**
   * 023 — Las citas con las que choca. En `overlap_warning`, las compatibles
   * que piden confirmación; en un `slot_taken` de reasignar/reactivar, las que
   * lo impiden.
   */
  conflicts: BusyItem[];

  constructor(
    code: BookingErrorCode,
    message: string,
    slots: OfferedSlot[] = [],
    conflicts: BusyItem[] = []
  ) {
    super(message);
    this.name = "BookingError";
    this.code = code;
    this.slots = slots;
    this.conflicts = conflicts;
  }
}

type BookingRow = typeof schema.booking.$inferSelect;

export type BookingResult = {
  booking: BookingRow;
  meetingLink: string | null;
  linkPending: boolean;
  label: string;
  /** 023 — Nombre del tipo de cita (null en citas sin tipo). */
  typeName: string | null;
};

export type ConflictMode = "strict" | "staff";

/**
 * 023 (A11) — Mensaje del `slot_taken` cuando el tipo ofrecido se desactivó
 * entre la oferta y la reserva. El agente lo distingue de "agenda llena" para
 * preguntar el tipo en vez de disculparse.
 */
export const TYPE_GONE_MESSAGE = "Ese tipo de cita ya no está disponible";

/** Cuántas alternativas se devuelven cuando el hueco se ocupó. */
const FRESH_ALTERNATIVES = 3;

/** Citas que ocupan agenda de verdad. */
export const ACTIVE_STATUSES = ["agendada", "realizada"] as const;

/**
 * 023 — El candado por organización: serializa las escrituras de agenda de
 * UN negocio (volumen bajo: no cuesta nada) y deja pasar a los demás. Vive en
 * la transacción, así que funciona también tras un pooler en modo
 * transacción. Mismo patrón que el catálogo (`assertCodeFree`).
 */
async function withAgendaLock<T>(
  organizationId: string,
  run: (tx: AgendaTx) => Promise<T>
): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`agenda:${organizationId}`}))`
    );
    return run(tx);
  });
}

/** Qué re-ofrecer si el hueco resulta ocupado (mismo tipo, mismo modo). */
type RefreshSpec = {
  typeId: string | null;
  durationMinutes: number;
  ctx: ConflictContext;
};

export async function createSessionBooking(input: {
  organizationId: string;
  startUtc: string;
  source: "manual" | "ai";
  /** Obligatoria en el camino conversacional; de ella sale el contacto. */
  conversationId?: string | null;
  /** Camino manual del operador. */
  contactId?: string | null;
  notes?: string | null;
  /**
   * true ⇒ exige que el instante figure entre los ofrecidos a la conversación
   * (agente/bot). El operador elige de la disponibilidad que está viendo, así
   * que reserva sin oferta previa.
   */
  requireOffer: boolean;
  now?: Date;
  /**
   * 023 — Tipo de cita. Para humanos es obligatorio; la IA/bot lo toma de la
   * oferta o, si no, del tipo por omisión (A2).
   */
  typeId?: string | null;
  /**
   * 023 — Vendedor explícito (solo el Propietario lo elige). `undefined` ⇒
   * se deduce (asignado a la conversación → quien agenda); `null` ⇒ sin
   * vendedor a propósito.
   */
  assignedUserId?: string | null;
  /** 023 — Quien agenda (humano). La IA no tiene actor. */
  actorUserId?: string | null;
  /** 023 — El humano ya vio la advertencia de choque y confirma. */
  confirmOverlap?: boolean;
}): Promise<BookingResult> {
  if (Number.isNaN(Date.parse(input.startUtc))) {
    throw new BookingError("invalid", "Instante inválido");
  }
  const settings = await getSettings(input.organizationId);
  const mode: ConflictMode = input.source === "ai" ? "strict" : "staff";

  // Lo que hay que re-ofrecer si el hueco se ocupó; se fija al resolver el
  // tipo DENTRO del candado y se usa FUERA, ya sin él (A1).
  const pending: { refresh: RefreshSpec | null } = { refresh: null };

  let created: {
    booking: BookingRow;
    startUtc: string;
    contactId: string;
    type: AppointmentType;
  };
  try {
    created = await withAgendaLock(input.organizationId, async (tx) => {
      // Contexto de la conversación: contacto, Laboratorio y vendedor asignado.
      let isTest = false;
      let contactId = input.contactId ?? null;
      let convAssignee: string | null = null;
      if (input.conversationId) {
        const rows = await tx
          .select({
            contactId: schema.conversation.contactId,
            isTest: schema.conversation.isTest,
            assignedUserId: schema.conversation.assignedUserId,
          })
          .from(schema.conversation)
          .where(
            scoped(
              schema.conversation.organizationId,
              input.organizationId,
              eq(schema.conversation.id, input.conversationId)
            )
          )
          .limit(1);
        const conv = rows[0];
        if (!conv) {
          throw new BookingError("not_found", "Conversación no encontrada");
        }
        // Un contacto explícito tiene que ser EL de la conversación: si no,
        // la cita quedaría colgada de un hilo ajeno.
        if (contactId && contactId !== conv.contactId) {
          throw new BookingError(
            "invalid",
            "El contacto no corresponde a la conversación"
          );
        }
        isTest = conv.isTest;
        contactId = contactId ?? conv.contactId;
        convAssignee = conv.assignedUserId ?? null;
      }
      if (!contactId) {
        throw new BookingError("invalid", "La cita necesita un contacto");
      }
      // Multi-tenancy (III): un `contactId` que llega de fuera se comprueba
      // contra ESTA organización antes de escribir nada con él.
      if (input.contactId) {
        const found = await tx
          .select({ id: schema.contact.id })
          .from(schema.contact)
          .where(
            scoped(
              schema.contact.organizationId,
              input.organizationId,
              eq(schema.contact.id, input.contactId)
            )
          )
          .limit(1);
        if (found.length === 0) {
          throw new BookingError("invalid", "Contacto no encontrado");
        }
      }

      // REGLA 1: solo se reserva lo que se ofreció.
      let offered: OfferedSlot | null = null;
      if (input.requireOffer) {
        if (!input.conversationId) {
          throw new BookingError(
            "invalid",
            "Se necesita la conversación para validar la oferta"
          );
        }
        const offers = await getOffers(
          input.organizationId,
          input.conversationId,
          tx
        );
        offered = findOffered(offers, input.startUtc);
        if (!offered) {
          throw new BookingError(
            "slot_not_offered",
            "Ese horario no se ofreció en esta conversación",
            offers
          );
        }
      }

      const type = await resolveBookingType(tx, {
        organizationId: input.organizationId,
        offeredTypeId: offered?.typeId ?? null,
        typeId: input.typeId ?? null,
        source: input.source,
        onGone: (spec) => {
          pending.refresh = spec;
        },
      });

      // Vendedor: explícito → asignado a la conversación → quien agenda.
      let sellerId: string | null;
      if (input.assignedUserId === null) {
        sellerId = null;
      } else if (input.assignedUserId) {
        if (!(await isOrgMember(input.organizationId, input.assignedUserId, tx))) {
          throw new BookingError(
            "invalid",
            "El vendedor no pertenece a la organización"
          );
        }
        sellerId = input.assignedUserId;
      } else {
        sellerId = convAssignee ?? input.actorUserId ?? null;
      }

      const ctx: ConflictContext =
        mode === "strict"
          ? STRICT
          : {
              mode: "staff",
              typeId: type.id,
              typeExclusive: type.exclusive,
              sellerId,
            };
      pending.refresh = {
        typeId: type.id,
        durationMinutes: type.durationMinutes,
        ctx,
      };

      // REGLA 2: el hueco debe seguir libre AHORA — y dentro del candado
      // nadie más del negocio puede ocuparlo antes del INSERT.
      const slot = await findSlot(input.organizationId, input.startUtc, {
        now: input.now,
        settings,
        durationMinutes: type.durationMinutes,
        ctx,
        db: tx,
      });
      if (!slot) {
        throw new BookingError("slot_taken", "Ese horario ya no está disponible");
      }
      if (slot.conflicts.length > 0 && !input.confirmOverlap) {
        throw new BookingError(
          "overlap_warning",
          overlapMessage(slot.conflicts),
          [],
          slot.conflicts
        );
      }

      const leadRows = await tx
        .select({ id: schema.lead.id })
        .from(schema.lead)
        .where(
          scoped(
            schema.lead.organizationId,
            input.organizationId,
            eq(schema.lead.contactId, contactId)
          )
        )
        .limit(1);

      const inserted = await tx
        .insert(schema.booking)
        .values({
          id: newId("booking"),
          organizationId: input.organizationId,
          kind: "session",
          source: input.source === "ai" ? "ai" : "manual",
          contactId,
          conversationId: input.conversationId ?? null,
          leadId: leadRows[0]?.id ?? null,
          scheduledAt: new Date(slot.startUtc),
          // Copias históricas del tipo: editarlo no reescribe el pasado.
          durationMinutes: type.durationMinutes,
          exclusive: type.exclusive,
          appointmentTypeId: type.id,
          assignedUserId: sellerId,
          createdByUserId: input.actorUserId ?? null,
          // Copia histórica: si el negocio cambia de conector, esta cita
          // conserva el que le tocó y sigue hablando con él.
          connector: settings.connector,
          isTest,
          notes: input.notes ?? null,
        })
        .returning();
      return {
        booking: inserted[0]!,
        startUtc: slot.startUtc,
        contactId,
        type,
      };
    });
  } catch (err) {
    // Ya FUERA del candado: aquí sí se calculan y registran alternativas.
    const taken =
      (err instanceof BookingError &&
        err.code === "slot_taken" &&
        err.slots.length === 0) ||
      isUniqueViolation(err);
    if (taken) {
      // El 23505 (índices únicos parciales) es la defensa en profundidad.
      const message =
        err instanceof BookingError
          ? err.message
          : "Ese horario acaba de ocuparse";
      // Solo quien conduce la conversación (IA o bot, `requireOffer`) recibe
      // alternativas REGISTRADAS como nueva oferta. Un humano que choca en
      // una conversación no puede pisar la oferta que la IA ya le hizo al
      // cliente (ni sumar una ronda falsa a `agenda_offer_log`): la UI
      // recarga su propia rejilla.
      throw new BookingError(
        "slot_taken",
        message,
        input.requireOffer && pending.refresh
          ? await refreshOffer(input.organizationId, input.conversationId, {
              now: input.now,
              ...pending.refresh,
            })
          : []
      );
    }
    throw err;
  }

  const { type } = created;

  // La oferta cumplió su propósito.
  if (input.conversationId) {
    await clearOffers(input.organizationId, input.conversationId).catch(
      (err) => {
        console.warn(`[agenda] no pude limpiar la oferta: ${err}`);
      }
    );
  }

  // Efectos secundarios: ninguno puede revertir la cita.
  const contactName = await getContactName(
    input.organizationId,
    created.contactId
  );
  const delivered = await deliverMeeting(created.booking, settings, contactName);
  await advanceLeadStage(
    input.organizationId,
    created.contactId,
    input.source === "ai" ? "bot" : "dueno"
  ).catch((err) => {
    console.warn(`[agenda] avance de etapa falló: ${err}`);
  });

  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: delivered.id },
  });

  return {
    booking: delivered,
    meetingLink: delivered.meetingLink,
    linkPending: delivered.linkPending,
    label: labelInTz(created.startUtc, settings.timezone),
    typeName: type.name,
  };
}

/**
 * 023 — De dónde sale el tipo de la cita:
 *  1. el de la OFERTA (la IA/bot no lo repite). Desactivado o borrado entre la
 *     oferta y la reserva ⇒ `slot_taken` (A11): se re-ofrece solo si hay un
 *     único tipo activo; si no, sin alternativas (quien conduce pregunta);
 *  2. el `typeId` explícito (humano). Inexistente/ajeno/inactivo ⇒ `invalid`;
 *  3. IA/bot sin tipo (oferta legacy): el tipo por omisión (A2);
 *  4. humano sin tipo ⇒ `invalid` (en la UI el tipo es obligatorio).
 */
async function resolveBookingType(
  tx: AgendaTx,
  input: {
    organizationId: string;
    offeredTypeId: string | null;
    typeId: string | null;
    source: "manual" | "ai";
    onGone: (spec: RefreshSpec | null) => void;
  }
): Promise<AppointmentType> {
  if (input.offeredTypeId) {
    const offeredType = await getType(input.organizationId, input.offeredTypeId, tx);
    if (offeredType?.active) return offeredType;
    const active = await listTypes(input.organizationId, {}, tx);
    const only = active.length === 1 ? active[0]! : null;
    input.onGone(
      only
        ? { typeId: only.id, durationMinutes: only.durationMinutes, ctx: STRICT }
        : null
    );
    // El agente (`bookSlot`) convierte este slot_taken sin alternativas en
    // la pregunta "¿Qué tipo de cita te interesa?".
    throw new BookingError("slot_taken", TYPE_GONE_MESSAGE);
  }
  if (input.typeId) {
    const t = await getType(input.organizationId, input.typeId, tx);
    if (!t || !t.active) {
      throw new BookingError("invalid", "Tipo de cita inválido");
    }
    return t;
  }
  if (input.source === "ai") {
    const fallback = await resolveFallbackType(input.organizationId, tx);
    if (!fallback) {
      throw new BookingError("invalid", "No hay tipos de cita activos");
    }
    return fallback;
  }
  throw new BookingError("invalid", "Elige el tipo de cita");
}

/** "A esa hora ya hay 1 cita (Servicio, con Juan)." */
function overlapMessage(conflicts: BusyItem[]): string {
  const detail = conflicts
    .map((c) => {
      const type = c.typeName ?? "Cita";
      return c.sellerName ? `${type}, con ${c.sellerName}` : type;
    })
    .join("; ");
  const n = conflicts.length;
  return `A esa hora ya hay ${n} cita${n === 1 ? "" : "s"} (${detail}).`;
}

/**
 * Bloqueo manual. Los bloqueos son de TODO el negocio y se permiten encima de
 * citas existentes (es una decisión del operador); `affected` lista las citas
 * que pisa para que la UI lo diga. Corre bajo el candado para que una reserva
 * simultánea vea el bloqueo.
 */
export async function createBlock(input: {
  organizationId: string;
  startUtc: string;
  durationMinutes: number;
  notes?: string | null;
}): Promise<{ block: BookingRow; affected: BusyItem[] }> {
  if (Number.isNaN(Date.parse(input.startUtc))) {
    throw new BookingError("invalid", "Instante inválido");
  }
  const settings = await getSettings(input.organizationId);
  const result = await withAgendaLock(input.organizationId, async (tx) => {
    const { hard } = await conflictsAt(
      input.organizationId,
      {
        startUtc: input.startUtc,
        durationMinutes: input.durationMinutes,
        ctx: STRICT,
        bufferMinutes: settings.bufferMinutes,
      },
      tx
    );
    const inserted = await tx
      .insert(schema.booking)
      .values({
        id: newId("booking"),
        organizationId: input.organizationId,
        kind: "block",
        source: "manual",
        scheduledAt: new Date(input.startUtc),
        durationMinutes: input.durationMinutes,
        notes: input.notes ?? null,
      })
      .returning();
    return {
      block: inserted[0]!,
      affected: hard.filter((i) => i.kind === "session"),
    };
  });
  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: result.block.id },
  });
  return result;
}

export async function rescheduleBooking(input: {
  organizationId: string;
  bookingId: string;
  startUtc: string;
  now?: Date;
  /**
   * 023 — `staff` (default: humanos) o `strict` (bot). El tipo y el vendedor
   * son los de la cita.
   */
  mode?: ConflictMode;
  /** 023 — El humano ya vio la advertencia de choque y confirma. */
  confirmOverlap?: boolean;
}): Promise<BookingResult> {
  const settings = await getSettings(input.organizationId);
  const mode = input.mode ?? "staff";

  const { next, startUtc, typeName } = await withAgendaLock(
    input.organizationId,
    async (tx) => {
      const booking = await getOwnBooking(input.organizationId, input.bookingId, tx);
      if (booking.status === "cancelada") {
        throw new BookingError("invalid", "La cita está cancelada");
      }

      // Un bloqueo se mueve como hoy (todo lo bloquea); una sesión, con las
      // reglas de su tipo y su vendedor.
      const ctx: ConflictContext =
        mode === "strict" || booking.kind === "block"
          ? STRICT
          : {
              mode: "staff",
              typeId: booking.appointmentTypeId,
              typeExclusive: booking.exclusive,
              sellerId: booking.assignedUserId,
            };

      const slot = await findMovableSlot(tx, {
        organizationId: input.organizationId,
        booking,
        startUtc: input.startUtc,
        ctx,
        settings,
        now: input.now,
        confirmOverlap: input.confirmOverlap,
      });

      const updated = await tx
        .update(schema.booking)
        .set({ scheduledAt: new Date(slot.startUtc), updatedAt: new Date() })
        .where(eq(schema.booking.id, booking.id))
        .returning();
      const typeName = booking.appointmentTypeId
        ? ((await getType(input.organizationId, booking.appointmentTypeId, tx))
            ?.name ?? null)
        : null;
      return { next: updated[0]!, startUtc: slot.startUtc, typeName };
    }
  ).catch((err: unknown) => {
    // Defensa en profundidad: el índice único vio el choque.
    if (isUniqueViolation(err)) {
      throw new BookingError("slot_taken", "Ese horario acaba de ocuparse");
    }
    throw err;
  });

  // Mover la reunión en el proveedor conserva el enlace: es la MISMA reunión,
  // en otra hora. Un fallo aquí no deshace nada — el enlace anterior sigue
  // sirviendo en la práctica.
  await withConnector(next, settings, async (conn, externalRef) => {
    await conn.updateMeeting(externalRef, {
      startUtc,
      durationMinutes: next.durationMinutes,
      timezone: settings.timezone,
    });
  });

  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: next.id },
  });
  return {
    booking: next,
    meetingLink: next.meetingLink,
    linkPending: next.linkPending,
    label: labelInTz(startUtc, settings.timezone),
    typeName,
  };
}

/**
 * Reprograma una cita activa de la conversación (por defecto, la PRÓXIMA). Es
 * el camino del agente y del bot: mover una cita no debería obligar a pausar
 * la IA y pasarle el problema a un humano. Siempre en modo `strict`.
 */
export async function rescheduleForConversation(input: {
  organizationId: string;
  conversationId: string;
  startUtc: string;
  now?: Date;
  /** 023 (A9) — Cuál mover; sin él, la próxima cita activa del contacto. */
  bookingId?: string | null;
}): Promise<BookingResult> {
  const db = getDb();
  const now = input.now ?? new Date();

  const convRows = await db
    .select({ contactId: schema.conversation.contactId })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        input.organizationId,
        eq(schema.conversation.id, input.conversationId)
      )
    )
    .limit(1);
  const conv = convRows[0];
  if (!conv) throw new BookingError("not_found", "Conversación no encontrada");

  // Mismas reglas que al crear: el instante nuevo tiene que haberse ofrecido.
  const offers = await getOffers(input.organizationId, input.conversationId);
  if (!findOffered(offers, input.startUtc)) {
    throw new BookingError(
      "slot_not_offered",
      "Ese horario no se ofreció en esta conversación",
      offers
    );
  }

  const rows = await db
    .select()
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        input.organizationId,
        and(
          eq(schema.booking.contactId, conv.contactId),
          eq(schema.booking.kind, "session"),
          eq(schema.booking.status, "agendada"),
          gte(schema.booking.scheduledAt, now),
          input.bookingId ? eq(schema.booking.id, input.bookingId) : undefined
        )
      )
    )
    .orderBy(asc(schema.booking.scheduledAt))
    .limit(1);

  const target = rows[0];
  if (!target) {
    throw new BookingError("not_found", "No hay una cita activa que mover");
  }

  const result = await rescheduleBooking({
    organizationId: input.organizationId,
    bookingId: target.id,
    startUtc: input.startUtc,
    now: input.now,
    mode: "strict",
  });
  await clearOffers(input.organizationId, input.conversationId).catch(() => {});
  return result;
}

/** Idempotente: cancelar una cita ya cancelada no falla ni cambia nada. */
export async function cancelBooking(input: {
  organizationId: string;
  bookingId: string;
}): Promise<void> {
  const db = getDb();
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  if (booking.status === "cancelada") return;

  await db
    .update(schema.booking)
    .set({ status: "cancelada", updatedAt: new Date() })
    .where(eq(schema.booking.id, booking.id));

  const settings = await getSettings(input.organizationId);
  await withConnector(booking, settings, async (conn, externalRef) => {
    await conn.deleteMeeting(externalRef);
  });

  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: booking.id },
  });
}

export async function markBookingStatus(input: {
  organizationId: string;
  bookingId: string;
  status: "realizada" | "no_show";
}): Promise<void> {
  const settings = await getSettings(input.organizationId);
  const bookingId = await withAgendaLock(input.organizationId, async (tx) => {
    const booking = await getOwnBooking(input.organizationId, input.bookingId, tx);

    // 023 — Volver a ocupar agenda (p. ej. `no_show → realizada`) exige que
    // el hueco no choque de forma incompatible con lo que se agendó después.
    const reoccupies =
      input.status === "realizada" &&
      !(ACTIVE_STATUSES as readonly string[]).includes(booking.status) &&
      booking.kind === "session" &&
      !booking.isTest;
    if (reoccupies) {
      const { hard } = await conflictsAt(
        input.organizationId,
        {
          startUtc: booking.scheduledAt.toISOString(),
          durationMinutes: booking.durationMinutes,
          ctx: {
            mode: "staff",
            typeId: booking.appointmentTypeId,
            typeExclusive: booking.exclusive,
            sellerId: booking.assignedUserId,
          },
          bufferMinutes: settings.bufferMinutes,
          excludeBookingId: booking.id,
        },
        tx
      );
      if (hard.length > 0) {
        throw new BookingError("slot_taken", "Ese horario ya está ocupado", [], hard);
      }
    }

    await tx
      .update(schema.booking)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(schema.booking.id, booking.id));
    return booking.id;
  }).catch((err: unknown) => {
    // Defensa en profundidad: el índice único vio el choque.
    if (isUniqueViolation(err)) {
      throw new BookingError("slot_taken", "Ese horario ya está ocupado");
    }
    throw err;
  });
  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId },
  });
}

/**
 * 023 — Reasigna la cita a otro vendedor (o a nadie). Solo el Propietario (la
 * ruta lo exige). El nuevo vendedor debe ser miembro de la organización y no
 * puede tener otra cita suya traslapada (hard). Lo demás (otros vendedores,
 * bloqueos, tipo exclusivo) no cambia al reasignar, así que no se re-evalúa.
 */
export async function assignBooking(input: {
  organizationId: string;
  bookingId: string;
  userId: string | null;
}): Promise<BookingRow> {
  const settings = await getSettings(input.organizationId);
  const updated = await withAgendaLock(input.organizationId, async (tx) => {
    const booking = await getOwnBooking(input.organizationId, input.bookingId, tx);
    if (booking.kind !== "session") {
      throw new BookingError("invalid", "Un bloqueo no tiene vendedor");
    }
    if (input.userId) {
      if (!(await isOrgMember(input.organizationId, input.userId, tx))) {
        throw new BookingError(
          "invalid",
          "El vendedor no pertenece a la organización"
        );
      }
      const occupies =
        (ACTIVE_STATUSES as readonly string[]).includes(booking.status) &&
        !booking.isTest;
      if (occupies) {
        await assertSellerFree(tx, {
          organizationId: input.organizationId,
          booking,
          sellerId: input.userId,
          settings,
        });
      }
    }
    const rows = await tx
      .update(schema.booking)
      .set({ assignedUserId: input.userId, updatedAt: new Date() })
      .where(eq(schema.booking.id, booking.id))
      .returning();
    return rows[0]!;
  }).catch((err: unknown) => {
    if (isUniqueViolation(err)) {
      throw new BookingError(
        "slot_taken",
        "Ese vendedor ya tiene una cita a esa hora"
      );
    }
    throw err;
  });
  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: updated.id },
  });
  return updated;
}

/**
 * 023/028 — Dentro del candado: el hueco de destino de una cita que se mueve,
 * con la rejilla y el aviso mínimo (`findSlot`) en el contexto dado. Sin
 * hueco ⇒ `slot_taken`; con choques soft y sin confirmar ⇒ `overlap_warning`.
 * Lo comparten `rescheduleBooking` y `moveBooking`.
 */
async function findMovableSlot(
  tx: AgendaTx,
  input: {
    organizationId: string;
    booking: BookingRow;
    startUtc: string;
    ctx: ConflictContext;
    settings: CalendarSettings;
    now?: Date;
    confirmOverlap?: boolean;
  }
) {
  // excludeBookingId: la propia cita no debe bloquearse a sí misma.
  const slot = await findSlot(input.organizationId, input.startUtc, {
    excludeBookingId: input.booking.id,
    now: input.now,
    settings: input.settings,
    durationMinutes: input.booking.durationMinutes,
    ctx: input.ctx,
    db: tx,
  });
  if (!slot) {
    throw new BookingError("slot_taken", "Ese horario ya no está disponible");
  }
  if (slot.conflicts.length > 0 && !input.confirmOverlap) {
    throw new BookingError(
      "overlap_warning",
      overlapMessage(slot.conflicts),
      [],
      slot.conflicts
    );
  }
  return slot;
}

/**
 * 023/028 — Dentro del candado: el vendedor destino no puede tener otra cita
 * suya traslapada a la hora ACTUAL de la cita (sin rejilla ni aviso mínimo:
 * reasignar no cambia la hora). Lo comparten `assignBooking` y `moveBooking`.
 */
async function assertSellerFree(
  tx: AgendaTx,
  input: {
    organizationId: string;
    booking: BookingRow;
    sellerId: string;
    settings: CalendarSettings;
  }
): Promise<void> {
  const { hard } = await conflictsAt(
    input.organizationId,
    {
      startUtc: input.booking.scheduledAt.toISOString(),
      durationMinutes: input.booking.durationMinutes,
      ctx: {
        mode: "staff",
        typeId: null,
        typeExclusive: false,
        sellerId: input.sellerId,
      },
      bufferMinutes: input.settings.bufferMinutes,
      excludeBookingId: input.booking.id,
    },
    tx
  );
  const sellerClashes = hard.filter(
    (i) => i.kind === "session" && i.assignedUserId === input.sellerId
  );
  if (sellerClashes.length > 0) {
    throw new BookingError(
      "slot_taken",
      "Ese vendedor ya tiene una cita a esa hora",
      [],
      sellerClashes
    );
  }
}

/**
 * 028 (A5) — Dentro del candado: mover un bloqueo sigue la semántica de
 * crearlo. Cualquier inicio alineado a `slotMinutes` desde las 00:00 del
 * negocio (sin exigir horario hábil); si cubre sesiones activas, se pide
 * confirmación ("Este bloqueo cubrirá N citas").
 */
async function checkBlockMove(
  tx: AgendaTx,
  input: {
    organizationId: string;
    booking: BookingRow;
    startUtc: string;
    settings: CalendarSettings;
    confirmOverlap?: boolean;
  }
): Promise<void> {
  const slot = Math.max(1, input.settings.slotMinutes);
  const startMs = Date.parse(input.startUtc);
  const wall = wallClock(new Date(startMs), input.settings.timezone);
  if (startMs % 60_000 !== 0 || wall.minutes % slot !== 0) {
    throw new BookingError(
      "invalid",
      `El bloqueo debe empezar en múltiplos de ${slot} minutos`
    );
  }
  // Sin margen: "cubrir" es pisar de verdad, no quedar pegado.
  const { hard } = await conflictsAt(
    input.organizationId,
    {
      startUtc: input.startUtc,
      durationMinutes: input.booking.durationMinutes,
      ctx: STRICT,
      bufferMinutes: 0,
      excludeBookingId: input.booking.id,
    },
    tx
  );
  const covered = hard.filter((i) => i.kind === "session");
  if (covered.length > 0 && !input.confirmOverlap) {
    const n = covered.length;
    throw new BookingError(
      "overlap_warning",
      `Este bloqueo cubrirá ${n} ${n === 1 ? "cita" : "citas"}.`,
      [],
      covered
    );
  }
}

export type MoveResult = BookingResult & {
  /** ¿Cambió la hora? (solo entonces se avisa al conector). */
  timeChanged: boolean;
};

/**
 * 028 (A2) — Mover una cita en el calendario: hora y/o vendedor de forma
 * ATÓMICA, bajo UN candado y con UN `UPDATE`.
 *
 *  - Solo citas `agendada` y que no son de prueba (`invalid` si no).
 *  - `expectedStartUtc` (opcional): si la cita ya no está ahí, `stale` (409).
 *  - Sesión: el contexto de choque usa el vendedor DESTINO. Si cambia la
 *    hora, `findSlot` en modo staff con el tipo y la duración de la cita
 *    (rejilla + aviso mínimo); si solo cambia el vendedor, `conflictsAt` sin
 *    rejilla (como `assign`). El destino debe ser miembro de la organización.
 *  - Bloqueo (A5): sin vendedor (`userId` ⇒ `invalid`), inicio alineado a
 *    `slotMinutes` y confirmación si cubre citas.
 *  - 23505 ⇒ `slot_taken`. Después del commit: el conector solo si cambió la
 *    hora, y `booking.updated`.
 *
 * El permiso de reasignar (solo Propietario) lo exige la ruta.
 */
export async function moveBooking(input: {
  organizationId: string;
  bookingId: string;
  startUtc?: string;
  /** `null` = sin asignar; ausente = el mismo vendedor. */
  userId?: string | null;
  confirmOverlap?: boolean;
  expectedStartUtc?: string;
  now?: Date;
}): Promise<MoveResult> {
  if (input.startUtc === undefined && input.userId === undefined) {
    throw new BookingError("invalid", "Indica la nueva hora o el vendedor");
  }
  if (input.startUtc !== undefined && Number.isNaN(Date.parse(input.startUtc))) {
    throw new BookingError("invalid", "Instante inválido");
  }
  const settings = await getSettings(input.organizationId);

  const { next, timeChanged, typeName } = await withAgendaLock(
    input.organizationId,
    async (tx) => {
      const booking = await getOwnBooking(input.organizationId, input.bookingId, tx);
      if (booking.status !== "agendada" || booking.isTest) {
        throw new BookingError(
          "invalid",
          "Solo se mueven citas agendadas que no son de prueba"
        );
      }
      if (
        input.expectedStartUtc !== undefined &&
        Date.parse(input.expectedStartUtc) !== booking.scheduledAt.getTime()
      ) {
        throw new BookingError("stale", STALE_MESSAGE);
      }

      const targetStart =
        input.startUtc !== undefined
          ? new Date(input.startUtc).toISOString()
          : booking.scheduledAt.toISOString();
      const timeChanged = targetStart !== booking.scheduledAt.toISOString();
      let sellerId = booking.assignedUserId;

      if (booking.kind === "block") {
        if (input.userId !== undefined) {
          throw new BookingError("invalid", "Un bloqueo no tiene vendedor");
        }
        if (timeChanged) {
          await checkBlockMove(tx, {
            organizationId: input.organizationId,
            booking,
            startUtc: targetStart,
            settings,
            confirmOverlap: input.confirmOverlap,
          });
        }
      } else {
        sellerId = input.userId !== undefined ? input.userId : booking.assignedUserId;
        if (
          input.userId &&
          !(await isOrgMember(input.organizationId, input.userId, tx))
        ) {
          throw new BookingError(
            "invalid",
            "El vendedor no pertenece a la organización"
          );
        }
        const sellerChanged = sellerId !== booking.assignedUserId;
        if (timeChanged) {
          await findMovableSlot(tx, {
            organizationId: input.organizationId,
            booking,
            startUtc: targetStart,
            ctx: {
              mode: "staff",
              typeId: booking.appointmentTypeId,
              typeExclusive: booking.exclusive,
              sellerId,
            },
            settings,
            now: input.now,
            confirmOverlap: input.confirmOverlap,
          });
        } else if (sellerChanged && sellerId) {
          await assertSellerFree(tx, {
            organizationId: input.organizationId,
            booking,
            sellerId,
            settings,
          });
        }
      }

      const updated = await tx
        .update(schema.booking)
        .set({
          scheduledAt: new Date(targetStart),
          assignedUserId: sellerId,
          updatedAt: new Date(),
        })
        .where(eq(schema.booking.id, booking.id))
        .returning();
      const typeName = booking.appointmentTypeId
        ? ((await getType(input.organizationId, booking.appointmentTypeId, tx))
            ?.name ?? null)
        : null;
      return { next: updated[0]!, timeChanged, typeName };
    }
  ).catch((err: unknown) => {
    // Defensa en profundidad: el índice único vio el choque.
    if (isUniqueViolation(err)) {
      throw new BookingError("slot_taken", "Ese horario acaba de ocuparse");
    }
    throw err;
  });

  const startUtc = next.scheduledAt.toISOString();
  if (timeChanged) {
    // La MISMA reunión en otra hora (como reprogramar). Best-effort.
    await withConnector(next, settings, async (conn, externalRef) => {
      await conn.updateMeeting(externalRef, {
        startUtc,
        durationMinutes: next.durationMinutes,
        timezone: settings.timezone,
      });
    });
  }
  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: next.id },
  });
  return {
    booking: next,
    meetingLink: next.meetingLink,
    linkPending: next.linkPending,
    label: labelInTz(startUtc, settings.timezone),
    typeName,
    timeChanged,
  };
}

/**
 * Reintenta la entrega de una cita que quedó sin enlace porque el proveedor
 * falló. Habla con el conector con el que NACIÓ la cita, no con el activo.
 *
 * Sin esto, un hipo del proveedor sería una pérdida silenciosa que nadie
 * repara — que es exactamente lo que pasa hoy en el fork.
 */
export async function retryMeetingLink(input: {
  organizationId: string;
  bookingId: string;
}): Promise<BookingResult> {
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  if (!booking.linkPending) {
    throw new BookingError("invalid", "Esta cita no tiene un enlace pendiente");
  }
  const settings = await getSettings(input.organizationId);
  const contactName = booking.contactId
    ? await getContactName(input.organizationId, booking.contactId)
    : "";
  const delivered = await deliverMeeting(booking, settings, contactName);

  publish(input.organizationId, {
    type: "booking.updated",
    data: { bookingId: delivered.id },
  });
  return {
    booking: delivered,
    meetingLink: delivered.meetingLink,
    linkPending: delivered.linkPending,
    label: labelInTz(delivered.scheduledAt.toISOString(), settings.timezone),
    typeName: null,
  };
}

/**
 * Crea la reunión en el proveedor y la guarda en la cita.
 *
 * SANDBOX: una cita del Laboratorio jamás llega a un conector. La aserción va
 * aquí, ANTES de resolver cuál es, para que valga igual para todos — hoy y
 * para el que agregue un fork mañana.
 */
async function deliverMeeting(
  booking: BookingRow,
  settings: CalendarSettings,
  contactName: string
): Promise<BookingRow> {
  if (booking.isTest) return booking;
  const connectorId = (booking.connector ?? settings.connector) as ConnectorId;

  try {
    const conn = await bindConnector(
      booking.organizationId,
      connectorId,
      settings
    );

    // Si la cita YA tiene reunión, esto es un reintento: se vuelve a leer, no
    // se crea otra. Sin esta rama, reintentar el enlace de un evento de Google
    // dejaría al dueño con dos citas en su calendario.
    const meeting =
      booking.externalRef && conn.refreshMeeting
        ? await conn.refreshMeeting(booking.externalRef)
        : await conn.createMeeting({
            topic: contactName ? `Cita — ${contactName}` : "Cita",
            startUtc: booking.scheduledAt.toISOString(),
            durationMinutes: booking.durationMinutes,
            timezone: settings.timezone,
            notes: booking.notes ?? undefined,
          });

    return await persistDelivery(booking.id, {
      externalRef: meeting.externalId ?? booking.externalRef,
      meetingLink: meeting.joinUrl,
      // Un conector que promete enlace por cita y no lo trajo todavía deja la
      // cita "sin enlace" — reintentable. `enlace-fijo` sin sala configurada,
      // en cambio, no tiene nada pendiente: simplemente no hay enlace.
      linkPending: CONNECTOR_META[connectorId].perBookingLink && !meeting.joinUrl,
    });
  } catch (err) {
    console.warn(
      `[agenda] el conector ${connectorId} no pudo entregar la reunión: ${err}`
    );
    if (err instanceof ConnectorError && err.isAuthError) {
      await markConnectorAuthError(booking.organizationId, connectorId).catch(
        () => {}
      );
    }
    // La cita ya existe y se queda: el enlace es lo único que falta. Se
    // conserva la referencia externa si ya la había, para que el reintento
    // sepa que no debe crear otra reunión.
    return await persistDelivery(booking.id, {
      externalRef: booking.externalRef,
      meetingLink: null,
      linkPending: true,
    });
  }
}

async function persistDelivery(
  bookingId: string,
  values: {
    externalRef: string | null;
    meetingLink: string | null;
    linkPending: boolean;
  }
): Promise<BookingRow> {
  const db = getDb();
  const rows = await db
    .update(schema.booking)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(schema.booking.id, bookingId))
    .returning();
  return rows[0]!;
}

/**
 * Corre un efecto sobre el proveedor de una cita ya creada (mover, borrar).
 * Best-effort y con el mismo guardarraíl de sandbox. Sin `external_ref` no hay
 * nada que mover: el conector no generó reunión (p. ej. el enlace fijo).
 */
async function withConnector(
  booking: BookingRow,
  settings: CalendarSettings,
  run: (
    conn: Awaited<ReturnType<typeof bindConnector>>,
    externalRef: string
  ) => Promise<void>
): Promise<void> {
  if (booking.isTest || !booking.externalRef) return;
  const connectorId = (booking.connector ?? settings.connector) as ConnectorId;
  try {
    const conn = await bindConnector(
      booking.organizationId,
      connectorId,
      settings
    );
    await run(conn, booking.externalRef);
  } catch (err) {
    console.warn(`[agenda] efecto en ${connectorId} falló: ${err}`);
    if (err instanceof ConnectorError && err.isAuthError) {
      await markConnectorAuthError(booking.organizationId, connectorId).catch(
        () => {}
      );
    }
  }
}

/**
 * Alternativas frescas para re-ofrecer, con el MISMO tipo y modo que la
 * reserva que falló, y solo huecos sin choques (ni soft). Si hay
 * conversación, quedan REGISTRADAS como su nueva oferta: el cliente puede
 * aceptar una de inmediato y la validación seguirá siendo válida. Se llama
 * FUERA del candado.
 */
async function refreshOffer(
  organizationId: string,
  conversationId: string | null | undefined,
  opts: { now?: Date } & RefreshSpec
): Promise<OfferedSlot[]> {
  let offers: OfferedSlot[] = [];
  try {
    const fresh = await computeAvailability(organizationId, {
      now: opts.now,
      durationMinutes: opts.durationMinutes,
      ctx: opts.ctx,
    });
    offers = fresh
      .filter((s) => s.conflicts.length === 0)
      .slice(0, FRESH_ALTERNATIVES)
      .map((s) => ({ startUtc: s.startUtc, label: s.label, typeId: opts.typeId }));
  } catch (err) {
    console.warn(`[agenda] no pude calcular alternativas: ${err}`);
    return [];
  }
  if (conversationId && offers.length > 0) {
    await replaceOffers(organizationId, conversationId, offers, opts.typeId).catch(
      (err) => {
        console.warn(`[agenda] no pude registrar la nueva oferta: ${err}`);
      }
    );
  }
  return offers;
}

async function getOwnBooking(
  organizationId: string,
  bookingId: string,
  db: AgendaDb = getDb()
): Promise<BookingRow> {
  const rows = await db
    .select()
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.id, bookingId)
      )
    )
    .limit(1);
  if (!rows[0]) throw new BookingError("not_found", "Cita no encontrada");
  return rows[0];
}

/** 023 (A5) — ¿El usuario es miembro de la organización? */
async function isOrgMember(
  organizationId: string,
  userId: string,
  db: AgendaDb
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(
      scoped(
        schema.member.organizationId,
        organizationId,
        eq(schema.member.userId, userId)
      )
    )
    .limit(1);
  return rows.length > 0;
}

async function getContactName(
  organizationId: string,
  contactId: string
): Promise<string> {
  const db = getDb();
  const rows = await db
    .select({ name: schema.contact.name })
    .from(schema.contact)
    .where(
      scoped(
        schema.contact.organizationId,
        organizationId,
        eq(schema.contact.id, contactId)
      )
    )
    .limit(1);
  return rows[0]?.name ?? "";
}

/**
 * El lead avanza a la siguiente etapa abierta al agendar — solo hacia adelante,
 * nunca retrocede.
 *
 * Pasa por `moveLeadToStage`, la única puerta que puede escribir `stage_id`:
 * mover el lead y registrar el movimiento en la bitácora son la misma
 * operación. Escribir el UPDATE aquí no truena, solo hace que las gráficas
 * mientan meses después — y hay un test de vigilancia que lo impide.
 */
async function advanceLeadStage(
  organizationId: string,
  contactId: string,
  source: "bot" | "dueno"
): Promise<void> {
  const db = getDb();
  const leads = await db
    .select({ id: schema.lead.id, stageId: schema.lead.stageId })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        eq(schema.lead.contactId, contactId)
      )
    )
    .limit(1);
  const lead = leads[0];
  if (!lead) return;

  const stages = await db
    .select({
      id: schema.pipelineStage.id,
      position: schema.pipelineStage.position,
      kind: schema.pipelineStage.kind,
    })
    .from(schema.pipelineStage)
    .where(scoped(schema.pipelineStage.organizationId, organizationId))
    .orderBy(asc(schema.pipelineStage.position));

  const currentIdx = stages.findIndex((s) => s.id === lead.stageId);
  if (currentIdx < 0) return;
  const nextOpen = stages.find((s, i) => i > currentIdx && s.kind === "open");
  if (!nextOpen) return; // ya está en la última etapa abierta (o en un ancla)

  await moveLeadToStage({
    organizationId,
    leadId: lead.id,
    toStageId: nextOpen.id,
    source,
    extra: { lastActivityAt: new Date() },
  });
}

/** ¿Hay alguna cita activa para este contacto? Lo usa el agente. */
export async function hasActiveBooking(
  organizationId: string,
  contactId: string,
  now = new Date()
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.booking.id })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        and(
          eq(schema.booking.contactId, contactId),
          eq(schema.booking.kind, "session"),
          inArray(schema.booking.status, [...ACTIVE_STATUSES]),
          gte(schema.booking.scheduledAt, now)
        )
      )
    )
    .limit(1);
  return rows.length > 0;
}

/** 23505 = unique_violation de Postgres. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "23505") return true;
  // Drizzle envuelve el error del driver: el código real viaja en `cause`.
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "23505"
  );
}
