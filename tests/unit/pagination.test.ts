import { describe, expect, it } from "vitest";
import {
  nextOffset,
  PAGE_DEFAULT_LIMIT,
  PAGE_MAX_LIMIT,
  parsePage,
} from "@/lib/pagination";

const p = (qs: string) => parsePage(new URLSearchParams(qs));

describe("parsePage", () => {
  it("sin parámetros usa el default y empieza en 0", () => {
    expect(p("")).toEqual({ limit: PAGE_DEFAULT_LIMIT, offset: 0 });
  });

  it("respeta valores válidos", () => {
    expect(p("limit=25&offset=75")).toEqual({ limit: 25, offset: 75 });
  });

  it("ajusta al borde lo que se sale del rango", () => {
    expect(p("limit=500").limit).toBe(PAGE_MAX_LIMIT);
    expect(p("limit=0").limit).toBe(1);
    expect(p("limit=-3").limit).toBe(1);
    expect(p("offset=-10").offset).toBe(0);
  });

  it("lo ilegible cae al default en vez de romper", () => {
    expect(p("limit=abc&offset=xyz")).toEqual({ limit: PAGE_DEFAULT_LIMIT, offset: 0 });
    expect(p("limit=2.5").limit).toBe(PAGE_DEFAULT_LIMIT);
    expect(p("limit=&offset=").offset).toBe(0);
    expect(p("limit=Infinity").limit).toBe(PAGE_DEFAULT_LIMIT);
  });
});

describe("nextOffset", () => {
  it("apunta a la siguiente página mientras quede algo", () => {
    expect(nextOffset({ limit: 50, offset: 0 }, 50, 120)).toBe(50);
    expect(nextOffset({ limit: 50, offset: 100 }, 20, 120)).toBeNull();
  });

  it("una página exacta al final no promete otra", () => {
    expect(nextOffset({ limit: 50, offset: 50 }, 50, 100)).toBeNull();
  });

  it("una página vacía nunca promete otra (evita bucles)", () => {
    expect(nextOffset({ limit: 50, offset: 300 }, 0, 120)).toBeNull();
  });
});
