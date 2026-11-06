/**
 * 032 — Seguimiento «que se explica solo». Puro: lo usa
 * `src/components/pipeline/pipeline-client.tsx` y lo cubre
 * `tests/unit/pipeline-card.test.ts`.
 *
 * Dado un trato, quién mira, la hora y la zona del NEGOCIO, decide qué dice
 * la tarjeta (chips + una línea) y cuál es su siguiente paso; además el
 * resumen «lo que te toca» y el filtro «Mis clientes · Sin tomar · Todos».
 *
 * La ventana se recalcula con `replyModeFor` (la misma regla que la Bandeja)
 * desde `lastInboundAt` y el `now` inyectado: así avanza con el reloj sin
 * volver a pedir el tablero. Nada aquí lee `Date.now()`.
 */

import { CHANNEL_LABEL, type Channel } from "@/lib/channels";
import { formatMoneyCents, sumable } from "@/lib/money";
import { firstName } from "@/lib/quick-replies";
import { isOwner, type Role } from "@/lib/roles";
import { wallClock } from "@/lib/time/calendar";
import { addDaysISO, dayIsoInTz } from "@/lib/time/slots";
import { replyModeFor } from "@/server/channels/capabilities";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** A partir de cuántos días sin entrante un trato abierto «se enfría». */
export const STALE_DAYS = 3;

export type StageKind = "open" | "won" | "lost";

export type CardLead = {
  id: string;
  contact: { id: string; name: string };
  conversationId: string | null;
  channel: Channel | null;
  assignedTo: { id: string; name: string } | null;
  awaitingSince: string | null;
  lastInboundAt: string | null;
  amountCents: number | null;
  currency: string | null;
  nextBooking: { id: string; scheduledAtUtc: string } | null;
};

export type CardViewer = {
  userId: string;
  role: Role;
  /** Sin equipo (Propietario solo), todo chat sin responsable es «tuyo». */
  teamMode: boolean;
};

export type CardContext = {
  viewer: CardViewer;
  now: number;
  /** Zona IANA del negocio: toda hora de la tarjeta se dice en ella. */
  tz: string;
  /** Moneda del negocio, para el trato que aún no trae la suya. */
  currency: string;
  stageKind: StageKind;
};

export type Ownership = "nochat" | "mine" | "unassigned" | "other";

export type ChipTone = "neutral" | "info" | "warning" | "danger" | "success";

export type CardChip = {
  id: "owner" | "waiting" | "stale" | "booking";
  text: string;
  tone: ChipTone;
};

export type CardAction =
  | { kind: "take"; label: string; conversationId: string; href: string }
  | { kind: "template"; label: string; href: string }
  | { kind: "open"; label: string; href: string }
  | { kind: "amount"; label: string };

export type CardView = {
  ownership: Ownership;
  /** ¿Quien mira puede abrir este chat en la Bandeja? */
  canOpenChat: boolean;
  chips: CardChip[];
  /** Una línea en palabras: qué pasa con este cliente. */
  note: string | null;
  /** «Venta de $X» (etapa ganada con monto). */
  sale: string | null;
  /** Monto ya capturado en una etapa abierta (se toca para editarlo). */
  amount: string | null;
  /** Botón lleno: el siguiente paso. */
  primary: CardAction | null;
  /** Botones discretos (abrir chat, poner monto). */
  secondary: CardAction[];
};

/* ───────────────────────── tiempo, en palabras ───────────────────────── */

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

/**
 * «4:00 p. m.» en la zona dada. Se arma a mano: `Intl` con `hour12` cambia
 * entre versiones de ICU («p.m.» / «p. m.»).
 */
export function clockLabel(instant: string | Date, tz: string): string {
  const { minutes } = wallClock(instant, tz);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "a. m." : "p. m."}`;
}

/**
 * Para PINTAR: une «4:00 p. m.» con espacios duros para que el renglón no se
 * corte en «4:00 p.» / «m.». Los textos de la lógica siguen con espacios
 * normales (los tests y los E2E los comparan así).
 */
export function keepClockTogether(text: string): string {
  return text.replace(/(\d) ([ap])\. m\./g, "$1 $2. m.");
}

/** «lun 3 nov» de una fecha ISO (YYYY-MM-DD). */
function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()] ?? ""} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""}`;
}

