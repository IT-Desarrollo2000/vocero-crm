import { describe, expect, it } from "vitest";
import {
  assigneeLabel,
  filterConversations,
  initials,
  isAwaiting,
  isMine,
  needsHuman,
} from "@/components/inbox/helpers";
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
    contact: { id: `ct_${seq}`, name: name ?? `Contacto ${seq}`, phone: phone ?? null, profileName: null },
    stageName: "Nuevo",
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
    // 09: sin asignar por defecto.
    assignedTo: null,
    assignedAt: null,
    // 06: clave de orden y etapa por id.
    sortAt: "2026-01-01T00:00:00.000Z",
    stageId: null,
    anuncio: null,
    archivedAt: null,
    archivedReason: null,
    awaitingSince: null,
    ...rest,
  } satisfies ConversationDto;
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
    awaitingSince: "2026-10-01T10:00:00.000Z",
  });
  const ana = mk({
    name: "Ana Kevinsky",
    unreadCount: 1,
    handoffAt: "2026-10-02T10:00:00.000Z",
    handoffReason: "hostilidad",
    aiEnabled: false,
    awaitingSince: "2026-10-02T10:05:00.000Z",
  });
  // IA apagada a mano, SIN handoff: también está en manos de una persona.
  const lucia = mk({
    name: "Lucía Sol",
    aiEnabled: false,
    awaitingSince: "2026-10-03T09:00:00.000Z",
  });
  // 026: escalada, pero ya contestada: "Atendida", fuera de "Por atender".
  const marta = mk({
    name: "Marta Atendida",
    handoffAt: "2026-10-02T08:00:00.000Z",
    handoffReason: "cliente",
    awaitingSince: null,
  });
  // Ni handoff ni IA apagada: la atiende el agente.
  const pablo = mk({ name: "Pablo Ríos" });
  const all = [kevin, diego, ana, lucia, marta, pablo];

  it("'all' devuelve todo, en el mismo orden", () => {
    const { visible, inInbox, searched } = filterConversations(all, {
      ...base,
      filter: "all",
    });
    expect(names(visible)).toEqual(names(all));
    expect(inInbox).toHaveLength(6);
    expect(searched).toHaveLength(6);
  });

  it("'unread' deja solo las que tienen mensajes sin leer", () => {
    const { visible } = filterConversations(all, { ...base, filter: "unread" });
    expect(names(visible)).toEqual(["Kevin Belier", "Ana Kevinsky"]);
  });

  it("'human' deja las que están en manos de una persona Y esperan respuesta (026)", () => {
    const { visible } = filterConversations(all, { ...base, filter: "human" });
    expect(names(visible)).toEqual(["Diego Pérez", "Ana Kevinsky", "Lucía Sol"]);
  });

  it("026: escalada ya contestada (awaitingSince null) NO está por atender", () => {
    expect(needsHuman(marta)).toBe(true);
    expect(isAwaiting(marta)).toBe(false);
    const { visible } = filterConversations([marta], { ...base, filter: "human" });
    expect(visible).toHaveLength(0);
  });

  it("026: esperando respuesta pero con la IA al mando NO está por atender", () => {
    // El cliente escribió y la IA aún no contesta: no es trabajo de nadie.
    const conIa = mk({ name: "Con IA", awaitingSince: "2026-10-03T09:00:00.000Z" });
    expect(needsHuman(conIa)).toBe(false);
    expect(isAwaiting(conIa)).toBe(false);
    const { visible } = filterConversations([conIa], { ...base, filter: "human" });
    expect(visible).toHaveLength(0);
  });

  it("IA apagada sin handoff SÍ cuenta como atención humana", () => {
    expect(needsHuman(lucia)).toBe(true);
    expect(needsHuman(diego)).toBe(true);
    expect(needsHuman(pablo)).toBe(false);
    expect(isAwaiting(lucia)).toBe(true);
    const { visible } = filterConversations([lucia], { ...base, filter: "human" });
    expect(names(visible)).toEqual(["Lucía Sol"]);
  });

  it("handoff + IA apagada cuenta una sola vez", () => {
    // Diego tiene ambos; no se duplica en la lista ni en el contador.
    const { visible } = filterConversations([diego, pablo], {
      ...base,
      filter: "human",
    });
    expect(names(visible)).toEqual(["Diego Pérez"]);
    expect([diego, pablo].filter(needsHuman)).toHaveLength(1);
  });

  it("handoff con la IA encendida también cuenta", () => {
    const juan = mk({ name: "Juan", handoffAt: "2026-10-03T10:00:00.000Z" });
    expect(needsHuman(juan)).toBe(true);
  });

  it("'human' se combina con la búsqueda", () => {
    const { visible, inInbox } = filterConversations(all, {
      ...base,
      query: "kevin",
      filter: "human",
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
    for (const filter of ["all", "unread", "human"] as const) {
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
  const waiting = { handoffAt: "2026-10-01T00:00:00Z", awaitingSince: "2026-10-01T00:00:00Z" };
  const a = mk({ name: "Alfa", stageName: "Interesado", ...waiting });
  const b = mk({ name: "Beta", stageName: "Nuevo", ...waiting });
  const c = mk({
    name: "Gama",
    stageName: "Interesado",
    channel: "instagram",
    ...waiting,
  });
  const all = [a, b, c];

  it("etapa + handoff", () => {
    const { visible } = filterConversations(all, {
      ...base,
      stage: "Interesado",
      filter: "human",
    });
    expect(names(visible)).toEqual(["Alfa", "Gama"]);
  });

  it("el canal es el filtro de afuera; `searched` no lo aplica (contadores por canal)", () => {
    const { searched, inInbox, visible } = filterConversations(all, {
      ...base,
      inbox: "instagram",
      filter: "human",
    });
    expect(searched).toHaveLength(3);
    expect(names(inInbox)).toEqual(["Gama"]);
    expect(names(visible)).toEqual(["Gama"]);
  });
});

describe("filterConversations — asignación (09)", () => {
  const yo = "usr_yo";
  const mia = mk({ name: "Mía", assignedTo: { userId: yo, name: "Yo Vendedor" } });
  const libre = mk({ name: "Libre", unreadCount: 1 });
  const ajena = mk({ name: "Ajena", assignedTo: { userId: "usr_otro", name: "Otra Persona" } });
  const all = [mia, libre, ajena];

  it("'mine' deja solo las asignadas a quien mira", () => {
    const { visible } = filterConversations(all, { ...base, filter: "mine", viewerId: yo });
    expect(names(visible)).toEqual(["Mía"]);
  });

  it("'mine' sin viewerId no adivina: queda vacía", () => {
    const { visible } = filterConversations(all, { ...base, filter: "mine" });
    expect(visible).toHaveLength(0);
  });

  it("'unassigned' deja las que nadie tiene", () => {
    const { visible } = filterConversations(all, {
      ...base,
      filter: "unassigned",
      viewerId: yo,
    });
    expect(names(visible)).toEqual(["Libre"]);
  });

  it("se combina con la búsqueda y el canal", () => {
    const ig = mk({ name: "Libre IG", channel: "instagram" });
    const { visible } = filterConversations([...all, ig], {
      ...base,
      query: "libre",
      inbox: "instagram",
      filter: "unassigned",
      viewerId: yo,
    });
    expect(names(visible)).toEqual(["Libre IG"]);
  });

  it("isMine / assigneeLabel / initials", () => {
    expect(isMine(mia, yo)).toBe(true);
    expect(isMine(ajena, yo)).toBe(false);
    expect(isMine(libre, yo)).toBe(false);
    expect(assigneeLabel(mia, yo)).toEqual({ kind: "mine", label: "Tuya" });
    expect(assigneeLabel(libre, yo)).toEqual({ kind: "none", label: "Sin asignar" });
    expect(assigneeLabel(ajena, yo)).toEqual({ kind: "other", label: "Otra Persona" });
    expect(initials("Ana María López")).toBe("AL");
    expect(initials("ana")).toBe("A");
    expect(initials("  ")).toBe("?");
  });
});
