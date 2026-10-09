import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 016 — Reintento de conversiones y la venta que espera su monto.
 *
 * - Reintentar reusa la MISMA fila y el mismo `event_id` (nunca inserta).
 * - Solo se reintentan `failed` y los `skipped` cuyo motivo el negocio puede
 *   resolver (sin configurar, sin monto); jamás `sent` ni "sin ctwa_clid".
 * - Un `Purchase` sin monto queda `skipped` y sale cuando el monto llega.
 * - Con la bandera apagada, nada de esto toca la base ni a Meta.
 */

// BD simulada: cola de resultados de select; registro de inserts y updates.
const selectQueue: unknown[][] = [];
const inserts: Record<string, unknown>[] = [];
const updates: Record<string, unknown>[] = [];
const joins: unknown[] = [];
let claimRows: unknown[] = [{ id: "claimed" }];

function thenableChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit"]) {
    chain[m] = () => chain;
  }
  for (const m of ["innerJoin", "leftJoin"]) {
    chain[m] = (_table: unknown, cond: unknown) => {
      joins.push(cond);
      return chain;
    };
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(rows).then(resolve);
  return chain;
}

const fakeDb = {
  select: () => thenableChain(selectQueue.shift() ?? []),
  insert: () => ({
    values: (v: Record<string, unknown>) => {
      inserts.push(v);
      return {
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve([v]),
        }),
      };
    },
  }),
  update: () => ({
    set: (v: Record<string, unknown>) => {
      updates.push(v);
      const done = Promise.resolve([]);
      return {
        where: () => ({
          returning: () =>
            Promise.resolve(v.status === "pending" ? claimRows : []),
          then: (resolve: (x: unknown) => void) => done.then(resolve),
          catch: () => done,
        }),
      };
    },
  }),
};

const getDb = vi.fn(() => fakeDb);

vi.mock("@/lib/db", () => ({
  getDb,
  schema: new Proxy(
    {},
    {
      get: (_t, tableName) =>
        new Proxy(
          {},
          {
            get: (_t2, col) =>
              col === "__name"
                ? String(tableName)
                : `${String(tableName)}.${String(col)}`,
          }
        ),
    }
  ),
}));

vi.mock("drizzle-orm", () => {
  const sql = (...args: unknown[]) => ({ args });
  return { and: sql, eq: sql, inArray: sql, or: sql, desc: sql };
});

vi.mock("@/lib/db/ids", () => ({ newId: () => "cve_new" }));

const getAttributionForConversation = vi.fn();
vi.mock("@/server/attribution/store", () => ({
  getAttributionForConversation,
}));

const getCapiSettings = vi.fn();
vi.mock("@/server/attribution/settings", () => ({ getCapiSettings }));

const getCredentialsByOrg = vi.fn();
vi.mock("@/server/whatsapp/credentials", () => ({ getCredentialsByOrg }));

// Se simula la frontera de red, no `capi.ts`: así se afirma el payload real.
const graphRequest = vi.fn();
vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...original, graphRequest };
});

const mod = await import("@/server/attribution/conversions");
const {
  NO_AMOUNT_REASON,
  NO_CLID_REASON,
  NOT_CONFIGURED_REASON,
  PURCHASE_EVENT,
  QUALIFIED_EVENT,
  isRetryableConversion,
  reportAmountChange,
  reportStageChange,
  retryConversion,
} = mod;

const SETTINGS = {
  datasetId: "ds-1",
  token: "tok-1",
  qualifiedStageId: null,
  status: "connected" as const,
};

function sentPayload(callIndex = 0) {
  const body = graphRequest.mock.calls[callIndex]?.[1]?.body as {
    data: Record<string, unknown>[];
  };
  return body.data[0]!;
}

beforeEach(() => {
  process.env.ATRIBUCION = "on";
  selectQueue.length = 0;
  inserts.length = 0;
  updates.length = 0;
  joins.length = 0;
  claimRows = [{ id: "claimed" }];
  getDb.mockClear();
  graphRequest.mockReset();
  graphRequest.mockResolvedValue({ events_received: 1, fbtrace_id: "trace-ok" });
  getAttributionForConversation.mockReset();
  getAttributionForConversation.mockResolvedValue({
    id: "att_1",
    ctwaClid: "clid-1",
  });
  getCapiSettings.mockReset();
  getCapiSettings.mockResolvedValue(SETTINGS);
  getCredentialsByOrg.mockReset();
  getCredentialsByOrg.mockResolvedValue({ wabaId: "WABA-1" });
});

