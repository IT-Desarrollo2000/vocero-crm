import { describe, expect, it, vi } from "vitest";
import {
  APPOINTMENT_TYPE_SEED,
  matchTypeByName,
  normalizeTypeName,
  pickFallbackType,
  validateTypeInput,
} from "@/lib/agenda-types";

/** 023 — Tipos de cita: siembra, resolución por nombre, omisión y validación. */

const T = (
  id: string,
  name: string,
  over: { exclusive?: boolean; active?: boolean; position?: number } = {}
) => ({
  id,
  name,
  exclusive: over.exclusive ?? false,
  active: over.active ?? true,
  position: over.position ?? 0,
});

const CATALOGO = [
  T("p", "Prueba de manejo", { exclusive: true, position: 0 }),
  T("s", "Servicio", { position: 1 }),
  T("g", "Garantía", { position: 2 }),
  T("o", "Otro", { position: 3 }),
];

describe("la siembra", () => {
  it("trae los cuatro tipos de la decisión 2, con la prueba exclusiva", () => {
    expect(APPOINTMENT_TYPE_SEED.map((s) => s.seedKey)).toEqual([
      "prueba_manejo",
      "servicio",
      "garantia",
      "otro",
    ]);
    const prueba = APPOINTMENT_TYPE_SEED[0]!;
    expect(prueba).toMatchObject({ exclusive: true, durationMinutes: 60 });
    expect(APPOINTMENT_TYPE_SEED.slice(1).every((s) => !s.exclusive)).toBe(true);
    expect(APPOINTMENT_TYPE_SEED.map((s) => s.position)).toEqual([0, 1, 2, 3]);
  });
});

describe("matchTypeByName (A10)", () => {
  it("normaliza mayúsculas, acentos y espacios", () => {
    expect(normalizeTypeName("  GARANTÍA  ")).toBe("garantia");
    expect(matchTypeByName(CATALOGO, "garantia")?.id).toBe("g");
    expect(matchTypeByName(CATALOGO, "prueba   DE manejo")?.id).toBe("p");
  });

  it("acepta un prefijo solo si es único", () => {
    expect(matchTypeByName(CATALOGO, "prueba")?.id).toBe("p");
    const ambiguo = [...CATALOGO, T("x", "Servicio express")];
    expect(matchTypeByName(ambiguo, "serv")).toBeNull();
    // Exacto gana aunque también sea prefijo de otro.
    expect(matchTypeByName(ambiguo, "servicio")?.id).toBe("s");
  });

  it("desconocido, vacío o inactivo ⇒ null (se pregunta)", () => {
    expect(matchTypeByName(CATALOGO, "lavado")).toBeNull();
    expect(matchTypeByName(CATALOGO, "   ")).toBeNull();
    const inactivo = [T("s", "Servicio", { active: false })];
    expect(matchTypeByName(inactivo, "servicio")).toBeNull();
  });
});

describe("pickFallbackType (A2)", () => {
  it("con varios activos: el primer NO exclusivo por posición", () => {
    expect(pickFallbackType(CATALOGO)?.id).toBe("s");
  });

  it("con un único activo: ese, aunque sea exclusivo", () => {
    const solo = [
      T("p", "Prueba de manejo", { exclusive: true }),
      T("s", "Servicio", { active: false }),
    ];
    expect(pickFallbackType(solo)?.id).toBe("p");
  });

  it("nunca cae en un exclusivo si hay más de uno activo", () => {
    const todos = [
      T("p", "Prueba", { exclusive: true }),
      T("q", "Prueba 2", { exclusive: true, position: 1 }),
    ];
    expect(pickFallbackType(todos)).toBeNull();
  });

  it("sin tipos activos ⇒ null", () => {
    expect(pickFallbackType([])).toBeNull();
  });
});

describe("validateTypeInput", () => {
  it("rechaza duración fuera de 10–480 y nombre fuera de 1–60", () => {
    expect(validateTypeInput({ durationMinutes: 5 }).ok).toBe(false);
    expect(validateTypeInput({ durationMinutes: 481 }).ok).toBe(false);
    expect(validateTypeInput({ durationMinutes: 30.5 }).ok).toBe(false);
    expect(validateTypeInput({ name: "   " }).ok).toBe(false);
    expect(validateTypeInput({ name: "x".repeat(61) }).ok).toBe(false);
  });

  it("normaliza el nombre y deja pasar lo válido", () => {
    expect(
      validateTypeInput({ name: "  Servicio   mayor ", durationMinutes: 45 })
    ).toEqual({
      ok: true,
      value: { name: "Servicio mayor", durationMinutes: 45 },
    });
  });
});

describe("siembra perezosa idempotente (types-store)", () => {
  it("sin tipos siembra con ON CONFLICT (org, seed_key) DO NOTHING y relee", async () => {
    vi.resetModules();
    const onConflict = vi.fn(async () => {});
    let reads = 0;
    const seeded = APPOINTMENT_TYPE_SEED.map((s, i) => ({
      id: `apt_${i}`,
      name: s.name,
      active: true,
      position: s.position,
    }));
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: async () => (reads++ === 0 ? [] : seeded),
          }),
        }),
      }),
      insert: () => ({
        values: (v: unknown[]) => {
          expect(v).toHaveLength(4);
          return { onConflictDoNothing: onConflict };
        },
      }),
    };
    vi.doMock("@/lib/db", async () => ({
      getDb: () => db,
      schema: await import("@/lib/db/schema"),
    }));
    const { listTypes } = await import("@/server/agenda/types-store");
    const types = await listTypes("org_1");
    expect(types).toHaveLength(4);
    expect(onConflict).toHaveBeenCalledOnce();
    const arg = (onConflict.mock.calls[0] as unknown[])[0] as {
      target: { name: string }[];
    };
    expect(arg.target.map((c) => c.name)).toEqual([
      "organization_id",
      "seed_key",
    ]);
    vi.doUnmock("@/lib/db");
  });
});
