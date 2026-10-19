import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACCENT_PRESETS,
  accentCssVariables,
  isValidHex,
  normalizeBranding,
  resolveAccentSet,
} from "@/lib/branding";

const DARK_BG = "#101115";

/** Contraste WCAG entre dos hex, para afirmar sobre legibilidad y no sobre
 *  valores concretos: lo que importa es que se LEA, no que dé cierto color. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const ch = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  };
  const [l1, l2] = [lum(a), lum(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

describe("white-label: acento", () => {
  it("preset devuelve el set exacto del handoff", () => {
    expect(resolveAccentSet("#3f5972")).toEqual(ACCENT_PRESETS["#3f5972"]!.set);
    expect(resolveAccentSet("#5f5470").soft).toBe("#e6e1ec");
  });

  it("color personalizado deriva hover/soft/tint/text", () => {
    const s = resolveAccentSet("#7a3b5e");
    expect(isValidHex(s.hover)).toBe(true);
    expect(isValidHex(s.soft)).toBe(true);
    expect(isValidHex(s.tint)).toBe(true);
    expect(s.hover).not.toBe(s.accent);
  });

  it("color demasiado claro se oscurece para contraste con texto blanco", () => {
    const s = resolveAccentSet("#ffee88"); // amarillo pálido, ilegible con blanco
    expect(s.accent).not.toBe("#ffee88");
    // el resultado debe ser notablemente más oscuro
    const lum = parseInt(s.accent.slice(1, 3), 16);
    expect(lum).toBeLessThan(0xd0);
  });

  it("hex inválido cae al default", () => {
    expect(resolveAccentSet("rojo")).toEqual(ACCENT_PRESETS["#3f5972"]!.set);
  });
});

describe("white-label: acento en tema oscuro", () => {
  it("un acento pensado para fondo blanco se aclara hasta despegarse del fondo", () => {
    // Azul profundo: sobre #101115 casi no se ve.
    const oscuro = resolveAccentSet("#12305a", "dark");
    expect(contrast("#12305a", DARK_BG)).toBeLessThan(3.5);
    expect(contrast(oscuro.accent, DARK_BG)).toBeGreaterThanOrEqual(3.5);
  });

  it("la tinta del botón sigue legible sobre el acento ya aclarado", () => {
    for (const hex of ["#12305a", "#3f5972", "#ffee88", "#7a3b5e"]) {
      const s = resolveAccentSet(hex, "dark");
      expect(contrast(s.fg, s.accent)).toBeGreaterThanOrEqual(3);
    }
  });

  it("los presets NO se aplican tal cual: están calculados para fondo blanco", () => {
    const claro = resolveAccentSet("#3f5972", "light");
    const oscuro = resolveAccentSet("#3f5972", "dark");
    expect(oscuro.accent).not.toBe(claro.accent);
    // soft y tint se mezclan hacia el fondo oscuro, no hacia blanco
    expect(contrast(oscuro.tint, DARK_BG)).toBeLessThan(2);
  });

  it("hex inválido en oscuro también cae al acento por defecto", () => {
    expect(resolveAccentSet("rojo", "dark")).toEqual(
      resolveAccentSet("#3f5972", "dark")
    );
  });

  it("el CSS inyectado trae los DOS temas: el botón cambia sin recargar", () => {
    const css = accentCssVariables("#3f5972");
    expect(css).toContain(":root:root{");
    expect(css).toContain(':root:root[data-theme="dark"]{');
    expect(css).toContain(resolveAccentSet("#3f5972", "light").accent);
    expect(css).toContain(resolveAccentSet("#3f5972", "dark").accent);
  });

  it("021: al imprimir (PDF de Reportes) manda el acento CLARO, también en oscuro", () => {
    const css = accentCssVariables("#3f5972");
    const print = css.slice(css.indexOf("@media print{"));
    expect(print).toContain(":root:root:root:root:root{");
    expect(print).toContain(`--accent:${resolveAccentSet("#3f5972", "light").accent};`);
    expect(print).not.toContain("data-theme");
  });

  it("el fondo de referencia del cálculo sigue al de globals.css", () => {
    // DARK_BG vive duplicado en branding.ts porque el cálculo de contraste es
    // JS y el token es CSS. Si alguien cambia el fondo oscuro y no el otro,
    // los acentos se calculan contra un fondo que ya no existe: aquí se cae.
    const css = readFileSync("src/app/globals.css", "utf8");
    const dark = css.slice(css.indexOf(':root[data-theme="dark"]'));
    const bg = /--bg:\s*(#[0-9a-fA-F]{6})/.exec(dark)?.[1];
    expect(bg?.toLowerCase()).toBe(DARK_BG);
  });
});

describe("white-label: normalización", () => {
  it("nombre vacío o nulo → default 'Vocero'; se recorta a 30", () => {
    expect(normalizeBranding(null).name).toBe("Vocero");
    expect(normalizeBranding({ name: "   " }).name).toBe("Vocero");
    expect(normalizeBranding({ name: "x".repeat(50) }).name).toHaveLength(30);
  });

  it("acento inválido → default", () => {
    expect(normalizeBranding({ accent: "azul" }).accent).toBe("#3f5972");
    expect(normalizeBranding({ accent: "#3F6B66" }).accent).toBe("#3f6b66");
  });
});
