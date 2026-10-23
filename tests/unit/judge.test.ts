import { beforeEach, describe, expect, it, vi } from "vitest";

const chatJson = vi.fn();

vi.mock("@/lib/ai", () => ({
  chatJson: (...args: unknown[]) => chatJson(...args),
}));

import { computeScore, judgeCase } from "@/server/lab/judge";

describe("judgeCase (FR-032)", () => {
  beforeEach(() => chatJson.mockReset());

  it("veredicto válido → done", async () => {
    chatJson.mockResolvedValue({
      ok: true,
      data: { veredicto: "verde", hallazgos: [] },
      raw: "{}",
    });
    const outcome = await judgeCase({
      personaKey: "comprador_decidido",
      transcript: [{ role: "cliente", text: "hola" }],
      kbText: "kb",
      behaviorText: "b",
    });
    expect(outcome.status).toBe("done");
    // usa el modelo del juez (opts.judge)
    expect(chatJson.mock.calls[0]![2]).toMatchObject({ judge: true });
  });

  it("030 — reenvía el pase a humano al prompt del juez", async () => {
    chatJson.mockResolvedValue({
      ok: true,
      data: { veredicto: "verde", hallazgos: [] },
      raw: "{}",
    });
    await judgeCase({
      personaKey: "pide_humano",
      transcript: [{ role: "cliente", text: "quiero hablar con un humano" }],
      kbText: "kb",
      behaviorText: "b",
      handoff: { reason: "cliente", note: null },
    });
    const messages = chatJson.mock.calls[0]![1] as { role: string; content: string }[];
    expect(messages[1]!.content).toContain(
      "El sistema pasó la conversación a un asesor humano (motivo: El cliente pidió un humano [cliente])."
    );
  });

  it("salida inválida tras reintentos internos → judge_failed (no lanza)", async () => {
    chatJson.mockResolvedValue({
      ok: false,
      error: "invalid_output",
      detail: "no cumple el esquema (raw=...)",
    });
    const outcome = await judgeCase({
      personaKey: "fuera_de_kb",
      transcript: [],
      kbText: "",
      behaviorText: "",
    });
    expect(outcome.status).toBe("judge_failed");
  });
});

describe("computeScore (FR-033: judge_failed excluido del denominador)", () => {
  it("pondera verde=1, amarillo=0.5, rojo=0", () => {
    const score = computeScore([
      { status: "done", veredicto: "verde" },
      { status: "done", veredicto: "amarillo" },
      { status: "done", veredicto: "rojo" },
    ]);
    expect(score).toBe(50); // (1 + 0.5 + 0) / 3 = 0.5
  });

  it("judge_failed NO cuenta en el denominador", () => {
    const score = computeScore([
      { status: "done", veredicto: "verde" },
      { status: "done", veredicto: "verde" },
      { status: "judge_failed", veredicto: null },
    ]);
    expect(score).toBe(100); // 2/2, no 2/3
  });

  it("todo judge_failed → sin score (null)", () => {
    expect(
      computeScore([{ status: "judge_failed", veredicto: null }])
    ).toBeNull();
  });

  it("6 verdes → 100; 6 rojos → 0", () => {
    const verdes = Array(6).fill({ status: "done", veredicto: "verde" });
    const rojos = Array(6).fill({ status: "done", veredicto: "rojo" });
    expect(computeScore(verdes)).toBe(100);
    expect(computeScore(rojos)).toBe(0);
  });
});

describe("03 — el juez recibe la descripción y la semilla de la persona", () => {
  it("judgeCase pasa descripción + semilla; la clave sigue al frente (el ai-mock la busca)", async () => {
    chatJson.mockReset();
    chatJson.mockResolvedValue({ ok: true, data: { veredicto: "verde", hallazgos: [] }, raw: "{}" });
    await judgeCase({
      personaKey: "cliente_que_regresa",
      personaDescription: "Ya había preguntado antes",
      seedText: "- modelo_interes: Leapmotor T03",
      transcript: [],
      kbText: "",
      behaviorText: "",
    });
    const user = (chatJson.mock.calls[0]![1] as { content: string }[])[1]!.content;
    expect(user).toContain("PERSONA SIMULADA: cliente_que_regresa — Ya había preguntado antes");
    expect(user).toContain("El agente tenía estos datos del cliente");
    expect(user).toContain("Leapmotor T03");
  });
});
