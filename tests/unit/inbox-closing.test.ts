import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  CLOSING_SOON_MS,
  closingRemainingMs,
  closingWindowGroups,
  isClosingSoon,
} from "@/lib/closing-window";
import { closingCondition } from "@/server/inbox/queries";
import { INBOX_FILTERS, parseInboxQuery } from "@/server/inbox/list-query";
import { filterConversations } from "@/components/inbox/helpers";
import {
  DEFAULT_FILTERS,
  countsFromLoaded,
  matchesFilters,
  mergeFirstPage,
} from "@/components/inbox/list-state";
import type { Channel } from "@/lib/channels";
import type { ConversationDto } from "@/lib/types";

/**
 * 05 — «Ventana por cerrar» (RF-05-13, CA-05-08): bordes del predicado y
 * paridad entre el SQL del servidor (`closingCondition`, interpretado con su
 * semántica: `channel in (…) and last_inbound_at > $after and
 * last_inbound_at <= $atOrBefore`) y su espejo en el cliente
 * (`filterConversations` / `matchesFilters`). Más `mergeFirstPage` (06:
 * refresco sin perder la posición).
 */

const H = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-12T18:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

let seq = 0;
function mk(over: Partial<ConversationDto> = {}): ConversationDto {
  seq++;
  return {
    id: `cv_${String(seq).padStart(3, "0")}`,
    channel: "whatsapp",
    contact: { id: `ct_${seq}`, name: `Contacto ${seq}`, phone: null },
    stageName: null,
    aiEnabled: true,
    handoffAt: null,
    handoffReason: null,
    handoffNote: null,
    lastInboundAt: null,
    lastMessageAt: null,
    unreadCount: 0,
    windowOpen: false,
    windowRemainingMs: 0,
    replyMode: "free",
    outboundFiles: null,
    outboundStructured: true,
    templates: true,
    preview: null,
    assignedTo: null,
    assignedAt: null,
    sortAt: "2026-01-01T00:00:00.000Z",
    stageId: null,
    ...over,
  } satisfies ConversationDto;
}