afterEach(() => {
  delete process.env.ATRIBUCION;
});

describe("isRetryableConversion", () => {
  const base = { eventName: QUALIFIED_EVENT, error: null };

  it("failed siempre se puede reintentar", () => {
    expect(isRetryableConversion({ ...base, status: "failed", error: "x" })).toBe(true);
  });

  it("skipped solo por motivos que el negocio puede resolver", () => {
    expect(
      isRetryableConversion({ ...base, status: "skipped", error: NOT_CONFIGURED_REASON })
    ).toBe(true);
    expect(
      isRetryableConversion({ eventName: PURCHASE_EVENT, status: "skipped", error: NO_AMOUNT_REASON })
    ).toBe(true);
    // Sin ctwa_clid es definitivo: reintentar daría lo mismo.
    expect(
      isRetryableConversion({ ...base, status: "skipped", error: NO_CLID_REASON })
    ).toBe(false);
  });

  it("sent y pending jamás", () => {
    expect(isRetryableConversion({ ...base, status: "sent" })).toBe(false);
    expect(isRetryableConversion({ ...base, status: "pending" })).toBe(false);
  });

  it("un evento propio de un fork no se sabe reconstruir", () => {
    expect(
      isRetryableConversion({ eventName: "InitiateCheckout", status: "failed", error: "x" })
    ).toBe(false);
  });
});

