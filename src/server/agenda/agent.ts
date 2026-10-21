import type { AgentActionRecord } from "@/lib/agent-action";
import { matchTypeByName } from "@/lib/agenda-types";
import type { Formality } from "@/lib/formality";
import { addDaysISO, dayIsoInTz, timeInTz, todayInTz } from "@/lib/time/slots";
import { computeAvailability, type AvailableSlot } from "@/server/agenda/availability";
import {
  agendaCopy,
  fill,
  isTypeQuestion,
  AGENDA_COPY,
  type AgendaCopy,
} from "@/server/agenda/copy";
import {
  normalizeSlotKey,
  shortLabel,
  slotKeyToUtc,
} from "@/server/agenda/offer-format";
import { getSettings } from "@/server/agenda/settings";
import { spreadByDay } from "@/server/agenda/spread";
import {
  findOffered,
  getOffers,
  replaceOffers,
  type OfferedSlot,
} from "@/server/agenda/offers";
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
 *
 * 025 — Incidente del 21-oct (el agente inventó horarios y no pudo reservar):
 *  - `offerSlots` acepta `date` (día pedido, acotado a la ventana; sin huecos
 *    ⇒ el día más cercano, diciéndolo) y `part` (mañana/tarde);
 *  - `bookSlot` acepta `slot` ("YYYY-MM-DD HH:MM" en hora LOCAL) y lo resuelve
 *    contra el MISMO array de ofertas que vio el prompt; nada de ISO a ojo;
 *  - hora no ofrecida u ocupada ⇒ re-oferta del día pedido sin repetir lo que
 *    el cliente ya vio;
 *  - los textos respetan el trato (tú/usted) y cada turno devuelve la acción
 *    que lo produjo (`agentAction`) para que el historial no le enseñe al
 *    modelo a escribir horarios.
 */

/** Cuántos huecos se le enseñan al cliente en un mensaje (sin fecha). */
const SHOWN = 3;
/** Cuántos se guardan como reservables: el catálogo es más ancho que el menú. */
const OFFERED = 12;
/** Con fecha: cuántos se enseñan, repartidos en el día. */
const DAY_SHOWN = 4;
/** Con fecha: tope de reservables del día. */
const DAY_OFFERED = 24;

export type DayPart = "mañana" | "tarde";

export type AgendaTurn = {
  /** Lo que hay que enviarle al cliente. */
  text: string;
  /** false ⇒ el motor no pudo (o re-ofreció); el turno sigue, sin agendar. */
  ok: boolean;
  /**
   * 025 — La acción que produjo el texto, para `message.agent_action`.
   * Ausente en la pregunta del tipo y en los textos de "no pude".
   */
  agentAction?: AgentActionRecord;
};

/** "Prueba de manejo, Servicio, Garantía u Otro". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  const last = names[names.length - 1]!;
  // "u" ante sonido /o/: "Garantía u Otro".
  const conj = /^h?o/i.test(last) ? "u" : "o";
  return `${names.slice(0, -1).join(", ")} ${conj} ${last}`;
}

/** Cómo empieza la pregunta del tipo en tú (la de la 023). */
export const TYPE_QUESTION_PREFIX = AGENDA_COPY.tu.typeQuestionPrefix;

export { isTypeQuestion };

/** La pregunta del tipo, con los nombres REALES del catálogo. */
export function typeQuestion(
  types: Pick<AppointmentType, "name">[],
  formality?: Formality | null
): string {
  const copy = agendaCopy(formality);
  if (types.length === 0) return copy.noTypes;
  return fill(copy.typeQuestion, { names: joinNames(types.map((t) => t.name)) });
}

function lowerType(name: string): string {
  return name.toLocaleLowerCase("es");
}

/** "viernes 23 de octubre" (sin "hoy"/"mañana": va tras "el"). */
function dayWords(startUtc: string, tz: string): string {
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
  })
    .format(new Date(startUtc))
    .replace(",", "");
}

/** Hasta `k` elementos repartidos uniformemente (primero y último incluidos). */
export function pickSpread<T>(items: readonly T[], k: number): T[] {
  if (items.length <= k) return [...items];
  if (k <= 1) return items.slice(0, Math.max(0, k));
  const out: T[] = [];
  for (let i = 0; i < k; i++) {
    out.push(items[Math.round((i * (items.length - 1)) / (k - 1))]!);
  }
  return out;
}

