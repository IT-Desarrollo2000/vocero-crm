import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FICHA_TEMPLATE_AUTOS_ELECTRICOS,
  type FichaMeta,
} from "@/lib/ficha-fields";

/**
 * 04 — Procedencia de la ficha: "el humano gana" (RF-04-07), el legado se
 * protege solo contra el agente, la bitácora no duplica y el desbloqueo
 * devuelve el campo al agente (RF-04-08). La regla vive en la puerta
 * (`planFichaWrite` dentro de `upsertFicha`).
 */

// BD simulada para `upsertFicha`: transacción con SELECT … FOR UPDATE.
const calls: string[] = [];
let lockedRows: unknown[] = [];
const contactSets: Record<string, unknown>[] = [];
const inserted: Record<string, unknown>[][] = [];

vi.mock("@/lib/db", () => {
  const tx = {
    select: () => {
      const c: Record<string, unknown> = {};
      for (const m of ["from", "where", "limit"]) c[m] = () => c;
      c.for = (mode: string) => {
        calls.push(`for:${mode}`);
        return Promise.resolve(lockedRows);
      };
      return c;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        contactSets.push(values);
        return { where: () => Promise.resolve([]) };
      },
    }),
    insert: () => ({
      values: (rows: Record<string, unknown>[]) => {
        inserted.push(rows);
        return Promise.resolve([]);
      },
    }),
  };
  return {
    getDb: () => ({
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
        calls.push("transaction");
        return fn(tx);
      },
    }),
    schema: new Proxy(
      {},
      {
        get: (_t, tableName) =>
          new Proxy({}, { get: (_t2, col) => `${String(tableName)}.${String(col)}` }),
      }
    ),
  };
});

import { planFichaWrite, upsertFicha } from "@/server/bot/ficha";

const FIELDS = FICHA_TEMPLATE_AUTOS_ELECTRICOS;
const NOW = new Date("2026-10-12T15:00:00.000Z");
const AT = NOW.toISOString();

