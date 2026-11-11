import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  duplicateMessage,
  lastTemplateSent,
  matchTemplateByText,
  minutesSince,
  TEMPLATE_DUPLICATE_WINDOW_MIN,
  templateStatusLabel,
} from "@/lib/template-sent";
import type { MessageDto } from "@/lib/types";

/**
 * 033 — «Plantilla enviada» (tarjeta derivada del hilo) y candado contra
 * la misma plantilla repetida (solo en envíos humanos).
 */

function msg(over: Partial<MessageDto>): MessageDto {
  return {
    id: "msg_1",
    conversationId: "cv_1",
    direction: "out",
    type: "template",
    text: "Hola Ana",
    status: "sent",
    error: null,
    aiGenerated: false,
    origin: "template",
    media: null,
    createdAt: "2026-11-11T16:00:00.000Z",
    ...over,
  };
}

describe("lastTemplateSent (regla de la tarjeta)", () => {
  it("hilo vacío → null", () => {
    expect(lastTemplateSent([])).toBeNull();
  });

  it("última = plantilla saliente → la tarjeta con su estado", () => {
    const last = lastTemplateSent([
      msg({ id: "m0", direction: "in", origin: "operator", type: "text" }),
      msg({ id: "m1", status: "delivered" }),
    ]);
    expect(last).toEqual({
      id: "m1",
      createdAt: "2026-11-11T16:00:00.000Z",
      status: "delivered",
      text: "Hola Ana",
      error: null,
    });
  });

  it("el cliente contestó después → null (vuelven los pasos/caja libre)", () => {
    expect(
      lastTemplateSent([msg({ id: "m1" }), msg({ id: "m2", direction: "in", origin: "operator" })])
    ).toBeNull();
  });

  it("última saliente que no es plantilla → null", () => {
    expect(lastTemplateSent([msg({ origin: "operator", type: "text" })])).toBeNull();
  });

  it("fallida → se devuelve con su error (la UI muestra los pasos con el aviso)", () => {
    const last = lastTemplateSent([msg({ status: "failed", error: "Número inválido" })]);
    expect(last?.status).toBe("failed");
    expect(last?.error).toBe("Número inválido");
  });

  it("hilo de otra conversación (aún cargando) → null", () => {
    expect(lastTemplateSent([msg({ conversationId: "cv_viejo" })], "cv_1")).toBeNull();
    expect(lastTemplateSent([msg({})], "cv_1")?.id).toBe("msg_1");
  });
});

describe("textos de la tarjeta y del aviso", () => {
  it("estado en palabras", () => {
    expect(templateStatusLabel("pending")).toBe("Enviando…");
    expect(templateStatusLabel("sent")).toBe("Enviada");
    expect(templateStatusLabel("delivered")).toBe("Entregada");
    expect(templateStatusLabel("read")).toBe("Leída");
  });

  it("minutos completos, nunca negativos", () => {
    const now = new Date("2026-11-11T16:10:00Z");
    expect(minutesSince(new Date("2026-11-11T16:09:30Z"), now)).toBe(0);
    expect(minutesSince(new Date("2026-11-11T16:06:59Z"), now)).toBe(3);
    expect(minutesSince(new Date("2026-11-11T16:11:00Z"), now)).toBe(0);
  });

  it("«hace menos de 1 min» con 0 y «hace n min» después", () => {
    expect(duplicateMessage("Ana", 0)).toBe("Ya le enviaste este mensaje a Ana hace menos de 1 min.");
    expect(duplicateMessage("Ana", 4)).toBe("Ya le enviaste este mensaje a Ana hace 4 min.");
    expect(duplicateMessage(null, 2)).toBe("Ya le enviaste este mensaje a este cliente hace 2 min.");
  });

  it("la ventana acordada es de 10 minutos", () => {
    expect(TEMPLATE_DUPLICATE_WINDOW_MIN).toBe(10);
  });

  it("reconoce la plantilla por su texto sustituido; ambigua o ajena → null", () => {
    const tpls = [
      { id: "a", body: "Hola {{1}}, ¿retomamos tu cotización de {{2}}?" },
      { id: "b", body: "Hola {{ 1 }}, gracias (de verdad)." },
    ];
    expect(matchTemplateByText("Hola Ana, ¿retomamos tu cotización de la sala?", tpls)?.id).toBe("a");
    expect(matchTemplateByText("Hola Ana, gracias (de verdad).", tpls)?.id).toBe("b");
    expect(matchTemplateByText("Otra cosa", tpls)).toBeNull();
    expect(matchTemplateByText(null, tpls)).toBeNull();
    expect(matchTemplateByText("Hola X", [{ id: "1", body: "Hola {{1}}" }, { id: "2", body: "Hola {{1}}" }])).toBeNull();
  });
});

/* ---------- servidor: findRecentDuplicate + sendTemplate({ guardDuplicates }) ---------- */

const callGraphSend = vi.fn();
const selectRows: unknown[][] = [];
const whereArgs: unknown[] = [];
const inserted: unknown[] = [];

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "orderBy"]) c[m] = () => c;
  c.where = (w: unknown) => {
    whereArgs.push(w);
    return c;
  };
  c.limit = () => Promise.resolve(rows);
  return c;
}

