import { describe, expect, it, vi } from "vitest";

/**
 * 08 — Historial del Laboratorio: delta solo contra corrida comparable
 * (RF-08-17), tendencia (RF-08-10), "qué cambió" (RF-08-16) y snapshot de la
 * configuración (RF-08-15, D-08-04). Piezas puras, sin BD.
 */

vi.mock("@/lib/db", () => ({ getDb: () => ({}), schema: {} }));

import type { LabConfigSnapshot } from "@/lib/lab";
import {
  aggregateTrends,
  computeDeltas,
  diffSnapshots,
  personaHashesOf,
  type RunHistoryRow,
} from "@/server/lab/history";
import { PERSONAS, fromCodePersona, personaHash } from "@/server/lab/personas";
import { behaviorTextOf, buildConfigSnapshot } from "@/server/lab/snapshot";

const t = (min: number) => new Date(Date.UTC(2026, 9, 12, 12, min));
const run = (
  id: string,
  min: number,
  score: number | null,
  keys: string[] | null,
  hashes: Record<string, string> | null = null,
  status: RunHistoryRow["status"] = "done"
): RunHistoryRow => ({
  id,
  status,
  score,
  error: null,
  startedAt: t(min),
  finishedAt: t(min + 1),
  personaKeys: keys,
  personaHashes: hashes ? Object.entries(hashes).map(([key, hash]) => ({ key, hash })) : null,
});

describe("computeDeltas (RF-08-17)", () => {
  it("delta contra la anterior con el MISMO conjunto, saltando las distintas", () => {
    const rows = computeDeltas([
      run("r4", 40, 100, ["a", "b"], { a: "1", b: "2" }),
      run("r3", 30, 50, ["a"], { a: "1" }),
      run("r2", 20, 80, ["b", "a"], { a: "1", b: "2" }),
      run("r1", 10, 60, ["a", "b"], { a: "1", b: "X" }),
    ]);
    expect(rows[0]).toMatchObject({ id: "r4", delta: 20, deltaAgainst: "r2", deltaNote: null });
    // r3: hay anteriores done pero ninguna con el conjunto {a}.
    expect(rows[1]).toMatchObject({ delta: null, deltaAgainst: null, deltaNote: "conjunto distinto" });
    // r2 vs r1: mismas claves pero el guion de b cambió (hash distinto).
    expect(rows[2]).toMatchObject({ delta: null, deltaNote: "conjunto distinto" });
    // r1: no hay anteriores → sin nota.
    expect(rows[3]).toMatchObject({ delta: null, deltaNote: null });
    expect(rows[0]!.startedAt).toBe(t(40).toISOString());
  });

  it("corridas en curso o fallidas no llevan delta ni nota; las pre-08 solo entre sí", () => {
    const rows = computeDeltas([
      run("r3", 30, null, ["a"], null, "running"),
      run("r2", 20, 70, null),
      run("r1", 10, 60, null),
    ]);
    expect(rows[0]).toMatchObject({ delta: null, deltaNote: null });
    expect(rows[1]).toMatchObject({ delta: 10, deltaAgainst: "r1" });
  });

  it("personaHashesOf tolera jsonb nulo o con basura", () => {
    expect(personaHashesOf(null)).toBeNull();
    expect(personaHashesOf([{ key: "a", hash: "1", id: null }, { key: 3 }])).toEqual([
      { key: "a", hash: "1" },
    ]);
  });
});

