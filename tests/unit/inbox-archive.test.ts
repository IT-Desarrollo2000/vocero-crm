import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * 022 — Archivo de conversaciones: la condición "archivable" (texto SQL y
 * parámetros), la limpieza masiva/auto contra una BD SIMULADA (cliente
 * postgres-js falso que anota cada sentencia, como `inbox-list.test.ts`), los
 * ajustes de la Bandeja, el reloj y los esquemas Zod de las rutas.
 */

type Call = { sql: string; params: unknown[] };
const calls: Call[] = [];
let responder: (call: Call) => unknown[][] = () => [];

const fakeClient = {
  options: { parsers: {}, serializers: {} },
  unsafe(query: string, params: unknown[]) {
    const call = { sql: query, params };
    calls.push(call);
    const rows = responder(call);
    const p = Promise.resolve(rows) as Promise<unknown[][]> & {
      values: () => Promise<unknown[][]>;
    };
    p.values = () => Promise.resolve(rows);
    return p;
  },
};

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  const db = drizzle(fakeClient as never, { schema: original.schema });
  return { ...original, getDb: () => db };
});

const published: { org: string; event: unknown }[] = [];
vi.mock("@/server/events/bus", () => ({
  publish: (org: string, event: unknown) => published.push({ org, event }),
}));

const {
  UNARCHIVE_SET,
  archiveInactive,
  getInboxSettings,
  inactiveArchivableCondition,
  inactivityCutoff,
  runAutoArchive,
  saveInboxSettings,
} = await import("@/server/inbox/archive");
const { archiveInactiveSchema, inboxSettingsSchema, DEFAULT_INBOX_SETTINGS } = await import(
  "@/lib/inbox-settings"
);
const { parseAutoArchiveTickMs, startAutoArchiveTicker, stopAutoArchiveTicker } = await import(
  "@/server/inbox/auto-archive-ticker"
);

const NOW = new Date("2026-10-19T12:00:00.000Z");
const CUTOFF = new Date("2026-10-05T12:00:00.000Z");

beforeEach(() => {
  calls.length = 0;
  published.length = 0;
  responder = () => [];
});

const dialect = new PgDialect();

