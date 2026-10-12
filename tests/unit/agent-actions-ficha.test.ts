import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatJson } from "@/lib/ai";
import { agentActionSchema, degradeAction } from "@/server/ai/actions";

/**
 * 04 — `ficha` acompaña a cualquier acción del agente (D-04-1) y JAMÁS
 * invalida la acción: un dato raro del modelo no puede costar la respuesta al
 * cliente (reintentos → handoff `error`).
 */

const base = agentActionSchema(false);
const conAgenda = agentActionSchema(true);

describe("acciones con ficha", () => {
  it("reply + ficha objeto → se conserva la ficha", () => {
    const r = base.safeParse({
      action: "reply",
      text: "¡Claro!",
      ficha: { modelo_interes: "T03", ciudad: "Villahermosa" },
    });
    expect(r.success && r.data).toEqual({
      action: "reply",
      text: "¡Claro!",
      ficha: { modelo_interes: "T03", ciudad: "Villahermosa" },
    });
  });

  it("ficha que no es objeto → se descarta sin invalidar la acción", () => {
    for (const ficha of ["no soy un objeto", 42, [1, 2], true]) {
      const r = base.safeParse({ action: "reply", text: "ok", ficha });
      expect(r.success).toBe(true);
      expect(r.success && r.data.ficha).toBeUndefined();
    }
  });

  it("ficha null → aceptada (y no se escribe nada)", () => {
    const r = base.safeParse({ action: "none", ficha: null });
    expect(r.success).toBe(true);
  });

  it("toda acción acepta ficha: handoff, move_stage, update_lead, agenda", () => {
    const ficha = { ciudad: "Villahermosa" };
    for (const a of [
      { action: "handoff", reason: "x", ficha },
      { action: "move_stage", stage: "Interesado", ficha },
      { action: "update_lead", note: "n", ficha },
    ]) {
      const r = base.safeParse(a);
      expect(r.success && r.data.ficha).toEqual(ficha);
    }
    const r = conAgenda.safeParse({ action: "offer_slots", ficha });
    expect(r.success && r.data.ficha).toEqual(ficha);
  });

  it("alias update_ficha con reply → reply + ficha", () => {
    const r = base.safeParse({
      action: "update_ficha",
      reply: "Perfecto",
      ficha: { presupuesto: "350 mil" },
    });
    expect(r.success && r.data).toEqual({
      action: "reply",
      text: "Perfecto",
      ficha: { presupuesto: "350 mil" },
    });
  });

  it("alias update_ficha sin texto → none + ficha", () => {
    const r = base.safeParse({ action: "update_ficha", ficha: { ciudad: "X" } });
    expect(r.success && r.data).toEqual({ action: "none", ficha: { ciudad: "X" } });
  });

  it("reply con `reply` en vez de `text` → se normaliza", () => {
    const r = base.safeParse({ action: "reply", reply: "Hola" });
    expect(r.success && r.data).toMatchObject({ action: "reply", text: "Hola" });
  });

  it("reply sin texto pero con ficha → inválido (no se vuelve `none` en silencio)", () => {
    expect(base.safeParse({ action: "reply", ficha: { ciudad: "X" } }).success).toBe(false);
    expect(
      conAgenda.safeParse({ action: "reply", text: "", ficha: { ciudad: "X" } }).success
    ).toBe(false);
  });

  it("reply sin texto ni ficha → sigue siendo inválido (como antes)", () => {
    expect(base.safeParse({ action: "reply" }).success).toBe(false);
  });

  it("sin agenda, offer_slots sigue fuera del esquema", () => {
    expect(base.safeParse({ action: "offer_slots" }).success).toBe(false);
  });

  it("degradeAction conserva la ficha", () => {
    expect(
      degradeAction({ action: "move_stage", stage: "?", reply: "ok", ficha: { a: 1 } })
    ).toEqual({ action: "reply", text: "ok", ficha: { a: 1 } });
    expect(degradeAction({ action: "book_slot", startUtc: "x", ficha: { a: 1 } })).toEqual({
      action: "none",
      ficha: { a: 1 },
    });
  });
});

/**
 * El `reply` sin texto con ficha entra al mismo carril que cualquier salida
 * inválida: `chatJson` reintenta con el esquema real del agente y, si nunca
 * cumple, devuelve `invalid_output` (→ handoff `error` en el pipeline).
 */
describe("reply sin texto con ficha → reintento", () => {
  beforeEach(() => {
    vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
    vi.stubEnv("DATABASE_URL", "postgresql://t:t@localhost:5432/t");
    vi.stubEnv("BETTER_AUTH_SECRET", "secret-de-test-suficiente");
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 3).toString("base64"));
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "verify-test");
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("OPENROUTER_MODEL", "modelo-test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function providerResponse(content: string) {
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  const SIN_TEXTO = JSON.stringify({ action: "reply", ficha: { ciudad: "Villahermosa" } });

  it("primer intento sin texto → reintenta y entrega la respuesta del segundo", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(providerResponse(SIN_TEXTO))
      .mockResolvedValueOnce(
        providerResponse(
          JSON.stringify({ action: "reply", text: "¡Claro!", ficha: { ciudad: "Villahermosa" } })
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatJson(base, [{ role: "user", content: "soy de Villahermosa" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok && result.data).toEqual({
      action: "reply",
      text: "¡Claro!",
      ficha: { ciudad: "Villahermosa" },
    });
  });

  it("siempre sin texto → invalid_output tras agotar los intentos", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(providerResponse(SIN_TEXTO)));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatJson(base, [{ role: "user", content: "soy de Villahermosa" }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_output");
  });
});
