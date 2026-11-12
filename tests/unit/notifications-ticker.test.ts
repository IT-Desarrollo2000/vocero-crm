import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseNotificationsTickMs,
  startNotificationsTicker,
  stopNotificationsTicker,
} from "@/server/notifications/ticker";

/** 035 B — Reloj de avisos: un fallo solo se registra; la app sigue. */

type FakeInterval = (fn: () => void, ms: number) => ReturnType<typeof setInterval>;

function capture(): { setInterval: FakeInterval; fire: () => void } {
  let cb: () => void = () => {};
  return {
    setInterval: ((fn: () => void) => {
      cb = fn;
      return 0 as unknown as ReturnType<typeof setInterval>;
    }) as FakeInterval,
    fire: () => cb(),
  };
}

describe("NOTIFICATIONS_TICK_MS", () => {
  it("default 60 s, 0 apaga, mínimo 1 s, ilegible → default", () => {
    expect(parseNotificationsTickMs(undefined)).toBe(60_000);
    expect(parseNotificationsTickMs("")).toBe(60_000);
    expect(parseNotificationsTickMs("0")).toBeNull();
    expect(parseNotificationsTickMs("10")).toBe(1_000);
    expect(parseNotificationsTickMs("abc")).toBe(60_000);
    expect(parseNotificationsTickMs("-5")).toBe(60_000);
    expect(parseNotificationsTickMs("30000")).toBe(30_000);
  });
});

describe("reloj de avisos", () => {
  afterEach(() => stopNotificationsTicker());

  it("con 0 no arranca", () => {
    expect(
      startNotificationsTicker({ env: { NOTIFICATIONS_TICK_MS: "0" }, tick: async () => {} })
    ).toBe(false);
  });

  it("una vuelta que falla (async o síncrona) solo se registra: la siguiente corre igual", async () => {
    const clock = capture();
    const tick = vi
      .fn<(now: Date) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("BD caída"))
      .mockImplementationOnce(() => {
        throw new Error("síncrono");
      })
      .mockResolvedValue({ due: 0 });
    const logError = vi.fn();
    const deps = { env: {}, tick, setInterval: clock.setInterval, logError };
    expect(startNotificationsTicker(deps)).toBe(true);
    // Guard: arrancarlo otra vez (hot reload) no duplica.
    expect(startNotificationsTicker(deps)).toBe(true);
    clock.fire();
    await vi.waitFor(() => expect(logError).toHaveBeenCalledTimes(1));
    clock.fire();
    await vi.waitFor(() => expect(logError).toHaveBeenCalledTimes(2));
    clock.fire();
    await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 0));
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it("no se solapa consigo mismo (inFlight)", async () => {
    const clock = capture();
    let release: () => void = () => {};
    const tick = vi.fn(() => new Promise<void>((r) => (release = r)));
    startNotificationsTicker({ env: {}, tick, setInterval: clock.setInterval });
    clock.fire();
    clock.fire();
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    await new Promise((r) => setTimeout(r, 0));
    clock.fire();
    expect(tick).toHaveBeenCalledTimes(2);
  });
});
