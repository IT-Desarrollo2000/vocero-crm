import { describe, expect, it } from "vitest";
import {
  AGGREGATE_HANDOFF_TAG,
  aggregateHandoffContent,
  alertPrefsKey,
  applyTitleCount,
  createBurstAggregator,
  createDedupe,
  dedupeKey,
  DEFAULT_ALERT_PREFS,
  faviconBadgeDot,
  isConversationInView,
  loadAlertPrefs,
  messageAlertEvent,
  notificationContent,
  notificationSupport,
  notificationTag,
  parseAlertPrefs,
  saveAlertPrefs,
  shouldNotify,
  shouldPlaySound,
  soundAllowed,
  stripTitleCount,
  titleWithCount,
  unreadFromCounts,
  unreadFromList,
  wonClaim,
  type AlertPrefs,
  type HandoffAlertEvent,
  type IncomingMessageEvent,
  type PrefsStorage,
} from "@/lib/alerts";

const ON: AlertPrefs = { ...DEFAULT_ALERT_PREFS, notifications: true, sound: true };
const granted = { permission: "granted" as const, conversationInView: false };

const inbound = (over: Partial<IncomingMessageEvent> = {}): IncomingMessageEvent => ({
  kind: "message",
  conversationId: "cv_1",
  messageId: "msg_1",
  direction: "in",
  type: "text",
  text: "Hola, ¿tienen envío?",
  ...over,
});

const handoff = (over: Partial<HandoffAlertEvent> = {}): HandoffAlertEvent => ({
  kind: "handoff",
  conversationId: "cv_1",
  reason: "cliente",
  handoffAt: "2026-10-12T15:00:00.000Z",
  ...over,
});

function memoryStorage(initial: Record<string, string> = {}): PrefsStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe("shouldNotify", () => {
  it("entrante normal con permiso y preferencia → sí", () => {
    expect(shouldNotify(inbound(), ON, granted)).toBe(true);
  });

  it("saliente → no", () => {
    expect(shouldNotify(inbound({ direction: "out" }), ON, granted)).toBe(false);
  });

  it("handoff `manual_reply` → no (ya atiende un humano); otro motivo → sí", () => {
    expect(shouldNotify(handoff({ reason: "manual_reply" }), ON, granted)).toBe(false);
    expect(shouldNotify(handoff(), ON, granted)).toBe(true);
  });

  it("conversación abierta en una pestaña visible → no", () => {
    const ctx = { permission: "granted" as const, conversationInView: true };
    expect(shouldNotify(inbound(), ON, ctx)).toBe(false);
    expect(shouldNotify(handoff(), ON, ctx)).toBe(false);
  });

  it("permiso denegado, por pedir o sin soporte → no", () => {
    for (const permission of ["denied", "default", "unsupported"] as const) {
      expect(shouldNotify(inbound(), ON, { permission, conversationInView: false })).toBe(
        false
      );
    }
  });

  it("preferencias apagadas → no", () => {
    expect(shouldNotify(inbound(), { ...ON, notifications: false }, granted)).toBe(false);
    expect(shouldNotify(inbound(), { ...ON, incoming: false }, granted)).toBe(false);
    expect(shouldNotify(handoff(), { ...ON, handoffs: false }, granted)).toBe(false);
    // Apagar un tipo no afecta al otro.
    expect(shouldNotify(handoff(), { ...ON, incoming: false }, granted)).toBe(true);
  });

  it("con los defaults no se notifica nada (hay que activarlo)", () => {
    expect(shouldNotify(inbound(), DEFAULT_ALERT_PREFS, granted)).toBe(false);
  });
});

