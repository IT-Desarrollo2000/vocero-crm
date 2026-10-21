import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  awaitingState,
  formatWait,
  inHumanHands,
  normalizeOverdueMinutes,
  OVERDUE_DEFAULT_MINUTES,
} from "@/lib/awaiting";
import { closeAwaitingSql, openAwaitingSql } from "@/server/inbox/awaiting";

/**
 * 026 — "Por atender" que dice la verdad: estado de la espera (puro) y la
 * forma del SQL que la abre y la cierra.
 */

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("awaitingState", () => {
  it("con la IA al mando (sin handoff, IA encendida) → none, aunque haya espera", () => {
    expect(
      awaitingState({ handoffAt: null, aiEnabled: true, awaitingSince: ago(5 * MIN) }, NOW)
    ).toEqual({ kind: "none" });
  });

  it("en manos de una persona sin espera → attended", () => {
    expect(
      awaitingState({ handoffAt: ago(MIN), aiEnabled: true, awaitingSince: null }, NOW)
    ).toEqual({ kind: "attended" });
    // IA apagada a mano, sin escalar: entra en el mismo flujo.
    expect(
      awaitingState({ handoffAt: null, aiEnabled: false, awaitingSince: null }, NOW)
    ).toEqual({ kind: "attended" });
  });

  it("esperando antes del umbral → waiting, no atrasada", () => {
    const since = ago(25 * MIN);
    expect(
      awaitingState({ handoffAt: ago(30 * MIN), aiEnabled: false, awaitingSince: since }, NOW)
    ).toEqual({ kind: "waiting", ms: 25 * MIN, since, overdue: false });
  });

  it("justo en el umbral (≥) → atrasada; el umbral por defecto es 60 min", () => {
    const c = { handoffAt: null, aiEnabled: false, awaitingSince: ago(60 * MIN) };
    expect(OVERDUE_DEFAULT_MINUTES).toBe(60);
    expect(awaitingState(c, NOW)).toMatchObject({ kind: "waiting", overdue: true });
    expect(awaitingState(c, NOW, 61)).toMatchObject({ kind: "waiting", overdue: false });
  });

  it("umbral bajo (5 min) marca atrasada una espera corta", () => {
    const c = { handoffAt: ago(MIN), aiEnabled: true, awaitingSince: ago(6 * MIN) };
    expect(awaitingState(c, NOW, 5)).toMatchObject({ overdue: true });
    expect(awaitingState(c, NOW, 60)).toMatchObject({ overdue: false });
  });

  it("hora futura (relojes desfasados) o ilegible → espera de 0, sigue esperando", () => {
    const futuro = new Date(NOW + 5 * MIN).toISOString();
    expect(
      awaitingState({ handoffAt: null, aiEnabled: false, awaitingSince: futuro }, NOW)
    ).toMatchObject({ kind: "waiting", ms: 0, overdue: false });
    expect(
      awaitingState({ handoffAt: null, aiEnabled: false, awaitingSince: "no-es-fecha" }, NOW)
    ).toMatchObject({ kind: "waiting", ms: 0 });
  });

  it("inHumanHands ≡ handoff abierto o IA apagada", () => {
    expect(inHumanHands({ handoffAt: null, aiEnabled: true })).toBe(false);
    expect(inHumanHands({ handoffAt: ago(MIN), aiEnabled: true })).toBe(true);
    expect(inHumanHands({ handoffAt: null, aiEnabled: false })).toBe(true);
  });
});

describe("formatWait", () => {
  it.each([
    [0, "menos de 1 min"],
    [59_000, "menos de 1 min"],
    [MIN, "1 min"],
    [25 * MIN, "25 min"],
    [59 * MIN + 59_000, "59 min"],
    [60 * MIN, "1 h"],
    [80 * MIN, "1 h 20 min"],
    [3 * 60 * MIN, "3 h"],
    [24 * 60 * MIN, "1 d"],
    [2 * 24 * 60 * MIN, "2 d"],
    [(2 * 24 + 5) * 60 * MIN + 7 * MIN, "2 d 5 h"],
    [-5 * MIN, "menos de 1 min"],
  ])("%d ms → %s", (ms, text) => {
    expect(formatWait(ms)).toBe(text);
  });
});

describe("normalizeOverdueMinutes", () => {
  it("acepta enteros 5–1440; lo demás cae al default", () => {
    expect(normalizeOverdueMinutes(5)).toBe(5);
    expect(normalizeOverdueMinutes(1440)).toBe(1440);
    expect(normalizeOverdueMinutes(90)).toBe(90);
    for (const bad of [4, 1441, 30.5, "60", null, undefined, Number.NaN]) {
      expect(normalizeOverdueMinutes(bad)).toBe(60);
    }
  });
});

describe("SQL de la espera (src/server/inbox/awaiting.ts)", () => {
  const dialect = new PgDialect();
  const at = new Date("2026-10-21T12:00:00.000Z");

  it("abrir: coalesce — no mueve una espera ya abierta; instante como ::timestamp", () => {
    const q = dialect.sqlToQuery(openAwaitingSql(at));
    expect(q.sql).toBe('coalesce("conversation"."awaiting_since", $1::timestamp)');
    // Texto UTC (no un Date, que viajaría como timestamptz).
    expect(q.params).toEqual(["2026-10-21T12:00:00.000Z"]);
  });

  it("cerrar: un entrante posterior al inicio del envío deja la espera abierta", () => {
    const q = dialect.sqlToQuery(closeAwaitingSql(at));
    expect(q.sql).toBe(
      'CASE WHEN "conversation"."last_inbound_at" > $1::timestamp THEN coalesce("conversation"."awaiting_since", "conversation"."last_inbound_at") ELSE NULL END'
    );
    expect(q.params).toEqual(["2026-10-21T12:00:00.000Z"]);
  });
});
