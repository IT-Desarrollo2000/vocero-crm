import { describe, expect, it } from "vitest";
import {
  COTAS,
  anuncioDeMeta,
  anuncioDeWhatsapp,
  imagenDeOrigen,
  referralDeEvento,
} from "@/server/attribution/referral";
import { normalizarReferral } from "@/server/inbox/ingest";
import { toInboundMessage, toOriginOnly } from "@/server/messenger/ingest";

/**
 * 020 fase C — El anuncio de origen en Messenger (Click-to-Messenger) e
 * Instagram (Click-to-Instagram-Direct). Los ejemplos siguen la forma de la
 * documentación oficial de Meta (webhooks `messages`, `messaging_postbacks` y
 * `messaging_referrals`).
 */

const FOTO = "https://scontent.xx.fbcdn.net/v/t45.1600-4/anuncio.jpg?oh=1";
const MINIATURA_VIDEO = "https://scontent.cdninstagram.com/v/t51/miniatura.jpg?oh=2";

/** `messaging[].message.referral` de un hilo nuevo de Messenger. */
const MESSENGER_MESSAGE_REFERRAL = {
  ref: "promo-verano",
  ad_id: "120212345678900101",
  source: "ADS",
  type: "OPEN_THREAD",
  ads_context_data: {
    ad_title: "Kit de verano con 20 % de descuento",
    photo_url: FOTO,
    post_id: "1099887766_5544332211",
    product_id: "prod-9",
  },
};

/** `messaging[].message.referral` de Instagram (Click-to-Direct con video). */
const INSTAGRAM_REFERRAL = {
  ad_id: "120212345678900202",
  source: "ADS",
  type: "OPEN_THREAD",
  ads_context_data: {
    ad_title: "Agenda tu diagnóstico",
    video_url: MINIATURA_VIDEO,
  },
};

describe("anuncioDeMeta — Messenger", () => {
  it("message.referral: id, titular, foto, enlace a la publicación y raw anidado", () => {
    const a = anuncioDeMeta(MESSENGER_MESSAGE_REFERRAL, "messenger");
    expect(a).toEqual({
      sourceId: "120212345678900101",
      sourceType: "ad",
      sourceUrl: "https://www.facebook.com/1099887766_5544332211",
      headline: "Kit de verano con 20 % de descuento",
      body: null,
      mediaType: "image",
      ctwaClid: null,
      imageUrl: FOTO,
      raw: {
        ref: "promo-verano",
        ad_id: "120212345678900101",
        source: "ADS",
        type: "OPEN_THREAD",
        ads_context_data: {
          ad_title: "Kit de verano con 20 % de descuento",
          photo_url: FOTO,
          post_id: "1099887766_5544332211",
          product_id: "prod-9",
        },
      },
    });
  });

  it("postback.referral del botón Empezar sin ad_id ni contexto: es de anuncio, sin más datos", () => {
    const a = anuncioDeMeta({ source: "ADS", type: "OPEN_THREAD", ref: "x" }, "messenger");
    expect(a).toMatchObject({
      sourceId: null,
      sourceType: "ad",
      headline: null,
      imageUrl: null,
      mediaType: null,
      sourceUrl: null,
    });
  });

  it("referral suelto con referer_uri y solo ad_id (sin source) cuenta como anuncio", () => {
    const a = anuncioDeMeta(
      { ad_id: "777", referer_uri: "https://m.me/pagina?ref=x", type: "OPEN_THREAD" },
      "messenger"
    );
    expect(a?.sourceId).toBe("777");
    expect(a?.raw.referer_uri).toBe("https://m.me/pagina?ref=x");
  });

  it("un enlace m.me (SHORTLINK) o cualquier origen que no es anuncio → null", () => {
    expect(anuncioDeMeta({ ref: "x", source: "SHORTLINK", type: "OPEN_THREAD" }, "messenger")).toBeNull();
    expect(anuncioDeMeta({ source: "CUSTOMER_CHAT_PLUGIN" }, "messenger")).toBeNull();
    expect(anuncioDeMeta({}, "messenger")).toBeNull();
  });

  it("un post_id que no es numérico no se pega en una URL", () => {
    const a = anuncioDeMeta(
      { ...MESSENGER_MESSAGE_REFERRAL, ads_context_data: { post_id: "../evil?x=1" } },
      "messenger"
    );
    expect(a?.sourceUrl).toBeNull();
  });

  it("en Messenger el video_url sin foto queda como posible miniatura (la copia lo valida)", () => {
    const a = anuncioDeMeta(
      { ad_id: "1", source: "ADS", ads_context_data: { video_url: "https://video.xx.fbcdn.net/v.mp4" } },
      "messenger"
    );
    expect(a?.mediaType).toBe("video");
    expect(a?.imageUrl).toBe("https://video.xx.fbcdn.net/v.mp4");
  });
});