describe("retryConversion", () => {
  const failedRow = {
    id: "cve_1",
    conversationId: "cv_1",
    eventName: QUALIFIED_EVENT,
    status: "failed",
    error: "Meta respondió 200 pero events_received=0",
    contactId: "ct_1",
  };

  it("failed → sent reusando la MISMA fila y el mismo event_id", async () => {
    selectQueue.push([failedRow]);
    const res = await retryConversion("org_1", "cve_1");

    expect(res).toEqual({ ok: true, outcome: "sent" });
    expect(inserts).toEqual([]); // nunca una fila nueva
    expect(graphRequest).toHaveBeenCalledTimes(1);
    expect(sentPayload().event_id).toBe("cve_1");
    expect(sentPayload().custom_data).toEqual({ lead_stage: "qualified" });
    // Se reclama (pending) y luego se escribe el desenlace.
    expect(updates[0]).toEqual({ status: "pending" });
    expect(updates.at(-1)).toMatchObject({
      status: "sent",
      fbTraceId: "trace-ok",
      error: null,
    });
  });

  it("la conversación del Laboratorio queda fuera del reintento", async () => {
    selectQueue.push([failedRow]);
    await retryConversion("org_1", "cve_1");
    expect(joins).toContainEqual({
      args: [
        { args: ["conversation.id", "conversionEvent.conversationId"] },
        { args: ["conversation.isTest", false] },
      ],
    });
  });

  it("skipped por no configurado → sale en cuanto el dueño conecta", async () => {
    const row = { ...failedRow, status: "skipped", error: NOT_CONFIGURED_REASON };

    // Aún sin configurar: se reevalúa y sigue omitida, sin hablar con Meta.
    getCapiSettings.mockResolvedValueOnce(null);
    selectQueue.push([row]);
    expect(await retryConversion("org_1", "cve_1")).toEqual({
      ok: true,
      outcome: "skipped",
    });
    expect(graphRequest).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({
      status: "skipped",
      error: NOT_CONFIGURED_REASON,
    });

    // Ya configurado.
    selectQueue.push([row]);
    expect(await retryConversion("org_1", "cve_1")).toEqual({
      ok: true,
      outcome: "sent",
    });
    expect(sentPayload().event_id).toBe("cve_1");
    expect(inserts).toEqual([]);
  });

  it("Meta sigue rechazando → vuelve a quedar failed con el motivo", async () => {
    graphRequest.mockResolvedValueOnce({ events_received: 0, fbtrace_id: "t" });
    selectQueue.push([failedRow]);
    expect(await retryConversion("org_1", "cve_1")).toEqual({
      ok: true,
      outcome: "failed",
    });
    expect(updates.at(-1)).toMatchObject({ status: "failed" });
    expect(String(updates.at(-1)?.error)).toMatch(/events_received=0/);
  });

  it("estados no reintentables se rechazan sin tocar nada", async () => {
    for (const row of [
      { ...failedRow, status: "sent", error: null },
      { ...failedRow, status: "pending", error: null },
      { ...failedRow, status: "skipped", error: NO_CLID_REASON },
    ]) {
      selectQueue.push([row]);
      expect(await retryConversion("org_1", "cve_1")).toEqual({
        ok: false,
        reason: "not_retryable",
      });
    }
    expect(updates).toEqual([]);
    expect(graphRequest).not.toHaveBeenCalled();
  });

  it("fila inexistente (u otra org) → not_found", async () => {
    selectQueue.push([]);
    expect(await retryConversion("org_1", "cve_x")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("si otro reintento ganó la carrera, este no manda nada", async () => {
    claimRows = [];
    selectQueue.push([failedRow]);
    expect(await retryConversion("org_1", "cve_1")).toEqual({
      ok: false,
      reason: "not_retryable",
    });
    expect(graphRequest).not.toHaveBeenCalled();
  });
});

describe("la venta sin monto", () => {
  it("ganar sin monto deja la compra skipped 'sin monto' (no va a Meta)", async () => {
    selectQueue.push([
      { conversationId: "cv_1", amountCents: null, currency: "MXN" },
    ]);
    await reportStageChange({
      organizationId: "org_1",
      leadId: "ld_1",
      contactId: "ct_1",
      toStageId: "stg_won",
      toStageKind: "won",
    });

    expect(inserts[0]).toMatchObject({ eventName: PURCHASE_EVENT });
    expect(graphRequest).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({
      status: "skipped",
      error: NO_AMOUNT_REASON,
    });
  });

  it("ganar CON monto sigue saliendo como siempre", async () => {
    selectQueue.push([
      { conversationId: "cv_1", amountCents: 45050, currency: "MXN" },
    ]);
    await reportStageChange({
      organizationId: "org_1",
      leadId: "ld_1",
      contactId: "ct_1",
      toStageId: "stg_won",
      toStageKind: "won",
    });
    expect(sentPayload().custom_data).toEqual({
      lead_stage: "won",
      value: 450.5,
      currency: "MXN",
    });
  });

  it("fijar el monto después emite ESA fila con value", async () => {
    selectQueue.push(
      // reportAmountChange: lead ganado con su compra retenida
      [{ eventRowId: "cve_p", stageKind: "won", amountCents: 45050 }],
      // retryConversion: la fila
      [
        {
          id: "cve_p",
          conversationId: "cv_1",
          eventName: PURCHASE_EVENT,
          status: "skipped",
          error: NO_AMOUNT_REASON,
          contactId: "ct_1",
        },
      ],
      // el monto actual del lead
      [{ amountCents: 45050, currency: "MXN" }]
    );
    await reportAmountChange({ organizationId: "org_1", leadId: "ld_1" });

    expect(inserts).toEqual([]);
    expect(graphRequest).toHaveBeenCalledTimes(1);
    expect(sentPayload().event_id).toBe("cve_p");
    expect(sentPayload().event_name).toBe(PURCHASE_EVENT);
    expect(sentPayload().custom_data).toEqual({
      lead_stage: "won",
      value: 450.5,
      currency: "MXN",
    });
    expect(updates.at(-1)).toMatchObject({ status: "sent" });
  });

  it("si el lead ya no está ganado, fijar el monto no emite nada", async () => {
    selectQueue.push([
      { eventRowId: "cve_p", stageKind: "open", amountCents: 45050 },
    ]);
    await reportAmountChange({ organizationId: "org_1", leadId: "ld_1" });
    expect(graphRequest).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("sin compra retenida (p. ej. ya enviada), no hace nada", async () => {
    selectQueue.push([]);
    await reportAmountChange({ organizationId: "org_1", leadId: "ld_1" });
    expect(graphRequest).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});

describe("con la bandera apagada", () => {
  it("nada toca la base ni a Meta", async () => {
    process.env.ATRIBUCION = "off";
    await reportStageChange({
      organizationId: "org_1",
      leadId: "ld_1",
      contactId: "ct_1",
      toStageId: "stg_won",
      toStageKind: "won",
    });
    await reportAmountChange({ organizationId: "org_1", leadId: "ld_1" });
    expect(await retryConversion("org_1", "cve_1")).toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(getDb).not.toHaveBeenCalled();
    expect(graphRequest).not.toHaveBeenCalled();
  });
});
