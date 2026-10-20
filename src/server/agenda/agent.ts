import { matchTypeByName } from "@/lib/agenda-types";
import { computeAvailability } from "@/server/agenda/availability";
import { getSettings } from "@/server/agenda/settings";
import { spreadByDay } from "@/server/agenda/spread";
import { replaceOffers } from "@/server/agenda/offers";
import {
  BookingError,
  createSessionBooking,
  TYPE_GONE_MESSAGE,
} from "@/server/agenda/service";
import { listTypes, type AppointmentType } from "@/server/agenda/types-store";

/**
 * 015 — Lo que el agente incluido puede hacer con la agenda.
 *
 * Vive aquí y no en el pipeline para que el pipeline no aprenda de agendas: el
 * turno pide "ofrece" o "reserva" y recibe el texto que hay que mandar.
 *
 * Regla que atraviesa las dos operaciones: el modelo NO redacta horarios. Pide
 * ofrecer, y el motor pega las etiquetas reales. Si el modelo inventa un
 * instante al reservar, el motor lo rechaza y se re-ofrece — nunca se agenda
 * algo que el cliente no eligió.
 *
 * 023 — Visitas presenciales con TIPO de cita. Una sola regla para el tipo al
 * ofrecer: el nombre que mandó el modelo si resuelve (exacto o prefijo único);
 * si no, el único tipo activo; si no, se le PREGUNTA al cliente con los
 * nombres reales. La disponibilidad es `strict` (la IA no pisa ninguna cita)
 * con la duración del tipo, y la oferta guarda el tipo: `book_slot` lo toma de
 * ahí. Funciona igual en WhatsApp, Messenger e Instagram.
 */

/** Cuántos huecos se le enseñan al cliente en un mensaje. */
const SHOWN = 3;
/** Cuántos se guardan como reservables: el catálogo es más ancho que el menú. */
const OFFERED = 12;

export type AgendaTurn = {
  /** Lo que hay que enviarle al cliente. */
  text: string;
  /** false ⇒ el motor no pudo; el turno sigue, sin agendar. */
  ok: boolean;
};

/** "Prueba de manejo, Servicio, Garantía u Otro". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  const last = names[names.length - 1]!;
  // "u" ante sonido /o/: "Garantía u Otro".
  const conj = /^h?o/i.test(last) ? "u" : "o";
  return `${names.slice(0, -1).join(", ")} ${conj} ${last}`;
}

/** Cómo empieza la pregunta del tipo (el pipeline la reconoce para no repetirla). */
export const TYPE_QUESTION_PREFIX = "¿Qué tipo de cita te interesa?";

/** ¿Este texto es la pregunta del tipo? */
export function isTypeQuestion(text: string | null | undefined): boolean {
  return (text ?? "").trimStart().startsWith(TYPE_QUESTION_PREFIX);
}

/** La pregunta del tipo, con los nombres REALES del catálogo. */
export function typeQuestion(types: Pick<AppointmentType, "name">[]): string {
  if (types.length === 0) {
    return "Por ahora no puedo agendar en línea. Lo reviso con el equipo y te confirmo.";
  }
  return `${TYPE_QUESTION_PREFIX} Tengo: ${joinNames(types.map((t) => t.name))}.`;
}

function lowerType(name: string): string {
  return name.toLocaleLowerCase("es");
}

