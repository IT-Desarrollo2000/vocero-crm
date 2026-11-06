import { describe, expect, it } from "vitest";
import { tzLabel, tzPlace } from "@/lib/tz-label";

/** 032 — La zona del negocio se dice como lugar, nunca como IANA. */

describe("tzLabel", () => {
  it("zonas de México", () => {
    expect(tzLabel("America/Mexico_City")).toBe("hora de Ciudad de México");
    expect(tzLabel("America/Monterrey")).toBe("hora de Monterrey");
    expect(tzLabel("America/Merida")).toBe("hora de Mérida");
    expect(tzLabel("America/Cancun")).toBe("hora de Cancún");
    expect(tzLabel("America/Chihuahua")).toBe("hora de Chihuahua");
    expect(tzLabel("America/Ciudad_Juarez")).toBe("hora de Ciudad Juárez");
    expect(tzLabel("America/Hermosillo")).toBe("hora de Hermosillo");
    expect(tzLabel("America/Mazatlan")).toBe("hora de Mazatlán");
    expect(tzLabel("America/Tijuana")).toBe("hora de Tijuana");
    expect(tzLabel("America/Bahia_Banderas")).toBe("hora de Bahía de Banderas");
    expect(tzLabel("America/Matamoros")).toBe("hora de Matamoros");
    expect(tzLabel("America/Ojinaga")).toBe("hora de Ojinaga");
  });

  it("Latinoamérica y Madrid", () => {
    expect(tzLabel("America/Bogota")).toBe("hora de Bogotá");
    expect(tzLabel("America/Lima")).toBe("hora de Lima");
    expect(tzLabel("America/Santiago")).toBe("hora de Santiago de Chile");
    expect(tzLabel("America/Argentina/Buenos_Aires")).toBe("hora de Buenos Aires");
    expect(tzLabel("America/Guatemala")).toBe("hora de Guatemala");
    expect(tzLabel("America/El_Salvador")).toBe("hora de El Salvador");
    expect(tzLabel("America/Costa_Rica")).toBe("hora de Costa Rica");
    expect(tzLabel("America/Panama")).toBe("hora de Panamá");
    expect(tzLabel("America/Caracas")).toBe("hora de Caracas");
    expect(tzLabel("Europe/Madrid")).toBe("hora de Madrid");
  });

  it("respaldo: último segmento con «_» → espacio", () => {
    expect(tzLabel("America/Port_of_Spain")).toBe("hora de Port of Spain");
    expect(tzPlace("Asia/Tokyo")).toBe("Tokyo");
    expect(tzLabel("UTC")).toBe("hora UTC");
  });

  it("sin zona ⇒ null (la pantalla no dice nada)", () => {
    expect(tzLabel(undefined)).toBeNull();
    expect(tzLabel("")).toBeNull();
    expect(tzLabel("   ")).toBeNull();
  });
});
