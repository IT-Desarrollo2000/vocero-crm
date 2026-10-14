import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 018 — Caché de 30 días (FR-815/817): la purga borra SOLO
 * `MEDIA_DIR/{org}/{assetId}` de filas seleccionadas, marca `expired`, es
 * idempotente y va por lotes. El reloj sigue el patrón de recordatorios.
 */

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ MEDIA_DIR: "/data/media" }),
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}), schema: { mediaAsset: {} } }));

const { runMediaPurge, parseRetentionDays, PURGEABLE_STATUSES } = await import(
  "@/server/media/purge"
);
const PURGEABLE: readonly string[] = PURGEABLE_STATUSES;
const { parsePurgeTickMs, startMediaPurgeTicker, stopMediaPurgeTicker } = await import(
  "@/server/media/purge-ticker"
);

const NOW = new Date("2026-11-20T12:00:00Z");

/** BD falsa: filas con fecha y estado; select/markExpired como la real. */
function fakeStore(
  rows: { id: string; organizationId: string; createdAt: Date; status: string }[]
) {
  return {
    rows,
    selectBatch: async (cutoff: Date, limit: number) =>
      rows
        .filter((r) => r.createdAt < cutoff && PURGEABLE.includes(r.status))
        .slice(0, limit)
        .map(({ id, organizationId }) => ({ id, organizationId })),
    markExpired: async (ids: string[]) => {
      for (const r of rows) if (ids.includes(r.id)) r.status = "expired";
    },
  };
}

