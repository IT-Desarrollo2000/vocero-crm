import { describe, expect, it } from "vitest";
import { createEventHub } from "@/lib/event-hub";
import {
  brandIconHref,
  createFaviconBadge,
  ORIGINAL_ATTR,
  type IconDocLike,
  type IconLinkLike,
} from "@/components/favicon-badge";

/** `<link rel="icon">` simulado. */
function fakeLink(href: string): IconLinkLike & { attrs: Map<string, string> } {
  const attrs = new Map<string, string>([["href", href]]);
  return {
    attrs,
    getAttribute: (n) => attrs.get(n) ?? null,
    setAttribute: (n, v) => {
      attrs.set(n, v);
    },
    removeAttribute: (n) => {
      attrs.delete(n);
    },
  };
}

function fakeDoc(links: IconLinkLike[]): IconDocLike {
  return { querySelectorAll: () => links };
}

describe("favicon con punto (DOM simulado)", () => {
  it("pone el data URL y restaura el original", async () => {
    const link = fakeLink("/api/branding/favicon?v=g1");
    const badge = createFaviconBadge(fakeDoc([link]), async (src) => `data:image/png;${src}`);
    await badge.set(true);
    expect(link.getAttribute("href")).toBe("data:image/png;/api/branding/favicon?v=g1");
    expect(link.getAttribute(ORIGINAL_ATTR)).toBe("/api/branding/favicon?v=g1");
    await badge.set(false);
    expect(link.getAttribute("href")).toBe("/api/branding/favicon?v=g1");
    expect(link.getAttribute(ORIGINAL_ATTR)).toBeNull();
  });

  it("reaplicar no dibuja sobre el icono ya marcado (usa el original y la caché)", async () => {
    const link = fakeLink("/icon");
    const calls: string[] = [];
    const badge = createFaviconBadge(fakeDoc([link]), async (src) => {
      calls.push(src);
      return `data:${src}`;
    });
    await badge.set(true);
    await badge.set(true);
    expect(calls).toEqual(["/icon"]);
    expect(link.getAttribute("href")).toBe("data:/icon");
  });

  it("icono no dibujable → no se toca (jamás un icono roto)", async () => {
    const link = fakeLink("/raro.ico");
    const badge = createFaviconBadge(fakeDoc([link]), async () => null);
    await badge.set(true);
    expect(link.getAttribute("href")).toBe("/raro.ico");
    expect(link.getAttribute(ORIGINAL_ATTR)).toBeNull();
    const failing = createFaviconBadge(fakeDoc([link]), () => Promise.reject(new Error("x")));
    await failing.set(true);
    expect(link.getAttribute("href")).toBe("/raro.ico");
  });

  it("un apagado que llega mientras se dibuja gana la carrera", async () => {
    const link = fakeLink("/icon");
    let finish: (v: string) => void = () => {};
    const badge = createFaviconBadge(
      fakeDoc([link]),
      () => new Promise<string>((r) => (finish = r))
    );
    const pending = badge.set(true);
    await badge.set(false);
    finish("data:late");
    await pending;
    expect(link.getAttribute("href")).toBe("/icon");
  });

  it("el icono de las notificaciones es siempre el de la marca, sin punto", async () => {
    const link = fakeLink("/icon");
    const doc = fakeDoc([link]);
    await createFaviconBadge(doc, async () => "data:x").set(true);
    expect(brandIconHref(doc)).toBe("/icon");
    expect(brandIconHref(fakeDoc([]))).toBeUndefined();
  });
});

type H = {
  onMessageNew?: (d: { conversationId: string }) => void;
  onConversationHandoff?: (d: { conversationId: string }) => void;
  onReconnect?: () => void;
};

describe("event hub (un solo EventSource para todos los useEvents)", () => {
  it("reparte cada evento a todos los suscriptores con handler, parseado una vez", () => {
    const hub = createEventHub<H>();
    const a: string[] = [];
    const b: string[] = [];
    hub.subscribe({ current: { onMessageNew: (d) => a.push(d.conversationId) } });
    hub.subscribe({
      current: {
        onMessageNew: (d) => b.push(d.conversationId),
        onConversationHandoff: (d) => b.push(`h:${d.conversationId}`),
      },
    });
    hub.dispatch("message.new", JSON.stringify({ conversationId: "cv_1" }));
    hub.dispatch("conversation.handoff", JSON.stringify({ conversationId: "cv_2" }));
    expect(a).toEqual(["cv_1"]);
    expect(b).toEqual(["cv_1", "h:cv_2"]);
  });

  it("lee los handlers actuales del ref y respeta la desuscripción", () => {
    const hub = createEventHub<H>();
    const seen: string[] = [];
    const ref = { current: { onMessageNew: () => seen.push("v1") } as H };
    const off = hub.subscribe(ref);
    ref.current = { onMessageNew: () => seen.push("v2") };
    hub.dispatch("message.new", "{}");
    off();
    hub.dispatch("message.new", "{}");
    expect(seen).toEqual(["v2"]);
    expect(hub.size).toBe(0);
  });

  it("evento malformado o handler que lanza no corta a los demás", () => {
    const hub = createEventHub<H>();
    const seen: string[] = [];
    hub.subscribe({
      current: {
        onMessageNew: () => {
          throw new Error("boom");
        },
      },
    });
    hub.subscribe({ current: { onMessageNew: () => seen.push("ok") } });
    hub.dispatch("message.new", "{no json");
    hub.dispatch("message.new", "{}");
    expect(seen).toEqual(["ok"]);
  });

  it("onReconnect solo tras un error previo, no en la apertura inicial", () => {
    const hub = createEventHub<H>();
    let n = 0;
    hub.subscribe({ current: { onReconnect: () => n++ } });
    hub.open();
    expect(n).toBe(0);
    hub.error();
    hub.error();
    hub.open();
    expect(n).toBe(1);
    hub.open();
    expect(n).toBe(1);
  });
});