vi.mock("@/lib/db", async () => {
  const { schema } = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    schema,
    getDb: () => ({
      select: () => chain(selectRows.shift() ?? []),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return { returning: () => Promise.resolve([{ ...v, createdAt: new Date(), mediaAssetId: null }]) };
        },
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    }),
  };
});

vi.mock("@/server/inbox/send", () => ({
  callGraphSend,
  SendError: class SendError extends Error {
    code: string;
    constructor(code: string, m: string) {
      super(m);
      this.code = code;
    }
  },
}));
vi.mock("@/server/whatsapp/credentials", () => ({
  getCredentialsByOrg: async () => ({ status: "active", organizationId: "org_1" }),
  getCredentialsByWabaId: async () => null,
  markReconnectRequired: async () => {},
}));
const scopedSpy = vi.fn();
vi.mock("@/lib/db/tenant", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/tenant")>("@/lib/db/tenant");
  return {
    ...actual,
    scoped: (...args: Parameters<typeof actual.scoped>) => {
      scopedSpy(...args);
      return actual.scoped(...args);
    },
  };
});
vi.mock("@/server/events/bus", () => ({ publish: () => {} }));
vi.mock("@/server/inbox/ingest", () => ({ serializeMessage: (m: unknown) => m }));

const TEMPLATE = { id: "tpl_1", name: "retomar", language: "es_MX", body: "Hola {{1}}, ¿retomamos?", status: "approved" };
const CONV = {
  conversation: { id: "cv_1", isTest: false, channel: "whatsapp" },
  contact: { id: "ct_1", name: "Ana López", phone: "5215511111111", waUserId: null },
};

describe("candado contra duplicados en sendTemplate", () => {
  beforeEach(() => {
    callGraphSend.mockReset();
    callGraphSend.mockResolvedValue("wamid.nuevo");
    selectRows.length = 0;
    whereArgs.length = 0;
    inserted.length = 0;
    scopedSpy.mockClear();
  });

  it("findRecentDuplicate: devuelve el envío previo y filtra por organización", async () => {
    const at = new Date("2026-11-11T16:05:00Z");
    selectRows.push([{ createdAt: at }]);
    const { findRecentDuplicate } = await import("@/server/whatsapp/templates");
    const r = await findRecentDuplicate({ organizationId: "org_1", conversationId: "cv_1", text: "Hola Ana" });
    expect(r).toEqual({ createdAt: at });
    // El WHERE pasa por scoped() con la organización (multi-tenancy).
    expect(scopedSpy).toHaveBeenCalledWith(expect.anything(), "org_1", expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });

  it("findRecentDuplicate: sin coincidencias → null", async () => {
    const { findRecentDuplicate } = await import("@/server/whatsapp/templates");
    expect(await findRecentDuplicate({ organizationId: "org_1", conversationId: "cv_1", text: "x" })).toBeNull();
  });

  it("con guardDuplicates y un envío reciente → 409 template_recently_sent SIN llamar a Meta", async () => {
    selectRows.push([TEMPLATE], [CONV], [{ createdAt: new Date(Date.now() - 3 * 60_000 - 5_000) }]);
    const { sendTemplate, TemplateError, templateErrorStatus } = await import("@/server/whatsapp/templates");
    const err = await sendTemplate({
      organizationId: "org_1",
      conversationId: "cv_1",
      templateId: "tpl_1",
      variables: ["Ana"],
      guardDuplicates: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TemplateError);
    expect((err as InstanceType<typeof TemplateError>).code).toBe("template_recently_sent");
    expect(templateErrorStatus(err as InstanceType<typeof TemplateError>)).toBe(409);
    expect((err as Error).message).toBe("Ya le enviaste este mensaje a Ana hace 3 min.");
    expect(callGraphSend).not.toHaveBeenCalled();
  });

  it("con guardDuplicates y nada reciente (o el previo falló) → sale normal", async () => {
    selectRows.push([TEMPLATE], [CONV], []);
    const { sendTemplate } = await import("@/server/whatsapp/templates");
    const r = await sendTemplate({
      organizationId: "org_1",
      conversationId: "cv_1",
      templateId: "tpl_1",
      variables: ["Ana"],
      guardDuplicates: true,
    });
    expect(r.messageId).toMatch(/^msg_/);
    expect(callGraphSend).toHaveBeenCalledTimes(1);
    expect((inserted[0] as { text: string }).text).toBe("Hola Ana, ¿retomamos?");
  });

  it("sin guardDuplicates (recordatorios automáticos) → ni siquiera consulta: sale", async () => {
    // Si consultara, este tercer resultado lo frenaría.
    selectRows.push([TEMPLATE], [CONV], [{ createdAt: new Date() }]);
    const { sendTemplate } = await import("@/server/whatsapp/templates");
    await sendTemplate({ organizationId: "org_1", conversationId: "cv_1", templateId: "tpl_1", variables: ["Ana"], attends: false });
    expect(callGraphSend).toHaveBeenCalledTimes(1);
    expect(selectRows.length).toBe(1);
  });
});