describe("shouldPlaySound", () => {
  it("suena aunque las notificaciones estén bloqueadas (RF-05-14)", () => {
    const prefs = { ...DEFAULT_ALERT_PREFS, sound: true };
    expect(shouldPlaySound(inbound(), prefs, { conversationInView: false })).toBe(true);
  });

  it("no suena con el sonido apagado, por salientes, manual_reply ni a la vista", () => {
    expect(shouldPlaySound(inbound(), { ...ON, sound: false }, granted)).toBe(false);
    expect(shouldPlaySound(inbound({ direction: "out" }), ON, granted)).toBe(false);
    expect(shouldPlaySound(handoff({ reason: "manual_reply" }), ON, granted)).toBe(false);
    expect(shouldPlaySound(inbound(), ON, { conversationInView: true })).toBe(false);
  });

  it("máximo uno cada 3 s", () => {
    expect(soundAllowed(null, 1_000)).toBe(true);
    expect(soundAllowed(1_000, 3_999)).toBe(false);
    expect(soundAllowed(1_000, 4_000)).toBe(true);
  });
});

describe("dedupeKey y tag", () => {
  it("entrante → msg:<messageId>; handoff → handoff:<conversationId>:<handoffAt>", () => {
    expect(dedupeKey(inbound())).toBe("msg:msg_1");
    expect(dedupeKey(handoff())).toBe("handoff:cv_1:2026-10-12T15:00:00.000Z");
  });

  it("es estable para el mismo evento y distinta para otro handoff de la misma conversación", () => {
    expect(dedupeKey(handoff())).toBe(dedupeKey(handoff()));
    expect(dedupeKey(handoff({ handoffAt: "2026-10-12T16:00:00.000Z" }))).not.toBe(
      dedupeKey(handoff())
    );
  });

  it("el tag es por conversación (reemplaza, no apila)", () => {
    expect(notificationTag("cv_9")).toBe("conv:cv_9");
  });
});

describe("messageAlertEvent (payload de message.new)", () => {
  it("toma lo necesario del DTO", () => {
    expect(
      messageAlertEvent({
        conversationId: "cv_1",
        message: { id: "msg_7", direction: "in", type: "image", text: null },
      })
    ).toEqual({
      kind: "message",
      conversationId: "cv_1",
      messageId: "msg_7",
      direction: "in",
      type: "image",
      text: null,
    });
  });

  it("payload inesperado → null (no rompe)", () => {
    expect(messageAlertEvent({ conversationId: "cv_1", message: null })).toBeNull();
    expect(messageAlertEvent({ conversationId: "cv_1", message: { id: 3 } })).toBeNull();
    expect(
      messageAlertEvent({ conversationId: "cv_1", message: { id: "m", direction: "x" } })
    ).toBeNull();
  });
});

describe("notificationContent", () => {
  it("entrante con contenido: nombre + texto", () => {
    expect(notificationContent(inbound(), ON, { contactName: "Ana" })).toEqual({
      title: "Ana",
      body: "Hola, ¿tienen envío?",
    });
  });

  it("sin «Mostrar contenido» → «Nuevo mensaje»", () => {
    expect(
      notificationContent(inbound(), { showContent: false }, { contactName: "Ana" }).body
    ).toBe("Nuevo mensaje");
  });

  it("adjunto → etiqueta con clip", () => {
    expect(
      notificationContent(inbound({ type: "image", text: null }), ON, { contactName: "Ana" })
        .body
    ).toBe("📎 Imagen");
  });

  it("sin nombre → título genérico", () => {
    expect(notificationContent(inbound(), ON, { contactName: null }).title).toBe(
      "Nuevo mensaje"
    );
  });

  it("handoff: título fijo, motivo en español y nota", () => {
    const c = notificationContent(handoff(), ON, { contactName: "Ana", note: "Quiere factura" });
    expect(c.title).toBe("Un cliente espera que lo atiendas");
    expect(c.body).toBe("Ana — El cliente pidió un humano\nQuiere factura");
    expect(
      notificationContent(handoff(), { showContent: false }, { contactName: "Ana", note: "x" })
        .body
    ).toBe("Ana — El cliente pidió un humano");
  });

  it("agregada", () => {
    expect(aggregateHandoffContent(5).title).toBe(
      "5 conversaciones están por atender"
    );
    expect(AGGREGATE_HANDOFF_TAG).toBe("handoff:aggregate");
  });
});

