import type { Formality } from "@/lib/formality";

/**
 * 025 — Los textos del motor de agenda, por trato (`agent_profile.formality`).
 *
 * El negocio del incidente habla de usted y el motor tuteaba: un mismo hilo
 * mezclaba "le" del modelo con "te" del sistema. Todo texto que redacta el
 * motor (no el modelo) sale de aquí.
 *
 * Plantillas con `{type}`, `{label}`, `{day}`, `{address}`, `{names}`; se
 * llenan con `fill()`. Así el test puede revisar TODAS las cadenas "usted".
 */

export type AgendaCopy = {
  /** Cómo empieza la pregunta del tipo (el pipeline la reconoce). */
  typeQuestionPrefix: string;
  /** "{prefix} Tengo: {names}." */
  typeQuestion: string;
  noTypes: string;
  /** Sin fecha: encabezado de la oferta. */
  offerIntro: string;
  /** Con fecha: "Para el {day} tengo estos horarios para su {type}:". */
  offerIntroDay: string;
  /** El día pedido no tiene huecos (o está fuera de la ventana). */
  offerDayFallback: string;
  /** Sin fecha: invita a pedir otro día. */
  otherDayHint: string;
  noSlots: string;
  booked: string;
  bookedNoType: string;
  address: string;
  link: string;
  linkPending: string;
  /** La hora pedida no se ofreció (va antes de la re-oferta del día). */
  notOffered: string;
  /** Se ocupó al confirmar (va antes de la re-oferta del día). */
  slotTaken: string;
  typeGoneOne: string;
  typeGoneGeneric: string;
  bookFailed: string;
  /** La barrera descartó horarios inventados y el motor no pudo ofrecer. */
  checkLater: string;
};

export const AGENDA_COPY: Record<Formality, AgendaCopy> = {
  tu: {
    typeQuestionPrefix: "¿Qué tipo de cita te interesa?",
    typeQuestion: "¿Qué tipo de cita te interesa? Tengo: {names}.",
    noTypes:
      "Por ahora no puedo agendar en línea. Lo reviso con el equipo y te confirmo.",
    offerIntro: "Tengo estos horarios disponibles para tu {type}:",
    offerIntroDay: "Para el {day} tengo estos horarios para tu {type}:",
    offerDayFallback:
      "Ese día ya no tengo horarios para tu {type}; el más cercano es el {day}:",
    otherDayHint: "Si prefieres otro día, dime cuál.",
    noSlots:
      "Por ahora no me quedan horarios libres. Déjame confirmarlo con el equipo y te aviso.",
    booked: "¡Listo! Te agendé tu {type} para {label}.",
    bookedNoType: "¡Listo! Te agendé para {label}.",
    address: " Te esperamos en {address}.",
    link: "Enlace: {link}",
    linkPending: "En un momento te comparto el enlace por aquí.",
    notOffered: "Ese horario no lo tengo disponible.",
    slotTaken: "Se me acaba de ocupar ese horario, ¡perdón!",
    typeGoneOne:
      "Ese tipo de cita ya no está disponible; te puedo ofrecer {type}:",
    typeGoneGeneric: "Ese tipo de cita ya no está disponible. Tengo estos horarios:",
    bookFailed:
      "No pude agendarlo en este momento. Lo reviso con el equipo y te confirmo.",
    checkLater:
      "Déjame revisar los horarios disponibles con el equipo y te confirmo.",
  },
  usted: {
    typeQuestionPrefix: "¿Qué tipo de cita le interesa?",
    typeQuestion: "¿Qué tipo de cita le interesa? Tengo: {names}.",
    noTypes:
      "Por ahora no puedo agendar en línea. Lo reviso con el equipo y le confirmo.",
    offerIntro: "Tengo estos horarios disponibles para su {type}:",
    offerIntroDay: "Para el {day} tengo estos horarios para su {type}:",
    offerDayFallback:
      "Ese día ya no tengo horarios para su {type}; el más cercano es el {day}:",
    otherDayHint: "Si prefiere otro día, dígame cuál.",
    noSlots:
      "Por ahora no me quedan horarios libres. Permítame confirmarlo con el equipo y le aviso.",
    booked: "¡Listo! Le agendé su {type} para {label}.",
    bookedNoType: "¡Listo! Le agendé para {label}.",
    address: " Le esperamos en {address}.",
    link: "Enlace: {link}",
    linkPending: "En un momento le comparto el enlace por aquí.",
    notOffered: "Ese horario no lo tengo disponible.",
    slotTaken: "Se me acaba de ocupar ese horario, ¡disculpe!",
    typeGoneOne:
      "Ese tipo de cita ya no está disponible; le puedo ofrecer {type}:",
    typeGoneGeneric: "Ese tipo de cita ya no está disponible. Tengo estos horarios:",
    bookFailed:
      "No pude agendarlo en este momento. Lo reviso con el equipo y le confirmo.",
    checkLater:
      "Permítame revisar los horarios disponibles con el equipo y le confirmo.",
  },
};

export function agendaCopy(formality: Formality | null | undefined): AgendaCopy {
  return AGENDA_COPY[formality === "usted" ? "usted" : "tu"];
}

/** Llena `{clave}` con los valores; lo que falte queda vacío. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? "");
}

/**
 * Prefijos que reconoce `isTypeQuestion`: los dos tratos. El de tú es también
 * el de la 023 (mensajes ya guardados en conversaciones vivas).
 */
export const TYPE_QUESTION_PREFIXES: readonly string[] = [
  AGENDA_COPY.tu.typeQuestionPrefix,
  AGENDA_COPY.usted.typeQuestionPrefix,
];

/** ¿Este texto es la pregunta del tipo (en cualquier trato)? */
export function isTypeQuestion(text: string | null | undefined): boolean {
  const t = (text ?? "").trimStart();
  return TYPE_QUESTION_PREFIXES.some((p) => t.startsWith(p));
}