describe("inactiveArchivableCondition — forma del SQL", () => {
  const q = dialect.sqlToQuery(inactiveArchivableCondition("org_1", { cutoff: CUTOFF, now: NOW }));

  it("inactiva por coalesce(last_message_at, created_at) < corte (parámetro, nunca now())", () => {
    expect(q.sql).toMatch(
      /coalesce\("conversation"\."last_message_at", "conversation"\."created_at"\) < \$\d+/
    );
    expect(q.sql).not.toContain("now()");
    // El corte viaja codificado como lo haría la columna timestamp.
    expect(q.params).toContain(CUTOFF.toISOString());
  });

  it("no archivada, no de prueba, en la org", () => {
    expect(q.sql).toContain('"conversation"."organization_id" = $');
    expect(q.sql).toContain('"conversation"."archived_at" is null');
    expect(q.sql).toContain('"conversation"."is_test" = $');
    expect(q.params.filter((p) => p === "org_1").length).toBeGreaterThanOrEqual(3);
  });

  it("excepción: cita real agendada futura por conversación O por contacto", () => {
    expect(q.sql).toMatch(/not exists \(select 1 from "booking"/);
    expect(q.sql).toContain('"booking"."organization_id" = $');
    expect(q.sql).toContain('"booking"."is_test" = $');
    expect(q.sql).toContain('"booking"."status" = $');
    expect(q.sql).toContain('"booking"."scheduled_at" > $');
    expect(q.sql).toContain(
      '("booking"."conversation_id" = "conversation"."id" or "booking"."contact_id" = "conversation"."contact_id")'
    );
    expect(q.params).toContain("agendada");
    expect(q.params).toContain(NOW.toISOString());
  });

  it("excepción: lead del contacto en etapa keep_active", () => {
    expect(q.sql).toMatch(
      /not exists \(select 1 from "lead" inner join "pipeline_stage" on "pipeline_stage"\."id" = "lead"\."stage_id"/
    );
    expect(q.sql).toContain('"lead"."organization_id" = $');
    expect(q.sql).toContain('"lead"."contact_id" = "conversation"."contact_id"');
    expect(q.sql).toContain('"pipeline_stage"."keep_active" = $');
  });

  it("excepción: traspaso dentro de los N días (NULL no excluye)", () => {
    expect(q.sql).toMatch(
      /\("conversation"\."handoff_at" is null or "conversation"\."handoff_at" <= \$\d+\)/
    );
  });

  it("inactivityCutoff = now − días", () => {
    expect(inactivityCutoff(NOW, 14)).toEqual(CUTOFF);
  });
});

describe("UNARCHIVE_SET", () => {
  it("limpia las tres columnas de archivo", () => {
    expect(UNARCHIVE_SET).toEqual({ archivedAt: null, archivedReason: null, archivedBy: null });
  });
});

describe("archiveInactive", () => {
  it("dryRun: solo cuenta (SELECT count), no escribe ni publica", async () => {
    responder = (c) => (c.sql.startsWith("select count") ? [["7"]] : []);
    const res = await archiveInactive("org_1", {
      days: 14,
      reason: "bulk",
      by: "usr_owner",
      dryRun: true,
      now: NOW,
    });
    expect(res).toEqual({ count: 7 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('from "conversation"');
    expect(calls[0]!.sql).toContain('"conversation"."archived_at" is null');
    expect(calls[0]!.params).toContain(CUTOFF.toISOString());
    expect(calls.some((c) => c.sql.startsWith("update"))).toBe(false);
    expect(published).toEqual([]);
  });

  it("masiva: UPDATE con motivo y autor, sube updated_at y publica UN conversations.bulk", async () => {
    responder = (c) => (c.sql.startsWith("update") ? [["cv_1"], ["cv_2"]] : []);
    const res = await archiveInactive("org_1", {
      days: 14,
      reason: "bulk",
      by: "usr_owner",
      now: NOW,
    });
    expect(res).toEqual({ count: 2 });
    const upd = calls.find((c) => c.sql.startsWith("update"))!;
    expect(upd.sql).toContain('"archived_at" = $');
    expect(upd.sql).toContain('"archived_reason" = $');
    expect(upd.sql).toContain('"archived_by" = $');
    expect(upd.sql).toContain('"updated_at" = $');
    expect(upd.params).toEqual(expect.arrayContaining(["bulk", "usr_owner", "org_1"]));
    expect(published).toEqual([
      { org: "org_1", event: { type: "conversations.bulk", data: { reason: "bulk" } } },
    ]);
  });

  it("nada que archivar → sin evento", async () => {
    responder = () => [];
    expect(await archiveInactive("org_1", { days: 3, reason: "auto", now: NOW })).toEqual({
      count: 0,
    });
    expect(published).toEqual([]);
  });
});

describe("ajustes de la Bandeja", () => {
  it("sin fila → defaults (apagado, 14 días)", async () => {
    responder = () => [];
    expect(await getInboxSettings("org_1")).toEqual(DEFAULT_INBOX_SETTINGS);
    expect(DEFAULT_INBOX_SETTINGS).toEqual({ autoArchiveEnabled: false, autoArchiveDays: 14 });
    expect(calls[0]!.sql).toContain('"inbox_settings"."organization_id" = $');
  });

  it("con fila → la fila", async () => {
    responder = () => [[true, 30]];
    expect(await getInboxSettings("org_1")).toEqual({
      autoArchiveEnabled: true,
      autoArchiveDays: 30,
    });
  });

  it("guardar = upsert por organization_id", async () => {
    await saveInboxSettings("org_1", { autoArchiveEnabled: true, autoArchiveDays: 21 });
    const ins = calls[0]!;
    expect(ins.sql).toMatch(/^insert into "inbox_settings"/);
    expect(ins.sql).toContain('on conflict ("organization_id") do update set');
    expect(ins.params).toEqual(expect.arrayContaining(["org_1", true, 21]));
  });
});

describe("runAutoArchive", () => {
  it("recorre solo las orgs encendidas, cada una con su umbral; un fallo no corta las demás", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    responder = (c) => {
      if (c.sql.includes('from "inbox_settings"')) {
        return [
          ["org_a", 14],
          ["org_b", 30],
          ["org_c", 7],
        ];
      }
      if (c.sql.startsWith("update")) {
        if (c.params.includes("org_b")) throw new Error("BD caída");
        return c.params.includes("org_a") ? [["cv_1"], ["cv_2"]] : [["cv_9"]];
      }
      return [];
    };
    const res = await runAutoArchive(NOW);
    expect(res).toEqual({
      now: NOW.toISOString(),
      organizations: 3,
      archived: 3,
      failed: 1,
    });
    const listing = calls.find((c) => c.sql.includes('from "inbox_settings"'))!;
    expect(listing.sql).toContain('"inbox_settings"."auto_archive_enabled" = $');
    // Cada org con su corte (14 y 7 días) y motivo auto, sin autor.
    const updates = calls.filter((c) => c.sql.startsWith("update"));
    expect(updates).toHaveLength(3);
    expect(updates[0]!.params).toContain(inactivityCutoff(NOW, 14).toISOString());
    expect(updates[2]!.params).toContain(inactivityCutoff(NOW, 7).toISOString());
    expect(updates[0]!.params).toContain("auto");
    expect(published.map((p) => p.org)).toEqual(["org_a", "org_c"]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    log.mockRestore();
  });

  it("ninguna org encendida → no archiva nada", async () => {
    responder = () => [];
    expect(await runAutoArchive(NOW)).toMatchObject({ organizations: 0, archived: 0 });
    expect(calls.some((c) => c.sql.startsWith("update"))).toBe(false);
  });
});

describe("esquemas Zod de las rutas", () => {
  it("PUT /api/settings/inbox: booleano + días 1–365 enteros", () => {
    expect(inboxSettingsSchema.safeParse({ autoArchiveEnabled: true, autoArchiveDays: 14 }).success).toBe(true);
    expect(inboxSettingsSchema.safeParse({ autoArchiveEnabled: false, autoArchiveDays: 1 }).success).toBe(true);
    expect(inboxSettingsSchema.safeParse({ autoArchiveEnabled: true, autoArchiveDays: 365 }).success).toBe(true);
    for (const days of [0, 366, 1.5, "14", null]) {
      expect(
        inboxSettingsSchema.safeParse({ autoArchiveEnabled: true, autoArchiveDays: days }).success,
        String(days)
      ).toBe(false);
    }
    expect(inboxSettingsSchema.safeParse({ autoArchiveDays: 14 }).success).toBe(false);
  });

  it("POST /api/conversations/archive-inactive: días 1–365, dryRun por defecto false", () => {
    expect(archiveInactiveSchema.parse({ days: 14 })).toEqual({ days: 14, dryRun: false });
    expect(archiveInactiveSchema.parse({ days: 30, dryRun: true })).toEqual({ days: 30, dryRun: true });
    expect(archiveInactiveSchema.safeParse({ days: 0 }).success).toBe(false);
    expect(archiveInactiveSchema.safeParse({ days: 400 }).success).toBe(false);
    expect(archiveInactiveSchema.safeParse({ days: 14, dryRun: "si" }).success).toBe(false);
  });
});

describe("reloj del auto-archivo", () => {
  afterEach(() => stopAutoArchiveTicker());

  it("parseAutoArchiveTickMs: default 1 h, 0 apaga, mínimo 60 s", () => {
    expect(parseAutoArchiveTickMs(undefined)).toBe(3_600_000);
    expect(parseAutoArchiveTickMs(" ")).toBe(3_600_000);
    expect(parseAutoArchiveTickMs("nada")).toBe(3_600_000);
    expect(parseAutoArchiveTickMs("-1")).toBe(3_600_000);
    expect(parseAutoArchiveTickMs("0")).toBeNull();
    expect(parseAutoArchiveTickMs("10")).toBe(60_000);
    expect(parseAutoArchiveTickMs("120000")).toBe(120_000);
  });

  it("arranca sin bandera, no duplica intervalos y hace unref", () => {
    const unref = vi.fn();
    const setIntervalFn = vi.fn(() => ({ unref }) as unknown as ReturnType<typeof setInterval>);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(startAutoArchiveTicker({ env: {}, setInterval: setIntervalFn })).toBe(true);
    expect(startAutoArchiveTicker({ env: {}, setInterval: setIntervalFn })).toBe(true);
    log.mockRestore();
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 3_600_000);
    expect(unref).toHaveBeenCalled();
  });

  it("INBOX_AUTO_ARCHIVE_TICK_MS=0 → no arranca", () => {
    const setIntervalFn = vi.fn();
    expect(
      startAutoArchiveTicker({
        env: { INBOX_AUTO_ARCHIVE_TICK_MS: "0" },
        setInterval: setIntervalFn,
      })
    ).toBe(false);
    expect(setIntervalFn).not.toHaveBeenCalled();
  });

  it("una vuelta a la vez (inFlight) y un fallo solo se loguea", async () => {
    let run: () => void = () => {};
    let release: () => void = () => {};
    const tick = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          release = () => reject(new Error("BD caída"));
        })
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    startAutoArchiveTicker({
      env: {},
      tick,
      setInterval: (fn) => {
        run = fn;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
    });
    run();
    run(); // la primera sigue en vuelo: no se encima
    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenCalledWith(expect.any(Date));
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(err).toHaveBeenCalled();
    run(); // tras terminar (aunque fallara), la siguiente vuelta corre
    expect(tick).toHaveBeenCalledTimes(2);
    log.mockRestore();
    err.mockRestore();
  });
});