describe("createBurstAggregator (ráfaga de handoffs)", () => {
  it("hasta el umbral, una por conversación; después, agregada con el conteo", () => {
    const agg = createBurstAggregator({ windowMs: 10_000, threshold: 3 });
    expect(agg.push(0)).toEqual({ kind: "single" });
    expect(agg.push(1_000)).toEqual({ kind: "single" });
    expect(agg.push(2_000)).toEqual({ kind: "single" });
    expect(agg.push(3_000)).toEqual({ kind: "aggregate", count: 4 });
    expect(agg.push(4_000)).toEqual({ kind: "aggregate", count: 5 });
  });

  it("fuera de la ventana vuelve a avisar uno por uno", () => {
    const agg = createBurstAggregator({ windowMs: 10_000, threshold: 3 });
    for (const t of [0, 1, 2, 3]) agg.push(t);
    expect(agg.push(20_000)).toEqual({ kind: "single" });
  });
});

describe("createDedupe", () => {
  it("recuerda claves dentro del TTL", () => {
    const d = createDedupe({ ttlMs: 1_000 });
    expect(d.has("msg:1", 0)).toBe(false);
    d.mark("msg:1", 0);
    expect(d.has("msg:1", 999)).toBe(true);
    expect(d.has("msg:1", 1_000)).toBe(false);
  });

  it("está acotado", () => {
    const d = createDedupe({ ttlMs: 60_000, max: 3 });
    for (const k of ["a", "b", "c", "d"]) d.mark(k, 0);
    expect(d.size).toBe(3);
    expect(d.has("a", 1)).toBe(false);
    expect(d.has("d", 1)).toBe(true);
  });
});

describe("coordinación entre pestañas (simulada)", () => {
  it("wonClaim: gana el tabId menor entre los reclamos", () => {
    expect(wonClaim("a", ["a", "b", "c"])).toBe(true);
    expect(wonClaim("b", ["a", "b"])).toBe(false);
    expect(wonClaim("z", [])).toBe(true);
  });

  it("tres pestañas reclaman la misma clave → exactamente una avisa", () => {
    const tabs = ["k3-x", "k1-y", "k2-z"];
    const winners = tabs.filter((t) => wonClaim(t, tabs));
    expect(winners).toEqual(["k1-y"]);
  });

  it("dedupe compartido: la clave difundida evita repetir tras cambio de líder", () => {
    const leaderA = createDedupe();
    const leaderB = createDedupe();
    const key = dedupeKey(inbound());
    // A avisa y difunde `seen`; B la recibe.
    leaderA.mark(key, 0);
    leaderB.mark(key, 0);
    // A se cierra, B toma el mando y llega el mismo evento (retraso del SSE).
    expect(leaderB.has(key, 500)).toBe(true);
  });

  it("isConversationInView: solo pestañas visibles y no vencidas", () => {
    const now = 100_000;
    const presences = [
      { tabId: "a", visible: false, conversationId: "cv_1", at: now },
      { tabId: "b", visible: true, conversationId: "cv_2", at: now },
      { tabId: "c", visible: true, conversationId: "cv_3", at: now - 60_000 },
    ];
    expect(isConversationInView(presences, "cv_1", now)).toBe(false);
    expect(isConversationInView(presences, "cv_2", now)).toBe(true);
    expect(isConversationInView(presences, "cv_3", now)).toBe(false);
  });
});

