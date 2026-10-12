import { describe, expect, it } from "vitest";
import { aiMockCompletion } from "@/server/dev/ai-mock";

/**
 * 03 — Rama "¿qué sabes de mí?" del ai-mock: devuelve el contenido del bloque
 * de contexto que llegó en el system, para que el E2E compruebe que el bloque
 * LLEGA al proveedor. Las demás ramas no cambian.
 */

const system = [
  "Eres X",
  "DATOS DEL CONTACTO",
  "<<<DATOS_CONTACTO>>>",
  "Nombre: «Ana»",
  "Ficha:",
  "- modelo_interes: «Leapmotor T03»",
  "<<<FIN_DATOS_CONTACTO>>>",
  "En cada turno respondes…",
].join("\n");

describe("ai-mock — ¿qué sabes de mí?", () => {
  it("devuelve CTX: con el bloque en una línea (sin acentos ni mayúsculas en la pregunta)", () => {
    for (const q of ["¿Qué sabes de mí?", "que sabes de mi", "QUÉ SABES DE MI"]) {
      const out = JSON.parse(
        aiMockCompletion([
          { role: "system", content: system },
          { role: "user", content: q },
        ])
      );
      expect(out.action).toBe("reply");
      expect(out.text).toBe(
        "CTX: Nombre: «Ana» Ficha: - modelo_interes: «Leapmotor T03»"
      );
    }
  });

  it("sin bloque en el system → CTX con aviso", () => {
    const out = JSON.parse(
      aiMockCompletion([{ role: "user", content: "¿qué sabes de mí?" }])
    );
    expect(out.text).toBe("CTX: (sin datos del contacto)");
  });

  it("el eco de siempre devuelve el marcador de medios", () => {
    const out = JSON.parse(
      aiMockCompletion([{ role: "user", content: "[imagen] «¿lo tienen en rojo?»" }])
    );
    expect(out.text).toContain("[imagen] «¿lo tienen en rojo?»");
  });
});
