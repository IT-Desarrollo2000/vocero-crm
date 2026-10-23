import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionContext } from "@/lib/auth/session";

/**
 * 029 (US-3) — `GET /api/bookings/[id]/client`: la regla de la decisión 4
 * (completo = Propietario ∨ cita sin asignar ∨ cita asignada a mí ∨ veo el
 * chat), el botón según la visibilidad del chat, 404 a la cita ajena o de
 * otra organización y `card: null` en bloqueos. Las lecturas están simuladas;
 * la visibilidad de la cita es la real (`canViewBooking`).
 */

const sessionState: { current: SessionContext | null } = { current: null };
vi.mock("@/lib/auth/session", () => {
  class UnauthorizedError extends Error {}
  return {
    UnauthorizedError,
    requireSession: async () => {
      if (!sessionState.current) throw new UnauthorizedError();
      return sessionState.current;
    },
  };
});

const OWNER: SessionContext = { userId: "u_owner", organizationId: "org_1", role: "owner" };
const ANA: SessionContext = { userId: "u_ana", organizationId: "org_1", role: "member" };
const OTHER_ORG: SessionContext = { userId: "u_x", organizationId: "org_2", role: "owner" };

type BookingRow = {
  id: string;
  organizationId: string;
  kind: "session" | "block";
  contactId: string | null;
  conversationId: string | null;
  assignedUserId: string | null;
  createdByUserId: string | null;
};
let bookings: BookingRow[] = [];
vi.mock("@/server/agenda/queries", async (orig) => {
  const real = await orig<typeof import("@/server/agenda/queries")>();
  return {
    ...real,
    getVisibleBooking: async (org: string, id: string, viewer: { userId: string; role: "owner" | "member" }) => {
      const row = bookings.find((b) => b.organizationId === org && b.id === id);
      return row && real.canViewBooking(row, viewer) ? row : null;
    },
  };
});

/** Conversaciones que el Vendedor ve (el Propietario, todas). */
let visibleConversations = new Set<string>();
const canSeeConversation = vi.fn(
  async (_org: string, viewer: { role: string }, id: string) =>
    viewer.role === "owner" || visibleConversations.has(id)
);
vi.mock("@/server/inbox/visibility", () => ({ canSeeConversation }));

const CONTACT = {
  id: "ct_1",
  organizationId: "org_1",
  channel: "whatsapp" as const,
  waIdentity: "525511112222",
  phone: "525511112222" as string | null,
  waUserId: null,
  name: "Lucía",
  profileName: null,
  notes: "nota privada",
  ficha: { presupuesto: "alto" },
  fichaMeta: {},
  source: null,
  archivedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
let contact: typeof CONTACT | null = CONTACT;
vi.mock("@/server/contacts", async (orig) => {
  const real = await orig<typeof import("@/server/contacts")>();
  return {
    ...real,
    getContactById: async () => contact,
    getContactStage: async () => ({
      stage: { id: "st_1", name: "Interesado" },
      lead: { id: "ld_1", priority: "alta" },
    }),
  };
});

const ANUNCIO = {
  sourceId: "ad_1",
  sourceType: "ad",
  headline: "Promo octubre",
  body: null,
  imageUrl: null,
  sourceUrl: null,
  mediaType: null,
  capturedAt: new Date().toISOString(),
};
const anuncioDelContacto = vi.fn(async () => ANUNCIO);
vi.mock("@/server/attribution/store", () => ({ anuncioDelContacto }));

/** Lo que devuelve la consulta de la conversación de la cita. */
let convRows: { id: string; channel: string; assignedUserName: string | null }[] = [];
vi.mock("@/lib/db", async () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "leftJoin", "where", "orderBy"]) chain[m] = () => chain;
  chain.limit = async () => convRows;
  return { getDb: () => ({ select: () => chain }), schema: await import("@/lib/db/schema") };
});

const route = await import("@/app/api/bookings/[id]/client/route");
const { isClientRestricted } = await import("@/server/agenda/client-card");

const call = async (id: string) => {
  const res = await route.GET(new Request(`http://x/api/bookings/${id}/client`), {
    params: Promise.resolve({ id }),
  });
  return { status: res.status, json: res.status === 200 ? await res.json() : null };
};

const session = (over: Partial<BookingRow> = {}): BookingRow => ({
  id: "bk_1",
  organizationId: "org_1",
  kind: "session",
  contactId: "ct_1",
  conversationId: "cv_1",
  assignedUserId: null,
  createdByUserId: null,
  ...over,
});