/** «hoy» · «mañana» · «ayer» · «el lun 3 nov», según el día en la zona. */
export function dayWord(instant: string | Date, now: number, tz: string): string {
  const day = dayIsoInTz(new Date(instant), tz);
  const today = dayIsoInTz(new Date(now), tz);
  if (day === today) return "hoy";
  if (day === addDaysISO(today, 1)) return "mañana";
  if (day === addDaysISO(today, -1)) return "ayer";
  return `el ${shortDate(day)}`;
}

/** «12 min» · «1 h 37 min» · «2 h» · «3 días». */
export function durationLabel(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < MIN_MS) return "menos de 1 min";
  if (safe < HOUR_MS) return `${Math.floor(safe / MIN_MS)} min`;
  if (safe < DAY_MS) {
    const h = Math.floor(safe / HOUR_MS);
    const m = Math.floor((safe % HOUR_MS) / MIN_MS);
    return m > 0 ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(safe / DAY_MS);
  return d === 1 ? "1 día" : `${d} días`;
}

/** «hace 12 min» · «hoy, 9:10 a. m.» · «ayer, 6:40 p. m.» · «el lun 3 nov, …». */
export function whenLabel(instant: string, now: number, tz: string): string {
  const ms = now - Date.parse(instant);
  if (ms < MIN_MS) return "hace un momento";
  if (ms < HOUR_MS) return `hace ${Math.floor(ms / MIN_MS)} min`;
  return `${dayWord(instant, now, tz)}, ${clockLabel(instant, tz)}`;
}

/** «Cita mañana · 4:00 p. m.» */
export function bookingLabel(scheduledAtUtc: string, now: number, tz: string): string {
  return `Cita ${dayWord(scheduledAtUtc, now, tz)} · ${clockLabel(scheduledAtUtc, tz)}`;
}

/* ───────────────────────── de quién es ───────────────────────── */

export function ownershipOf(
  lead: Pick<CardLead, "conversationId" | "assignedTo">,
  viewer: CardViewer
): Ownership {
  if (!lead.conversationId) return "nochat";
  if (lead.assignedTo?.id === viewer.userId) return "mine";
  if (!lead.assignedTo) return viewer.teamMode ? "unassigned" : "mine";
  return "other";
}

/** Días completos sin entrante (null si nunca escribió). */
function daysSilent(lead: Pick<CardLead, "lastInboundAt">, now: number): number | null {
  if (!lead.lastInboundAt) return null;
  const last = Date.parse(lead.lastInboundAt);
  if (!Number.isFinite(last)) return null;
  return Math.floor((now - last) / DAY_MS);
}