/** Evalúa en JS el SQL que `closingCondition(now)` manda a Postgres. */
function serverClosing(
  now: number,
  row: { channel: Channel; lastInboundAt: string | null }
): boolean {
  const { sql, params } = new PgDialect().sqlToQuery(closingCondition(new Date(now)));
  expect(sql).not.toContain("now()");
  // Un grupo por duración de ventana: (channel in (…) and > $a and <= $b).
  const groups = sql.split(" or ");
  expect(groups).toHaveLength(closingWindowGroups().length);
  let i = 0;
  return groups
    .map((g) => {
      expect(g).toMatch(/"channel" in \(/);
      expect(g).toMatch(/"last_inbound_at" > \$\d+/);
      expect(g).toMatch(/"last_inbound_at" <= \$\d+/);
      const nChannels = (g.slice(g.indexOf(" in (")).match(/\$\d+/g) ?? []).length - 2;
      const channels = params.slice(i, i + nChannels) as string[];
      const after = Date.parse(String(params[i + nChannels]));
      const atOrBefore = Date.parse(String(params[i + nChannels + 1]));
      i += nChannels + 2;
      if (row.lastInboundAt === null) return false; // NULL > x → NULL → fuera
      const t = Date.parse(row.lastInboundAt);
      return channels.includes(row.channel) && t > after && t <= atOrBefore;
    })
    .some(Boolean);
}

describe("«Ventana por cerrar» — bordes", () => {
  it("22 h exactas entra; 24 h exactas ya cerró; sin entrantes, fuera", () => {
    expect(isClosingSoon("whatsapp", ago(22 * H), NOW)).toBe(true);
    expect(isClosingSoon("whatsapp", ago(24 * H), NOW)).toBe(false);
    expect(isClosingSoon("whatsapp", ago(24 * H - 1), NOW)).toBe(true);
    expect(isClosingSoon("whatsapp", ago(22 * H - 1), NOW)).toBe(false);
    expect(isClosingSoon("whatsapp", ago(23 * H), NOW)).toBe(true);
    expect(isClosingSoon("whatsapp", ago(10 * H), NOW)).toBe(false);
    expect(isClosingSoon("whatsapp", null, NOW)).toBe(false);
    expect(isClosingSoon("whatsapp", "no-es-fecha", NOW)).toBe(false);
  });

  it("cuenta regresiva desde lastInboundAt (no del windowRemainingMs serializado)", () => {
    expect(closingRemainingMs("whatsapp", ago(23 * H), NOW)).toBe(1 * H);
    expect(closingRemainingMs("whatsapp", ago(22 * H), NOW)).toBe(CLOSING_SOON_MS);
    expect(closingRemainingMs("whatsapp", ago(10 * H), NOW)).toBeNull();
    // Al pasar el tiempo sale sola (CA-05-08).
    expect(closingRemainingMs("whatsapp", ago(23 * H), NOW + 61 * 60 * 1000)).toBeNull();
  });

  it("closing está en el catálogo y se parsea", () => {
    expect(INBOX_FILTERS).toContain("closing");
    expect(parseInboxQuery(new URLSearchParams("filter=closing")).filter).toBe("closing");
  });
});

describe("«Ventana por cerrar» — paridad servidor ≡ cliente", () => {
  const offsets = [
    0,
    1,
    10 * H,
    22 * H - 1,
    22 * H,
    22 * H + 1,
    23 * H,
    24 * H - 1,
    24 * H,
    24 * H + 1,
    48 * H,
  ];
  const channels: Channel[] = ["whatsapp", "instagram", "messenger"];

  it("coinciden en todos los bordes y canales", () => {
    const diffs: string[] = [];
    for (const channel of channels) {
      for (const lastInboundAt of [...offsets.map(ago), null]) {
        const row = mk({ channel, lastInboundAt });
        const server = serverClosing(NOW, { channel, lastInboundAt });
        const client = filterConversations([row], {
          query: "",
          stage: "all",
          inbox: "all",
          filter: "closing",
          now: NOW,
        }).visible.length === 1;
        const mirror = matchesFilters(row, { ...DEFAULT_FILTERS, filter: "closing" }, undefined, NOW);
        if (server !== client || client !== mirror) {
          diffs.push(`${channel} ${lastInboundAt}: servidor ${server}, cliente ${client}, espejo ${mirror}`);
        }
      }
    }
    expect(diffs).toEqual([]);
  });

  it("el respaldo de contadores cuenta closing con la misma regla", () => {
    const items = [
      mk({ lastInboundAt: new Date(Date.now() - 23 * H).toISOString() }),
      mk({ lastInboundAt: new Date(Date.now() - 10 * H).toISOString() }),
      mk({ lastInboundAt: null }),
    ];
    expect(countsFromLoaded(items, DEFAULT_FILTERS, undefined).closing).toBe(1);
  });
});

describe("mergeFirstPage — refresco sin perder la posición (06)", () => {
  const at = (h: number) => new Date(NOW - h * H).toISOString();
  const a = mk({ sortAt: at(1) });
  const b = mk({ sortAt: at(2) });
  const c = mk({ sortAt: at(3) });
  const d = mk({ sortAt: at(4) });
  const e = mk({ sortAt: at(5) });
  const loaded = [a, b, c, d, e];

  it("la página 1 manda en su tramo; lo de más abajo se conserva", () => {
    const nuevo = mk({ sortAt: at(0.5) });
    // Página 1 = [nuevo, a, c] (b salió del filtro): d y e siguen cargados.
    const merged = mergeFirstPage(loaded, [nuevo, a, c], false);
    expect(merged.map((x) => x.id)).toEqual([nuevo.id, a.id, c.id, d.id, e.id]);
  });

  it("una fila de abajo que subió se toma de la página (sin duplicar)", () => {
    const eUp = { ...e, sortAt: at(0.1) };
    const merged = mergeFirstPage(loaded, [eUp, a, b], false);
    expect(merged.map((x) => x.id)).toEqual([e.id, a.id, b.id, c.id, d.id]);
    expect(new Set(merged.map((x) => x.id)).size).toBe(merged.length);
  });

  it("página completa (sin cursor) reemplaza todo", () => {
    expect(mergeFirstPage(loaded, [a, b], true).map((x) => x.id)).toEqual([a.id, b.id]);
  });
});
