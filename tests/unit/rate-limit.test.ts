import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_RATE_LIMIT,
  checkRateLimit,
  peekRateLimit,
  resetRateLimit,
} from "@/lib/rate-limit";

describe("rate limit por IP (FR-062: 10 / 10 min → 429)", () => {
  beforeEach(() => resetRateLimit());

  it("permite hasta el máximo y bloquea el siguiente", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < AUTH_RATE_LIMIT.max; i++) {
      expect(
        checkRateLimit("login:1.2.3.4", AUTH_RATE_LIMIT, t0 + i).allowed
      ).toBe(true);
    }
    expect(
      checkRateLimit("login:1.2.3.4", AUTH_RATE_LIMIT, t0 + 100).allowed
    ).toBe(false);
  });

  it("la ventana desliza: pasados 10 minutos vuelve a permitir", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < AUTH_RATE_LIMIT.max; i++) {
      checkRateLimit("k", AUTH_RATE_LIMIT, t0 + i);
    }
    expect(checkRateLimit("k", AUTH_RATE_LIMIT, t0 + 1000).allowed).toBe(false);
    expect(
      checkRateLimit("k", AUTH_RATE_LIMIT, t0 + AUTH_RATE_LIMIT.windowMs + 500)
        .allowed
    ).toBe(true);
  });

  it("claves distintas (IPs) no se afectan entre sí", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < AUTH_RATE_LIMIT.max; i++) {
      checkRateLimit("login:1.1.1.1", AUTH_RATE_LIMIT, t0 + i);
    }
    expect(
      checkRateLimit("login:1.1.1.1", AUTH_RATE_LIMIT, t0 + 100).allowed
    ).toBe(false);
    expect(
      checkRateLimit("login:2.2.2.2", AUTH_RATE_LIMIT, t0 + 100).allowed
    ).toBe(true);
  });
});

describe("peekRateLimit (011: cubetas que solo cuentan fallos)", () => {
  beforeEach(() => resetRateLimit());

  it("consulta sin registrar el intento", () => {
    const opts = { windowMs: 60_000, max: 2 };
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(peekRateLimit("k", opts, t0 + i).allowed).toBe(true);
    }
    checkRateLimit("k", opts, t0);
    expect(peekRateLimit("k", opts, t0 + 1)).toEqual({ allowed: true, remaining: 1 });
    checkRateLimit("k", opts, t0 + 2);
    expect(peekRateLimit("k", opts, t0 + 3)).toEqual({ allowed: false, remaining: 0 });
    // La ventana desliza igual que en checkRateLimit.
    expect(peekRateLimit("k", opts, t0 + opts.windowMs + 3).allowed).toBe(true);
  });
});
