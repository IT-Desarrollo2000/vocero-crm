import { describe, expect, it } from "vitest";
import { deduceDay, detectInventedSlots } from "@/server/ai/slot-barrier";

/**
 * 025 (A4) — Barrera de horarios inventados. Conservadora: solo dispara con
 * una LISTA de horas + léxico de oferta, nunca con un horario de atención, un
 * precio o una hora suelta.
 */

const tz = "America/Mexico_City";
// Miércoles 21 de octubre de 2026, 12:24 en CDMX (el día del incidente).
const now = new Date("2026-10-21T18:24:00.000Z");
const opts = { now, timezone: tz };

describe("detectInventedSlots — positivos", () => {
  it("la lista inventada del incidente: viernes 24 ⇒ el viernes REAL (23), el nombre manda", () => {
    const text =
      "Tengo estos horarios disponibles para el viernes, 24 de octubre a las 10:00 • viernes, 24 de octubre a las 10:30 • viernes, 24 de octubre a las 11:00";
    expect(detectInventedSlots(text, opts)).toEqual({ date: "2026-10-23" });
  });

  it("la misma lista con viñetas en líneas", () => {
    const text =
      "¡Claro! Para el viernes tengo:\n• 10:00\n• 10:30\n• 11:00\n¿Cuál le acomoda?";
    expect(detectInventedSlots(text, opts)).toEqual({ date: "2026-10-23" });
  });

  it('"10, 10:30 y 11" con "tengo": los números sueltos cuentan pegados a una HH:MM', () => {
    expect(detectInventedSlots("Mañana tengo 10, 10:30 y 11", opts)).toEqual({
      date: "2026-10-22",
    });
  });

  it("el léxico en la oración anterior cuenta si la lista la continúa (pregunta o dos puntos)", () => {
    expect(
      detectInventedSlots(
        "Con gusto. ¿Cuál de estos horarios del viernes le acomoda? • viernes, 24 de octubre a las 10:00 • viernes, 24 de octubre a las 10:30 • viernes, 24 de octubre a las 11:00",
        opts
      )
    ).toEqual({ date: "2026-10-23" });
  });

  it("\"a las N\" sí es hora fuerte", () => {
    expect(detectInventedSlots("Tengo a las 10 o a las 12", opts)).toEqual({});
  });

  it("sin día nombrado: positivo sin fecha", () => {
    expect(detectInventedSlots("Tengo a las 10:00 o a las 12:00", opts)).toEqual({});
  });
});

describe("detectInventedSlots — falsos positivos que NO disparan", () => {
  const negatives = [
    "Nuestro horario es de lunes a sábado de 9:00 am a 6:00 pm y domingo de 10:00 am a 3:00 pm",
    "Tenemos horarios de lunes a sábado de 9:00 am a 6:00 pm y domingo de 10:00 am a 3:00 pm",
    "El precio de contado es de $285,990 y tengo opciones de financiamiento.",
    "Perfecto, a las 11 entonces.",
    "¡Listo! Le agendé su prueba para el vie 23 oct, 11:00",
    "Atendemos de 9:00 a 18:00, tengo disponibilidad toda la semana.",
    "Tengo horarios entre las 10 y las 12, ¿le acomoda?",
    "Tengo horarios de 10:00-14:00",
    // Léxico de atención en singular y plural (no es una oferta).
    "Nuestros horarios: abre a las 9:00 y cierra a las 18:00",
    "Nuestros horarios: abrimos a las 9:00 y cerramos a las 18:00",
    "Los horarios: abren a las 9:00, cierran a las 18:00",
    "Horarios de atención disponibles: 9:00 y 18:00",
    "Tengo horarios: atiende a las 9:00 y a las 18:00",
    "Abrimos de lunes a sábado de 9:00 a 18:00 y domingo de 10:00 a 15:00.",
    // R2: "las N" suelto no es hora fuerte, y un número seguido de un
    // sustantivo es una cantidad.
    "Quedan las 3 unidades blancas y las 2 negras",
    "Tengo 2 modelos y 3 colores disponibles",
    // R2: el léxico de oferta en OTRA oración; el `;` divide oraciones.
    "Su cita queda a las 11:00; llegue a las 10:45, tenemos estacionamiento disponible",
    "Su cita queda a las 11:00 y llegue a las 10:45. Tenemos estacionamiento disponible.",
    "",
  ];
  for (const text of negatives) {
    it(JSON.stringify(text), () => {
      expect(detectInventedSlots(text, opts)).toBeNull();
    });
  }

  it("dos horas sin léxico de oferta no disparan (p. ej. repetir lo que dijo el cliente)", () => {
    expect(detectInventedSlots("Entonces a las 10:00, y si no a las 11:00", opts)).toBeNull();
  });
});

describe("deduceDay", () => {
  it.each([
    ["el viernes 24", "2026-10-23"],
    ["el sábado", "2026-10-24"],
    ["el miércoles", "2026-10-21"],
    ["el martes", "2026-10-27"],
    ["mañana", "2026-10-22"],
    ["pasado mañana", "2026-10-23"],
    ["hoy", "2026-10-21"],
    ["el 24 de octubre", "2026-10-24"],
    ["el 5 de enero", "2027-01-05"],
    ["el 30", "2026-10-30"],
    ["el 2", "2026-11-02"],
  ])("%s ⇒ %s", (text, iso) => {
    expect(deduceDay(text, now, tz)).toBe(iso);
  });

  it('"por la mañana" no es un día', () => {
    expect(deduceDay("por la mañana", now, tz)).toBeUndefined();
  });
});