describe("aggregateTrends (RF-08-10)", () => {
  it("conteo por tipo (los 4 siempre presentes) y veredicto por persona", () => {
    const dto = aggregateTrends(
      [
        { id: "r2", startedAt: t(20), finishedAt: t(21), score: 100, personaKeys: ["a", "b"] },
        { id: "r1", startedAt: t(10), finishedAt: null, score: 50, personaKeys: ["a", "b"] },
      ],
      [
        { runId: "r1", persona: "a", status: "done", veredicto: "rojo", hallazgos: [{ tipo: "fuera_de_kb" }, { tipo: "tono" }, { tipo: "tono" }] },
        { runId: "r1", persona: "b", status: "judge_failed", veredicto: null, hallazgos: null },
        { runId: "r2", persona: "a", status: "done", veredicto: "verde", hallazgos: [] },
        { runId: "r2", persona: "b", status: "done", veredicto: "verde", hallazgos: [{ tipo: "inventado" }] },
      ]
    );
    expect(dto.runs.map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(dto.runs[1]!.hallazgosPorTipo).toEqual({
      alucinacion: 0,
      fuera_de_kb: 1,
      debio_escalar: 0,
      tono: 2,
    });
    expect(dto.runs[1]!.veredictos).toEqual({ a: "rojo", b: "sin_veredicto" });
    expect(dto.runs[0]!.hallazgosPorTipo.tono).toBe(0);
    expect(dto.runs[0]!.veredictos).toEqual({ a: "verde", b: "verde" });
    expect(dto.runs[1]!.finishedAt).toBeNull();
  });
});

const kbRow = (id: string, question: string, answer = "r") => ({
  id,
  kind: "qa" as const,
  question,
  answer,
  content: null,
  updatedAt: t(0),
});
const profile = (tone: string | null) => ({
  name: "Sofi",
  tone,
  instructions: "Vende autos",
  escalationRules: null,
  greeting: null,
});
const personas = PERSONAS.slice(0, 2).map((p, i) => fromCodePersona(p, i));

describe("buildConfigSnapshot (RF-08-15, D-08-04)", () => {
  it("perfil + KB completo + personas con hash + modelos; nunca más campos del perfil", () => {
    const snap = buildConfigSnapshot({
      profile: { ...profile("Amable"), token: "secreto" } as never,
      kb: [kbRow("kb_1", "¿Horario?")],
      personas,
      models: { agent: "m/a", judge: null },
      now: t(0),
    });
    expect(snap).toMatchObject({
      version: 1,
      takenAt: t(0).toISOString(),
      profile: profile("Amable"),
      kb: { mode: "full", entries: [{ id: "kb_1", question: "¿Horario?", answer: "r" }] },
      models: { agent: "m/a", judge: null },
    });
    expect(JSON.stringify(snap)).not.toContain("secreto");
    expect(snap.personas).toEqual(
      personas.map((p) => ({ id: null, key: p.key, name: p.name, hash: personaHash(p) }))
    );
  });

  it("KB por encima del tope → modo hashed (id, kind, hash, updatedAt)", () => {
    const snap = buildConfigSnapshot({
      profile: null,
      kb: [kbRow("kb_1", "x".repeat(200))],
      personas: [],
      models: { agent: null, judge: null },
      maxKbBytes: 100,
    });
    expect(snap.kb.mode).toBe("hashed");
    expect(Object.keys(snap.kb.entries[0]!).sort()).toEqual(["hash", "id", "kind", "updatedAt"]);
    expect(snap.profile).toBeNull();
  });

  it("texto de comportamiento para el juez", () => {
    expect(behaviorTextOf(profile("Amable"))).toBe("Nombre: Sofi\nTono: Amable\nInstrucciones: Vende autos");
    expect(behaviorTextOf(null)).toBe("");
  });
});

describe("diffSnapshots (RF-08-16)", () => {
  const snap = (over: Partial<LabConfigSnapshot> = {}): LabConfigSnapshot => ({
    version: 1,
    takenAt: t(0).toISOString(),
    profile: profile("Amable"),
    kb: {
      mode: "full",
      entries: [
        { ...kbRow("kb_1", "¿Horario?"), updatedAt: t(0).toISOString() },
        { ...kbRow("kb_2", "¿Envíos?"), updatedAt: t(0).toISOString() },
      ],
    },
    personas: [
      { id: "lpe_a", key: "a", name: "A", hash: "1" },
      { id: "lpe_b", key: "b", name: "B", hash: "2" },
    ],
    models: { agent: "m/a", judge: null },
    ...over,
  });

  it("perfil por campo, KB +/−/editada con texto, personas y modelo", () => {
    const before = snap();
    const after = snap({
      profile: profile("Amable\nSé cálido."),
      kb: {
        mode: "full",
        entries: [
          { ...kbRow("kb_1", "¿Horario de sábado?"), updatedAt: t(5).toISOString() },
          { ...kbRow("kb_3", "¿Garantía?"), updatedAt: t(5).toISOString() },
        ],
      },
      personas: [
        { id: "lpe_a", key: "a", name: "A", hash: "1b" },
        { id: "lpe_c", key: "c", name: "C", hash: "3" },
      ],
      models: { agent: "m/b", judge: null },
    });
    const d = diffSnapshots(before, after);
    expect(d.profile).toEqual({ tone: { before: "Amable", after: "Amable\nSé cálido." } });
    expect(d.kb.added.map((e) => e.id)).toEqual(["kb_3"]);
    expect(d.kb.removed.map((e) => e.id)).toEqual(["kb_2"]);
    expect(d.kb.edited).toHaveLength(1);
    expect(d.kb.edited[0]!.before).toMatchObject({ question: "¿Horario?" });
    expect(d.kb.edited[0]!.after).toMatchObject({ question: "¿Horario de sábado?" });
    expect(d.personas).toEqual({ added: ["c"], removed: ["b"], edited: ["a"] });
    expect(d.models).toEqual({ agent: { before: "m/a", after: "m/b" }, judge: null });
  });

  it("sin cambios → todo vacío", () => {
    const d = diffSnapshots(snap(), snap());
    expect(d.profile).toEqual({});
    expect(d.kb).toEqual({ added: [], removed: [], edited: [] });
    expect(d.personas).toEqual({ added: [], removed: [], edited: [] });
  });

  it("KB solo con hash en un lado → editada sin texto", () => {
    const after = snap({
      kb: {
        mode: "hashed",
        entries: [
          { id: "kb_1", kind: "qa", hash: "h", updatedAt: t(9).toISOString() },
          { id: "kb_2", kind: "qa", hash: "h2", updatedAt: t(0).toISOString() },
        ],
      },
    });
    const d = diffSnapshots(snap(), after);
    expect(d.kb.edited).toEqual([{ id: "kb_1", before: null, after: null }]);
  });
});
