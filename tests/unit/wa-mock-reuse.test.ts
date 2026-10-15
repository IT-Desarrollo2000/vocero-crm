import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 019 fase B — El wa-mock imita lo que el self-test necesita para probar la
 * reutilización: cuenta las subidas aparte del outbox, emite `attachment_id`
 * de Messenger, acepta `/messages` por `attachment_id`, y deja "invalidar" un
 * id para forzar la re-subida. El reset del outbox no reinicia el contador
 * (los wamids repetidos chocan con el UNIQUE de la BD).
 */

vi.mock("@/lib/dev-guard", () => ({ mockGuard: () => null }));

const graph = await import("@/app/api/dev/wa-mock/graph/[...path]/route");
const outboxRoute = await import("@/app/api/dev/wa-mock/outbox/route");
const invalidate = await import("@/app/api/dev/wa-mock/invalidate-media/route");
const { getWaMockState, resetWaMockState } = await import("@/server/dev/wa-mock-state");

const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });
const auth = { authorization: "Bearer tok-e2e" };

function postForm(path: string[], form: FormData) {
  return graph.POST(
    new Request("http://mock/x", { method: "POST", headers: auth, body: form }),
    ctx(...path)
  );
}
function postJson(path: string[], body: unknown) {
  return graph.POST(
    new Request("http://mock/x", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx(...path)
  );
}
const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });

beforeEach(() => resetWaMockState());

describe("wa-mock — subidas y reutilización", () => {
  it("WA /media y Messenger /message_attachments quedan en `uploads`, no en el outbox", async () => {
    const wa = new FormData();
    wa.set("messaging_product", "whatsapp");
    wa.set("file", jpeg(), "a.jpg");
    const waId = ((await (await postForm(["v25.0", "pn_1", "media"], wa)).json()) as { id: string }).id;
    expect(waId).toMatch(/^media-up-\d+-\d+$/);

    const fb = new FormData();
    fb.set("message", JSON.stringify({ attachment: { type: "image", payload: { is_reusable: true } } }));
    fb.set("filedata", jpeg(), "b.jpg");
    const att = ((await (await postForm(["page_1", "message_attachments"], fb)).json()) as {
      attachment_id: string;
    }).attachment_id;
    expect(att).toMatch(/^att-up-\d+-\d+$/);

    const res = (await (await outboxRoute.GET()).json()) as { outbox: unknown[]; uploads: { channel: string; id: string; kind: string }[] };
    expect(res.outbox).toHaveLength(0);
    expect(res.uploads.map((u) => [u.kind, u.channel, u.id])).toEqual([
      ["upload", "whatsapp", waId],
      ["upload", "messenger", att],
    ]);

    const sent = await postJson(["page_1", "messages"], {
      recipient: { id: "psid_1" },
      messaging_type: "RESPONSE",
      message: { attachment: { type: "image", payload: { attachment_id: att } } },
    });
    expect(sent.status).toBe(200);
    const entry = getWaMockState().outbox.at(-1)!;
    expect(entry.attachment).toMatchObject({ channel: "messenger", attachmentId: att, bytes: 4 });
  });

  it("invalidate-media: /messages con ese id → 400 (WA 131053, Messenger 100)", async () => {
    const r = await invalidate.POST(
      new Request("http://mock/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "media-up-1-1" }),
      })
    );
    expect(r.status).toBe(200);
    const wa = await postJson(["pn_1", "messages"], {
      messaging_product: "whatsapp",
      to: "5255",
      type: "image",
      image: { id: "media-up-1-1" },
    });
    expect(wa.status).toBe(400);
    expect(((await wa.json()) as { error: { code: number } }).error.code).toBe(131053);

    getWaMockState().invalidMediaIds.add("att-x");
    const fb = await postJson(["page_1", "messages"], {
      recipient: { id: "psid_1" },
      message: { attachment: { type: "image", payload: { attachment_id: "att-x" } } },
    });
    expect(fb.status).toBe(400);
    expect(((await fb.json()) as { error: { code: number } }).error.code).toBe(100);
    expect(getWaMockState().outbox).toHaveLength(0);
  });

  it("el reset del outbox NO reinicia el contador de ids", async () => {
    await postJson(["pn_1", "messages"], { messaging_product: "whatsapp", to: "5255", type: "text", text: { body: "a" } });
    const first = getWaMockState().outbox[0]!.waMessageId;
    await outboxRoute.DELETE();
    await postJson(["pn_1", "messages"], { messaging_product: "whatsapp", to: "5255", type: "text", text: { body: "b" } });
    const second = getWaMockState().outbox[0]!.waMessageId;
    expect(second).not.toBe(first);
  });
});
