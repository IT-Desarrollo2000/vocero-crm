import { describe, expect, it } from "vitest";
import { takeOverAssigns, whoAnswers, type WhoAnswersInput } from "@/lib/who-answers";

/**
 * 031 — Franja «quién responde»: A (IA), B (persona, IA en pausa), C
 * (escalada) o nada cuando el agente no responde en la instancia.
 */

const ME = "u_me";
const base: WhoAnswersInput = {
  aiEnabled: true,
  handoffAt: null,
  handoffReason: null,
  assignedTo: null,
};
const opts = { viewerId: ME, agentReady: true, teamMode: true };

describe("whoAnswers", () => {
  it("A: IA encendida, sin escalar y el agente responde", () => {
    expect(whoAnswers(base, opts)).toEqual({ kind: "ai" });
  });

  it("sin agente listo no hay franja A ni B (no se promete una IA)", () => {
    const off = { ...opts, agentReady: false };
    expect(whoAnswers(base, off)).toEqual({ kind: "none" });
    expect(whoAnswers({ ...base, aiEnabled: false }, off)).toEqual({ kind: "none" });
  });

  it("C: escalada, con su motivo, aunque el agente esté apagado", () => {
    const c = { ...base, aiEnabled: false, handoffAt: "2026-11-05T10:00:00Z", handoffReason: "cliente" };
    expect(whoAnswers(c, opts)).toEqual({ kind: "handoff", reason: "cliente" });
    expect(whoAnswers(c, { ...opts, agentReady: false })).toEqual({
      kind: "handoff",
      reason: "cliente",
    });
  });

  it("B: IA en pausa — tuyo, de nadie o de otro miembro", () => {
    const paused = { ...base, aiEnabled: false };
    expect(whoAnswers({ ...paused, assignedTo: { userId: ME, name: "Yo" } }, opts)).toEqual({
      kind: "human",
      who: "me",
    });
    expect(whoAnswers(paused, opts)).toEqual({ kind: "human", who: "nobody" });
    expect(
      whoAnswers({ ...paused, assignedTo: { userId: "u_x", name: "Daniela" } }, opts)
    ).toEqual({ kind: "human", who: { name: "Daniela" } });
  });

  it("B sin equipo (Propietario solo): todo chat es tuyo", () => {
    expect(whoAnswers({ ...base, aiEnabled: false }, { ...opts, teamMode: false })).toEqual({
      kind: "human",
      who: "me",
    });
  });
});

describe("takeOverAssigns", () => {
  it("solo asigna en modo equipo y si nadie lo tiene", () => {
    expect(takeOverAssigns({ assignedTo: null }, true)).toBe(true);
    expect(takeOverAssigns({ assignedTo: null }, false)).toBe(false);
    expect(takeOverAssigns({ assignedTo: { userId: "u_x", name: "X" } }, true)).toBe(false);
  });
});
