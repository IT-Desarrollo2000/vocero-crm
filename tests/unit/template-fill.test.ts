import { describe, expect, it } from "vitest";
import {
  blankBody,
  displayFirstName,
  firstMissing,
  greetingPrefill,
  humanizeTemplateName,
  previewSegments,
  templateLabels,
  templateSnippet,
  variableContext,
} from "@/lib/template-fill";

/**
 * 031 — Ventana cerrada en 3 pasos: nombre legible, contexto de cada
 * espacio, el nombre puesto solo cuando el cuerpo saluda y la vista previa.
 */

const COTIZACION =
  "Hola {{1}}, te escribo para saber si pudiste revisar la cotización de {{2}}. Quedo atento a cualquier duda.";

describe("humanizeTemplateName", () => {
  it("guiones bajos a espacios y primera mayúscula", () => {
    expect(humanizeTemplateName("seguimiento_cotizacion")).toBe("Seguimiento cotizacion");
    expect(humanizeTemplateName("retomar__conversacion_")).toBe("Retomar conversacion");
  });

  it("un nombre vacío de verdad se queda como venía", () => {
    expect(humanizeTemplateName("___")).toBe("___");
  });
});

describe("templateLabels", () => {
  it("idioma entre paréntesis solo si dos se llaman igual", () => {
    const labels = templateLabels([
      { id: "a", name: "seguimiento", language: "es_MX" },
      { id: "b", name: "seguimiento", language: "en_US" },
      { id: "c", name: "recordatorio_cita", language: "es_MX" },
    ]);
    expect(labels.get("a")).toBe("Seguimiento (es_MX)");
    expect(labels.get("b")).toBe("Seguimiento (en_US)");
    expect(labels.get("c")).toBe("Recordatorio cita");
  });
});

describe("blankBody / templateSnippet", () => {
  it("los {{n}} se ven como ___", () => {
    expect(blankBody("Hola {{1}}, tu cita es el {{ 2 }}")).toBe("Hola ___, tu cita es el ___");
  });

  it("un cuerpo largo se corta en una palabra con …", () => {
    const s = templateSnippet(COTIZACION, 60);
    expect(s.startsWith("Hola ___, te escribo")).toBe(true);
    expect(s.endsWith(" …")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(62);
  });

  it("uno corto queda entero", () => {
    expect(templateSnippet("Hola {{1}}")).toBe("Hola ___");
  });
});

describe("variableContext", () => {
  it("unas palabras alrededor del espacio", () => {
    expect(variableContext(COTIZACION, 1)).toBe("Hola ___, te…");
    expect(variableContext(COTIZACION, 2)).toBe("…la cotización de ___");
  });

  it("no cruza a otra oración", () => {
    expect(variableContext("Gracias. Tu pedido {{1}} va en camino.", 1)).toBe(
      "Tu pedido ___ va en…"
    );
  });

  it("null si el espacio no existe", () => {
    expect(variableContext(COTIZACION, 3)).toBeNull();
  });
});

describe("displayFirstName", () => {
  it("primer nombre", () => {
    expect(displayFirstName("Laura Gómez")).toBe("Laura");
  });

  it("un teléfono o un id no se usan como nombre", () => {
    expect(displayFirstName("+52 55 0000 0001")).toBeNull();
    expect(displayFirstName("5215500000001")).toBeNull();
    expect(displayFirstName("bsuid:abc")).toBeNull();
    expect(displayFirstName("   ")).toBeNull();
  });
});

describe("greetingPrefill", () => {
  it("pone el primer nombre si hay un saludo justo antes de {{1}}", () => {
    expect(greetingPrefill(COTIZACION, "Carlos Ruiz")).toBe("Carlos");
    expect(greetingPrefill("Buenos días {{1}}, …", "Ana")).toBe("Ana");
    expect(greetingPrefill("Estimada, {{1}}:", "Ana Torres")).toBe("Ana");
  });

  it("sin saludo no adivina", () => {
    expect(greetingPrefill("Tu pedido {{1}} va en camino", "Carlos")).toBeNull();
    expect(greetingPrefill("Hola, tu cita es el {{1}}", "Carlos")).toBeNull();
  });

  it("sin nombre de verdad, nada", () => {
    expect(greetingPrefill(COTIZACION, "+52 55 0000 0001")).toBeNull();
  });
});

describe("previewSegments / firstMissing", () => {
  it("valores llenos y espacios que faltan", () => {
    expect(previewSegments("Hola {{1}}, la cotización de {{2}}.", ["Carlos", " "])).toEqual([
      { kind: "text", text: "Hola " },
      { kind: "value", n: 1, text: "Carlos" },
      { kind: "text", text: ", la cotización de " },
      { kind: "missing", n: 2 },
      { kind: "text", text: "." },
    ]);
  });

  it("primer espacio vacío (1..n) o null", () => {
    expect(firstMissing(["Carlos", ""])).toBe(2);
    expect(firstMissing(["", "x"])).toBe(1);
    expect(firstMissing(["a", "b"])).toBeNull();
    expect(firstMissing([])).toBeNull();
  });
});