describe("runMediaPurge", () => {
  it("expira lo creado antes del corte y borra solo su archivo", async () => {
    const store = fakeStore([
      { id: "ma_viejo", organizationId: "org_1", createdAt: new Date("2026-10-01"), status: "available" },
      { id: "ma_nuevo", organizationId: "org_1", createdAt: new Date("2026-11-10"), status: "available" },
      { id: "ma_otra", organizationId: "org_2", createdAt: new Date("2026-09-01"), status: "failed" },
    ]);
    const removed: string[] = [];
    const r = await runMediaPurge(NOW, 30, {
      ...store,
      removeFile: async (f) => {
        removed.push(f);
      },
    });

    expect(r).toEqual({ cutoff: "2026-10-21T12:00:00.000Z", expired: 2 });
    expect(removed.sort()).toEqual(
      [
        path.join("/data/media", "org_1", "ma_viejo"),
        path.join("/data/media", "org_2", "ma_otra"),
      ].sort()
    );
    expect(store.rows.map((x) => x.status)).toEqual(["expired", "available", "expired"]);
    // Jamás el favicon: no es una fila, así que no hay forma de que se pida.
    expect(removed.some((f) => f.endsWith("favicon"))).toBe(false);
  });

  it("un `blocked` viejo NO se purga: no tiene archivo y conserva su aviso", async () => {
    expect(PURGEABLE).not.toContain("blocked");
    expect(PURGEABLE).not.toContain("expired");
    const store = fakeStore([
      { id: "ma_bloq", organizationId: "org_1", createdAt: new Date("2026-01-01"), status: "blocked" },
    ]);
    const removeFile = vi.fn(async () => {});
    const r = await runMediaPurge(NOW, 30, { ...store, removeFile });
    expect(r.expired).toBe(0);
    expect(removeFile).not.toHaveBeenCalled();
    expect(store.rows[0]?.status).toBe("blocked");
  });

  it("idempotente: la segunda vuelta no hace nada", async () => {
    const store = fakeStore([
      { id: "ma_1", organizationId: "org_1", createdAt: new Date("2026-01-01"), status: "available" },
    ]);
    const removeFile = vi.fn(async () => {});
    await runMediaPurge(NOW, 30, { ...store, removeFile });
    const again = await runMediaPurge(NOW, 30, { ...store, removeFile });
    expect(again.expired).toBe(0);
    expect(removeFile).toHaveBeenCalledTimes(1);
  });

  it("por lotes: recorre todo aunque haya más filas que el lote", async () => {
    const store = fakeStore(
      Array.from({ length: 7 }, (_, i) => ({
        id: `ma_${i}`,
        organizationId: "org_1",
        createdAt: new Date("2026-01-01"),
        status: "pending",
      }))
    );
    const r = await runMediaPurge(NOW, 30, {
      ...store,
      removeFile: async () => {},
      batchSize: 3,
    });
    expect(r.expired).toBe(7);
    expect(store.rows.every((x) => x.status === "expired")).toBe(true);
  });

  it("un archivo que no se puede borrar no detiene el lote ni se marca", async () => {
    const store = fakeStore([
      { id: "ma_malo", organizationId: "org_1", createdAt: new Date("2026-01-01"), status: "available" },
      { id: "ma_bueno", organizationId: "org_1", createdAt: new Date("2026-01-01"), status: "available" },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await runMediaPurge(NOW, 30, {
      ...store,
      removeFile: async (f) => {
        if (f.endsWith("ma_malo")) throw new Error("EACCES");
      },
      batchSize: 2,
    });
    warn.mockRestore();
    expect(r.expired).toBe(1);
    expect(store.rows.find((x) => x.id === "ma_malo")?.status).toBe("available");
  });

  it("la retención es configurable", async () => {
    const store = fakeStore([
      { id: "ma_1", organizationId: "org_1", createdAt: new Date("2026-11-15"), status: "available" },
    ]);
    const r = await runMediaPurge(NOW, 3, { ...store, removeFile: async () => {} });
    expect(r.expired).toBe(1);
  });
});

describe("parámetros del reloj", () => {
  it("MEDIA_RETENTION_DAYS: default 30, mínimo 1", () => {
    expect(parseRetentionDays(undefined)).toBe(30);
    expect(parseRetentionDays("")).toBe(30);
    expect(parseRetentionDays("abc")).toBe(30);
    expect(parseRetentionDays("-5")).toBe(30);
    expect(parseRetentionDays("0")).toBe(30);
    expect(parseRetentionDays("7")).toBe(7);
    expect(parseRetentionDays("0.5")).toBe(1);
  });

  it("MEDIA_PURGE_TICK_MS: default 1 h, 0 apaga, mínimo 1 min", () => {
    expect(parsePurgeTickMs(undefined)).toBe(3_600_000);
    expect(parsePurgeTickMs(" ")).toBe(3_600_000);
    expect(parsePurgeTickMs("nada")).toBe(3_600_000);
    expect(parsePurgeTickMs("-1")).toBe(3_600_000);
    expect(parsePurgeTickMs("0")).toBeNull();
    expect(parsePurgeTickMs("10")).toBe(60_000);
    expect(parsePurgeTickMs("120000")).toBe(120_000);
  });
});

describe("startMediaPurgeTicker", () => {
  afterEach(() => stopMediaPurgeTicker());

  it("arranca sin bandera y no duplica intervalos", () => {
    const setIntervalFn = vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(startMediaPurgeTicker({ env: {}, setInterval: setIntervalFn })).toBe(true);
    expect(startMediaPurgeTicker({ env: {}, setInterval: setIntervalFn })).toBe(true);
    log.mockRestore();
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 3_600_000);
  });

  it("MEDIA_PURGE_TICK_MS=0 → no arranca", () => {
    const setIntervalFn = vi.fn();
    expect(
      startMediaPurgeTicker({ env: { MEDIA_PURGE_TICK_MS: "0" }, setInterval: setIntervalFn })
    ).toBe(false);
    expect(setIntervalFn).not.toHaveBeenCalled();
  });

  it("la vuelta usa la retención del entorno y un fallo solo se loguea", async () => {
    let run: () => void = () => {};
    const tick = vi.fn(async () => {
      throw new Error("BD caída");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    startMediaPurgeTicker({
      env: { MEDIA_RETENTION_DAYS: "10" },
      tick,
      setInterval: (fn) => {
        run = fn;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
    });
    run();
    await new Promise((r) => setTimeout(r, 0));
    expect(tick).toHaveBeenCalledWith(expect.any(Date), 10);
    expect(err).toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
  });
});