describe("preferencias en localStorage", () => {
  it("la clave incluye el userId", () => {
    expect(alertPrefsKey("u_1")).toBe("vocero.alerts.v1.u_1");
  });

  it("guarda y lee por usuario", () => {
    const s = memoryStorage();
    saveAlertPrefs("u_1", ON, s);
    expect(loadAlertPrefs("u_1", s)).toEqual(ON);
    expect(loadAlertPrefs("u_2", s)).toEqual(DEFAULT_ALERT_PREFS);
  });

  it("JSON corrupto o tipos raros → defaults campo por campo", () => {
    expect(parseAlertPrefs("{no es json")).toEqual(DEFAULT_ALERT_PREFS);
    expect(parseAlertPrefs("[]")).toEqual(DEFAULT_ALERT_PREFS);
    expect(parseAlertPrefs(JSON.stringify({ sound: "sí", notifications: true }))).toEqual({
      ...DEFAULT_ALERT_PREFS,
      notifications: true,
    });
  });

  it("acceso bloqueado → defaults sin lanzar", () => {
    const broken: PrefsStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    expect(loadAlertPrefs("u_1", broken)).toEqual(DEFAULT_ALERT_PREFS);
    expect(saveAlertPrefs("u_1", ON, broken)).toBe(false);
    expect(loadAlertPrefs("u_1", null)).toEqual(DEFAULT_ALERT_PREFS);
  });

  it("defaults: todo apagado salvo el contador (y mostrar contenido, D-05-6)", () => {
    expect(DEFAULT_ALERT_PREFS.notifications).toBe(false);
    expect(DEFAULT_ALERT_PREFS.sound).toBe(false);
    expect(DEFAULT_ALERT_PREFS.tabCounter).toBe(true);
    expect(DEFAULT_ALERT_PREFS.showContent).toBe(true);
  });
});

describe("título con contador", () => {
  it("titleWithCount: 0 sin prefijo, 1, 99+ e idempotente", () => {
    expect(titleWithCount("Acme — CRM", 0)).toBe("Acme — CRM");
    expect(titleWithCount("Acme — CRM", 1)).toBe("(1) Acme — CRM");
    expect(titleWithCount("Acme — CRM", 150)).toBe("(99+) Acme — CRM");
    expect(titleWithCount("(3) Acme — CRM", 2)).toBe("(2) Acme — CRM");
    expect(titleWithCount("(99+) Acme — CRM", 0)).toBe("Acme — CRM");
    expect(stripTitleCount("(12) Acme")).toBe("Acme");
  });

  it("applyTitleCount sobre un documento simulado solo escribe si cambia", () => {
    const doc = { title: "Acme — CRM" };
    expect(applyTitleCount(doc, 2)).toBe(true);
    expect(doc.title).toBe("(2) Acme — CRM");
    expect(applyTitleCount(doc, 2)).toBe(false);
    // Next reescribe el título al navegar: se reaplica sobre el nuevo.
    doc.title = "Acme — Pipeline";
    expect(applyTitleCount(doc, 2)).toBe(true);
    expect(doc.title).toBe("(2) Acme — Pipeline");
    applyTitleCount(doc, 0);
    expect(doc.title).toBe("Acme — Pipeline");
  });

  it("N sale de counts.unreadConversations o, de respaldo, cuenta conversaciones", () => {
    expect(unreadFromCounts({ unreadConversations: 3, unreadMessages: 9 })).toBe(3);
    expect(unreadFromCounts({ error: "not_implemented" })).toBeNull();
    expect(
      unreadFromList({
        conversations: [{ unreadCount: 5 }, { unreadCount: 0 }, { unreadCount: 1 }],
      })
    ).toBe(2);
    expect(unreadFromList(null)).toBeNull();
  });
});

describe("favicon y soporte", () => {
  it("el punto cabe en el icono, arriba a la derecha", () => {
    const d = faviconBadgeDot(64);
    expect(d.cx + d.r + d.ring).toBeLessThanOrEqual(64);
    expect(d.cy - d.r - d.ring).toBeGreaterThanOrEqual(0);
    expect(d.cx).toBeGreaterThan(32);
    expect(d.stroke).toBe("#FFFFFF");
  });

  it("notificationSupport", () => {
    expect(
      notificationSupport({ hasNotification: false, isSecureContext: true, permission: null })
    ).toBe("unsupported");
    expect(
      notificationSupport({ hasNotification: true, isSecureContext: false, permission: "default" })
    ).toBe("insecure");
    expect(
      notificationSupport({ hasNotification: true, isSecureContext: true, permission: "denied" })
    ).toBe("denied");
    expect(
      notificationSupport({ hasNotification: true, isSecureContext: true, permission: "granted" })
    ).toBe("granted");
  });
});
