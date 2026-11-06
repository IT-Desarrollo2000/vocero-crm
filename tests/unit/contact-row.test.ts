import { describe, expect, it } from "vitest";
import {
  contactRowView,
  remainingLabel,
  silenceLabel,
  type RowContact,
  type RowContext,
  type RowConversation,
} from "@/lib/contact-row";
import type { CardViewer } from "@/lib/pipeline-card";

/**
 * 032 — Contactos que se explican solos: la acción de cada fila según su
 * chat, quién mira y la hora. Mismas reglas de permiso que Seguimiento.
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

const ctx = (viewer: CardViewer = seller): RowContext => ({ viewer, now: NOW, tz: TZ });

function conv(over: Partial<RowConversation> = {}): RowConversation {
  return {
    id: "cv_1",
    channel: "whatsapp",
    assignedTo: { id: "u_ana", name: "Ana Pérez" },
    lastInboundAt: iso(NOW - 12 * MIN),
    ...over,
  };
}

function contact(over: Partial<RowContact> = {}): RowContact {
  return {
    id: "ct_1",
    channel: "whatsapp",
    phone: "5215500000011",
    conversation: conv(),
    ...over,
  };
}

describe("contactRowView — ventana abierta", () => {
  it("WhatsApp: «Abrir chat» lleno y cuánto le queda en palabras", () => {
    const v = contactRowView(contact(), ctx());
    expect(v.action).toEqual({
      kind: "open",
      label: "Abrir chat",
      href: "/inbox?contact=ct_1",
      strong: true,
    });
    expect(v.status).toBe("Te escribió hace 12 min · puedes escribirle libremente 23 h más");
    expect(v.tone).toBe("success");
    expect(v.who).toBe("tú lo atiendes");
    expect(v.reason).toBeNull();
  });

  it("menos de una hora de ventana: en minutos", () => {
    const v = contactRowView(
      contact({ conversation: conv({ lastInboundAt: iso(NOW - 23 * HOUR - 20 * MIN) }) }),
      ctx()
    );
    expect(v.status).toMatch(/libremente 40 min más$/);
  });

  it("Propietario sin equipo: no dice «tú lo atiendes»", () => {
    const v = contactRowView(contact({ conversation: conv({ assignedTo: null }) }), ctx(soloOwner));
    expect(v.ownership).toBe("mine");
    expect(v.who).toBeNull();
    expect(v.action?.kind).toBe("open");
  });
});

describe("contactRowView — WhatsApp fuera de las 24 h", () => {
  it("«Retomar con plantilla» lleva a la Bandeja", () => {
    const v = contactRowView(
      contact({ conversation: conv({ lastInboundAt: iso(NOW - 30 * HOUR) }) }),
      ctx()
    );
    expect(v.action).toEqual({
      kind: "template",
      label: "Retomar con plantilla",
      href: "/inbox?contact=ct_1",
    });
    expect(v.status).toBe("No te escribe desde hace 30 h · para retomarlo usa un mensaje aprobado");
    expect(v.tone).toBe("warning");
  });

  it("chat abierto por plantilla al que nunca contestó: «Escribir con plantilla»", () => {
    const v = contactRowView(contact({ conversation: conv({ lastInboundAt: null }) }), ctx());
    expect(v.action?.kind).toBe("template");
    expect(v.action?.label).toBe("Escribir con plantilla");
    expect(v.status).toMatch(/^Aún no te contesta/);
  });
});

describe("contactRowView — sin conversación", () => {
  it("WhatsApp con teléfono: «Escribir primero»", () => {
    const v = contactRowView(contact({ conversation: null }), ctx());
    expect(v.ownership).toBe("nochat");
    expect(v.action).toEqual({ kind: "first", label: "Escribir primero" });
    expect(v.status).toBe("Nunca te ha escrito · el primer mensaje tiene que ser uno aprobado");
  });

  it("sin teléfono (BSUID): sin acción y con el motivo", () => {
    const v = contactRowView(contact({ conversation: null, phone: null }), ctx());
    expect(v.action).toBeNull();
    expect(v.reason).toMatch(/^Sin teléfono/);
    expect(v.reason).toBe(v.status);
  });

  it("Instagram: solo contestar cuando te escriba, sin acción", () => {
    const v = contactRowView(
      contact({ channel: "instagram", phone: null, conversation: null }),
      ctx()
    );
    expect(v.action).toBeNull();
    expect(v.reason).toBe("Por Instagram solo puedes contestarle cuando te escriba");
  });

  it("Messenger: igual", () => {
    const v = contactRowView(contact({ channel: "messenger", conversation: null }), ctx());
    expect(v.action).toBeNull();
    expect(v.reason).toBe("Por Messenger solo puedes contestarle cuando te escriba");
  });
});

describe("contactRowView — Instagram/Messenger con chat", () => {
  const ig = (lastAgo: number) =>
    contact({
      channel: "instagram",
      phone: null,
      conversation: conv({ channel: "instagram", lastInboundAt: iso(NOW - lastAgo) }),
    });

  it("dentro de 24 h: como WhatsApp", () => {
    const v = contactRowView(ig(2 * HOUR), ctx());
    expect(v.action?.kind).toBe("open");
    expect(v.status).toMatch(/libremente 22 h más$/);
  });

  it("entre 24 h y 7 días: aún se contesta, con los días que quedan", () => {
    const v = contactRowView(ig(3 * DAY), ctx());
    expect(v.action).toMatchObject({ kind: "open", strong: false });
    expect(v.status).toBe(
      "Por Instagram puedes contestarle 4 días más; después, solo cuando te vuelva a escribir"
    );
  });

  it("pasados 7 días: solo cuando vuelva a escribir (abrir sirve para leer)", () => {
    const v = contactRowView(ig(8 * DAY), ctx());
    expect(v.action).toMatchObject({ kind: "open", strong: false });
    expect(v.status).toBe(
      "Por Instagram solo puedes contestarle cuando te vuelva a escribir: pasaron más de 7 días"
    );
  });
});

describe("contactRowView — de quién es", () => {
  const ajeno = contact({ conversation: conv({ assignedTo: { id: "u_marco", name: "Marco Ríos" } }) });

  it("Vendedor ante el chat de otro: «Lo atiende X», sin abrir", () => {
    const v = contactRowView(ajeno, ctx(seller));
    expect(v.ownership).toBe("other");
    expect(v.canOpenChat).toBe(false);
    expect(v.action).toBeNull();
    expect(v.reason).toBe("Lo atiende Marco Ríos · solo Marco abre su chat");
    // No revela cómo va el chat ajeno.
    expect(v.status).not.toMatch(/escribió/i);
  });

  it("Propietario ante el chat de otro: puede abrirlo y ve quién lo atiende", () => {
    const v = contactRowView(ajeno, ctx(owner));
    expect(v.canOpenChat).toBe(true);
    expect(v.action?.kind).toBe("open");
    expect(v.who).toBe("lo atiende Marco Ríos");
    expect(v.status).toMatch(/^Escribió hace 12 min/);
  });

  it("Vendedor ante un chat sin tomar (con equipo): «Tomar y responder», como Seguimiento", () => {
    const v = contactRowView(contact({ conversation: conv({ assignedTo: null }) }), ctx(seller));
    expect(v.ownership).toBe("unassigned");
    expect(v.canOpenChat).toBe(true);
    expect(v.who).toBe("nadie lo atiende todavía");
    expect(v.action).toEqual({
      kind: "take",
      label: "Tomar y responder",
      conversationId: "cv_1",
      href: "/inbox?contact=ct_1",
    });
    // La línea sigue diciendo cómo va su chat.
    expect(v.status).toMatch(/^Escribió hace 12 min/);
  });

  it("también con la ventana cerrada: primero se toma", () => {
    const v = contactRowView(
      contact({ conversation: conv({ assignedTo: null, lastInboundAt: iso(NOW - 30 * HOUR) }) }),
      ctx(seller)
    );
    expect(v.action?.kind).toBe("take");
    expect(v.status).toMatch(/para retomarlo usa un mensaje aprobado$/);
  });

  it("Propietario ante un chat sin tomar: lo abre, no lo toma", () => {
    const v = contactRowView(contact({ conversation: conv({ assignedTo: null }) }), ctx(owner));
    expect(v.ownership).toBe("unassigned");
    expect(v.action?.kind).toBe("open");
    expect(v.who).toBe("nadie lo atiende todavía");
  });

  it("vendedor sin nombre: no deja huecos", () => {
    const v = contactRowView(
      contact({ conversation: conv({ assignedTo: { id: "u_x", name: "" } }) }),
      ctx(seller)
    );
    expect(v.reason).toBe("Lo atiende otro vendedor · solo su vendedor abre su chat");
  });
});

describe("etiquetas de tiempo", () => {
  it("remainingLabel", () => {
    expect(remainingLabel(30 * 1000)).toBe("1 min");
    expect(remainingLabel(40 * MIN)).toBe("40 min");
    expect(remainingLabel(23 * HOUR + 48 * MIN)).toBe("23 h");
    expect(remainingLabel(3 * DAY + 2 * HOUR)).toBe("4 días");
    expect(remainingLabel(20 * HOUR + DAY)).toBe("2 días");
    expect(remainingLabel(-5)).toBe("1 min");
  });

  it("silenceLabel", () => {
    expect(silenceLabel(30 * HOUR)).toBe("30 h");
    expect(silenceLabel(47 * HOUR)).toBe("47 h");
    expect(silenceLabel(3 * DAY + HOUR)).toBe("3 días");
  });
});
