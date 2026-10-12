import { describe, expect, it } from "vitest";
import {
  findUnknownVars,
  insertQuickReply,
  matchQuickReplies,
  movePositions,
  quickReplyContext,
  renderQuickReply,
  slashQuery,
} from "@/components/inbox/quick-reply-render";
import type { QuickReplyDto } from "@/lib/types";

/**
 * 09 — Respuestas rápidas en el compositor (lógica pura, provisional hasta
 * unificar con `src/lib/quick-replies.ts`).
 */

const viewer = { name: "Ana Vendedora", businessName: "Panadería Sol" };

describe("renderQuickReply", () => {
  it("sustituye las cuatro variables con su contexto", () => {
    const ctx = quickReplyContext("María López", viewer);
    expect(
      renderQuickReply(
        "Hola {{nombre}} ({{nombre_completo}}), soy {{vendedor}} de {{negocio}}.",
        ctx
      )
    ).toBe("Hola María (María López), soy Ana Vendedora de Panadería Sol.");
  });

  it("tolera espacios dentro de las llaves y variables repetidas", () => {
    const ctx = quickReplyContext("María López", viewer);
    expect(renderQuickReply("{{ nombre }} y {{nombre}}", ctx)).toBe("María y María");
  });

  it("variable sin valor → cadena vacía y espacios dobles colapsados", () => {
    const ctx = quickReplyContext("", viewer);
    expect(renderQuickReply("Hola {{nombre}} ¿cómo estás?", ctx)).toBe(
      "Hola ¿cómo estás?"
    );
    expect(renderQuickReply("Hola {{nombre}}", { vendedor: "x" })).toBe("Hola ");
  });

  it("conserva los saltos de línea", () => {
    const ctx = quickReplyContext("Leo", viewer);
    expect(renderQuickReply("Hola {{nombre}}\n\nSaludos", ctx)).toBe(
      "Hola Leo\n\nSaludos"
    );
  });

  it("deja tal cual una variable desconocida", () => {
    expect(renderQuickReply("Tel {{telefono}}", {})).toBe("Tel {{telefono}}");
  });

  it("es estable entre llamadas (el patrón global no arrastra lastIndex)", () => {
    const ctx = quickReplyContext("Leo", viewer);
    for (let i = 0; i < 3; i++) {
      expect(renderQuickReply("{{nombre}}", ctx)).toBe("Leo");
    }
  });
});

describe("quickReplyContext", () => {
  it("nombre = primera palabra; completo sin espacios sobrantes", () => {
    expect(quickReplyContext("  María   López ", viewer)).toEqual({
      nombre: "María",
      nombreCompleto: "María   López",
      vendedor: "Ana Vendedora",
      negocio: "Panadería Sol",
    });
  });
});

describe("findUnknownVars", () => {
  it("nombra solo las desconocidas, sin repetir", () => {
    expect(findUnknownVars("{{telefono}} {{nombre}} {{ telefono }} {{email}}")).toEqual([
      "telefono",
      "email",
    ]);
    expect(findUnknownVars("Hola {{nombre}}")).toEqual([]);
  });
});

describe("slashQuery", () => {
  it("dispara al inicio del campo", () => {
    expect(slashQuery("/hor", 4)).toEqual({ query: "hor", start: 0 });
    expect(slashQuery("/", 1)).toEqual({ query: "", start: 0 });
  });

  it("dispara tras un espacio o un salto de línea", () => {
    expect(slashQuery("hola /pa", 8)).toEqual({ query: "pa", start: 5 });
    expect(slashQuery("hola\n/Pa", 8)).toEqual({ query: "pa", start: 5 });
  });

  it("'1/2 kilo' no dispara", () => {
    expect(slashQuery("1/2 kilo", 3)).toBeNull();
    expect(slashQuery("1/2", 3)).toBeNull();
  });

  it("depende del cursor: con el cursor en medio mira la palabra hasta él", () => {
    expect(slashQuery("/horario y más", 3)).toEqual({ query: "ho", start: 0 });
    expect(slashQuery("/horario y más", 14)).toBeNull();
  });

  it("no dispara con caracteres fuera del atajo", () => {
    expect(slashQuery("/hola!", 6)).toBeNull();
  });
});

let seq = 0;
function qr(shortcut: string, title: string, position: number): QuickReplyDto {
  seq++;
  return {
    id: `qr_${seq}`,
    shortcut,
    title,
    body: `cuerpo ${shortcut}`,
    position,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

describe("matchQuickReplies", () => {
  const horario = qr("horario", "Horario de atención", 2);
  const pago = qr("pago", "Formas de pago", 0);
  const ubicacion = qr("ubicacion", "Dónde estamos", 1);
  const precioHora = qr("precios", "Precio por hora", 3);
  const list = [horario, pago, ubicacion, precioHora];

  it("consulta vacía → todas por position", () => {
    expect(matchQuickReplies(list, "").map((r) => r.shortcut)).toEqual([
      "pago",
      "ubicacion",
      "horario",
      "precios",
    ]);
  });

  it("primero los que empiezan con la consulta, luego los que la contienen (atajo o título)", () => {
    expect(matchQuickReplies(list, "hor").map((r) => r.shortcut)).toEqual([
      "horario",
      "precios",
    ]);
  });

  it("sin acentos ni mayúsculas", () => {
    expect(matchQuickReplies(list, "DONDE").map((r) => r.shortcut)).toEqual([
      "ubicacion",
    ]);
  });

  it("sin coincidencias → vacía (el selector no se abre)", () => {
    expect(matchQuickReplies(list, "zzz")).toEqual([]);
  });

  it("respeta el límite", () => {
    expect(matchQuickReplies(list, "", 2)).toHaveLength(2);
  });
});

describe("insertQuickReply", () => {
  it("reemplaza el /atajo por el texto y deja el cursor al final", () => {
    expect(insertQuickReply("ok /hor gracias", 3, 7, "Abrimos 9-6")).toEqual({
      text: "ok Abrimos 9-6 gracias",
      caret: 14,
    });
  });
});

describe("movePositions", () => {
  const a = qr("a", "A", 0);
  const b = qr("b", "B", 1);
  const c = qr("c", "C", 2);

  it("subir el segundo intercambia con el primero", () => {
    expect(movePositions([a, b, c], 1, 0)).toEqual([
      { id: b.id, position: 0 },
      { id: a.id, position: 1 },
    ]);
  });

  it("normaliza posiciones repetidas (todas en 0)", () => {
    const x = qr("x", "X", 0);
    const y = qr("y", "Y", 0);
    expect(movePositions([x, y], 1, 0)).toEqual([{ id: x.id, position: 1 }]);
  });

  it("fuera de rango o sin movimiento → sin cambios", () => {
    expect(movePositions([a, b], 0, -1)).toEqual([]);
    expect(movePositions([a, b], 1, 1)).toEqual([]);
  });
});
