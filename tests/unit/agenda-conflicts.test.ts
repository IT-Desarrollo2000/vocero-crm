import { describe, expect, it } from "vitest";
import {
  classify,
  overlapsWithBuffer,
  STRICT,
  type BusyItem,
  type ConflictContext,
} from "@/server/agenda/conflicts";

/**
 * 023 — El motor de choques, puro. Cada regla del plan §2 por separado:
 * `strict` (IA/bot) todo bloquea; `staff` (humanos) bloquean el bloqueo, el
 * mismo tipo exclusivo y el mismo vendedor; lo demás es advertencia.
 */

const CAND = {
  startUtc: "2026-08-05T15:00:00.000Z",
  endUtc: "2026-08-05T15:30:00.000Z",
};

function item(over: Partial<BusyItem> = {}): BusyItem {
  return {
    id: "bk_1",
    kind: "session",
    startUtc: "2026-08-05T15:00:00.000Z",
    endUtc: "2026-08-05T15:30:00.000Z",
    typeId: "apt_serv",
    exclusive: false,
    assignedUserId: "u_juan",
    typeName: "Servicio",
    sellerName: "Juan",
    ...over,
  };
}

function staff(over: Partial<Extract<ConflictContext, { mode: "staff" }>> = {}) {
  return {
    mode: "staff" as const,
    typeId: "apt_serv",
    typeExclusive: false,
    sellerId: "u_ana",
    ...over,
  };
}

describe("classify — strict (IA y bot)", () => {
  it("cualquier traslape es hard, sea del tipo o vendedor que sea", () => {
    const busy = [item(), item({ id: "bk_2", typeId: "apt_otro" })];
    const { hard, soft } = classify(CAND, busy, STRICT);
    expect(hard.map((b) => b.id)).toEqual(["bk_1", "bk_2"]);
    expect(soft).toEqual([]);
  });

  it("lo que no se traslapa no cuenta", () => {
    const later = item({
      startUtc: "2026-08-05T15:30:00.000Z",
      endUtc: "2026-08-05T16:00:00.000Z",
    });
    expect(classify(CAND, [later], STRICT)).toEqual({ hard: [], soft: [] });
  });
});

describe("classify — staff (humanos)", () => {
  it("un bloqueo es hard", () => {
    const block = item({
      kind: "block",
      typeId: null,
      assignedUserId: null,
    });
    expect(classify(CAND, [block], staff()).hard).toHaveLength(1);
  });

  it("el mismo tipo EXCLUSIVO es hard aunque sea de otro vendedor", () => {
    const prueba = item({ typeId: "apt_prueba", exclusive: true });
    const ctx = staff({ typeId: "apt_prueba", typeExclusive: true });
    expect(classify(CAND, [prueba], ctx).hard).toHaveLength(1);
  });

  it("basta con que la cita existente sea exclusiva (copia histórica)", () => {
    // El Propietario quitó la exclusividad al tipo después: la cita vieja la
    // conserva y sigue protegiendo su recurso.
    const prueba = item({ typeId: "apt_prueba", exclusive: true });
    const ctx = staff({ typeId: "apt_prueba", typeExclusive: false });
    expect(classify(CAND, [prueba], ctx).hard).toHaveLength(1);
  });

  it("el mismo tipo NO exclusivo de otro vendedor es soft", () => {
    const { hard, soft } = classify(CAND, [item()], staff());
    expect(hard).toEqual([]);
    expect(soft).toHaveLength(1);
  });

  it("un tipo exclusivo distinto al pedido es soft", () => {
    const prueba = item({ typeId: "apt_prueba", exclusive: true });
    expect(classify(CAND, [prueba], staff()).soft).toHaveLength(1);
  });

  it("una cita del mismo vendedor es hard, sea del tipo que sea", () => {
    const mine = item({ typeId: "apt_otro", assignedUserId: "u_ana" });
    expect(classify(CAND, [mine], staff()).hard).toHaveLength(1);
  });

  it("sin vendedor (null) no se compara contra las citas sin asignar", () => {
    const unassigned = item({ assignedUserId: null });
    const { hard, soft } = classify(CAND, [unassigned], staff({ sellerId: null }));
    expect(hard).toEqual([]);
    expect(soft).toHaveLength(1);
  });
});

describe("el margen entre citas (A6)", () => {
  const before = item({
    startUtc: "2026-08-05T14:30:00.000Z",
    endUtc: "2026-08-05T15:00:00.000Z",
  });
  const after = item({
    startUtc: "2026-08-05T15:30:00.000Z",
    endUtc: "2026-08-05T16:00:00.000Z",
  });

  it("sin margen, citas contiguas no chocan", () => {
    expect(overlapsWithBuffer(CAND, before, 0)).toBe(false);
    expect(overlapsWithBuffer(CAND, after, 0)).toBe(false);
  });

  it("con margen, lo ocupado cuenta hasta fin + margen", () => {
    expect(overlapsWithBuffer(CAND, before, 15)).toBe(true);
  });

  it("y es simétrico: el candidato tampoco invade el margen del siguiente", () => {
    expect(overlapsWithBuffer(CAND, after, 15)).toBe(true);
  });

  it("classify aplica el margen", () => {
    expect(classify(CAND, [before], STRICT, 15).hard).toHaveLength(1);
    expect(classify(CAND, [before], STRICT, 0).hard).toHaveLength(0);
  });
});