beforeEach(() => {
  vi.stubEnv("AGENDA", "on");
  sessionState.current = null;
  bookings = [session()];
  contact = CONTACT;
  visibleConversations = new Set();
  convRows = [{ id: "cv_1", channel: "whatsapp", assignedUserName: "Juan" }];
  canSeeConversation.mockClear();
  anuncioDelContacto.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("isClientRestricted (decisión 4)", () => {
  it("solo restringe al Vendedor con cita de otro y chat ajeno", () => {
    expect(isClientRestricted(OWNER, { assignedUserId: "u_juan" }, false)).toBe(false);
    expect(isClientRestricted(ANA, { assignedUserId: null }, false)).toBe(false);
    expect(isClientRestricted(ANA, { assignedUserId: "u_ana" }, false)).toBe(false);
    expect(isClientRestricted(ANA, { assignedUserId: "u_juan" }, true)).toBe(false);
    expect(isClientRestricted(ANA, { assignedUserId: "u_juan" }, false)).toBe(true);
  });
});

describe("GET /api/bookings/[id]/client", () => {
  it("con AGENDA apagada: 404 antes de la sesión", async () => {
    vi.stubEnv("AGENDA", "");
    expect((await call("bk_1")).status).toBe(404);
  });

  it("sin sesión: 401", async () => {
    expect((await call("bk_1")).status).toBe(401);
  });

  it("Propietario: datos completos y puede abrir el chat", async () => {
    sessionState.current = OWNER;
    bookings = [session({ assignedUserId: "u_juan" })];
    const { status, json } = await call("bk_1");
    expect(status).toBe(200);
    expect(json.card).toMatchObject({
      contactId: "ct_1",
      name: "Lucía",
      phone: "525511112222",
      restricted: false,
      conversation: { id: "cv_1", assignedUserName: "Juan", canOpenChat: true },
      channel: "whatsapp",
      stageName: "Interesado",
      priority: "alta",
      source: { value: "anuncio", source: "deducida" },
      anuncio: { sourceId: "ad_1" },
    });
    // Solo los chips: notas y ficha no viajan en esta tarjeta.
    expect(json.card).not.toHaveProperty("notes");
    expect(json.card).not.toHaveProperty("ficha");
  });

  it("Vendedor, cita SIN asignar y chat ajeno (CA-5b): completo, botón deshabilitado", async () => {
    sessionState.current = ANA;
    const { status, json } = await call("bk_1");
    expect(status).toBe(200);
    expect(json.card.restricted).toBe(false);
    expect(json.card.channel).toBe("whatsapp");
    expect(json.card.anuncio).toMatchObject({ sourceId: "ad_1" });
    expect(json.card.conversation).toEqual({
      id: "cv_1",
      assignedUserName: "Juan",
      canOpenChat: false,
    });
  });

  it("Vendedor, cita asignada a él y chat ajeno: completo", async () => {
    sessionState.current = ANA;
    bookings = [session({ assignedUserId: "u_ana" })];
    const { json } = await call("bk_1");
    expect(json.card.restricted).toBe(false);
    expect(json.card.conversation.canOpenChat).toBe(false);
  });

  it("Vendedor, cita de otro (la creó él) y chat visible: completo y abre", async () => {
    sessionState.current = ANA;
    bookings = [session({ assignedUserId: "u_juan", createdByUserId: "u_ana" })];
    visibleConversations = new Set(["cv_1"]);
    const { json } = await call("bk_1");
    expect(json.card.restricted).toBe(false);
    expect(json.card.conversation.canOpenChat).toBe(true);
  });

  it("Vendedor, cita asignada a otro y chat ajeno (CA-5): solo nombre y teléfono", async () => {
    sessionState.current = ANA;
    bookings = [session({ assignedUserId: "u_juan", createdByUserId: "u_ana" })];
    const { status, json } = await call("bk_1");
    expect(status).toBe(200);
    expect(json.card).toEqual({
      contactId: "ct_1",
      name: "Lucía",
      phone: "525511112222",
      restricted: true,
      conversation: { id: "cv_1", assignedUserName: "Juan", canOpenChat: false },
    });
    for (const k of ["channel", "stageName", "priority", "source", "anuncio"]) {
      expect(json.card).not.toHaveProperty(k);
    }
    expect(anuncioDelContacto).not.toHaveBeenCalled();
  });

  it("Vendedor, cita que no puede ver (CA-6): 404", async () => {
    sessionState.current = ANA;
    bookings = [session({ assignedUserId: "u_juan" })];
    expect((await call("bk_1")).status).toBe(404);
  });

  it("cita inexistente: 404", async () => {
    sessionState.current = OWNER;
    expect((await call("bk_nope")).status).toBe(404);
  });

  it("cita de otra organización: 404 aunque sea Propietario", async () => {
    sessionState.current = OTHER_ORG;
    expect((await call("bk_1")).status).toBe(404);
  });

  it("bloqueo: card null", async () => {
    sessionState.current = OWNER;
    bookings = [session({ kind: "block", contactId: null, conversationId: null })];
    const { status, json } = await call("bk_1");
    expect(status).toBe(200);
    expect(json).toEqual({ card: null });
  });

  it("sin conversación: conversation null y sin botón (canOpenChat no consulta)", async () => {
    sessionState.current = ANA;
    convRows = [];
    bookings = [session({ conversationId: null })];
    const { json } = await call("bk_1");
    expect(json.card.conversation).toBeNull();
    expect(json.card.restricted).toBe(false);
    expect(canSeeConversation).not.toHaveBeenCalled();
  });

  it("identidad BSUID sin teléfono: phone null", async () => {
    sessionState.current = OWNER;
    contact = { ...CONTACT, waIdentity: "bsuid:abc", phone: null };
    const { json } = await call("bk_1");
    expect(json.card.phone).toBeNull();
  });
});
