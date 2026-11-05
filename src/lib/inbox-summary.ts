import type { ConversationCounts, InboxScope } from "@/lib/types";

export type SummaryItem = {
  id: "waiting" | "closing" | "inbox";
  count: number;
  title: string;
  hint: string;
  tone: "danger" | "warning" | "neutral";
};

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
 *  - `scopes.inbox.all`: chats sin responsable (no archivados), solo en modo
 *    equipo y si no estás ya en el Buzón.
 * Puro: lo usa `src/components/inbox/inbox-summary.tsx` y lo cubre
 * `tests/unit/inbox-summary.test.ts`.
 */
export function summaryItems(
  counts: Pick<ConversationCounts, "human" | "closing" | "scopes"> | null,
  opts: { scope: InboxScope | null; teamMode: boolean }
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
