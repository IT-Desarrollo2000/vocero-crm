import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseReminderTickMs,
  startReminderTicker,
  stopReminderTicker,
} from "@/server/agenda/reminder-ticker";

/**
 * 10 — El reloj de recordatorios vive detrás de AGENDA (RF-10-01): apagada,
 * no arranca; con `AGENDA_REMINDER_TICK_MS=0`, tampoco; el hot reload no
 * duplica intervalos; y la ruta dev responde 404 sin la agenda.
 */

const runReminderTick = vi.fn(async () => ({}));
vi.mock("@/server/agenda/reminders", () => ({ runReminderTick }));

// Import en la recolección: la primera carga de la ruta es lenta bajo carga.
const { POST } = await import("@/app/api/dev/reminders/tick/route");

afterEach(() => {
  stopReminderTicker();
  vi.unstubAllEnvs();
  runReminderTick.mockClear();
});

describe("parseReminderTickMs", () => {
  it("default 60 s; 0 apaga; ilegible → default; mínimo 1 s", () => {
    expect(parseReminderTickMs(undefined)).toBe(60_000);
    expect(parseReminderTickMs("")).toBe(60_000);
    expect(parseReminderTickMs("0")).toBeNull();
    expect(parseReminderTickMs("abc")).toBe(60_000);
    expect(parseReminderTickMs("-5")).toBe(60_000);
    expect(parseReminderTickMs("10")).toBe(1_000);
    expect(parseReminderTickMs("30000")).toBe(30_000);
  });
});

describe("startReminderTicker", () => {
  const fakeInterval = () => {
    const calls: { fn: () => void; ms: number }[] = [];
    const setIntervalFn = (fn: () => void, ms: number) => {
      calls.push({ fn, ms });
      return setInterval(() => {}, 1 << 30);
    };
    return { calls, setIntervalFn };
  };

  it("con AGENDA apagada no arranca", () => {
    const f = fakeInterval();
    expect(startReminderTicker({ env: {}, setInterval: f.setIntervalFn })).toBe(false);
    expect(startReminderTicker({ env: { AGENDA: "off" }, setInterval: f.setIntervalFn })).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  it("con AGENDA_REMINDER_TICK_MS=0 no arranca", () => {
    const f = fakeInterval();
    expect(
      startReminderTicker({
        env: { AGENDA: "on", AGENDA_REMINDER_TICK_MS: "0" },
        setInterval: f.setIntervalFn,
      })
    ).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  it("encendida arranca UNA vez (guard en globalThis) y no solapa ticks", async () => {
    const f = fakeInterval();
    let release: () => void = () => {};
    const tick = vi.fn(() => new Promise<void>((r) => (release = r)));
    const env = { AGENDA: "on", AGENDA_REMINDER_TICK_MS: "5000" };
    expect(startReminderTicker({ env, tick, setInterval: f.setIntervalFn })).toBe(true);
    expect(startReminderTicker({ env, tick, setInterval: f.setIntervalFn })).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.ms).toBe(5000);

    f.calls[0]!.fn();
    f.calls[0]!.fn(); // el primero sigue en vuelo
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    await new Promise((r) => setTimeout(r, 0));
    f.calls[0]!.fn();
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("un tick que lanza solo se loguea", async () => {
    const f = fakeInterval();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const tick = vi.fn(async () => {
      throw new Error("BD caída");
    });
    startReminderTicker({ env: { AGENDA: "on" }, tick, setInterval: f.setIntervalFn });
    f.calls[0]!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(err).toHaveBeenCalled();
  });
});

describe("POST /api/dev/reminders/tick", () => {
  const req = () =>
    new Request("http://localhost/api/dev/reminders/tick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ now: "2026-10-19T16:01:00.000Z" }),
    });

  it("con AGENDA apagada → 404 sin cuerpo, sin tocar el tick", async () => {
    vi.stubEnv("WA_MOCK_ENABLED", "true");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AGENDA", "");
    const res = await POST(req());
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(runReminderTick).not.toHaveBeenCalled();
  });

  it("con AGENDA encendida llama runReminderTick DIRECTO con el reloj pedido", async () => {
    vi.stubEnv("WA_MOCK_ENABLED", "true");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AGENDA", "on");
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(runReminderTick).toHaveBeenCalledWith(new Date("2026-10-19T16:01:00.000Z"));
  });
});
