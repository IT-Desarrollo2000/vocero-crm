import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * 030 — Cuerpo extra por rol (OPENROUTER_EXTRA_BODY / _JUDGE_EXTRA_BODY).
 * `getEnv()` memoiza: cada test re-importa los módulos tras `stubEnv`.
 */

const schema = z.object({ action: z.literal("none") });

function providerResponse() {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: '{"action":"none"}' } }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function baseEnv() {
  vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
  vi.stubEnv("DATABASE_URL", "postgresql://t:t@localhost:5432/t");
  vi.stubEnv("BETTER_AUTH_SECRET", "secret-de-test-suficiente");
  vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 3).toString("base64"));
  vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "verify-test");
  vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
  vi.stubEnv("OPENROUTER_MODEL", "modelo-agente");
  vi.stubEnv("OPENROUTER_JUDGE_MODEL", "");
  vi.stubEnv("OPENROUTER_EXTRA_BODY", "");
  vi.stubEnv("OPENROUTER_JUDGE_EXTRA_BODY", "");
}

/** Cuerpo que recibió el proveedor en la (única) llamada. */
async function sentBody(opts?: { judge?: boolean }): Promise<Record<string, unknown>> {
  const fetchMock = vi.fn().mockResolvedValue(providerResponse());
  vi.stubGlobal("fetch", fetchMock);
  const { chatJson } = await import("@/lib/ai");
  const result = await chatJson(schema, [{ role: "user", content: "hola" }], opts);
  expect(result.ok).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
}

const THINKING_OFF = '{"thinking":{"type":"disabled"}}';

describe("030 — cuerpo de la llamada por rol", () => {
  beforeEach(() => {
    vi.resetModules();
    baseEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sin variables → exactamente {model, messages}, como antes", async () => {
    const agent = await sentBody();
    expect(Object.keys(agent).sort()).toEqual(["messages", "model"]);
    expect(agent.model).toBe("modelo-agente");
    vi.resetModules();
    const judge = await sentBody({ judge: true });
    expect(Object.keys(judge).sort()).toEqual(["messages", "model"]);
  });

  it("agente con OPENROUTER_EXTRA_BODY → se mezcla en el cuerpo", async () => {
    vi.stubEnv("OPENROUTER_EXTRA_BODY", THINKING_OFF);
    const body = await sentBody();
    expect(body).toEqual({
      thinking: { type: "disabled" },
      model: "modelo-agente",
      messages: [{ role: "user", content: "hola" }],
    });
  });

  it("juez con modelo propio → usa SU extra; el del agente no se cuela", async () => {
    vi.stubEnv("OPENROUTER_JUDGE_MODEL", "modelo-juez");
    vi.stubEnv("OPENROUTER_EXTRA_BODY", THINKING_OFF);
    vi.stubEnv("OPENROUTER_JUDGE_EXTRA_BODY", '{"temperature":0}');
    const body = await sentBody({ judge: true });
    expect(body.model).toBe("modelo-juez");
    expect(body.temperature).toBe(0);
    expect(body).not.toHaveProperty("thinking");
  });

  it("juez con modelo propio y sin su extra → ninguno (Sonnet 5.5 da 400 con thinking)", async () => {
    vi.stubEnv("OPENROUTER_JUDGE_MODEL", "modelo-juez");
    vi.stubEnv("OPENROUTER_EXTRA_BODY", THINKING_OFF);
    const body = await sentBody({ judge: true });
    expect(Object.keys(body).sort()).toEqual(["messages", "model"]);
  });

  it("juez SIN modelo propio → corre en el del agente y hereda su extra", async () => {
    vi.stubEnv("OPENROUTER_EXTRA_BODY", THINKING_OFF);
    vi.stubEnv("OPENROUTER_JUDGE_EXTRA_BODY", '{"temperature":0}');
    const body = await sentBody({ judge: true });
    expect(body.model).toBe("modelo-agente");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body).not.toHaveProperty("temperature");
  });
});

describe("030 — validación de OPENROUTER_EXTRA_BODY / _JUDGE_EXTRA_BODY", () => {
  beforeEach(() => {
    vi.resetModules();
    baseEnv();
  });

  afterEach(() => vi.unstubAllEnvs());

  async function loadEnv() {
    const { getEnv } = await import("@/lib/env");
    return getEnv;
  }

  it("objeto válido → parseado", async () => {
    vi.stubEnv("OPENROUTER_EXTRA_BODY", THINKING_OFF);
    const getEnv = await loadEnv();
    expect(getEnv().OPENROUTER_EXTRA_BODY).toEqual({ thinking: { type: "disabled" } });
    expect(getEnv().OPENROUTER_JUDGE_EXTRA_BODY).toBeUndefined();
  });

  it("vacía → no definida", async () => {
    const getEnv = await loadEnv();
    expect(getEnv().OPENROUTER_EXTRA_BODY).toBeUndefined();
  });

  it("JSON inválido → error de arranque con el nombre de la variable", async () => {
    vi.stubEnv("OPENROUTER_EXTRA_BODY", "{thinking: off}");
    const getEnv = await loadEnv();
    expect(() => getEnv()).toThrow(/OPENROUTER_EXTRA_BODY.*JSON válido/);
  });

  it.each([["[1,2]"], ["null"], ['"texto"'], ["42"]])(
    "no-objeto (%s) → rechazado",
    async (raw) => {
      vi.stubEnv("OPENROUTER_JUDGE_EXTRA_BODY", raw);
      const getEnv = await loadEnv();
      expect(() => getEnv()).toThrow(/OPENROUTER_JUDGE_EXTRA_BODY.*objeto JSON/);
    }
  );

  it.each([
    ['{"model":"otro"}', /model/],
    ['{"messages":[]}', /messages/],
    ['{"model":"x","messages":[],"thinking":{}}', /model ni messages/],
  ])("intenta pisar model/messages (%s) → rechazado", async (raw, why) => {
    vi.stubEnv("OPENROUTER_EXTRA_BODY", raw);
    const getEnv = await loadEnv();
    expect(() => getEnv()).toThrow(/OPENROUTER_EXTRA_BODY no puede incluir/);
    expect(() => getEnv()).toThrow(why);
  });
});
