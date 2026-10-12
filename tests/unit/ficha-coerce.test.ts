import { describe, expect, it } from "vitest";
import {
  coerceFichaPatch,
  coerceFichaValue,
  FICHA_TEMPLATE_AUTOS_ELECTRICOS,
  fichaFieldsSchema,
  fichaWriteBlocked,
  isFichaLocked,
  parseFichaNumber,
  resolveFichaKey,
  slugifyFichaKey,
  type FichaFieldDef,
} from "@/lib/ficha-fields";

/** 04 — Contrato 04-0: definición, coerción y procedencia (puros). */

const T = FICHA_TEMPLATE_AUTOS_ELECTRICOS;
const def = (key: string): FichaFieldDef => {
  const f = T.find((x) => x.key === key);
  if (!f) throw new Error(key);
  return f;
};

describe("definición de campos (RF-04-01)", () => {
  it("la plantilla de autos eléctricos pasa su propio esquema", () => {
    const r = fichaFieldsSchema.safeParse(T);
    expect(r.success).toBe(true);
    expect(T.map((f) => f.key)).toEqual([
      "modelo_interes",
      "presupuesto",
      "forma_pago",
      "plazo_compra",
      "ciudad",
      "uso",
    ]);
    expect(def("uso").allowOther).toBe(true);
  });

  it("rechaza claves repetidas, no snake_case y más de 25 campos", () => {
    const base = { label: "X", type: "texto", agentFills: true };
    expect(
      fichaFieldsSchema.safeParse([
        { ...base, key: "a" },
        { ...base, key: "a" },
      ]).success
    ).toBe(false);
    expect(fichaFieldsSchema.safeParse([{ ...base, key: "Ciudad" }]).success).toBe(false);
    expect(fichaFieldsSchema.safeParse([{ ...base, key: "1x" }]).success).toBe(false);
    expect(fichaFieldsSchema.safeParse([{ ...base, key: "a".repeat(61) }]).success).toBe(false);
    const many = Array.from({ length: 26 }, (_, i) => ({ ...base, key: `k${i}` }));
    expect(fichaFieldsSchema.safeParse(many).success).toBe(false);
    expect(fichaFieldsSchema.safeParse(many.slice(0, 25)).success).toBe(true);
  });

  it("una opción necesita 2–20 opciones únicas; otros tipos las pierden", () => {
    const op = { key: "k", label: "K", type: "opcion", agentFills: true };
    expect(fichaFieldsSchema.safeParse([{ ...op, options: ["a"] }]).success).toBe(false);
    expect(fichaFieldsSchema.safeParse([{ ...op, options: ["Sí", "si"] }]).success).toBe(false);
    expect(fichaFieldsSchema.safeParse([{ ...op, options: ["a", "b"] }]).success).toBe(true);
    const r = fichaFieldsSchema.parse([
      { key: "t", label: "T", type: "texto", options: ["a", "b"], allowOther: true, hint: "", agentFills: false },
    ]);
    expect(r[0]).toEqual({ key: "t", label: "T", type: "texto", agentFills: false });
  });

  it("límites de label, pista y opción", () => {
    const f = { key: "k", label: "K", type: "texto", agentFills: true };
    expect(fichaFieldsSchema.safeParse([{ ...f, label: "x".repeat(61) }]).success).toBe(false);
    expect(fichaFieldsSchema.safeParse([{ ...f, hint: "x".repeat(201) }]).success).toBe(false);
    expect(
      fichaFieldsSchema.safeParse([
        { ...f, type: "opcion", options: ["a", "x".repeat(61)] },
      ]).success
    ).toBe(false);
  });

  it("slug de la clave a partir del label", () => {
    expect(slugifyFichaKey("Modelo de interés")).toBe("modelo_de_interes");
    expect(slugifyFichaKey("Presupuesto (MXN)")).toBe("presupuesto_mxn");
    expect(slugifyFichaKey("  ¿Año?  ")).toBe("ano");
  });
});

describe("resolución de claves (RF-04-05)", () => {
  it("exacta → sin acentos/mayúsculas → contra el label", () => {
    expect(resolveFichaKey("ciudad", T)?.key).toBe("ciudad");
    expect(resolveFichaKey("Ciudad", T)?.key).toBe("ciudad");
    expect(resolveFichaKey("Forma de pago", T)?.key).toBe("forma_pago");
    expect(resolveFichaKey("formaPago", T)?.key).toBe("forma_pago");
    expect(resolveFichaKey("Modelo de interés", T)?.key).toBe("modelo_interes");
    expect(resolveFichaKey("color", T)).toBeNull();
  });
});