describe("anuncioDeMeta — Instagram", () => {
  it("message.referral con video: miniatura del video, tipo video, sin enlace", () => {
    const a = anuncioDeMeta(INSTAGRAM_REFERRAL, "instagram");
    expect(a).toMatchObject({
      sourceId: "120212345678900202",
      sourceType: "ad",
      sourceUrl: null,
      headline: "Agenda tu diagnóstico",
      mediaType: "video",
      imageUrl: MINIATURA_VIDEO,
      ctwaClid: null,
    });
  });

  it("post_id en Instagram no arma enlace (no hay forma fiable)", () => {
    const a = anuncioDeMeta(
      { ...INSTAGRAM_REFERRAL, ads_context_data: { post_id: "123" } },
      "instagram"
    );
    expect(a?.sourceUrl).toBeNull();
  });

  it("el messaging_referral de un enlace ig.me (sin ad_id) no es un anuncio", () => {
    expect(anuncioDeMeta({ ref: "bio", source: "IGME", type: "OPEN_THREAD" }, "instagram")).toBeNull();
  });
});

describe("anuncioDeMeta — payloads raros", () => {
  it("no-objetos → null", () => {
    for (const v of [null, undefined, "basura", 42, [], true]) {
      expect(anuncioDeMeta(v, "messenger")).toBeNull();
    }
  });

  it("ads_context_data malformado no rompe: se ignora", () => {
    const a = anuncioDeMeta({ ad_id: "9", source: "ADS", ads_context_data: 42 }, "instagram");
    expect(a).toMatchObject({ sourceId: "9", headline: null, imageUrl: null });
    expect(a?.raw.ads_context_data).toBeUndefined();
  });

  it("tipos equivocados, javascript: y claves ajenas se descartan", () => {
    const a = anuncioDeMeta(
      {
        ad_id: 123,
        source: "ADS",
        hackeo: "x".repeat(10_000),
        ads_context_data: {
          ad_title: { no: "texto" },
          photo_url: "javascript:alert(1)",
          otra: "fuera",
        },
      },
      "messenger"
    );
    expect(a).toMatchObject({ sourceId: null, headline: null, imageUrl: null, mediaType: null });
    expect(a?.raw).toEqual({ source: "ADS" });
  });

  it("topes: titular recortado y raw acotado", () => {
    const largo = "a".repeat(COTAS.texto + 50);
    const a = anuncioDeMeta(
      {
        ad_id: "1",
        source: "ADS",
        ref: largo,
        referer_uri: largo,
        ads_context_data: { ad_title: largo, product_id: largo, post_id: largo },
      },
      "messenger"
    );
    expect(a?.headline?.length).toBe(COTAS.titular);
    expect(JSON.stringify(a?.raw).length).toBeLessThanOrEqual(COTAS.raw);
  });
});

describe("imagenDeOrigen — reparación de la miniatura desde el raw guardado", () => {
  it("round-trip Messenger/Instagram: el raw vuelve a dar la misma imagen", () => {
    for (const [r, canal] of [
      [MESSENGER_MESSAGE_REFERRAL, "messenger"],
      [INSTAGRAM_REFERRAL, "instagram"],
    ] as const) {
      const a = anuncioDeMeta(r, canal);
      expect(imagenDeOrigen(a?.raw)).toBe(a?.imageUrl);
    }
  });

  it("sigue sirviendo para el raw de WhatsApp", () => {
    const a = anuncioDeWhatsapp({
      source_id: "1",
      headline: "h",
      thumbnail_url: FOTO,
    });
    expect(imagenDeOrigen(a?.raw)).toBe(FOTO);
  });

  it("raw sin imagen o ilegible → null", () => {
    expect(imagenDeOrigen({ ad_id: "1", source: "ADS" })).toBeNull();
    expect(imagenDeOrigen(null)).toBeNull();
    expect(imagenDeOrigen("x")).toBeNull();
  });
});

