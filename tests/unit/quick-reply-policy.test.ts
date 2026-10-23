import { describe, expect, it } from "vitest";
import {
  canCreateQuickReply,
  canEditQuickReply,
  forbiddenQuickReplyFields,
} from "@/lib/quick-reply-policy";

/** 029 (US-1/US-2, CA-1..CA-3): quién escribe en el catálogo de respuestas rápidas. */

const OWNER = { userId: "u_owner", role: "owner" as const };
const ANA = { userId: "u_ana", role: "member" as const };

const suya = { createdByUserId: "u_ana", productId: null };
const ajena = { createdByUserId: "u_beto", productId: null };
const conProducto = { createdByUserId: "u_ana", productId: "prd_1" };
const sinAutor = { createdByUserId: null, productId: null };

describe("canCreateQuickReply", () => {
  it("Propietario: siempre, aunque el interruptor esté apagado", () => {
    expect(canCreateQuickReply(OWNER, true)).toBe(true);
    expect(canCreateQuickReply(OWNER, false)).toBe(true);
  });

  it("Vendedor: solo con el interruptor encendido", () => {
    expect(canCreateQuickReply(ANA, true)).toBe(true);
    expect(canCreateQuickReply(ANA, false)).toBe(false);
  });
});

describe("canEditQuickReply", () => {
  it("Propietario: cualquiera (ajena, con producto, sin autor), con o sin interruptor", () => {
    for (const row of [suya, ajena, conProducto, sinAutor]) {
      expect(canEditQuickReply(OWNER, row, true)).toBe(true);
      expect(canEditQuickReply(OWNER, row, false)).toBe(true);
    }
  });

  it("Vendedor: solo la suya, de texto, con el interruptor encendido", () => {
    expect(canEditQuickReply(ANA, suya, true)).toBe(true);
    expect(canEditQuickReply(ANA, suya, false)).toBe(false);
    expect(canEditQuickReply(ANA, ajena, true)).toBe(false);
    expect(canEditQuickReply(ANA, conProducto, true)).toBe(false);
  });

  it("fila sin autor (se borró el usuario) = solo Propietario", () => {
    expect(canEditQuickReply(ANA, sinAutor, true)).toBe(false);
    expect(canEditQuickReply({ userId: "", role: "member" }, { ...sinAutor }, true)).toBe(false);
  });
});

describe("forbiddenQuickReplyFields", () => {
  it("Propietario: nada prohibido", () => {
    expect(
      forbiddenQuickReplyFields(OWNER, { productId: "prd_1", attach: "images", position: 0 })
    ).toEqual([]);
  });

  it("Vendedor: productId/attach nulos o ausentes se permiten", () => {
    expect(forbiddenQuickReplyFields(ANA, {})).toEqual([]);
    expect(forbiddenQuickReplyFields(ANA, { productId: null, attach: null })).toEqual([]);
  });

  it("Vendedor: productId/attach no nulos y cualquier position → prohibidos", () => {
    expect(forbiddenQuickReplyFields(ANA, { productId: "prd_1" })).toEqual(["productId"]);
    expect(forbiddenQuickReplyFields(ANA, { attach: "all" })).toEqual(["attach"]);
    expect(forbiddenQuickReplyFields(ANA, { position: 0 })).toEqual(["position"]);
    expect(
      forbiddenQuickReplyFields(ANA, { productId: "prd_1", attach: "images", position: 3 })
    ).toEqual(["productId", "attach", "position"]);
  });
});