describe("planFichaWrite — regla de procedencia", () => {
  it("el agente llena campos vacíos: meta `ia` y un evento aplicado por clave", () => {
    const p = planFichaWrite({
      current: {},
      meta: {},
      raw: { modelo_interes: "Leapmotor T03", ciudad: "Villahermosa" },
      source: "ia",
      fields: FIELDS,
      now: NOW,
    });
    expect(p.ficha).toEqual({ modelo_interes: "Leapmotor T03", ciudad: "Villahermosa" });
    expect(p.meta.modelo_interes).toEqual({ by: "ia", at: AT });
    expect(p.events.map((e) => e.outcome)).toEqual(["aplicado", "aplicado"]);
    expect(p.changed).toBe(true);
  });

  it("humano gana: el agente no pisa un campo con candado (evento ignorado_humano)", () => {
    const meta: FichaMeta = { ciudad: { by: "humano", at: AT, userId: "u_1" } };
    const p = planFichaWrite({
      current: { ciudad: "Mérida" },
      meta,
      raw: { ciudad: "Villahermosa" },
      source: "ia",
      fields: FIELDS,
      now: NOW,
    });
    expect(p.ficha.ciudad).toBe("Mérida");
    expect(p.ignored).toEqual([{ key: "ciudad", reason: "candado_humano" }]);
    expect(p.events).toEqual([
      {
        key: "ciudad",
        oldValue: "Mérida",
        newValue: "Villahermosa",
        outcome: "ignorado_humano",
        reason: "candado_humano",
      },
    ]);
    expect(p.changed).toBe(false);
  });

  it("el cerebro externo también respeta el candado (D-04-4)", () => {
    const p = planFichaWrite({
      current: { presupuesto: 60000 },
      meta: { presupuesto: { by: "humano", at: AT } },
      raw: { presupuesto: 1 },
      source: "bot",
    });
    expect(p.ficha.presupuesto).toBe(60000);
    expect(p.ignored).toEqual([{ key: "presupuesto", reason: "candado_humano" }]);
  });

  it("legado (valor sin meta): protegido contra `ia`, pero `bot` sí escribe", () => {
    const ia = planFichaWrite({
      current: { ciudad: "Mérida" },
      meta: null,
      raw: { ciudad: "Villahermosa" },
      source: "ia",
      fields: FIELDS,
    });
    expect(ia.ficha.ciudad).toBe("Mérida");
    expect(ia.events[0]?.outcome).toBe("ignorado_humano");

    const bot = planFichaWrite({
      current: { ciudad: "Mérida" },
      meta: null,
      raw: { ciudad: "Villahermosa" },
      source: "bot",
      now: NOW,
    });
    expect(bot.ficha.ciudad).toBe("Villahermosa");
    expect(bot.meta.ciudad).toEqual({ by: "bot", at: AT });
  });

  it("el agente corrige lo que él mismo escribió (evento con valor anterior)", () => {
    const p = planFichaWrite({
      current: { modelo_interes: "T03" },
      meta: { modelo_interes: { by: "ia", at: AT } },
      raw: { modelo_interes: "Bingo" },
      source: "ia",
      fields: FIELDS,
    });
    expect(p.ficha.modelo_interes).toBe("Bingo");
    expect(p.events[0]).toMatchObject({ oldValue: "T03", newValue: "Bingo", outcome: "aplicado" });
  });

  it("mismo valor: sin evento ni cambio", () => {
    const p = planFichaWrite({
      current: { ciudad: "Villahermosa" },
      meta: { ciudad: { by: "ia", at: AT } },
      raw: { ciudad: "Villahermosa" },
      source: "ia",
      fields: FIELDS,
    });
    expect(p.events).toEqual([]);
    expect(p.changed).toBe(false);
  });

  it("humano escribe: candado con userId; borrar quita valor y meta", () => {
    const w = planFichaWrite({
      current: {},
      meta: {},
      raw: { presupuesto: 500000 },
      source: "humano",
      userId: "u_1",
      now: NOW,
    });
    expect(w.meta.presupuesto).toEqual({ by: "humano", at: AT, userId: "u_1" });

    const d = planFichaWrite({
      current: w.ficha,
      meta: w.meta,
      raw: { presupuesto: null },
      source: "humano",
      userId: "u_1",
    });
    expect(d.ficha).toEqual({});
    expect(d.meta).toEqual({});
    expect(d.events[0]).toMatchObject({ oldValue: 500000, newValue: null, outcome: "aplicado" });
  });

  it("unlock: el valor se queda, `by` pasa a `ia`, sin evento; luego el agente sí escribe", () => {
    const u = planFichaWrite({
      current: { ciudad: "Mérida", zona: "Centro" },
      meta: { ciudad: { by: "humano", at: AT } },
      raw: {},
      source: "humano",
      unlock: ["ciudad", "zona", "no_existe"],
      now: NOW,
    });
    expect(u.ficha.ciudad).toBe("Mérida");
    expect(u.meta.ciudad).toEqual({ by: "ia", at: AT });
    // `zona` es legado (valor sin meta): también se libera.
    expect(u.meta.zona).toEqual({ by: "ia", at: AT });
    expect(u.meta.no_existe).toBeUndefined();
    expect(u.events).toEqual([]);

    const a = planFichaWrite({
      current: u.ficha,
      meta: u.meta,
      raw: { ciudad: "Villahermosa" },
      source: "ia",
      fields: FIELDS,
    });
    expect(a.ficha.ciudad).toBe("Villahermosa");
  });

  it("ficha + unlock en el mismo cuerpo: primero la escritura, después el desbloqueo", () => {
    const p = planFichaWrite({
      current: {},
      meta: {},
      raw: { ciudad: "Mérida" },
      source: "humano",
      unlock: ["ciudad"],
    });
    expect(p.ficha.ciudad).toBe("Mérida");
    expect(p.meta.ciudad?.by).toBe("ia");
  });

  it("coerción del agente: '350 mil' → 350000; 'mucho' → invalido sin valor", () => {
    const ok = planFichaWrite({
      current: {},
      meta: {},
      raw: { presupuesto: "350 mil" },
      source: "ia",
      fields: FIELDS,
    });
    expect(ok.ficha.presupuesto).toBe(350000);

    const bad = planFichaWrite({
      current: {},
      meta: {},
      raw: { presupuesto: "mucho", inventada: "x" },
      source: "ia",
      fields: FIELDS,
    });
    expect(bad.ficha).toEqual({});
    expect(bad.events).toEqual([
      { key: "presupuesto", oldValue: null, newValue: null, outcome: "invalido", reason: "tipo" },
      { key: "inventada", oldValue: null, newValue: null, outcome: "invalido", reason: "clave_desconocida" },
    ]);
  });

  it("sin definición, el agente no llena nada ni deja eventos (RF-04-02)", () => {
    const p = planFichaWrite({
      current: {},
      meta: {},
      raw: { modelo_interes: "T03" },
      source: "ia",
      fields: null,
    });
    expect(p).toMatchObject({ ficha: {}, events: [], ignored: [], changed: false });
  });

  it("ficha que no es objeto: se ignora sin error", () => {
    for (const source of ["ia", "bot", "humano"] as const) {
      const p = planFichaWrite({
        current: { a: 1 },
        meta: {},
        raw: "no soy un objeto",
        source,
        fields: FIELDS,
      });
      expect(p.ficha).toEqual({ a: 1 });
      expect(p.changed).toBe(false);
    }
  });

  it("tope de 40 claves: lo nuevo que no cabe → invalido `tope`; las definidas van primero", () => {
    const current = Object.fromEntries(
      Array.from({ length: 39 }, (_, i) => [`libre_${i}`, i])
    );
    const p = planFichaWrite({
      current,
      meta: {},
      raw: { otra_libre: "x", ciudad: "Villahermosa" },
      source: "bot",
      fields: FIELDS,
    });
    expect(p.ficha.ciudad).toBe("Villahermosa");
    expect(p.ficha.otra_libre).toBeUndefined();
    expect(p.ignored).toEqual([{ key: "otra_libre", reason: "tope" }]);
    expect(p.events.find((e) => e.reason === "tope")?.outcome).toBe("invalido");
  });

  it("un modelo que manda cientos de claves basura no inunda la bitácora", () => {
    const raw = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`basura_${i}`, "x"])
    );
    const p = planFichaWrite({ current: {}, meta: {}, raw, source: "ia", fields: FIELDS });
    expect(p.events.length).toBeLessThanOrEqual(20);
  });
});

