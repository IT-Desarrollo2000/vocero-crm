import { describe, expect, it } from "vitest";
import {
  fichaEntries,
  fichaLabel,
  fichaValueText,
  parseFichaValue,
} from "@/lib/ficha";
import { FICHA_TEMPLATE_AUTOS_ELECTRICOS } from "@/lib/ficha-fields";
import type { FichaEventDto } from "@/lib/types";
import {
  applyHumanPatch,
  applyUnlock,
  buildFichaRows,
  defToDraft,
  emptyDraft,
  fichaCheckView,
  fichaProvenance,
  formatFichaEvent,
  moveDraft,
  parseServerFieldErrors,
  parseTypedFichaValue,
  provenanceLocked,
  provenanceTitle,
  selectOptions,
  validateDrafts,
  withLabel,
} from "@/components/ficha-view";

const AT = "2026-10-12T15:30:00.000Z";

describe("fichaLabel", () => {
  it("lee bonito lo que escribió un LLM, en cualquiera de sus manías", () => {
    expect(fichaLabel("dolor_principal")).toBe("Dolor principal");
    expect(fichaLabel("dolorPrincipal")).toBe("Dolor principal");
    expect(fichaLabel("dolor-principal")).toBe("Dolor principal");
    expect(fichaLabel("presupuesto")).toBe("Presupuesto");
  });

  it("no se rompe con claves raras", () => {
    expect(fichaLabel("m2")).toBe("M2");
    expect(fichaLabel("__")).toBe("__");
    expect(fichaLabel("ZONA")).toBe("Zona");
  });
});

describe("fichaValueText", () => {
  it("los booleanos se leen Sí/No: nadie califica en true", () => {
    expect(fichaValueText(true)).toBe("Sí");
    expect(fichaValueText(false)).toBe("No");
  });

  it("números y textos pasan tal cual", () => {
    expect(fichaValueText(50000)).toBe("50000");
    expect(fichaValueText("Polanco")).toBe("Polanco");
  });
});

describe("parseFichaValue", () => {
  it("editar NO cambia el tipo del dato", () => {
    // Del otro lado hay un bot que puede estar comparando; convertir en
    // silencio un número a texto es de los cambios que solo se descubren
    // cuando algo ya falló.
    expect(parseFichaValue("60000", 50000)).toBe(60000);
    expect(parseFichaValue("No", true)).toBe(false);
    expect(parseFichaValue("sí", false)).toBe(true);
    expect(parseFichaValue("Polanco", "Roma")).toBe("Polanco");
  });

  it("pero sí lo cambia si lo escrito ya no es de ese tipo", () => {
    expect(parseFichaValue("como cinco mil", 5000)).toBe("como cinco mil");
    expect(parseFichaValue("depende", true)).toBe("depende");
  });

  it("un dato nuevo entra como texto", () => {
    expect(parseFichaValue("42", undefined)).toBe("42");
  });

  it("recorta los espacios de sobra", () => {
    expect(parseFichaValue("  Polanco  ", "Roma")).toBe("Polanco");
  });
});

describe("fichaEntries", () => {
  it("ordena para que la ficha no baile entre recargas", () => {
    const claves = fichaEntries({ zona: "Roma", dolor: "x", presupuesto: 1 }).map(
      ([k]) => k
    );
    expect(claves).toEqual(["dolor", "presupuesto", "zona"]);
  });

  it("una ficha vacía no truena", () => {
    expect(fichaEntries({})).toEqual([]);
  });
});

/* ============================================================
 * 04 — Panel con campos definidos, procedencia, historial y editor
 * ============================================================ */

describe("fichaProvenance (meta → chip)", () => {
  it("ia/bot/humano según quién escribió", () => {
    expect(fichaProvenance({ by: "ia", at: AT }, true)).toBe("ia");
    expect(fichaProvenance({ by: "bot", at: AT }, true)).toBe("bot");
    expect(fichaProvenance({ by: "humano", at: AT }, true)).toBe("humano");
  });

  it("con valor y sin meta es legado: candado, el agente no lo pisa", () => {
    expect(fichaProvenance(undefined, true)).toBe("legado");
    expect(provenanceLocked("legado")).toBe(true);
    expect(provenanceLocked("humano")).toBe(true);
    expect(provenanceLocked("ia")).toBe(false);
  });

  it("sin valor no se marca nada", () => {
    expect(fichaProvenance({ by: "ia", at: AT }, false)).toBeNull();
    expect(fichaProvenance(undefined, false)).toBeNull();
  });

  it("el tooltip dice quién", () => {
    expect(provenanceTitle("ia", { by: "ia", at: AT })).toMatch(/^Lo llenó el agente · /);
    expect(provenanceTitle("legado", undefined)).toMatch(/previo/);
  });
});