function inPart(startUtc: string, tz: string, part: DayPart | undefined): boolean {
  if (!part) return true;
  const hhmm = timeInTz(startUtc, tz);
  return part === "mañana" ? hhmm < "12:00" : hhmm >= "12:00";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * El día que se ofrece cuando el pedido no tiene huecos: primero el más
 * cercano POSTERIOR; si no hay (p. ej. pidió más allá de la ventana), el más
 * cercano anterior.
 */
function nearestDay(days: readonly string[], wanted: string): string | null {
  const after = days.filter((d) => d > wanted).sort();
  if (after.length > 0) return after[0]!;
  const before = days.filter((d) => d < wanted).sort().reverse();
  return before[0] ?? null;
}

type OfferInput = {
  organizationId: string;
  conversationId: string;
  /** Frase de entrada del MODELO (ya pasada por la barrera). */
  intro?: string;
  /** 023 — El tipo que pidió el modelo (nombre libre; se resuelve aquí). */
  typeName?: string;
  /** 025 — El tipo por id (re-ofertas: el de la oferta vigente). */
  typeId?: string | null;
  /** 025 — Día pedido (YYYY-MM-DD, zona del negocio). */
  date?: string;
  /** 025 — Franja: mañana (< 12:00) o tarde (≥ 12:00), hora local. */
  part?: DayPart;
  /** 025 — Etiquetas cortas que el cliente ya vio: no se repiten si hay más. */
  exclude?: readonly string[];
  /** 025 — Texto del motor antes del encabezado (disculpa de re-oferta). */
  lead?: string;
  formality?: Formality | null;
  now?: Date;
};

export async function offerSlots(input: OfferInput): Promise<AgendaTurn> {
  const copy = agendaCopy(input.formality);
  const types = await listTypes(input.organizationId);
  let type =
    (input.typeId ? types.find((t) => t.id === input.typeId) : undefined) ??
    (input.typeName ? matchTypeByName(types, input.typeName) : null);
  if (!type && types.length === 1) type = types[0]!;
  if (!type) return { ok: false, text: typeQuestion(types, input.formality) };

  const settings = await getSettings(input.organizationId);
  const tz = settings.timezone;
  const now = input.now ?? new Date();
  const all = (
    await computeAvailability(input.organizationId, {
      settings,
      now,
      durationMinutes: type.durationMinutes,
      // Sin `ctx` es `strict`: la IA solo ofrece huecos sin NINGUNA cita.
    })
  ).filter((s) => inPart(s.startUtc, tz, input.part));
  const excluded = new Set(input.exclude ?? []);
  const intro = input.intro?.trim() || undefined;
  const typeLower = lowerType(type.name);

  const noSlots = (): AgendaTurn => ({
    // Agenda llena no es un error: es una respuesta que el cliente entiende.
    ok: false,
    // B1 — En una re-oferta (con `lead`) la intro del modelo también se antepone.
    text: [
      intro && input.lead ? intro : undefined,
      input.lead,
      intro && !input.date && !input.lead ? intro : copy.noSlots,
    ]
      .filter(Boolean)
      .join("\n"),
  });

  if (input.date && DATE_RE.test(input.date)) {
    return offerDay({
      input,
      copy,
      type,
      tz,
      now,
      all,
      excluded,
      intro,
      typeLower,
      maxDaysAhead: settings.maxDaysAhead,
      noSlots,
    });
  }

  const pool = all.filter((s) => !excluded.has(shortLabel(s.startUtc, tz)));
  let spread = spreadByDay(pool, { timezone: tz, limit: OFFERED, perDay: 3, now });
  // Repetir es mejor que no ofrecer nada.
  if (spread.length === 0) {
    spread = spreadByDay(all, { timezone: tz, limit: OFFERED, perDay: 3, now });
  }
  if (spread.length === 0) return noSlots();

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
  // R4 — El encabezado del motor va SIEMPRE; la intro del modelo se antepone,
  // nunca lo reemplaza (el cliente debe ver qué tipo y que son horarios reales).
  const header = fill(copy.offerIntro, { type: typeLower });
  const text = [intro, input.lead, header, lista, copy.otherDayHint]
    .filter(Boolean)
    .join("\n");
  return {
    ok: true,
    text,
    agentAction: {
      action: "offer_slots",
      type: type.name,
      date: null,
      part: input.part ?? null,
      shown: shown.map((s) => shortLabel(s.startUtc, tz)),
      ...(intro ? { reply: intro } : {}),
    },
  };
}

/** `offerSlots` con día pedido (A3): ventana, respaldo y reparto en el día. */
async function offerDay(c: {
  input: OfferInput;
  copy: AgendaCopy;
  type: AppointmentType;
  tz: string;
  now: Date;
  all: AvailableSlot[];
  excluded: Set<string>;
  intro: string | undefined;
  typeLower: string;
  maxDaysAhead: number;
  noSlots: () => AgendaTurn;
}): Promise<AgendaTurn> {
  const { input, copy, type, tz, now, all, excluded } = c;
  const wanted = input.date!;
  const today = todayInTz(now, tz);
  const last = addDaysISO(today, c.maxDaysAhead);

  const byDay = new Map<string, AvailableSlot[]>();
  for (const s of all) {
    const day = dayIsoInTz(new Date(s.startUtc), tz);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(s);
    else byDay.set(day, [s]);
  }

  // Pasado o más allá de la ventana cuenta como "sin huecos ese día".
  const inWindow = wanted >= today && wanted <= last;
  let day: string | null =
    inWindow && (byDay.get(wanted)?.length ?? 0) > 0 ? wanted : null;
  const fallback = day === null;
  if (!day) day = nearestDay([...byDay.keys()], wanted);
  if (!day) return c.noSlots();

  const registered = (byDay.get(day) ?? []).slice(0, DAY_OFFERED);
  await replaceOffers(
    input.organizationId,
    input.conversationId,
    registered.map((s) => ({ startUtc: s.startUtc, label: s.label })),
    type.id
  );

  // Lo ya visto no se repite si el día tiene otros; si no, se repite.
  const fresh = registered.filter((s) => !excluded.has(shortLabel(s.startUtc, tz)));
  const shown = pickSpread(fresh.length > 0 ? fresh : registered, DAY_SHOWN);
  const header = fill(fallback ? copy.offerDayFallback : copy.offerIntroDay, {
    day: dayWords(registered[0]!.startUtc, tz),
    type: c.typeLower,
  });
  const lista = shown.map((s) => `• ${timeInTz(s.startUtc, tz)}`).join("\n");
  return {
    ok: true,
    text: [c.intro, input.lead, header, lista].filter(Boolean).join("\n"),
    agentAction: {
      action: "offer_slots",
      type: type.name,
      date: day,
      part: input.part ?? null,
      shown: shown.map((s) => shortLabel(s.startUtc, tz)),
      ...(c.intro ? { reply: c.intro } : {}),
    },
  };
}

/**
 * Reserva el horario elegido. La confirmación la redacta el MOTOR con los
 * datos reales (tipo, fecha, dirección): un texto del modelo podría prometer
 * otra hora u otro lugar.
 *
 * 025 — `slot` ("YYYY-MM-DD HH:MM", hora local) o `startUtc`; los dos se
 * resuelven contra `offers` — el MISMO array que armó el prompt del turno
 * (A2) — por epoch exacto. `createSessionBooking` vuelve a validar contra la
 * BD dentro del candado: defensa en profundidad.
 */
export async function bookSlot(input: {
  organizationId: string;
  conversationId: string;
  slot?: string;
  startUtc?: string;
  /** Ofertas vigentes del turno; sin ellas se leen de la BD. */
  offers?: readonly OfferedSlot[];
  /** Etiquetas cortas que el cliente vio (re-oferta sin repetir). */
  shown?: readonly string[];
  /**
   * B1 — Frase del MODELO (ya pasada por la barrera): la respuesta al resto
   * del mensaje (p. ej. el precio). Se antepone a la confirmación o a la
   * re-oferta del motor; nunca la reemplaza.
   */
  intro?: string;
  formality?: Formality | null;
  now?: Date;
}): Promise<AgendaTurn> {
  const copy = agendaCopy(input.formality);
  const intro = input.intro?.trim() || undefined;
  const withIntro = (text: string) => (intro ? `${intro}\n${text}` : text);
  const settings = await getSettings(input.organizationId);
  const tz = settings.timezone;
  const offers =
    input.offers ?? (await getOffers(input.organizationId, input.conversationId));

  // El instante pedido y su día (para re-ofrecer ese día si no se puede).
  let requested: string | null = null;
  let day: string | undefined;
  const key = normalizeSlotKey(input.slot);
  if (key) {
    requested = slotKeyToUtc(key, tz);
    day = key.slice(0, 10);
  } else if (input.startUtc && !Number.isNaN(Date.parse(input.startUtc))) {
    requested = input.startUtc;
    day = dayIsoInTz(new Date(input.startUtc), tz);
  }

  const offered = requested ? findOffered([...offers], requested) : null;
  const reOffer = async (lead?: string): Promise<AgendaTurn> => {
    const turn = await offerSlots({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      typeId: offered?.typeId ?? offers[0]?.typeId ?? null,
      date: day,
      exclude: input.shown,
      intro,
      lead,
      formality: input.formality,
      now: input.now,
    });
    return { ...turn, ok: false };
  };

  // Sin instante legible: re-oferta de lo no mostrado.
  if (!requested) return reOffer();
  // No se ofreció: nunca se agenda; se re-ofrece ese día.
  if (!offered) return reOffer(copy.notOffered);

  try {
    const result = await createSessionBooking({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      startUtc: offered.startUtc,
      source: "ai",
      requireOffer: true,
      now: input.now,
    });

    let base = result.typeName
      ? fill(copy.booked, { type: lowerType(result.typeName), label: result.label })
      : fill(copy.bookedNoType, { label: result.label });
    if (settings.address) base += fill(copy.address, { address: settings.address });
    const agentAction: AgentActionRecord = {
      action: "book_slot",
      booked: shortLabel(offered.startUtc, tz),
      ...(intro ? { reply: intro } : {}),
    };

    // El enlace solo si la cita lo tiene (camino remoto; oculto en la UI).
    if (result.meetingLink) {
      return {
        ok: true,
        text: withIntro(`${base}\n${fill(copy.link, { link: result.meetingLink })}`),
        agentAction,
      };
    }
    if (result.linkPending) {
      // La cita existe; el enlace no. No se promete lo que no se tiene.
      return { ok: true, text: withIntro(`${base}\n${copy.linkPending}`), agentAction };
    }
    return { ok: true, text: withIntro(base), agentAction };
  } catch (err) {
    if (!(err instanceof BookingError)) throw err;

    // 023 (A11) — El tipo ofrecido se desactivó entre la oferta y la reserva.
    if (err.code === "slot_taken" && err.message === TYPE_GONE_MESSAGE) {
      const types = await listTypes(input.organizationId).catch(() => []);
      if (err.slots.length === 0) {
        // No hay uno solo con qué re-ofrecer: se pregunta el tipo.
        return { ok: false, text: typeQuestion(types, input.formality) };
      }
      // Quedó UNO solo: las alternativas son de ese otro tipo y hay que decirlo.
      const typeId = err.slots[0]?.typeId ?? null;
      const next = types.find((t) => t.id === typeId);
      const shown = err.slots.slice(0, SHOWN);
      const disculpa = next
        ? fill(copy.typeGoneOne, { type: lowerType(next.name) })
        : copy.typeGoneGeneric;
      return {
        ok: false,
        text: withIntro(`${disculpa}\n${shown.map((s) => `• ${s.label}`).join("\n")}`),
        agentAction: {
          action: "offer_slots",
          type: next?.name ?? null,
          date: null,
          part: null,
          shown: shown.map((s) => shortLabel(s.startUtc, tz)),
          ...(intro ? { reply: intro } : {}),
        },
      };
    }
    // A7 — Se ocupó, o la oferta de la BD ya no era la del prompt: en ambos
    // casos se re-ofrece EL DÍA pedido con datos reales.
    if (err.code === "slot_taken") return reOffer(copy.slotTaken);
    if (err.code === "slot_not_offered") return reOffer(copy.notOffered);
    return { ok: false, text: withIntro(copy.bookFailed) };
  }
}