describe("referralDeEvento — de dónde sale el referral de un evento", () => {
  const sender = { id: "psid_1" };
  it("message.referral, postback.referral y referral suelto", () => {
    expect(referralDeEvento({ sender, message: { mid: "m", referral: { a: 1 } } })).toEqual({ a: 1 });
    expect(referralDeEvento({ sender, postback: { title: "Empezar", referral: { b: 2 } } })).toEqual({ b: 2 });
    expect(referralDeEvento({ sender, referral: { c: 3 } })).toEqual({ c: 3 });
  });
  it("un eco no cuenta; un evento raro tampoco", () => {
    expect(referralDeEvento({ message: { is_echo: true, referral: { a: 1 } } })).toBeUndefined();
    expect(referralDeEvento("x")).toBeUndefined();
    expect(referralDeEvento({ sender, read: { watermark: 1 } })).toBeUndefined();
  });
});

describe("normalizarReferral — por canal, sin lanzar jamás", () => {
  it("Messenger/Instagram usan la forma de Meta; WhatsApp, la suya", () => {
    expect(normalizarReferral(MESSENGER_MESSAGE_REFERRAL, "messenger")?.sourceId).toBe(
      "120212345678900101"
    );
    expect(normalizarReferral(INSTAGRAM_REFERRAL, "instagram")?.mediaType).toBe("video");
    // El referral de Meta leído como WhatsApp no tiene nada que identificar.
    expect(normalizarReferral(MESSENGER_MESSAGE_REFERRAL, "whatsapp")).toBeNull();
    expect(normalizarReferral({ source_id: "5", headline: "h" }, undefined)?.sourceId).toBe("5");
  });
  it("vacío o basura → null", () => {
    expect(normalizarReferral(null, "messenger")).toBeNull();
    expect(normalizarReferral("basura", "instagram")).toBeNull();
  });
});

describe("Messenger — toOriginOnly: anuncios que llegan sin mensaje", () => {
  const base = { sender: { id: "psid_1" }, recipient: { id: "page_1" }, timestamp: 1 };

  it("referral suelto de un hilo existente", () => {
    const o = toOriginOnly({ ...base, referral: MESSENGER_MESSAGE_REFERRAL });
    expect(o?.psid).toBe("psid_1");
    expect(o?.anuncio.sourceId).toBe("120212345678900101");
  });

  it("postback.referral del botón Empezar", () => {
    const o = toOriginOnly({
      ...base,
      postback: { title: "Empezar", payload: "GET_STARTED", referral: { source: "ADS", type: "OPEN_THREAD" } },
    });
    expect(o?.anuncio.sourceType).toBe("ad");
  });

  it("un mensaje con referral NO es solo-origen (el anuncio viaja con él)", () => {
    const m = { ...base, message: { mid: "m1", text: "hola", referral: MESSENGER_MESSAGE_REFERRAL } };
    expect(toOriginOnly(m)).toBeNull();
    expect(toInboundMessage(m)?.mid).toBe("m1");
  });

  it("eco, postback sin referral, enlace m.me, o sin remitente → null", () => {
    expect(
      toOriginOnly({ ...base, message: { mid: "e", is_echo: true, referral: MESSENGER_MESSAGE_REFERRAL } })
    ).toBeNull();
    expect(toOriginOnly({ ...base, postback: { payload: "X" } })).toBeNull();
    expect(toOriginOnly({ ...base, referral: { source: "SHORTLINK", ref: "x" } })).toBeNull();
    expect(toOriginOnly({ referral: MESSENGER_MESSAGE_REFERRAL })).toBeNull();
    expect(toOriginOnly({ ...base, referral: "basura" })).toBeNull();
  });
});