describe("upsertFicha — transacción con la fila bloqueada", () => {
  beforeEach(() => {
    calls.length = 0;
    contactSets.length = 0;
    inserted.length = 0;
    lockedRows = [];
  });

  it("SELECT … FOR UPDATE dentro de la transacción; escribe ficha + meta y la bitácora", async () => {
    lockedRows = [{ ficha: { ciudad: "Mérida" }, fichaMeta: { ciudad: { by: "humano", at: AT } } }];
    const res = await upsertFicha({
      organizationId: "org_1",
      contactId: "ct_1",
      ficha: { ciudad: "Villahermosa", modelo_interes: "T03" },
      source: "ia",
      fields: FIELDS,
      conversationId: "cv_1",
    });
    expect(calls).toEqual(["transaction", "for:update"]);
    expect(res?.ficha).toEqual({ ciudad: "Mérida", modelo_interes: "T03" });
    expect(res?.ignored).toEqual([{ key: "ciudad", reason: "candado_humano" }]);
    expect(contactSets).toHaveLength(1);
    expect(contactSets[0]).toHaveProperty("fichaMeta");
    const rows = inserted[0] ?? [];
    expect(rows.map((r) => r.outcome).sort()).toEqual(["aplicado", "ignorado_humano"]);
    expect(rows.every((r) => r.source === "ia" && r.actorUserId === null)).toBe(true);
    expect(rows.every((r) => r.conversationId === "cv_1")).toBe(true);
  });

  it("sin cambios no escribe nada", async () => {
    lockedRows = [{ ficha: { ciudad: "X" }, fichaMeta: { ciudad: { by: "ia", at: AT } } }];
    const res = await upsertFicha({
      organizationId: "org_1",
      contactId: "ct_1",
      ficha: { ciudad: "X" },
      source: "ia",
      fields: FIELDS,
    });
    expect(res?.changed).toBe(false);
    expect(contactSets).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  it("contacto de otra organización → null", async () => {
    const res = await upsertFicha({
      organizationId: "org_1",
      contactId: "ct_ajeno",
      ficha: { a: 1 },
      source: "humano",
      userId: "u_1",
    });
    expect(res).toBeNull();
  });
});

const SRC = path.resolve(import.meta.dirname, "..", "..", "src");
const PUERTA = path.join(SRC, "server", "bot", "ficha.ts");

function archivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...archivosTs(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("guardarraíl: la bitácora y la procedencia solo las escribe la puerta", () => {
  it("nadie más inserta en `ficha_event` ni escribe `fichaMeta`", () => {
    const culpables: string[] = [];
    for (const file of archivosTs(SRC)) {
      if (path.resolve(file) === path.resolve(PUERTA)) continue;
      const code = readFileSync(file, "utf8");
      if (/\.insert\(\s*schema\.fichaEvent\s*\)/.test(code)) {
        culpables.push(`${path.relative(SRC, file)} (insert ficha_event)`);
      }
      const re = /\.update\(\s*schema\.contact\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        if (/\bfichaMeta\b/.test(code.slice(m.index, m.index + 400))) {
          culpables.push(`${path.relative(SRC, file)} (update fichaMeta)`);
        }
      }
    }
    expect(culpables).toEqual([]);
  });
});
