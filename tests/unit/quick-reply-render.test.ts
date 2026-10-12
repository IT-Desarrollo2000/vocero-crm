import { describe, expect, it } from "vitest";
import { renderQuickReply } from "@/lib/quick-replies";
import {
  insertQuickReply,
  movePositions,
  quickReplyContext,
} from "@/components/inbox/quick-reply-render";
import type { QuickReplyDto } from "@/lib/types";

/**
 * 09 — Respuestas rápidas: lo exclusivo de la interfaz. El render, el atajo
 * `/` y el filtrado se prueban en `quick-replies.test.ts` (fuente única).
 */

const viewer = { name: "Ana Vendedora", businessName: "Panadería Sol" };

describe("quickReplyContext", () => {
  it("nombre = primera palabra; completo sin espacios sobrantes", () => {
    expect(quickReplyContext("  María   López ", viewer)).toEqual({
      nombre: "María",
      nombreCompleto: "María   López",
      vendedor: "Ana Vendedora",
      negocio: "Panadería Sol",
    });
  });

  it("alimenta el render compartido con las cuatro variables", () => {
    expect(
      renderQuickReply(
        "Hola {{nombre}} ({{nombre_completo}}), soy {{vendedor}} de {{negocio}}.",
        quickReplyContext("María López", viewer)
      )
    ).toBe("Hola María (María López), soy Ana Vendedora de Panadería Sol.");
  });

  it("contacto sin nombre → variable vacía y sin espacio huérfano", () => {
    expect(
      renderQuickReply("Hola {{nombre}}, ¿cómo estás?", quickReplyContext(null, viewer))
    ).toBe("Hola, ¿cómo estás?");
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