export async function offerSlots(input: {
  organizationId: string;
  conversationId: string;
  intro?: string;
  /** 023 — El tipo que pidió el modelo (nombre libre; se resuelve aquí). */
  typeName?: string;
}): Promise<AgendaTurn> {
  const types = await listTypes(input.organizationId);
  let type = input.typeName ? matchTypeByName(types, input.typeName) : null;
  if (!type && types.length === 1) type = types[0]!;
  if (!type) return { ok: false, text: typeQuestion(types) };

  const settings = await getSettings(input.organizationId);
  const now = new Date();
  const all = await computeAvailability(input.organizationId, {
    settings,
    now,
    durationMinutes: type.durationMinutes,
    // Sin `ctx` es `strict`: la IA solo ofrece huecos sin NINGUNA cita.
  });
  const spread = spreadByDay(all, {
    timezone: settings.timezone,
    limit: OFFERED,
    perDay: 3,
    now,
  });

  if (spread.length === 0) {
    // Agenda llena no es un error: es una respuesta que el cliente entiende.
    return {
      ok: false,
      text:
        input.intro?.trim() ||
        "Por ahora no me quedan horarios libres. Déjame confirmarlo con el equipo y te aviso.",
    };
  }

  // Se REGISTRA todo el catálogo, no solo lo que se enseña: si el cliente pide
  // otro día, el agente tiene alternativas legítimas que aceptar. Con el tipo:
  // la reserva lo toma de la oferta.
  await replaceOffers(
    input.organizationId,
    input.conversationId,
    spread.map((s) => ({ startUtc: s.startUtc, label: s.label })),
    type.id
  );

  const shown = spread.slice(0, SHOWN);
  const lista = shown.map((s) => `• ${s.dayLabel} a las ${s.time}`).join("\n");
  const intro =
    input.intro?.trim() ||
    `Tengo estos horarios disponibles para tu ${lowerType(type.name)}:`;
  return { ok: true, text: `${intro}\n${lista}` };
}

/**
 * Reserva el instante elegido. La confirmación la redacta el MOTOR con los
 * datos reales (tipo, fecha, dirección): un texto del modelo podría prometer
 * otra hora u otro lugar.
 */
export async function bookSlot(input: {
  organizationId: string;
  conversationId: string;
  startUtc: string;
}): Promise<AgendaTurn> {
  try {
    const result = await createSessionBooking({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      startUtc: input.startUtc,
      source: "ai",
      requireOffer: true,
    });

    const settings = await getSettings(input.organizationId);
    let base = result.typeName
      ? `¡Listo! Te agendé tu ${lowerType(result.typeName)} para ${result.label}.`
      : `¡Listo! Te agendé para ${result.label}.`;
    if (settings.address) base += ` Te esperamos en ${settings.address}.`;

    // El enlace solo si la cita lo tiene (camino remoto; oculto en la UI).
    if (result.meetingLink) {
      return { ok: true, text: `${base}\nEnlace: ${result.meetingLink}` };
    }
    if (result.linkPending) {
      // La cita existe; el enlace no. No se promete lo que no se tiene.
      return {
        ok: true,
        text: `${base}\nEn un momento te comparto el enlace por aquí.`,
      };
    }
    return { ok: true, text: base };
  } catch (err) {
    if (!(err instanceof BookingError)) throw err;

    // Se ocupó o el modelo inventó la hora: en ambos casos se re-ofrece con
    // datos reales en vez de discutir con el cliente.
    if (err.slots.length > 0) {
      const lista = err.slots
        .slice(0, SHOWN)
        .map((s) => `• ${s.label}`)
        .join("\n");
      let disculpa =
        err.code === "slot_taken"
          ? "Se me acaba de ocupar ese horario, ¡perdón!"
          : "Déjame confirmarte los horarios que tengo:";
      // 023 (A11) — El tipo ofrecido se desactivó y quedó UNO solo: las
      // alternativas son de ese otro tipo y hay que decirlo.
      if (err.code === "slot_taken" && err.message === TYPE_GONE_MESSAGE) {
        const typeId = err.slots[0]?.typeId ?? null;
        const types = await listTypes(input.organizationId).catch(() => []);
        const next = types.find((t) => t.id === typeId);
        disculpa = next
          ? `Ese tipo de cita ya no está disponible; te puedo ofrecer ${lowerType(next.name)}:`
          : "Ese tipo de cita ya no está disponible. Tengo estos horarios:";
      }
      return { ok: false, text: `${disculpa}\n${lista}` };
    }
    // 023 (A11) — El tipo ofrecido se desactivó y no hay uno solo con qué
    // re-ofrecer: se pregunta el tipo.
    if (err.code === "slot_taken" && err.message === TYPE_GONE_MESSAGE) {
      const types = await listTypes(input.organizationId).catch(() => []);
      return { ok: false, text: typeQuestion(types) };
    }
    return {
      ok: false,
      text: "No pude agendarlo en este momento. Lo reviso con el equipo y te confirmo.",
    };
  }
}
