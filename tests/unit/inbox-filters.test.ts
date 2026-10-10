import { describe, expect, it } from "vitest";
import { filterConversations, needsHuman } from "@/components/inbox/helpers";
import type { ConversationDto } from "@/lib/types";

let seq = 0;
function mk(
  overrides: Partial<ConversationDto> & { name?: string; phone?: string | null } = {}
): ConversationDto {
  const { name, phone, ...rest } = overrides;
  seq++;
  return {
    id: `cv_${seq}`,
    channel: "whatsapp",
    contact: { id: `ct_${seq}`, name: name ?? `Contacto ${seq}`, phone: phone ?? null },
    stageName: "Nuevo",
    aiEnabled: true,
    handoffAt: null,
    handoffReason: null,
    lastInboundAt: null,
    lastMessageAt: null,
    unreadCount: 0,
    windowOpen: false,
    windowRemainingMs: 0,
    replyMode: "free",
    outboundMedia: true,
    templates: true,
    preview: null,
    ...rest,
  } as ConversationDto;
}

const base = { query: "", stage: "all", inbox: "all" as const };
const names = (list: ConversationDto[]) => list.map((c) => c.contact.name);

describe("filterConversations — pastillas de la bandeja", () => {
  const kevin = mk({ name: "Kevin Belier", phone: "524621349768", unreadCount: 2 });
  const diego = mk({
    name: "Diego Pérez",
    handoffAt: "2026-10-01T10:00:00.000Z",
    handoffReason: "cliente",
    aiEnabled: false,
  });
  const ana = mk({
    name: "Ana Kevinsky",
    unreadCount: 1,
    handoffAt: "2026-10-02T10:00:00.000Z",
    handoffReason: "hostilidad",
    aiEnabled: false,
  });
  // IA apagada a mano, SIN handoff: también es "atención humana".
  const lucia = mk({ name: "Lucía Sol", aiEnabled: false });
  // Ni handoff ni IA apagada: la atiende el agente.
  const pablo = mk({ name: "Pablo Ríos" });
  const all = [kevin, diego, ana, lucia, pablo];

  it("'all' devuelve todo, en el mismo orden", () => {
    const { visible, inInbox, searched } = filterConversations(all, {
      ...base,
      filter: "all",
    });
    expect(names(visible)).toEqual(names(all));
    expect(inInbox).toHaveLength(5);
    expect(searched).toHaveLength(5);
  });

  it("'unread' deja solo las que tienen mensajes sin leer", () => {
    const { visible } = filterConversations(all, { ...base, filter: "unread" });
    expect(names(visible)).toEqual(["Kevin Belier", "Ana Kevinsky"]);
  });

  it("'handoff' deja las que tienen handoffAt o la IA apagada", () => {
    const { visible } = filterConversations(all, { ...base, filter: "handoff" });
    expect(names(visible)).toEqual(["Diego Pérez", "Ana Kevinsky", "Lucía Sol"]);
  });

  it("IA apagada sin handoff SÍ cuenta como atención humana", () => {
    expect(needsHuman(lucia)).toBe(true);
    expect(needsHuman(diego)).toBe(true);
    expect(needsHuman(pablo)).toBe(false);
    const { visible } = filterConversations([lucia], { ...base, filter: "handoff" });
    expect(names(visible)).toEqual(["Lucía Sol"]);
  });

  it("handoff + IA apagada cuenta una sola vez", () => {
    // Diego tiene ambos; no se duplica en la lista ni en el contador.
    const { visible } = filterConversations([diego, pablo], {
      ...base,
      filter: "handoff",
    });
    expect(names(visible)).toEqual(["Diego Pérez"]);
    expect([diego, pablo].filter(needsHuman)).toHaveLength(1);
  });

  it("handoff con la IA encendida también cuenta", () => {
    const juan = mk({ name: "Juan", handoffAt: "2026-10-03T10:00:00.000Z" });
    expect(needsHuman(juan)).toBe(true);
  });

  it("'handoff' se combina con la búsqueda", () => {
    const { visible, inInbox } = filterConversations(all, {
      ...base,
      query: "kevin",
      filter: "handoff",
    });
    // La búsqueda trae a Kevin y a Ana Kevinsky; solo Ana pidió un humano.
    expect(names(inInbox)).toEqual(["Kevin Belier", "Ana Kevinsky"]);
    expect(names(visible)).toEqual(["Ana Kevinsky"]);
  });

  it("'unread' se combina con la búsqueda por teléfono con formato", () => {
    const { visible } = filterConversations(all, {
      ...base,
      query: "+52 462 134 9768",
      filter: "unread",
    });
    expect(names(visible)).toEqual(["Kevin Belier"]);
  });

  it("búsqueda sin coincidencias → nada, en cualquier pastilla", () => {
    for (const filter of ["all", "unread", "handoff"] as const) {
      const { visible } = filterConversations(all, {
        ...base,
        query: "zzz-no-existe",
        filter,
      });
      expect(visible).toHaveLength(0);
    }
  });
});

describe("filterConversations — etapa y canal", () => {
  const a = mk({ name: "Alfa", stageName: "Interesado", handoffAt: "2026-10-01T00:00:00Z" });
  const b = mk({ name: "Beta", stageName: "Nuevo", handoffAt: "2026-10-01T00:00:00Z" });
  const c = mk({
    name: "Gama",
    stageName: "Interesado",
    channel: "instagram",
    handoffAt: "2026-10-01T00:00:00Z",
  });
  const all = [a, b, c];

  it("etapa + handoff", () => {
    const { visible } = filterConversations(all, {
      ...base,
      stage: "Interesado",
      filter: "handoff",
    });
    expect(names(visible)).toEqual(["Alfa", "Gama"]);
  });

  it("el canal es el filtro de afuera; `searched` no lo aplica (contadores por canal)", () => {
    const { searched, inInbox, visible } = filterConversations(all, {
      ...base,
      inbox: "instagram",
      filter: "handoff",
    });
    expect(searched).toHaveLength(3);
    expect(names(inInbox)).toEqual(["Gama"]);
    expect(names(visible)).toEqual(["Gama"]);
  });
});
