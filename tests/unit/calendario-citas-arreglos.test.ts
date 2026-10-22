import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockStartUtc, calendarVisible, coalesce } from "@/lib/time/calendar";

/**
 * 028 — Portado de upstream (`calendario-citas-arreglos.test.ts`, 215) SOLO
 * en lo que aplica a nuestro árbol: el bloqueo en hora del NEGOCIO (A8), la
 * ráfaga de SSE y las citas de prueba/canceladas ocultas. No se porta "fallo
 * 2" (`groupSlotsByDay` de upstream; el nuestro vive en `booking-logic.ts` con
 * otra forma) ni la revisión de `booking-drawer.tsx` (no existe aquí).
 */

describe("A8 · bloquear usa la hora del NEGOCIO, no la del navegador", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("las 15:00 de Ciudad de México son las 21:00 UTC", () => {
    expect(blockStartUtc("2026-09-24", "15:00", "America/Mexico_City")).toBe(
      "2026-09-24T21:00:00.000Z"
    );
  });

  it("la misma hora de pared en otra zona es otro instante", () => {
    expect(blockStartUtc("2026-09-24", "15:00", "Asia/Tokyo")).toBe("2026-09-24T06:00:00.000Z");
    expect(blockStartUtc("2026-09-24", "15:00", "Europe/Madrid")).toBe("2026-09-24T13:00:00.000Z");
  });

  it("no depende de la zona del proceso (el navegador de quien mira)", () => {
    const results = ["Asia/Tokyo", "Europe/Madrid", "America/Mexico_City", "UTC"].map((tz) => {
      process.env.TZ = tz;
      return blockStartUtc("2026-09-24", "15:00", "America/Mexico_City");
    });
    expect(new Set(results)).toEqual(new Set(["2026-09-24T21:00:00.000Z"]));
  });

  it("día u hora inexistentes no producen un instante", () => {
    expect(blockStartUtc("2026-02-31", "15:00", "America/Mexico_City")).toBeNull();
    expect(blockStartUtc("2026-09-24", "25:00", "America/Mexico_City")).toBeNull();
    expect(blockStartUtc("", "15:00", "America/Mexico_City")).toBeNull();
  });

  it("la pantalla ya no arma el bloqueo con new Date(datetime-local)", () => {
    const src = readFileSync(
      path.resolve(import.meta.dirname, "../../src/components/bookings/bookings-client.tsx"),
      "utf8"
    );
    expect(src).toContain("blockStartUtc(");
    expect(src).not.toMatch(/new Date\(blockStart\)/);
  });
});

describe("SSE · una ráfaga de eventos cuesta UNA recarga", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesce junta la ráfaga", () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const sse = coalesce(reload, 250);
    for (let i = 0; i < 5; i++) {
      sse.trigger();
      vi.advanceTimersByTime(100);
    }
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(reload).toHaveBeenCalledTimes(1);
    sse.trigger();
    vi.advanceTimersByTime(250);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("al desmontar, la recarga pendiente no corre", () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const sse = coalesce(reload, 250);
    sse.trigger();
    sse.cancel();
    vi.advanceTimersByTime(1000);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("las citas del Laboratorio y las canceladas no ensucian el calendario", () => {
  const b = (id: string, status: string, isTest: boolean) => ({ id, status, isTest });
  const all = [
    b("real", "agendada", false),
    b("cancelada", "cancelada", false),
    b("prueba", "agendada", true),
    b("prueba-cancelada", "cancelada", true),
  ];
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

  it("por defecto se ocultan las pruebas y las canceladas", () => {
    expect(ids(calendarVisible(all, { showCancelled: false, showTests: false }))).toEqual(["real"]);
  });

  it("cada interruptor muestra lo suyo", () => {
    expect(ids(calendarVisible(all, { showCancelled: false, showTests: true }))).toEqual([
      "real",
      "prueba",
    ]);
    expect(ids(calendarVisible(all, { showCancelled: true, showTests: false }))).toEqual([
      "real",
      "cancelada",
    ]);
    expect(calendarVisible(all, { showCancelled: true, showTests: true })).toHaveLength(4);
  });
});
