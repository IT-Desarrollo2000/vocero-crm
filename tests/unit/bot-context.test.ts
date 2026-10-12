import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: () => ({}), schema: {} }));

import { buildBotContextPayload } from "@/server/bot/context";
import {
  renderContactContext,
  type ContactContext,
} from "@/server/ai/contact-context";

/**
 * 03 — Contrato ADITIVO de `GET /api/bot/context`: hay cerebros externos en
 * producción leyendo estas claves. Las viejas siguen ahí con el mismo tipo;
 * las nuevas se agregan. Si quitas o renombras una, este test lo grita.
 */

const contact = {
  id: "ct_1",
  organizationId: "org_1",
  channel: "whatsapp" as const,
  waIdentity: "5215550000000",
  phone: "5215550000000",
  waUserId: null,
  name: "Ana",
  notes: "vieja\n[IA] reciente",
  ficha: { modelo_interes: "T03" },
  source: null,
  archivedAt: null,
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-01T00:00:00Z"),
};
const conversation = {
  id: "cv_1",
  organizationId: "org_1",
  contactId: "ct_1",
  isTest: false,
  aiEnabled: true,
  handoffAt: null,
  handoffReason: null,
  handoffNote: null,
  lastInboundAt: new Date(),
  lastMessageAt: new Date(),
  unreadCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Parameters<typeof buildBotContextPayload>[0]["conversation"];
const lead = {
  lead: { id: "ld_1", amountCents: 1250000, currency: "MXN" },
  stage: { id: "st_1", name: "Interesado", kind: "open" },
} as unknown as Parameters<typeof buildBotContextPayload>[0]["lead"];

const ctx: ContactContext = {
  now: new Date("2026-10-12T18:00:00Z"),
  timezone: "America/Mexico_City",
  contact: {
    name: "Ana",
    channel: "whatsapp",
    source: null,
    createdAt: contact.createdAt,
    ficha: contact.ficha,
    notes: contact.notes,
  },
  lead: { stageName: "Interesado", stageKind: "open", amountCents: 1250000, currency: "MXN" },
  recurrent: null,
};

describe("buildBotContextPayload — contrato aditivo", () => {
  it("las claves previas siguen con el mismo tipo", () => {
    const body = buildBotContextPayload({
      contact,
      conversation,
      lead,
      ctx,
      block: renderContactContext(ctx),
    });
    expect(body.contact).toMatchObject({
      id: "ct_1",
      name: "Ana",
      identity: "5215550000000",
      waIdentity: "5215550000000",
      channel: "whatsapp",
      phone: "5215550000000",
      ficha: { modelo_interes: "T03" },
    });
    expect(body.conversation).toMatchObject({ id: "cv_1", aiEnabled: true, handoffAt: null });
    expect(typeof body.conversation.windowOpen).toBe("boolean");
    expect(typeof body.conversation.windowRemainingMs).toBe("number");
    expect(body.lead).toMatchObject({ id: "ld_1", stageName: "Interesado" });
  });

  it("agrega los campos nuevos y el bloque idéntico al del agente", () => {
    const block = renderContactContext(ctx);
    const body = buildBotContextPayload({ contact, conversation, lead, ctx, block });
    expect(body.contact.source).toEqual({ value: "desconocida", source: "deducida" });
    expect(body.contact.createdAt).toBe("2026-09-01T00:00:00.000Z");
    expect(body.contact.notes).toBe("vieja\n[IA] reciente");
    expect(body.lead).toMatchObject({ stageKind: "open", amountCents: 1250000, currency: "MXN" });
    expect(body.recurrent).toBeNull();
    expect(body.now).toEqual({ iso: "2026-10-12T18:00:00.000Z", timezone: "America/Mexico_City" });
    expect(body.agentContext.block).toBe(block);
  });

  it("attribution/bookings solo existen con su bandera (ctx sin la clave → ausente)", () => {
    const off = buildBotContextPayload({ contact, conversation, lead, ctx, block: null });
    expect("attribution" in off).toBe(false);
    expect("bookings" in off).toBe(false);
    const on = buildBotContextPayload({
      contact,
      conversation,
      lead,
      ctx: {
        ...ctx,
        attribution: { sourceType: "ad", headline: "H", body: "B" },
        bookings: {
          next: { scheduledAt: new Date("2026-10-13T16:00:00Z"), durationMinutes: 30, moreCount: 0 },
          last: null,
        },
      },
      block: null,
    });
    expect(on).toMatchObject({
      attribution: { sourceType: "ad", headline: "H", body: "B" },
      bookings: { next: { scheduledAt: "2026-10-13T16:00:00.000Z", durationMinutes: 30, moreCount: 0 }, last: null },
    });
  });

  it("sin contexto (falló al armarse) las claves previas salen igual", () => {
    const body = buildBotContextPayload({ contact, conversation, lead: null, ctx: null, block: null });
    expect(body.contact.id).toBe("ct_1");
    expect(body.lead).toBeNull();
    expect(body.agentContext.block).toBeNull();
    expect(body.now).toBeNull();
  });
});
