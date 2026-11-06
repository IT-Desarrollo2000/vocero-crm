import { describe, expect, it } from "vitest";
import {
  amountHeading,
  bookingLabel,
  cardView,
  clockLabel,
  defaultFilter,
  durationLabel,
  emptyColumnText,
  filterCounts,
  matchesFilter,
  parseFilter,
  pipelineTodo,
  stageFooterText,
  stageSubtitle,
  whenLabel,
  type CardContext,
  type CardLead,
  type CardViewer,
  type StageKind,
} from "@/lib/pipeline-card";

/**
 * 032 — Seguimiento que se explica solo: chips y siguiente paso de cada
 * tarjeta, filtro «Mis clientes · Sin tomar · Todos» y «lo que te toca».
 * Horas SIEMPRE en la zona del negocio (CDMX = UTC−6, sin horario de verano).
 */

const TZ = "America/Mexico_City";
// 6-nov-2026 12:00 en CDMX = 18:00 UTC.
const NOW = Date.parse("2026-11-06T18:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

const seller: CardViewer = { userId: "u_ana", role: "member", teamMode: true };
const owner: CardViewer = { userId: "u_owner", role: "owner", teamMode: true };
const soloOwner: CardViewer = { userId: "u_owner", role: "owner", teamMode: false };

function lead(over: Partial<CardLead> = {}): CardLead {
  return {
    id: "ld_1",
    contact: { id: "ct_1", name: "Sofía Castro" },
    conversationId: "cv_1",
    channel: "whatsapp",
    assignedTo: { id: "u_ana", name: "Ana López" },
    awaitingSince: null,
    lastInboundAt: iso(NOW - 12 * MIN),
    amountCents: null,
    currency: "MXN",
    nextBooking: null,
    ...over,
  };
}

function ctx(viewer: CardViewer, stageKind: StageKind = "open"): CardContext {
  return { viewer, now: NOW, tz: TZ, currency: "MXN", stageKind };
}

const chipTexts = (l: CardLead, c: CardContext) => cardView(l, c).chips.map((x) => x.text);

describe("tiempo en palabras (zona del negocio)", () => {
  it("hora de 12 h armada a mano", () => {
    expect(clockLabel("2026-11-07T22:00:00Z", TZ)).toBe("4:00 p. m.");
    expect(clockLabel("2026-11-07T06:05:00Z", TZ)).toBe("12:05 a. m.");
    expect(clockLabel("2026-11-07T18:00:00Z", TZ)).toBe("12:00 p. m.");
  });

  it("cita hoy / mañana / otra fecha", () => {
    expect(bookingLabel("2026-11-06T23:30:00Z", NOW, TZ)).toBe("Cita hoy · 5:30 p. m.");
    expect(bookingLabel("2026-11-07T22:00:00Z", NOW, TZ)).toBe("Cita mañana · 4:00 p. m.");
    expect(bookingLabel("2026-11-10T17:00:00Z", NOW, TZ)).toBe("Cita el mar 10 nov · 11:00 a. m.");
  });

  it("el día se corta en la zona del negocio, no en UTC", () => {
    // 7-nov 03:00 UTC = 6-nov 9:00 p. m. en CDMX: sigue siendo «hoy».
    expect(bookingLabel("2026-11-07T03:00:00Z", NOW, TZ)).toBe("Cita hoy · 9:00 p. m.");
  });

  it("duraciones", () => {
    expect(durationLabel(97 * MIN)).toBe("1 h 37 min");
    expect(durationLabel(12 * MIN)).toBe("12 min");
    expect(durationLabel(2 * HOUR)).toBe("2 h");
    expect(durationLabel(3 * DAY + HOUR)).toBe("3 días");
    expect(durationLabel(DAY)).toBe("1 día");
  });

  it("cuándo escribió", () => {
    expect(whenLabel(iso(NOW - 12 * MIN), NOW, TZ)).toBe("hace 12 min");
    // ayer 6:40 p. m. CDMX = 6-nov 00:40 UTC
    expect(whenLabel("2026-11-06T00:40:00Z", NOW, TZ)).toBe("ayer, 6:40 p. m.");
    expect(whenLabel("2026-11-06T15:10:00Z", NOW, TZ)).toBe("hoy, 9:10 a. m.");
  });
});

describe("cardView", () => {
  it("de otro vendedor (vista del Vendedor): «Lo atiende X», solo X abre, sin chat", () => {
    const v = cardView(lead({ assignedTo: { id: "u_marco", name: "Marco Ríos" } }), ctx(seller));
    expect(v.chips[0]).toEqual({ id: "owner", text: "Lo atiende Marco Ríos", tone: "neutral" });
    expect(v.note).toBe("Solo Marco abre este chat. Si necesitas algo, pídeselo.");
    expect(v.canOpenChat).toBe(false);
    expect(v.primary).toBeNull();
    expect(v.secondary.some((a) => a.kind === "open")).toBe(false);
  });

  it("de otro vendedor (vista del Propietario): mismo chip pero sí abre el chat", () => {
    const v = cardView(lead({ assignedTo: { id: "u_marco", name: "Marco Ríos" } }), ctx(owner));
    expect(v.chips[0]?.text).toBe("Lo atiende Marco Ríos");
    expect(v.canOpenChat).toBe(true);
    expect(v.note).toBe("Escribió hace 12 min.");
    expect(v.secondary.map((a) => a.label)).toEqual(["Abrir chat", "Poner monto"]);
  });

  it("sin tomar: «Nadie ha tomado su chat.» + «Tomar y responder»", () => {
    const v = cardView(lead({ assignedTo: null }), ctx(seller));
    expect(v.ownership).toBe("unassigned");
    expect(v.note).toBe("Nadie ha tomado su chat.");
    expect(v.primary).toEqual({
      kind: "take",
      label: "Tomar y responder",
      conversationId: "cv_1",
      href: "/inbox?contact=ct_1",
    });
  });

  it("Propietario sin equipo: el chat sin responsable es suyo (no pide tomarlo)", () => {
    const v = cardView(lead({ assignedTo: null }), ctx(soloOwner));
    expect(v.ownership).toBe("mine");
    expect(v.primary).toBeNull();
    // Sin equipo, «Tú lo atiendes» no informa nada.
    expect(v.chips).toEqual([]);
  });

  it("mío: «Tú lo atiendes», cuándo escribió, Abrir chat y Poner monto", () => {
    const v = cardView(lead(), ctx(seller));
    expect(v.chips[0]?.text).toBe("Tú lo atiendes");
    expect(v.note).toBe("Te escribió hace 12 min.");
    expect(v.secondary).toEqual([
      { kind: "open", label: "Abrir chat", href: "/inbox?contact=ct_1" },
      { kind: "amount", label: "Poner monto" },
    ]);
  });

  it("espera respuesta con su duración", () => {
    const v = cardView(lead({ awaitingSince: iso(NOW - 97 * MIN), assignedTo: null }), ctx(seller));
    expect(v.chips.map((c) => c.text)).toContain("Espera respuesta · 1 h 37 min");
  });

  it("WhatsApp con la ventana cerrada → plantilla", () => {
    const v = cardView(lead({ lastInboundAt: iso(NOW - 2 * DAY) }), ctx(seller));
    expect(v.note).toBe("Su chat se cerró: retómalo con un mensaje aprobado.");
    expect(v.primary).toEqual({
      kind: "template",
      label: "Retomar con plantilla",
      href: "/inbox?contact=ct_1",
    });
  });

  it("Instagram entre 24 h y 7 días: todavía se contesta (agente humano)", () => {
    const v = cardView(lead({ channel: "instagram", lastInboundAt: iso(NOW - 2 * DAY) }), ctx(seller));
    expect(v.primary).toBeNull();
    expect(v.secondary[0]?.label).toBe("Abrir chat");
  });

  it("Messenger pasados 7 días: solo cuando le escriba, sin plantilla", () => {
    const v = cardView(lead({ channel: "messenger", lastInboundAt: iso(NOW - 8 * DAY) }), ctx(seller));
    expect(v.note).toBe(
      "Su chat se cerró: en Messenger solo puedes contestarle cuando vuelva a escribirte."
    );
    expect(v.primary).toBeNull();
    expect(JSON.stringify(v)).not.toMatch(/plantilla/i);
  });

  it("abierto sin entrante hace ≥3 días: chip neutro de género", () => {
    expect(chipTexts(lead({ lastInboundAt: iso(NOW - 3 * DAY - HOUR) }), ctx(seller))).toContain(
      "Sin escribirte hace 3 días"
    );
    expect(chipTexts(lead({ lastInboundAt: iso(NOW - 2 * DAY) }), ctx(seller)).join()).not.toMatch(
      /Sin escribir/
    );
    // En una etapa ganada no hay nada que enfriar.
    expect(
      chipTexts(lead({ lastInboundAt: iso(NOW - 5 * DAY) }), ctx(seller, "won")).join()
    ).not.toMatch(/Sin escribir/);
  });

  it("próxima cita", () => {
    const v = cardView(
      lead({ nextBooking: { id: "bk_1", scheduledAtUtc: "2026-11-07T22:00:00Z" } }),
      ctx(seller)
    );
    expect(v.chips.find((c) => c.id === "booking")?.text).toBe("Cita mañana · 4:00 p. m.");
  });

  it("ganado sin monto: avisa y ofrece capturar (nunca bloquea)", () => {
    const v = cardView(lead(), ctx(seller, "won"));
    expect(v.note).toBe("Compró, pero falta cuánto. Sin monto no suma en las ventas del mes.");
    expect(v.primary).toEqual({ kind: "amount", label: "Capturar monto" });
    expect(v.sale).toBeNull();
  });

  it("ganado con monto: «Venta de $X»", () => {
    const v = cardView(lead({ amountCents: 1_890_000 }), ctx(seller, "won"));
    expect(v.sale).toBe("Venta de $18,900.00");
    expect(v.primary).toBeNull();
  });

  it("sin conversación (alta manual): «Nunca te ha escrito», sin tomar", () => {
    const v = cardView(
      lead({ conversationId: null, channel: null, assignedTo: null, lastInboundAt: null }),
      ctx(seller)
    );
    expect(v.ownership).toBe("nochat");
    expect(v.note).toBe("Nunca te ha escrito.");
    expect(v.primary).toBeNull();
    expect(v.canOpenChat).toBe(false);
    expect(v.secondary).toEqual([{ kind: "amount", label: "Poner monto" }]);
  });

  it("chat sin entrantes (lo abrió una plantilla): no dice «se cerró»", () => {
    const v = cardView(lead({ lastInboundAt: null }), ctx(seller));
    expect(v.note).toBe("Nunca te ha escrito.");
    expect(v.primary?.label).toBe("Escribir con plantilla");
    const ig = cardView(lead({ lastInboundAt: null, channel: "instagram" }), ctx(seller));
    expect(ig.note).toMatch(/solo puedes contestarle cuando te escriba/);
    expect(ig.primary).toBeNull();
  });

  it("con monto en etapa abierta: se muestra el monto, ya no «Poner monto»", () => {
    const v = cardView(lead({ amountCents: 2_450_000 }), ctx(seller));
    expect(v.amount).toBe("$24,500.00");
    expect(v.secondary.some((a) => a.kind === "amount")).toBe(false);
  });
});

describe("filtro", () => {
  const leads = [
    lead({ id: "a" }),
    lead({ id: "b", assignedTo: null }),
    lead({ id: "c", assignedTo: { id: "u_marco", name: "Marco" } }),
    lead({ id: "d", conversationId: null, assignedTo: null }),
  ];

  it("conteos y pertenencia", () => {
    expect(filterCounts(leads, seller)).toEqual({ mine: 1, unassigned: 2, all: 4 });
    expect(leads.filter((l) => matchesFilter(l, "unassigned", seller)).map((l) => l.id)).toEqual([
      "b",
      "d",
    ]);
  });

  it("por defecto según rol, y lectura segura de lo guardado", () => {
    expect(defaultFilter("member")).toBe("mine");
    expect(defaultFilter("owner")).toBe("all");
    expect(parseFilter("unassigned")).toBe("unassigned");
    expect(parseFilter("basura")).toBeNull();
    expect(parseFilter(null)).toBeNull();
  });
});

describe("pipelineTodo", () => {
  const opts = { viewer: seller, now: NOW, tz: TZ, agenda: true };

  it("sin pendientes → lista vacía (no hay franja)", () => {
    expect(pipelineTodo([{ ...lead(), stageKind: "open" }], opts)).toEqual([]);
  });

  it("los cuatro accesos, solo sobre lo del Vendedor (salvo citas visibles)", () => {
    const items = pipelineTodo(
      [
        { ...lead({ id: "w", awaitingSince: iso(NOW - HOUR) }), stageKind: "open" },
        { ...lead({ id: "s1", lastInboundAt: iso(NOW - 4 * DAY) }), stageKind: "open" },
        { ...lead({ id: "s2", lastInboundAt: iso(NOW - 5 * DAY) }), stageKind: "open" },
        { ...lead({ id: "v" }), stageKind: "won" },
        // De otro: no cuenta en lo tuyo.
        {
          ...lead({ id: "x", assignedTo: { id: "u_marco", name: "Marco" }, awaitingSince: iso(NOW - HOUR) }),
          stageKind: "open",
        },
        {
          ...lead({
            id: "c",
            contact: { id: "ct_9", name: "Laura Gómez" },
            nextBooking: { id: "bk", scheduledAtUtc: "2026-11-07T17:00:00Z" },
          }),
          stageKind: "open",
        },
      ],
      opts
    );
    expect(items.map((i) => [i.id, i.count, i.title])).toEqual([
      ["waiting", 1, "1 cliente tuyo espera tu respuesta"],
      ["stale", 2, "Clientes tuyos sin respuesta hace 3 días o más"],
      ["noAmount", 1, "Venta sin monto"],
      ["tomorrow", 1, "Cita mañana"],
    ]);
    expect(items.find((i) => i.id === "tomorrow")?.hint).toBe("Laura 11:00 a. m.");
    expect(items.find((i) => i.id === "waiting")?.href).toBe("/inbox");
    expect(items.find((i) => i.id === "tomorrow")?.href).toBe("/bookings");
    expect(items.find((i) => i.id === "noAmount")?.leadId).toBe("v");
  });

  it("sin agenda no hay «Citas mañana»; el Propietario cuenta todo", () => {
    const l = [
      {
        ...lead({ assignedTo: { id: "u_marco", name: "Marco" }, nextBooking: { id: "b", scheduledAtUtc: "2026-11-07T17:00:00Z" } }),
        stageKind: "won" as const,
      },
    ];
    expect(pipelineTodo(l, { ...opts, viewer: owner, agenda: false }).map((i) => i.id)).toEqual([
      "noAmount",
    ]);
  });
});

describe("columnas", () => {
  it("subtítulos y vacíos", () => {
    expect(stageSubtitle("won")).toBe("ya compró");
    expect(stageSubtitle("lost")).toBe("no compró");
    expect(stageSubtitle("open")).toBeNull();
    expect(emptyColumnText("lost", null)[0]).toBe("Aquí van los que decidieron no comprar.");
    expect(emptyColumnText("open", null)).toEqual([
      "Nadie en esta etapa todavía.",
      "Arrastra una tarjeta aquí o cámbiala desde su panel.",
    ]);
    // Vacía por el filtro no es «nadie en esta etapa».
    expect(emptyColumnText("open", "mine")[0]).not.toMatch(/Nadie en esta etapa/);
  });

  it("pie en palabras", () => {
    expect(
      stageFooterText(
        [
          { amountCents: 2_450_000, currency: "MXN" },
          { amountCents: null, currency: null },
        ],
        "MXN"
      )
    ).toEqual({ main: "Suma $24,500.00 · a 1 le falta el monto", otherCurrency: null });
    expect(stageFooterText([{ amountCents: null, currency: null }], "MXN")?.main).toBe(
      "A 1 le falta el monto"
    );
    expect(
      stageFooterText([{ amountCents: 100, currency: "USD" }], "MXN")
    ).toEqual({ main: "Sin montos capturados", otherCurrency: "1 en otra moneda, fuera de la suma" });
    expect(stageFooterText([], "MXN")).toBeNull();
  });

  it("monto en palabras llanas", () => {
    expect(amountHeading("MXN")).toBe("Monto en pesos");
    expect(amountHeading("USD")).toBe("Monto en USD");
  });
});