describe("buildFichaRows", () => {
  const fields = FICHA_TEMPLATE_AUTOS_ELECTRICOS.slice(0, 3);

  it("definidos primero, en su orden y con label, vacíos incluidos; luego las libres", () => {
    const rows = buildFichaRows(
      { zona: "Centro", presupuesto: 350000, apodo: "Beto" },
      { presupuesto: { by: "ia", at: AT } },
      fields
    );
    expect(rows.map((r) => r.key)).toEqual([
      "modelo_interes",
      "presupuesto",
      "forma_pago",
      "apodo",
      "zona",
    ]);
    expect(rows[0]).toMatchObject({ label: "Modelo de interés", value: undefined, provenance: null });
    expect(rows[1]).toMatchObject({ value: 350000, provenance: "ia" });
    expect(rows[3]).toMatchObject({ label: "Apodo", def: null, provenance: "legado" });
  });

  it("sin definición es la ficha libre de siempre", () => {
    const rows = buildFichaRows({ zona: "Roma", dolor: "x" }, undefined, null);
    expect(rows.map((r) => r.key)).toEqual(["dolor", "zona"]);
  });
});

describe("parseTypedFichaValue", () => {
  const def = (type: "texto" | "numero" | "si_no" | "opcion") => ({
    key: "k",
    label: "K",
    type,
    agentFills: true,
  });

  it("número: entiende cómo escribe la gente y manda número", () => {
    expect(parseTypedFichaValue(def("numero"), "350 mil")).toEqual({ ok: true, value: 350000 });
    expect(parseTypedFichaValue(def("numero"), "$1,200,000")).toEqual({
      ok: true,
      value: 1200000,
    });
    expect(parseTypedFichaValue(def("numero"), "mucho").ok).toBe(false);
  });

  it("sí/no a booleano", () => {
    expect(parseTypedFichaValue(def("si_no"), "Sí")).toEqual({ ok: true, value: true });
    expect(parseTypedFichaValue(def("si_no"), "No")).toEqual({ ok: true, value: false });
    expect(parseTypedFichaValue(def("si_no"), "quizá").ok).toBe(false);
  });

  it("texto y opción recortados; vacío no es valor", () => {
    expect(parseTypedFichaValue(def("texto"), "  Mérida ")).toEqual({ ok: true, value: "Mérida" });
    expect(parseTypedFichaValue(def("opcion"), "contado")).toEqual({ ok: true, value: "contado" });
    expect(parseTypedFichaValue(def("texto"), "  ").ok).toBe(false);
  });

  it("el selector no esconde un valor fuera de la lista", () => {
    const formaPago = FICHA_TEMPLATE_AUTOS_ELECTRICOS[2]!;
    expect(selectOptions(formaPago, "trueque")).toContain("trueque");
    expect(selectOptions(formaPago, "contado")).toEqual(formaPago.options);
  });
});

describe("applyHumanPatch / applyUnlock (optimismo del panel)", () => {
  it("lo escrito queda con candado y lo borrado pierde su meta", () => {
    const r = applyHumanPatch(
      { ciudad: "Villahermosa", uso: "carretera" },
      { ciudad: { by: "ia", at: AT }, uso: { by: "ia", at: AT } },
      { ciudad: "Mérida", uso: null },
      AT
    );
    expect(r.ficha).toEqual({ ciudad: "Mérida" });
    expect(r.meta).toEqual({ ciudad: { by: "humano", at: AT } });
  });

  it("desbloquear devuelve el campo al agente sin tocar el valor", () => {
    const meta = applyUnlock(
      { ciudad: "Mérida", zona: "Centro", bot: "x" },
      { ciudad: { by: "humano", at: AT }, bot: { by: "bot", at: AT } },
      ["ciudad", "zona", "bot", "vacio"],
      AT
    );
    expect(meta.ciudad?.by).toBe("ia");
    expect(meta.zona?.by).toBe("ia"); // legado
    expect(meta.bot?.by).toBe("bot"); // no-op
    expect(meta.vacio).toBeUndefined(); // sin valor: no-op
  });
});

