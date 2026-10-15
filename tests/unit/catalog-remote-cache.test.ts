import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 019 fase B (FR-942/943) — Vigencia de los ids remotos del catálogo:
 * WhatsApp < 25 días (Meta guarda 30), Messenger < 85 (Meta guarda 90). La consulta
 * siempre lleva el tenant y la llave (archivo, canal, cuenta); el guardado es
 * un upsert sobre esa llave.
 */

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  conflict: null as null | { target: unknown; set: Record<string, unknown> },
  values: null as null | Record<string, unknown>,
  deleted: 0,
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...original,
    getDb: () => ({
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => h.rows }) }),
      }),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          h.values = v;
          return {
            onConflictDoUpdate: async (c: { target: unknown; set: Record<string, unknown> }) => {
              h.conflict = c;
            },
          };
        },
      }),
      delete: () => ({
        where: async () => {
          h.deleted++;
        },
      }),
    }),
  };
});

const { getReusableRemoteId, saveRemoteId, forgetRemoteId } = await import(
  "@/server/catalog/remote-cache"
);
const { schema } = await import("@/lib/db");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-15T12:00:00Z");
const key = (channel: "whatsapp" | "messenger") => ({
  organizationId: "org_1",
  productFileId: "pf_1",
  channel,
  accountId: "acc_1",
});
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

beforeEach(() => {
  h.rows = [];
  h.conflict = null;
  h.values = null;
  h.deleted = 0;
});

describe("getReusableRemoteId", () => {
  it("sin fila → null", async () => {
    expect(await getReusableRemoteId(key("whatsapp"), NOW)).toBeNull();
  });

  it("WhatsApp: 24 días → se reutiliza; 25 o más → null (re-subir)", async () => {
    h.rows = [{ remoteId: "media-1", uploadedAt: ago(24) }];
    expect(await getReusableRemoteId(key("whatsapp"), NOW)).toBe("media-1");
    h.rows = [{ remoteId: "media-1", uploadedAt: ago(25) }];
    expect(await getReusableRemoteId(key("whatsapp"), NOW)).toBeNull();
    h.rows = [{ remoteId: "media-1", uploadedAt: ago(40) }];
    expect(await getReusableRemoteId(key("whatsapp"), NOW)).toBeNull();
  });

  it("Messenger: 84 días → se reutiliza; 85 o más → null (Meta los borra a los 90)", async () => {
    h.rows = [{ remoteId: "att-1", uploadedAt: ago(84) }];
    expect(await getReusableRemoteId(key("messenger"), NOW)).toBe("att-1");
    h.rows = [{ remoteId: "att-1", uploadedAt: ago(85) }];
    expect(await getReusableRemoteId(key("messenger"), NOW)).toBeNull();
  });

  it("sin organización → error de tenant (scoped)", async () => {
    await expect(
      getReusableRemoteId({ ...key("whatsapp"), organizationId: "" }, NOW)
    ).rejects.toThrow(/tenant/);
  });
});

describe("saveRemoteId / forgetRemoteId", () => {
  it("upsert por (product_file_id, channel, account_id) actualizando id y fecha", async () => {
    await saveRemoteId({ ...key("whatsapp"), remoteId: "media-2" }, NOW);
    expect(h.values).toMatchObject({
      organizationId: "org_1",
      productFileId: "pf_1",
      channel: "whatsapp",
      accountId: "acc_1",
      remoteId: "media-2",
      uploadedAt: NOW,
    });
    expect(String(h.values?.id)).toMatch(/^pfu_/);
    const t = schema.productFileUpload;
    expect(h.conflict?.target).toEqual([t.productFileId, t.channel, t.accountId]);
    expect(h.conflict?.set).toEqual({ remoteId: "media-2", uploadedAt: NOW });
  });

  it("forget borra la fila de la llave", async () => {
    await forgetRemoteId(key("messenger"));
    expect(h.deleted).toBe(1);
  });
});