describe("coerción por tipo (RF-04-05)", () => {
  it("número: formatos con los que habla la gente", () => {
    expect(parseFichaNumber("350 mil")).toBe(350000);
    expect(parseFichaNumber("$1,200,000")).toBe(1200000);
    expect(parseFichaNumber("1.2 millones")).toBe(1200000);
    expect(parseFichaNumber("350k")).toBe(350000);
    expect(parseFichaNumber("$350,000 pesos")).toBe(350000);
    expect(parseFichaNumber("1.200.000")).toBe(1200000);
    expect(parseFichaNumber(350000)).toBe(350000);
    expect(parseFichaNumber("mucho")).toBeNull();
    expect(parseFichaNumber("350 dólares")).toBeNull();
    expect(parseFichaNumber(Number.NaN)).toBeNull();
    expect(coerceFichaValue(def("presupuesto"), "mucho")).toEqual({ ok: false, reason: "tipo" });
  });

  it("si_no", () => {
    const sn: FichaFieldDef = { key: "auto", label: "Auto", type: "si_no", agentFills: true };
    for (const v of ["sí", "Si", "true", "1", "yes", true, 1]) {
      expect(coerceFichaValue(sn, v)).toEqual({ ok: true, value: true });
    }
    for (const v of ["no", "No.", "false", "0", false, 0]) {
      expect(coerceFichaValue(sn, v)).toEqual({ ok: true, value: false });
    }
    expect(coerceFichaValue(sn, "tal vez")).toEqual({ ok: false, reason: "tipo" });
  });

  it("opción: canónica sin acentos/mayúsculas; allowOther guarda el texto", () => {
    expect(coerceFichaValue(def("forma_pago"), "Financiamiento")).toEqual({
      ok: true,
      value: "financiamiento",
    });
    expect(coerceFichaValue(def("plazo_compra"), "MAS DE 3 MESES")).toEqual({
      ok: true,
      value: "más de 3 meses",
    });
    expect(coerceFichaValue(def("forma_pago"), "trueque")).toEqual({ ok: false, reason: "opcion" });
    expect(coerceFichaValue(def("uso"), "  Uber ")).toEqual({ ok: true, value: "Uber" });
  });

  it("texto: recortado a 200", () => {
    const r = coerceFichaValue(def("ciudad"), `  ${"x".repeat(300)} `);
    expect(r.ok && typeof r.value === "string" && r.value.length).toBe(200);
    expect(coerceFichaValue(def("ciudad"), { a: 1 })).toEqual({ ok: false, reason: "tipo" });
  });
});

describe("coerceFichaPatch", () => {
  it("aplica, rechaza sin valores y no borra", () => {
    const fields: FichaFieldDef[] = [
      ...T,
      { key: "interno", label: "Interno", type: "texto", agentFills: false },
    ];
    const { patch, rejected } = coerceFichaPatch(
      {
        "Modelo de interés": "Leapmotor T03",
        ciudad: "Villahermosa",
        presupuesto: "350 mil",
        forma_pago: "trueque",
        color: "rojo",
        interno: "x",
        uso: null,
        plazo_compra: "",
      },
      fields
    );
    expect(patch).toEqual({
      modelo_interes: "Leapmotor T03",
      ciudad: "Villahermosa",
      presupuesto: 350000,
    });
    expect(rejected).toEqual([
      { key: "forma_pago", reason: "opcion" },
      { key: "color", reason: "clave_desconocida" },
      { key: "interno", reason: "no_la_llena_el_agente" },
    ]);
  });

  it("lo que no es objeto se ignora sin error", () => {
    for (const raw of ["no soy un objeto", null, undefined, 3, ["a"]]) {
      expect(coerceFichaPatch(raw, T)).toEqual({ patch: {}, rejected: [] });
    }
  });

  it("dos claves al mismo campo: gana la primera", () => {
    expect(coerceFichaPatch({ ciudad: "A", Ciudad: "B" }, T).patch).toEqual({ ciudad: "A" });
  });
});

describe("procedencia: el humano gana (RF-04-07, D-04-4, legado)", () => {
  const at = "2026-10-12T00:00:00.000Z";
  const humano = { by: "humano" as const, at, userId: "u1" };
  const ia = { by: "ia" as const, at };
  const bot = { by: "bot" as const, at };

  it("humano escribe siempre", () => {
    expect(fichaWriteBlocked("humano", humano, true)).toBeNull();
    expect(fichaWriteBlocked("humano", undefined, true)).toBeNull();
  });

  it("ia: bloqueada por candado y por legado; corrige lo suyo y lo del bot", () => {
    expect(fichaWriteBlocked("ia", humano, true)).toBe("candado_humano");
    expect(fichaWriteBlocked("ia", undefined, true)).toBe("candado_humano");
    expect(fichaWriteBlocked("ia", undefined, false)).toBeNull();
    expect(fichaWriteBlocked("ia", ia, true)).toBeNull();
    expect(fichaWriteBlocked("ia", bot, true)).toBeNull();
  });

  it("bot: respeta el candado, pero puede escribir sus claves legadas", () => {
    expect(fichaWriteBlocked("bot", humano, true)).toBe("candado_humano");
    expect(fichaWriteBlocked("bot", undefined, true)).toBeNull();
    expect(fichaWriteBlocked("bot", ia, true)).toBeNull();
  });

  it("el candado se deriva de by = humano", () => {
    expect(isFichaLocked(humano)).toBe(true);
    expect(isFichaLocked(ia)).toBe(false);
    expect(isFichaLocked(undefined)).toBe(false);
  });
});