describe("formatFichaEvent", () => {
  const base: FichaEventDto = {
    id: "fe_1",
    key: "ciudad",
    oldValue: null,
    newValue: "Villahermosa",
    source: "ia",
    outcome: "aplicado",
    reason: null,
    actor: null,
    conversationId: null,
    createdAt: AT,
  };
  const label = (k: string) => (k === "ciudad" ? "Ciudad" : k);

  it("aplicado: quién, campo y antes → después", () => {
    expect(formatFichaEvent(base, label)).toMatchObject({
      quien: "Agente",
      campo: "Ciudad",
      cambio: "— → Villahermosa",
      resultado: "aplicado",
      aplicado: true,
    });
  });

  it("humano con nombre; borrado se lee como borrado", () => {
    const v = formatFichaEvent(
      {
        ...base,
        source: "humano",
        actor: { id: "u1", name: "Ana" },
        oldValue: "Mérida",
        newValue: null,
      },
      label
    );
    expect(v.quien).toBe("Ana");
    expect(v.cambio).toBe("Mérida → borrado");
  });

  it("ignorados con razón legible", () => {
    expect(
      formatFichaEvent({ ...base, outcome: "ignorado_humano", reason: "candado_humano" }, label)
        .resultado
    ).toMatch(/confirmó el equipo/);
    const inv = formatFichaEvent(
      { ...base, source: "bot", outcome: "invalido", reason: "tope", newValue: null },
      label
    );
    expect(inv).toMatchObject({ quien: "Bot", aplicado: false, cambio: "" });
    expect(inv.resultado).toMatch(/espacio/);
  });
});

describe("editor de campos", () => {
  it("la clave se deriva de la etiqueta hasta que alguien la toca", () => {
    let d = withLabel(emptyDraft(), "Modelo de interés");
    expect(d.key).toBe("modelo_de_interes");
    d = { ...d, key: "modelo", keyTouched: true };
    expect(withLabel(d, "Modelo").key).toBe("modelo");
  });

  it("la plantilla pasa la validación y vuelve canónica", () => {
    const r = validateDrafts(FICHA_TEMPLATE_AUTOS_ELECTRICOS.map(defToDraft));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields).toEqual(FICHA_TEMPLATE_AUTOS_ELECTRICOS);
  });

  it("los errores caen en su fila y su campo", () => {
    const a = withLabel(emptyDraft(), "Ciudad");
    const b = withLabel(emptyDraft(), "Ciudad");
    const c = { ...withLabel(emptyDraft(), "Pago"), type: "opcion" as const, options: "contado" };
    const r = validateDrafts([a, b, c]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.rows[1]?.key).toMatch(/repetida/);
      expect(r.errors.rows[2]?.options).toMatch(/al menos 2/);
      expect(r.errors.rows[0]).toBeUndefined();
    }
  });

  it("el 422 del servidor se ubica por fila", () => {
    const e = parseServerFieldErrors(
      "fields.2.key: clave repetida: ciudad; fields.0.options: opción repetida: x; algo raro"
    );
    expect(e.rows[2]?.key).toBe("clave repetida: ciudad");
    expect(e.rows[0]?.options).toBe("opción repetida: x");
    expect(e.general).toEqual(["algo raro"]);
  });

  it("reordenar con flechas", () => {
    expect(moveDraft(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveDraft(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveDraft(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });
});

describe("fichaCheckView (Laboratorio)", () => {
  it("Ficha N/M con esperado vs llenado", () => {
    const v = fichaCheckView({
      esperados: ["modelo_interes", "ciudad", "uso"],
      llenados: { modelo_interes: "Leapmotor T03", ciudad: "Villahermosa" },
      cumplidos: ["modelo_interes", "ciudad"],
    });
    expect(v.resumen).toBe("Ficha 2/3");
    expect(v.completo).toBe(false);
    expect(v.filas[2]).toMatchObject({ key: "uso", valor: "—", cumplido: false });
  });
});
