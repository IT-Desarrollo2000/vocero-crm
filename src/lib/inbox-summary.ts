import type { ConversationCounts, InboxScope } from "@/lib/types";

export type SummaryItem = {
  id: "waiting" | "closing" | "reminders" | "inbox";
  count: number;
  title: string;
  hint: string;
  tone: "danger" | "warning" | "accent" | "neutral";
};

/** 035 B — Recordatorios propios de hoy (incluye vencidos) y vencidos. */
export type ReminderCounts = { today: number; overdue: number };

/** «en Mis chats», «en el Buzón», «en Equipo»; vacío sin alcance. */
function inScope(scope: InboxScope | null): string {
  if (scope === null) return "";
  if (scope === "inbox") return " en el Buzón";
  return scope === "mine" ? " en Mis chats" : " en Equipo";
}

/**
 * 031 — Hasta 3 accesos de «lo que te toca ahora» (panel derecho sin chat
 * abierto), SOLO con contadores que ya trae `/counts` (sin servidor nuevo):
 *  - `human`: «Por atender» = en manos de una persona y el cliente espera
 *    respuesta, dentro del alcance activo (`assigned=` va en la base de
 *    `countConversations`).
 *  - `closing`: la ventana cierra en menos de 2 h, mismo alcance.
 *  - 035 B `reminders`: «N recordatorios para hoy (M vencidos)» con
 *    `GET /api/follow-ups/count` (los PROPIOS, en la zona del negocio); solo
 *    si N > 0. Lleva a Seguimiento › Pendientes.
 *  - `scopes.inbox.all`: chats sin responsable (no archivados), solo en modo
 *    equipo y si no estás ya en el Buzón.
 * Puro: lo usa `src/components/inbox/inbox-summary.tsx` y lo cubre
 * `tests/unit/inbox-summary.test.ts`.
 */
export function summaryItems(
  counts: Pick<ConversationCounts, "human" | "closing" | "scopes"> | null,
  opts: { scope: InboxScope | null; teamMode: boolean },
  reminders: ReminderCounts | null = null
): SummaryItem[] {
  if (!counts) return [];
  const where = inScope(opts.scope);
  const out: SummaryItem[] = [];
  if (counts.human > 0) {
    out.push({
      id: "waiting",
      count: counts.human,
      title:
        counts.human === 1
          ? `1 cliente espera respuesta${where}`
          : `${counts.human} clientes esperan respuesta${where}`,
      hint: "Ábrelos en «Por atender» y respóndeles primero.",
      tone: "danger",
    });
  }
  if (counts.closing > 0) {
    out.push({
      id: "closing",
      count: counts.closing,
      title:
        counts.closing === 1
          ? `A 1 chat${where} se le cierra la ventana en menos de 2 h`
          : `A ${counts.closing} chats${where} se les cierra la ventana en menos de 2 h`,
      hint: "Respóndeles ya; después solo podrás escribirles con una plantilla.",
      tone: "warning",
    });
  }
  if (reminders && reminders.today > 0) {
    const n = reminders.today;
    const late = Math.min(reminders.overdue, n);
    out.push({
      id: "reminders",
      count: n,
      title:
        (n === 1 ? "1 recordatorio para hoy" : `${n} recordatorios para hoy`) +
        (late > 0 ? ` (${late} ${late === 1 ? "vencido" : "vencidos"})` : ""),
      hint: "Ábrelos en Seguimiento › Pendientes.",
      tone: "accent",
    });
  }
  const inbox = counts.scopes?.inbox.all ?? 0;
  if (opts.teamMode && opts.scope !== "inbox" && inbox > 0) {
    out.push({
      id: "inbox",
      count: inbox,
      title: inbox === 1 ? "1 chat en el Buzón sin tomar" : `${inbox} chats en el Buzón sin tomar`,
      hint: "Toma uno para que quede a tu nombre.",
      tone: "neutral",
    });
  }
  return out;
}