/** Trato abierto que se está enfriando (y nadie le debe respuesta). */
export function isStale(
  lead: Pick<CardLead, "lastInboundAt" | "awaitingSince">,
  stageKind: StageKind,
  now: number
): boolean {
  if (stageKind !== "open" || lead.awaitingSince) return false;
  const d = daysSilent(lead, now);
  return d !== null && d >= STALE_DAYS;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/* ───────────────────────── la tarjeta ───────────────────────── */

export function cardView(lead: CardLead, ctx: CardContext): CardView {
  const { viewer, now, tz, stageKind } = ctx;
  const own = ownershipOf(lead, viewer);
  const owner = isOwner(viewer);
  const href = `/inbox?contact=${lead.contact.id}`;
  const canOpenChat =
    own === "mine" || own === "unassigned" || (own === "other" && owner);
  const money = (cents: number) =>
    formatMoneyCents(cents, lead.currency ?? ctx.currency) ?? "";

  const chips: CardChip[] = [];
  if (own === "other") {
    chips.push({
      id: "owner",
      text: `Lo atiende ${lead.assignedTo?.name || "otro vendedor"}`,
      tone: "neutral",
    });
  } else if (own === "mine" && viewer.teamMode) {
    chips.push({ id: "owner", text: "Tú lo atiendes", tone: "info" });
  }
  if (own !== "nochat" && lead.awaitingSince && stageKind !== "lost") {
    chips.push({
      id: "waiting",
      text: `Espera respuesta · ${durationLabel(now - Date.parse(lead.awaitingSince))}`,
      tone: "warning",
    });
  }
  if (own !== "nochat" && isStale(lead, stageKind, now)) {
    const d = daysSilent(lead, now) ?? STALE_DAYS;
    chips.push({
      id: "stale",
      // Sin saber si es él o ella, la frase neutra.
      text: `${own === "mine" ? "Sin escribirte" : "Sin escribir"} hace ${d} días`,
      tone: "danger",
    });
  }
  if (lead.nextBooking) {
    chips.push({
      id: "booking",
      text: bookingLabel(lead.nextBooking.scheduledAtUtc, now, tz),
      tone: "info",
    });
  }

  const openChat: CardAction = { kind: "open", label: "Abrir chat", href };
  const view: CardView = {
    ownership: own,
    canOpenChat,
    chips,
    note: null,
    sale: null,
    amount: null,
    primary: null,
    secondary: [],
  };

  // Ganado: lo que importa es cuánto. Sin monto se avisa, pero JAMÁS se
  // impide ganar sin él (e2e-capi-reintento lo prueba).
  if (stageKind === "won") {
    if (lead.amountCents === null) {
      view.note = "Compró, pero falta cuánto. Sin monto no suma en las ventas del mes.";
      view.primary = { kind: "amount", label: "Capturar monto" };
    } else {
      view.sale = `Venta de ${money(lead.amountCents)}`;
    }
    if (canOpenChat) view.secondary.push(openChat);
    return view;
  }

  if (stageKind === "lost") {
    if (own === "other" && !owner) {
      view.note = `Solo ${firstName(lead.assignedTo?.name) || "su vendedor"} abre este chat.`;
    }
    if (canOpenChat) view.secondary.push(openChat);
    return view;
  }

  // Etapa abierta.
  if (lead.amountCents !== null) view.amount = money(lead.amountCents);
  const amountAction: CardAction | null =
    lead.amountCents === null ? { kind: "amount", label: "Poner monto" } : null;

  if (own === "nochat") {
    view.note = "Nunca te ha escrito.";
  } else if (own === "other" && !owner) {
    const who = firstName(lead.assignedTo?.name) || "su vendedor";
    view.note = `Solo ${who} abre este chat. Si necesitas algo, pídeselo.`;
  } else if (own === "unassigned") {
    view.note = "Nadie ha tomado su chat.";
    view.primary = {
      kind: "take",
      label: "Tomar y responder",
      conversationId: lead.conversationId ?? "",
      href,
    };
  } else {
    const channel = lead.channel ?? "whatsapp";
    const last = lead.lastInboundAt ? new Date(lead.lastInboundAt) : null;
    const mode = replyModeFor(channel, last, new Date(now));
    if (!last) {
      // Hay chat pero el cliente nunca contestó (p. ej. lo abrió una plantilla).
      if (mode === "template") {
        view.note = "Nunca te ha escrito.";
        view.primary = { kind: "template", label: "Escribir con plantilla", href };
      } else {
        view.note = `Nunca te ha escrito. En ${CHANNEL_LABEL[channel]} solo puedes contestarle cuando te escriba.`;
      }
    } else if (mode === "template") {
      view.note = "Su chat se cerró: retómalo con un mensaje aprobado.";
      view.primary = { kind: "template", label: "Retomar con plantilla", href };
    } else if (mode === "closed") {
      view.note = `Su chat se cerró: en ${CHANNEL_LABEL[channel]} solo puedes contestarle cuando vuelva a escribirte.`;
      view.secondary.push(openChat);
    } else {
      const when = whenLabel(lead.lastInboundAt ?? "", now, tz);
      // «ayer, 6:40 p. m.» ya cierra con punto: sin esto saldría «p. m..».
      const end = when.endsWith(".") ? "" : ".";
      view.note = own === "mine" ? `Te escribió ${when}${end}` : `Escribió ${when}${end}`;
      view.secondary.push(openChat);
    }
  }
  if (amountAction) view.secondary.push(amountAction);
  return view;
}

/* ───────────────────────── filtro ───────────────────────── */

export type PipelineFilter = "mine" | "unassigned" | "all";

export const FILTER_LABEL: Record<PipelineFilter, string> = {
  mine: "Mis clientes",
  unassigned: "Sin tomar",
  all: "Todos",
};

export function parseFilter(raw: string | null | undefined): PipelineFilter | null {
  return raw === "mine" || raw === "unassigned" || raw === "all" ? raw : null;
}

/** Vendedor arranca en «Mis clientes»; Propietario en «Todos». */
export function defaultFilter(role: Role): PipelineFilter {
  return isOwner(role) ? "all" : "mine";
}

/**
 * ¿Entra este trato en el filtro? «Sin tomar» incluye los que no tienen chat
 * (alta manual): nadie los tiene, y así el vendedor que acaba de darlo de
 * alta lo encuentra a un clic en vez de que desaparezca.
 */
export function matchesFilter(
  lead: Pick<CardLead, "conversationId" | "assignedTo">,
  filter: PipelineFilter,
  viewer: CardViewer
): boolean {
  if (filter === "all") return true;
  const own = ownershipOf(lead, viewer);
  if (filter === "mine") return own === "mine";
  return own === "unassigned" || own === "nochat";
}

export function filterCounts(
  leads: readonly Pick<CardLead, "conversationId" | "assignedTo">[],
  viewer: CardViewer
): Record<PipelineFilter, number> {
  const out = { mine: 0, unassigned: 0, all: leads.length };
  for (const l of leads) {
    if (matchesFilter(l, "mine", viewer)) out.mine++;
    if (matchesFilter(l, "unassigned", viewer)) out.unassigned++;
  }
  return out;
}

/* ───────────────────────── lo que te toca ───────────────────────── */

export type TodoItem = {
  id: "waiting" | "stale" | "noAmount" | "tomorrow";
  count: number;
  title: string;
  hint: string;
  tone: "danger" | "warning" | "info";
  /** A dónde lleva (si es otra pantalla). */
  href?: string;
  /** Primer trato afectado (p. ej. abrir su monto). */
  leadId?: string;
};

/**
 * Hasta 4 accesos, solo los que tienen algo:
 *  - waiting: tratos abiertos que esperan respuesta → Bandeja.
 *  - stale: tratos abiertos sin entrante hace ≥3 días.
 *  - noAmount: ventas (etapa ganada) sin monto.
 *  - tomorrow: citas de mañana (si hay agenda) → Citas. Ya llegan filtradas
 *    por lo que quien mira puede ver.
 * El Vendedor cuenta SUS tratos; el Propietario, todos (sin equipo no tiene
 * nada asignado y la franja quedaría siempre vacía).
 */
export function pipelineTodo(
  leads: readonly (CardLead & { stageKind: StageKind })[],
  opts: { viewer: CardViewer; now: number; tz: string; agenda: boolean }
): TodoItem[] {
  const { viewer, now, tz } = opts;
  const owner = isOwner(viewer);
  const mine = leads.filter((l) => owner || ownershipOf(l, viewer) === "mine");
  const yours = owner ? "" : " tuyos";
  const out: TodoItem[] = [];

  const waiting = mine.filter(
    (l) => l.stageKind === "open" && l.conversationId && l.awaitingSince
  );
  if (waiting.length > 0) {
    const n = waiting.length;
    out.push({
      id: "waiting",
      count: n,
      title: owner
        ? plural(n, "1 cliente espera respuesta", `${n} clientes esperan respuesta`)
        : plural(n, "1 cliente tuyo espera tu respuesta", `${n} clientes tuyos esperan tu respuesta`),
      hint: "Respóndeles primero en la Bandeja.",
      tone: "danger",
      href: "/inbox",
    });
  }

  const stale = mine.filter((l) => l.conversationId && isStale(l, l.stageKind, now));
  if (stale.length > 0) {
    out.push({
      id: "stale",
      count: stale.length,
      title: `${plural(stale.length, `Cliente${owner ? "" : " tuyo"}`, `Clientes${yours}`)} sin respuesta hace ${STALE_DAYS} días o más`,
      hint: plural(stale.length, "Retómalo antes de que se enfríe.", "Retómalos antes de que se enfríen."),
      tone: "danger",
      leadId: stale[0]?.id,
    });
  }

  const noAmount = mine.filter((l) => l.stageKind === "won" && l.amountCents === null);
  if (noAmount.length > 0) {
    const n = noAmount.length;
    out.push({
      id: "noAmount",
      count: n,
      title: plural(n, "Venta sin monto", `${n} ventas sin monto`),
      hint: plural(n, "Captúralo para que cuente en los reportes.", "Captúralos para que cuenten en los reportes."),
      tone: "warning",
      leadId: noAmount[0]?.id,
    });
  }

  if (opts.agenda) {
    const tomorrow = addDaysISO(dayIsoInTz(new Date(now), tz), 1);
    const citas = leads
      .filter((l) => l.nextBooking && dayIsoInTz(new Date(l.nextBooking.scheduledAtUtc), tz) === tomorrow)
      .sort((a, b) =>
        Date.parse(a.nextBooking?.scheduledAtUtc ?? "") - Date.parse(b.nextBooking?.scheduledAtUtc ?? "")
      );
    if (citas.length > 0) {
      const shown = citas.slice(0, 3).map(
        (l) => `${firstName(l.contact.name) || l.contact.name} ${clockLabel(l.nextBooking?.scheduledAtUtc ?? "", tz)}`
      );
      const rest = citas.length - shown.length;
      out.push({
        id: "tomorrow",
        count: citas.length,
        title: plural(citas.length, "Cita mañana", "Citas mañana"),
        hint: shown.join(" · ") + (rest > 0 ? ` · y ${rest} más` : ""),
        tone: "info",
        href: "/bookings",
      });
    }
  }
  return out;
}

/* ───────────────────────── columnas ───────────────────────── */

/** Subtítulo de la etapa: el nombre no se toca, se explica. */
export function stageSubtitle(kind: StageKind): string | null {
  if (kind === "won") return "ya compró";
  if (kind === "lost") return "no compró";
  return null;
}

/**
 * Texto de la columna vacía. `filtered` = la etapa tiene tratos, pero
 * ninguno entra en el filtro activo: eso no es una etapa vacía.
 */
export function emptyColumnText(kind: StageKind, filtered: PipelineFilter | null): string[] {
  if (filtered === "mine") return ["Ninguno de tus clientes está en esta etapa."];
  if (filtered === "unassigned") return ["Ningún cliente sin tomar en esta etapa."];
  if (kind === "lost") {
    return [
      "Aquí van los que decidieron no comprar.",
      "Al moverlos te preguntamos por qué, para saber qué mejorar.",
    ];
  }
  return ["Nadie en esta etapa todavía.", "Arrastra una tarjeta aquí o cámbiala desde su panel."];
}

/**
 * Totales de una columna. Se calculan al pintar: un total guardado se
 * desincroniza en cuanto alguien mueve una tarjeta. Todo en CENTAVOS enteros.
 */
export function stageTotals(
  leads: readonly Pick<CardLead, "amountCents" | "currency">[],
  businessCurrency: string
): { totalCents: number; sinMonto: number; otraMoneda: number; conMonto: number } {
  let totalCents = 0;
  let sinMonto = 0;
  let otraMoneda = 0;
  for (const l of leads) {
    if (l.amountCents === null) {
      sinMonto++;
      continue;
    }
    if (!sumable({ amountCents: l.amountCents, currency: l.currency }, businessCurrency)) {
      otraMoneda++;
      continue;
    }
    totalCents += l.amountCents;
  }
  return { totalCents, sinMonto, otraMoneda, conMonto: leads.length - sinMonto - otraMoneda };
}

/** Pie de columna en palabras; null si la columna está vacía. */
export function stageFooterText(
  leads: readonly Pick<CardLead, "amountCents" | "currency">[],
  businessCurrency: string
): { main: string; otherCurrency: string | null } | null {
  if (leads.length === 0) return null;
  const t = stageTotals(leads, businessCurrency);
  const falta =
    t.sinMonto > 0 ? plural(t.sinMonto, "a 1 le falta el monto", `a ${t.sinMonto} les falta el monto`) : null;
  let main: string;
  if (t.conMonto === 0) {
    // Un «$0.00» se lee como error del sistema, no como dato.
    main = falta ? falta.charAt(0).toUpperCase() + falta.slice(1) : "Sin montos capturados";
  } else {
    main = `Suma ${formatMoneyCents(t.totalCents, businessCurrency) ?? ""}${falta ? ` · ${falta}` : ""}`;
  }
  return {
    main,
    otherCurrency:
      t.otraMoneda > 0
        ? plural(t.otraMoneda, "1 en otra moneda, fuera de la suma", `${t.otraMoneda} en otra moneda, fuera de la suma`)
        : null,
  };
}

/** «Monto en pesos» (MXN) o «Monto en USD». */
export function amountHeading(currency: string): string {
  return currency === "MXN" ? "Monto en pesos" : `Monto en ${currency}`;
}
