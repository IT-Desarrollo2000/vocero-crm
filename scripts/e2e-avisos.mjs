/**
 * Self-test E2E — 035 fase B: Avisos (campana, aviso emergente, navegador,
 * línea de la Bandeja).
 * Contrato: specs/035-recordatorios/spec.md · plan: specs/035-recordatorios/plan-b.md
 *
 * Contra la app VIVA (mocks) y la BD AISLADA, con `NOTIFICATIONS_TICK_MS=0`:
 * el reloj de avisos solo avanza con `POST /api/dev/notifications/tick`.
 *
 * Independiente de la hora y del día en que corre (sin SKIP cerca de
 * medianoche): los recordatorios que disparan el aviso quedan para MAÑANA
 * 07:00 (zona del negocio) y el tick se fuerza a mañana 07:01 — antes de las
 * 08:00, así ese tick NO crea resumen del día. El resumen se prueba con otro
 * tick forzado a HOY 23:59 (siempre ≥ 08:00 y siempre hoy): sale el de hoy,
 * con su texto vivo. Lo que usa la hora real (número rojo, línea de la
 * Bandeja) se siembra con un recordatorio de AYER (siempre vencido y «de hoy»).
 *
 *   1) la Bandeja dice «1 recordatorio para hoy (1 vencido)»
 *   2) el Propietario le asigna un chat a Vera → «Te asignaron a …» en vivo;
 *      cita creada para Bruno y reasignada a Vera → «Te asignaron la cita…»
 *   3) tomar uno mismo (chat o cita) no avisa; asignarse a sí mismo tampoco
 *   4) tick → aviso emergente EN VIVO (Vera), campana con el número; el
 *      resumen del día existe; otro tick con la misma hora no duplica
 *   5) Bruno y el Propietario no lo ven (API, pantalla y el SSE crudo)
 *   6) Posponer 1 h desde el emergente; Contactar abre el chat
 *   7) el Propietario cierra un recordatorio de Vera → su número rojo se
 *      apaga en vivo (SSE `follow_ups.changed`)
 *   8) Marcar todo como leído → contador 0; Escape cierra; 390 px
 *   9) reloj con fecha ilegible → 422 y la app sigue
 *
 * Presupuesto del limitador de login: 3 (dueño, Vera, Bruno; por API).
 *
 * Uso (BD aislada, app con .env.e2e):
 *   CATALOG_STORAGE=local node --env-file=.env.e2e scripts/e2e-avisos.mjs
 * Con `REVISAR_DIR=<dir>` deja capturas. Sale con 1 si algún check falla.
 */
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const S = Math.random().toString(36).slice(2, 7);
const PN = "PN-E2E-035B";
const WABA = "WABA-E2E-035B";
const REVISAR = process.env.REVISAR_DIR ?? null;
const TZ = "America/Mexico_City";
const DAY = 86_400_000;

let failures = 0;
let checks = 0;
function ok(name, cond, extra = "") {
  checks++;
  if (cond) console.log(`  OK  ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

/** Una sesión (cookie) por persona. */
function session() {
  const jar = { cookie: "" };
  async function api(p, opts = {}) {
    const res = await fetch(`${BASE}${p}`, {
      ...opts,
      headers: {
        "content-type": "application/json",
        origin: BASE,
        ...(jar.cookie ? { cookie: jar.cookie } : {}),
        ...(opts.headers ?? {}),
      },
      redirect: "manual",
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    if (setCookie.length) jar.cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    let json = null;
    try {
      json = await res.clone().json();
    } catch {}
    return { res, json };
  }
  return { jar, api };
}

const owner = session();
const vera = session();
const bruno = session();
const api = owner.api;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {}
    if (Date.now() - t0 > ms) return false;
    await sleep(250);
  }
};
const body = (o) => JSON.stringify(o);
const short = (r) => `${r.res.status} ${JSON.stringify(r.json)?.slice(0, 260)}`;
const shot = async (target, file) => {
  if (REVISAR) await target.screenshot({ path: `${REVISAR}/${file}`, animations: "disabled", caret: "hide" }).catch(() => {});
};

/** Día de pared (YYYY-MM-DD) en la zona del negocio, con desplazamiento en días. */
function dayIn(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(
    new Date(Date.now() + offsetDays * DAY)
  );
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${m.year}-${m.month}-${m.day}`;
}
/** Instante UTC de una hora de pared en la zona (dos pasadas, como el servidor). */
function wallToUtc(day, hhmm) {
  const [y, mo, d] = day.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = (t) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        .formatToParts(new Date(t))
        .map((x) => [x.type, x.value])
    );
    return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t) / 60000;
  };
  let ts = guess - off(guess) * 60000;
  const second = off(ts);
  ts = guess - second * 60000;
  return new Date(ts);
}

const OWNER = { email: "e2e@vocero.test", password: "password-e2e-123", name: "Operador E2E" };
const VERA = { name: `Vera ${S}`, email: `vera.b.${S}@vocero.test`, password: "password-vera-035b" };
const BRUNO = { name: `Bruno ${S}`, email: `bruno.b.${S}@vocero.test`, password: "password-bruno-035b" };

let seq = 0;
const phoneOf = new Map();
function phone(name) {
  if (!phoneOf.has(name)) phoneOf.set(name, `52156${String(Date.now()).slice(-5)}${String(seq++).padStart(3, "0")}`);
  return phoneOf.get(name);
}
async function convOf(name) {
  const r = await api(`/api/conversations?${new URLSearchParams({ q: name })}`);
  return (r.json?.conversations ?? []).find((c) => c.contact?.name === name) ?? null;
}
async function inbound(name, text) {
  const r = await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({ phoneNumberId: PN, from: phone(name), name, text, waMessageId: `wamid.e2e.035b.${S}.${seq++}` }),
  });
  if (!r.res.ok) ok(`inbound de ${name}`, false, short(r));
  await until(async () => !!(await convOf(name)));
  return convOf(name);
}

const N = {
  laura: `Laura Gómez ${S}`,
  marta: `Marta Ríos ${S}`,
  carlos: `Carlos Ruiz ${S}`,
  patricia: `Patricia Luna ${S}`,
  tomas: `Tomás Buzón ${S}`,
  propio: `Pepe Propio ${S}`,
  sofia: `Sofía Castro ${S}`,
  libre: `Lalo Libre ${S}`,
};
const NOTE_LAURA = "Avisarle cuando llegue el comedor de 6 sillas en nogal.";

let ids = {};
const conv = {};
const fu = {};

/* ───────────────────────── setup ───────────────────────── */

async function setup() {
  console.log("== Setup ==");
  let su = await api("/api/auth/sign-up/email", { method: "POST", body: body(OWNER) });
  if (!su.res.ok) su = await api("/api/auth/sign-in/email", { method: "POST", body: body({ email: OWNER.email, password: OWNER.password }) });
  ok("owner con sesión", su.res.ok, short(su));
  const conn = await api("/api/settings/whatsapp", { method: "PUT", body: body({ wabaId: WABA, phoneNumberId: PN, token: "tok-e2e-035b" }) });
  ok("WhatsApp (wa-mock)", conn.res.ok, short(conn));
  await api("/api/agent/profile", { method: "PUT", body: body({ name: "Lumi", tone: "breve", instructions: "Tienda.", enabled: false }) });

  for (const p of [VERA, BRUNO]) {
    const alta = await api("/api/settings/team", { method: "POST", body: body(p) });
    ok(`alta de ${p.name}`, alta.res.status === 201, short(alta));
  }
  const lv = await vera.api("/api/auth/sign-in/email", { method: "POST", body: body({ email: VERA.email, password: VERA.password }) });
  const lb = await bruno.api("/api/auth/sign-in/email", { method: "POST", body: body({ email: BRUNO.email, password: BRUNO.password }) });
  ok("Vera y Bruno inician sesión", lv.res.ok && lb.res.ok, `${short(lv)} | ${short(lb)}`);
  const team = (await api("/api/settings/team")).json?.members ?? [];
  const me = (await api("/api/auth/get-session")).json?.user?.id;
  ids = {
    owner: me,
    vera: team.find((m) => m.email === VERA.email)?.userId,
    bruno: team.find((m) => m.email === BRUNO.email)?.userId,
  };
  ok("ids del equipo", !!ids.owner && !!ids.vera && !!ids.bruno, JSON.stringify(ids));

  for (const name of Object.values(N)) {
    if (name === N.sofia || name === N.libre) continue;
    conv[name] = await inbound(name, "Hola, quiero informes");
  }
  // Los de Vera (Patricia y Tomás quedan en el Buzón para el paso 2/3).
  for (const name of [N.laura, N.marta, N.carlos]) {
    const a = await api(`/api/conversations/${conv[name]?.id}/assign`, { method: "POST", body: body({ userId: ids.vera }) });
    if (!a.res.ok) ok(`asignar ${name}`, false, short(a));
  }
  ok("conversaciones creadas", Object.values(conv).every((c) => !!c?.id));

  // Agenda 24/7 y contactos sin chat para las citas.
  const allDay = [{ start: "00:00", end: "23:30" }];
  const agenda = await api("/api/calendar/settings", {
    method: "PUT",
    body: body({
      weeklyHours: { mon: allDay, tue: allDay, wed: allDay, thu: allDay, fri: allDay, sat: allDay, sun: allDay },
      slotMinutes: 30,
      bufferMinutes: 0,
      minNoticeHours: 0,
      maxDaysAhead: 7,
      connector: "enlace-fijo",
      meetingLink: null,
      reminderEnabled: false,
    }),
  });
  ok("agenda 24/7", agenda.res.ok, short(agenda));
  for (const name of [N.sofia, N.libre]) {
    const ct = await api("/api/contacts", { method: "POST", body: body({ name, phone: phone(name) }) });
    ids[name] = ct.json?.contact?.id ?? ct.json?.id;
  }
  ok("contactos para las citas", !!ids[N.sofia] && !!ids[N.libre]);

  // Los avisos del setup (Vera recibió 3 «Te asignaron») no cuentan.
  await vera.api("/api/notifications/read", { method: "POST", body: body({ all: true }) });

  // Recordatorios de Vera: dos para MAÑANA 07:00 (disparan con el tick
  // forzado) y uno de AYER 10:00 (siempre vencido y «de hoy» en la hora real).
  const mk = async (name, day, reason, note, time = "07:00") => {
    const r = await vera.api("/api/follow-ups", {
      method: "POST",
      body: body({ contactId: conv[name].contact.id, conversationId: conv[name].id, day, time, reason, note }),
    });
    if (r.res.status !== 201) ok(`recordatorio de ${name}`, false, short(r));
    return r.json?.followUp;
  };
  fu.laura = await mk(N.laura, dayIn(1), "informacion", NOTE_LAURA);
  fu.marta = await mk(N.marta, dayIn(1), "volver_a_contactar", "Quedó de decidir después de la quincena.");
  fu.carlos = await mk(N.carlos, dayIn(-1), "servicio", null, "10:00");
  ok("Vera tiene 3 recordatorios (2 mañana, 1 de ayer)", !!fu.laura?.id && !!fu.marta?.id && !!fu.carlos?.id);

  for (const p of ["/api/notifications", "/api/follow-ups/count", "/inbox", "/pipeline?vista=pendientes", "/bookings"]) {
    await vera.api(p).catch(() => {});
  }
}

/* ───────────────────────── navegador ───────────────────────── */

let browser;
/** Página con SSE VIVO (a diferencia de e2e-pendientes, aquí no se corta). */
async function pageAs(sess, viewport = { width: 1366, height: 900 }, permissions = []) {
  const ctx = await browser.newContext({ viewport, permissions });
  if (permissions.includes("notifications")) {
    // Chromium headless informa `Notification.permission = "denied"` aunque
    // se conceda: se simula el permiso concedido y se registran los avisos.
    await ctx.addInitScript(() => {
      const shown = [];
      window.__notifications = shown;
      class FakeNotification {
        static permission = "granted";
        static requestPermission = async () => "granted";
        constructor(title, opts) {
          shown.push({ title, ...(opts ?? {}) });
        }
        close() {}
      }
      window.Notification = FakeNotification;
      // Pestaña «oculta» a pedido (`window.__hidden = true`).
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (window.__hidden ? "hidden" : "visible"),
      });
    });
  }
  const host = new URL(BASE);
  await ctx.addCookies(
    sess.jar.cookie.split("; ").filter(Boolean).map((kv) => {
      const i = kv.indexOf("=");
      return { name: kv.slice(0, i), value: kv.slice(i + 1), domain: host.hostname, path: "/" };
    })
  );
  const page = await ctx.newPage();
  return { ctx, page };
}
async function gotoInbox(page) {
  await page.goto(`${BASE}/inbox`, { waitUntil: "load" });
  await page.getByTestId("nav-bell").waitFor({ timeout: 60000 });
}
const bellCount = async (page, id = "nav-bell") => {
  const el = page.getByTestId(`${id}-count`);
  return (await el.count()) ? Number((await el.innerText()).trim()) : 0;
};
const listOf = async (sess) => (await sess.api("/api/notifications")).json;
const tick = (now) => api("/api/dev/notifications/tick", { method: "POST", body: body(now ? { now } : {}) });

/** Lector crudo de `/api/events` (lo que de verdad sale por el cable). */
function rawEvents(sess) {
  const ctrl = new AbortController();
  const state = { text: "" };
  void (async () => {
    try {
      const res = await fetch(`${BASE}/api/events`, { headers: { cookie: sess.jar.cookie }, signal: ctrl.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        state.text += dec.decode(value, { stream: true });
      }
    } catch {}
  })();
  return { state, stop: () => ctrl.abort() };
}

async function slotFor(typeId, minMs) {
  const slots = (await api(`/api/calendar/availability?typeId=${typeId}&sellerId=none`)).json?.slots ?? [];
  const free = slots.filter((x) => (x.conflicts ?? []).length === 0).map((x) => Date.parse(x.startUtc)).sort((a, b) => a - b);
  return free.find((t) => t >= minMs) ?? null;
}

/* ───────────────────────── recorrido ───────────────────────── */

async function recorrido() {
  console.log("\n== 1) La Bandeja y la campana al empezar ==");
  // Vera con el permiso de notificaciones concedido (el pie de la campana
  // ofrece «Activar avisos del navegador», como en el diseño).
  const v = await pageAs(vera, undefined, ["notifications"]);
  const o = await pageAs(owner);
  const b = await pageAs(bruno);
  await gotoInbox(v.page);
  await gotoInbox(o.page);
  await gotoInbox(b.page);
  const line = v.page.getByTestId("summary-reminders");
  ok(
    "Bandeja: «1 recordatorio para hoy (1 vencido)» · «Ábrelos en Seguimiento › Pendientes.»",
    await until(async () => /1 recordatorio para hoy \(1 vencido\)/.test(await line.innerText()) && /Ábrelos en Seguimiento › Pendientes\./.test(await line.innerText()), 30000),
    await line.innerText().catch(() => "sin línea")
  );
  await shot(v.page, "bandeja-recordatorios.png");
  ok("campana de Vera sin avisos al empezar", (await bellCount(v.page)) === 0, String(await bellCount(v.page)));
  ok("número rojo de vencidos junto a «Seguimiento» (1)", await until(async () => (await v.page.getByTestId("nav-overdue").innerText()) === "1", 15000));
  ok("sin `title` en la campana", (await v.page.locator('[data-testid="nav-bell"][title], [data-testid="nav-bell"] [title]').count()) === 0);

  const ownerWire = rawEvents(owner);
  await sleep(500);

  console.log("\n== 2) «Te asignaron…» (chat y cita) ==");
  const asg = await api(`/api/conversations/${conv[N.patricia].id}/assign`, { method: "POST", body: body({ userId: ids.vera }) });
  ok("el Propietario le asigna Patricia a Vera", asg.res.ok, short(asg));
  ok("en vivo: la campana de Vera marca 1", await until(async () => (await bellCount(v.page)) === 1, 15000), String(await bellCount(v.page)));
  let lv = await listOf(vera);
  const chatN = lv?.notifications?.find((n) => n.kind === "chat_assigned" && n.conversationId === conv[N.patricia].id);
  ok("API: aviso chat_assigned con el Propietario como actor", !!chatN && !!chatN.actorName && !chatN.readAt, JSON.stringify(chatN));

  const types = (await api("/api/calendar/types")).json?.types ?? [];
  const tipo = types.find((t) => t.name === "Servicio") ?? types.find((t) => !t.exclusive) ?? types[0];
  const start1 = await slotFor(tipo?.id, Date.now() + 26 * 3600_000);
  const start2 = await slotFor(tipo?.id, (start1 ?? Date.now()) + 2 * 3600_000);
  ok("huecos libres para dos citas", !!tipo?.id && !!start1 && !!start2, JSON.stringify({ tipo: tipo?.id, start1, start2 }));
  const cita = await api("/api/bookings", {
    method: "POST",
    body: body({ kind: "session", contactId: ids[N.sofia], conversationId: null, startUtc: new Date(start1).toISOString(), typeId: tipo.id, assignedUserId: ids.bruno }),
  });
  const bookingId = cita.json?.booking?.id ?? cita.json?.id;
  ok("el Propietario crea la cita de Sofía para Bruno", cita.res.status === 201 && !!bookingId, short(cita));
  ok(
    "API: Bruno recibe «Te asignaron la cita de Sofía»",
    await until(async () => ((await listOf(bruno))?.notifications ?? []).some((n) => n.kind === "booking_assigned" && n.bookingId === bookingId), 10000)
  );
  const re = await api(`/api/bookings/${bookingId}`, { method: "PATCH", body: body({ action: "assign", userId: ids.vera }) });
  ok("el Propietario la reasigna a Vera", re.res.ok, short(re));
  ok("en vivo: la campana de Vera marca 2", await until(async () => (await bellCount(v.page)) === 2, 15000), String(await bellCount(v.page)));
  lv = await listOf(vera);
  const bookN = lv?.notifications?.find((n) => n.kind === "booking_assigned" && n.bookingId === bookingId);
  ok("API: aviso booking_assigned para Vera con la hora", !!bookN?.payload?.scheduledAt && bookN.actorName === chatN?.actorName, JSON.stringify(bookN));

  console.log("\n== 3) Tomar uno mismo no avisa ==");
  const before = (await listOf(vera))?.notifications?.length ?? 0;
  const take = await vera.api(`/api/conversations/${conv[N.tomas].id}/assign`, { method: "POST", body: body({ userId: ids.vera }) });
  ok("Vera toma un chat del Buzón", take.res.ok, short(take));
  const libre = await api("/api/bookings", {
    method: "POST",
    body: body({ kind: "session", contactId: ids[N.libre], conversationId: null, startUtc: new Date(start2).toISOString(), typeId: tipo.id, assignedUserId: null }),
  });
  const libreId = libre.json?.booking?.id ?? libre.json?.id;
  const takeB = await vera.api(`/api/bookings/${libreId}`, { method: "PATCH", body: body({ action: "take" }) });
  ok("Vera toma una cita sin vendedor", libre.res.status === 201 && takeB.res.ok, `${short(libre)} | ${short(takeB)}`);
  const own = await api(`/api/conversations/${conv[N.propio].id}/assign`, { method: "POST", body: body({ userId: ids.owner }) });
  ok("el Propietario se asigna un chat a sí mismo", own.res.ok, short(own));
  await sleep(800);
  ok("tomar uno mismo no le avisa a Vera", ((await listOf(vera))?.notifications?.length ?? 0) === before);
  ok("asignarse a sí mismo no le avisa al Propietario", ((await listOf(owner))?.notifications ?? []).every((n) => n.kind !== "chat_assigned"));

  // Clic en una fila = leído (la cita queda «Leído · …», como en el diseño).
  await v.page.getByTestId("nav-bell").click();
  const panel = v.page.getByTestId("notifications-panel");
  await panel.waitFor();
  await panel.locator('[data-testid="notification-item"][data-kind="booking_assigned"] [data-testid="notification-text"]').click();
  ok("clic en un aviso lo marca leído (campana 1)", await until(async () => (await bellCount(v.page)) === 1, 10000), String(await bellCount(v.page)));
  await v.page.keyboard.press("Escape");
  ok("Escape cierra el panel y el foco vuelve a la campana", await until(async () => (await panel.count()) === 0, 5000) && (await v.page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "nav-bell");

  console.log("\n== 4) El reloj: aviso emergente en vivo, campana y resumen del día ==");
  const forced = new Date(wallToUtc(dayIn(1), "07:01")).toISOString();
  const forcedDaily = new Date(wallToUtc(dayIn(0), "23:59")).toISOString();
  const toasts = v.page.getByTestId("reminder-toast");
  const tDaily = await tick(forcedDaily);
  ok("tick (hoy 23:59): sale el resumen del día (ningún vencido: los de ayer pasan de 24 h)", tDaily.res.ok && tDaily.json?.daily >= 1, short(tDaily));
  ok("campana de Vera: 2 sin leer (chat + resumen)", await until(async () => (await bellCount(v.page)) === 2, 15000), String(await bellCount(v.page)));
  await sleep(1000);
  ok("el resumen NO saca aviso emergente (solo los vencidos)", (await toasts.count()) === 0);
  const t1 = await tick(forced);
  ok("tick (mañana 07:01): los 2 vencidos de Vera, sin resumen (antes de las 08:00)", t1.res.ok && t1.json?.due >= 2 && t1.json?.daily === 0, short(t1));
  ok("en vivo: aparecen 2 avisos emergentes", await until(async () => (await toasts.count()) === 2, 15000), String(await toasts.count()));
  const laToast = toasts.filter({ hasText: N.laura });
  const lt = await laToast.innerText().catch(() => "");
  ok(
    "emergente: «Recordatorio: Laura…» · «Información solicitada · «nota»» · Posponer 1 h · Contactar",
    lt.includes(`Recordatorio: ${N.laura}`) && lt.includes(`Información solicitada · «${NOTE_LAURA}»`) && /Posponer 1 h/.test(lt) && /Contactar/.test(lt),
    lt
  );
  ok("emergente con role=status", (await laToast.getAttribute("role")) === "status");
  ok("campana de Vera: 4 sin leer (chat + resumen + 2 vencidos)", await until(async () => (await bellCount(v.page)) === 4, 15000), String(await bellCount(v.page)));
  await shot(v.page, "aviso-emergente.png");
  lv = await listOf(vera);
  const dueNs = (lv?.notifications ?? []).filter((n) => n.kind === "follow_up_due");
  const daily = (lv?.notifications ?? []).find((n) => n.kind === "daily_summary");
  ok("API: 2 avisos follow_up_due (Laura y Marta)", dueNs.length === 2 && dueNs.some((n) => n.followUpId === fu.laura.id) && dueNs.some((n) => n.followUpId === fu.marta.id), JSON.stringify(dueNs.map((n) => n.followUpId)));
  ok("API: existe la fila del resumen de HOY (1 recordatorio: el de ayer)", daily?.payload?.day === dayIn(0) && daily?.payload?.total === 1, JSON.stringify(daily?.payload));
  ok("API: el texto vivo del resumen cuenta 1 para hoy (1 vencido)", lv?.summary?.today === 1 && lv?.summary?.overdue === 1, JSON.stringify(lv?.summary));
  ok("el de AYER no se avisa (solo vencidos de las últimas 24 h)", !(lv?.notifications ?? []).some((n) => n.followUpId === fu.carlos.id));

  const t2 = await tick(forced);
  const t3 = await tick(forcedDaily);
  ok(
    "repetir los dos ticks: no crea nada",
    t2.res.ok && t2.json?.due === 0 && t2.json?.daily === 0 && t3.json?.daily === 0 && t3.json?.due === 0,
    `${short(t2)} | ${short(t3)}`
  );
  ok("…y la campana sigue en 4", ((await listOf(vera))?.unread ?? -1) === 4);

  console.log("\n== 5) Ni Bruno ni el Propietario lo ven ==");
  await sleep(1500);
  ok("Bruno: sin aviso emergente", (await b.page.getByTestId("reminder-toast").count()) === 0);
  ok("Propietario: sin aviso emergente", (await o.page.getByTestId("reminder-toast").count()) === 0);
  const bl = await listOf(bruno);
  ok("API Bruno: nada de Vera", (bl?.notifications ?? []).every((n) => n.kind !== "follow_up_due" && n.kind !== "daily_summary"), JSON.stringify(bl?.notifications?.map((n) => n.kind)));
  const ol = await listOf(owner);
  ok("API Propietario: nada de Vera", (ol?.notifications ?? []).length === 0, JSON.stringify(ol?.notifications?.map((n) => n.kind)));
  ok(
    "SSE del Propietario: ningún `notification.changed` por el cable",
    !ownerWire.state.text.includes("event: notification.changed") && !ownerWire.state.text.includes("event: follow_ups.changed"),
    ownerWire.state.text.slice(-300)
  );
  ok("…pero el cable del Propietario sí está vivo", ownerWire.state.text.includes(": conectado"));
  ownerWire.stop();

  // Captura del panel con un vencido, el resumen, la asignación y la cita leída.
  await v.page.getByTestId("nav-bell").click();
  await panel.waitFor();
  const texts = (await panel.getByTestId("notification-item").allInnerTexts()).map((t) => t.replace(/^Sin leer\.\s*/, ""));
  ok(
    "panel: «Recordatorio vencido: Laura… · Información solicitada»",
    texts.some((t) => t.includes(`Recordatorio vencido: ${N.laura} · Información solicitada`) && t.includes("Contactar") && t.includes("Posponer ▾"))
  );
  ok(
    "panel: «Hoy tienes 1 recordatorio (1 vencido)» y «Ver en Seguimiento › Pendientes»",
    texts.some((t) => t.startsWith("Hoy tienes 1 recordatorio (1 vencido)")) && (await panel.getByText("Ver en Seguimiento › Pendientes").count()) === 1,
    JSON.stringify(texts)
  );
  ok(
    "panel: «Te asignaron a Patricia…» con «… la pasó a tu nombre · Abrir chat»",
    texts.some((t) => t.includes(`Te asignaron a ${N.patricia}`) && t.includes(`${chatN?.actorName} la pasó a tu nombre`) && t.includes("Abrir chat"))
  );
  ok("panel: la cita ya leída dice «Leído · …»", texts.some((t) => t.includes(`Te asignaron la cita de ${N.sofia}`) && /Leído · /.test(t)));
  ok("panel: pie «Activar avisos del navegador»", /Activar avisos del navegador|Avisos del navegador activados|bloqueaste|no permite/i.test(await panel.locator("footer").innerText()));
  ok("sin `title` (tooltips) en el panel ni en los emergentes", (await v.page.locator('[data-testid="notifications-panel"] [title], [data-testid="reminder-toast"] [title]').count()) === 0);
  await shot(v.page, "campana-panel.png");
  const foot = panel.getByTestId("browser-alerts-state");
  ok("pie: «¿Quieres el aviso aunque estés en otra pestaña?»", (await foot.innerText()).includes("¿Quieres el aviso aunque estés en otra pestaña?"));
  await panel.getByTestId("browser-alerts-on").click();
  ok("Activar avisos del navegador → «Avisos del navegador activados» · Desactivar", await until(async () => (await foot.innerText()).includes("Avisos del navegador activados") && (await panel.getByTestId("browser-alerts-off").count()) === 1, 5000));
  // Con los avisos del navegador activados y la pestaña oculta: «Te asignaron…».
  await v.page.keyboard.press("Escape");
  await v.page.evaluate(() => {
    window.__hidden = true;
  });
  const re2 = await api(`/api/conversations/${conv[N.propio].id}/assign`, { method: "POST", body: body({ userId: ids.vera }) });
  ok(
    "pestaña oculta: aviso del navegador «Te asignaron a …»",
    re2.res.ok &&
      (await until(async () => (await v.page.evaluate(() => window.__notifications.map((n) => n.title))).includes(`Te asignaron a ${N.propio}`), 15000)),
    JSON.stringify(await v.page.evaluate(() => window.__notifications))
  );
  ok(
    "…y los vencidos no se repiten en el navegador (ya estaba visible al llegar)",
    !(await v.page.evaluate(() => window.__notifications.some((n) => n.title.startsWith("Recordatorio:"))))
  );
  await v.page.evaluate(() => {
    window.__hidden = false;
  });
  const extra = ((await listOf(vera))?.notifications ?? []).find((n) => n.kind === "chat_assigned" && n.conversationId === conv[N.propio].id);
  await vera.api("/api/notifications/read", { method: "POST", body: body({ ids: [extra?.id ?? "ntf_x"] }) });
  ok("(se marca leído por API: la campana vuelve a 4)", await until(async () => (await bellCount(v.page)) === 4, 10000), String(await bellCount(v.page)));
  await v.page.getByTestId("nav-bell").click();
  await panel.waitFor();
  await panel.getByTestId("browser-alerts-off").click();
  ok("Desactivar → vuelve a ofrecer activarlos", await until(async () => (await panel.getByTestId("browser-alerts-on").count()) === 1, 5000));
  await v.page.keyboard.press("Escape");

  console.log("\n== 6) Posponer 1 h y Contactar desde el emergente ==");
  const t0 = Date.now();
  await laToast.getByRole("button", { name: "Posponer 1 h" }).click();
  ok("Posponer 1 h: el emergente de Laura se va", await until(async () => (await toasts.filter({ hasText: N.laura }).count()) === 0, 10000));
  const laura = ((await vera.api("/api/follow-ups")).json?.followUps ?? []).find((f) => f.id === fu.laura.id);
  const moved = Date.parse(laura?.dueAt ?? "") - t0;
  ok("…el recordatorio quedó dentro de una hora (desde ahora)", moved > 55 * 60_000 && moved < 65 * 60_000, laura?.dueAt);
  ok("…y su aviso quedó leído (campana 3)", await until(async () => (await bellCount(v.page)) === 3, 10000), String(await bellCount(v.page)));

  const maToast = toasts.filter({ hasText: N.marta });
  await maToast.getByRole("link", { name: "Contactar" }).click();
  ok("Contactar abre el chat de Marta", await until(async () => v.page.url().includes(`contact=${conv[N.marta].contact.id}`), 15000), v.page.url());
  await v.page.getByTestId("inbox-remind").waitFor({ timeout: 60000 }).catch(() => {});
  ok("…con el chat a la vista", (await v.page.locator("main").innerText()).includes(N.marta));
  ok("…el emergente se fue y el aviso quedó leído (campana 2)", (await toasts.count()) === 0 && (await until(async () => (await bellCount(v.page)) === 2, 10000)), String(await bellCount(v.page)));

  console.log("\n== 7) El Propietario cierra uno de Vera: su número rojo se apaga en vivo ==");
  await v.page.goto(`${BASE}/inbox`, { waitUntil: "load" });
  await v.page.getByTestId("nav-bell").waitFor({ timeout: 60000 });
  await until(async () => (await v.page.getByTestId("nav-overdue").count()) === 1, 15000);
  await sleep(1500); // el SSE de la página recién cargada ya conectó
  const done = await api(`/api/follow-ups/${fu.carlos.id}`, { method: "PATCH", body: body({ action: "done", note: "Lo atendió el Propietario" }) });
  ok("el Propietario marca hecho el de Carlos (de Vera)", done.res.ok, short(done));
  ok("en vivo (sin recargar): el número rojo de Vera desaparece", await until(async () => (await v.page.getByTestId("nav-overdue").count()) === 0, 15000));
  // (El de Laura quedó a «dentro de 1 h»: puede ser hoy o mañana según la hora.)
  ok(
    "…y la línea de la Bandeja ya no cuenta vencidos",
    await until(async () => {
      const l = v.page.getByTestId("summary-reminders");
      return (await l.count()) === 0 || !/vencido/.test(await l.innerText());
    }, 15000)
  );

  console.log("\n== 8) Marcar todo como leído · 390 px ==");
  await v.page.getByTestId("nav-bell").click();
  await panel.waitFor();
  await panel.getByTestId("notifications-read-all").click();
  ok("Marcar todo como leído → sin contador", await until(async () => (await bellCount(v.page)) === 0, 10000), String(await bellCount(v.page)));
  ok("API: 0 sin leer", ((await listOf(vera))?.unread ?? -1) === 0);
  ok("el aviso de Laura (pospuesto) dice «Lo pospusiste para …»", (await panel.getByTestId("notification-item").allInnerTexts()).some((t) => t.includes(N.laura) && /Lo pospusiste para /.test(t)));
  await v.page.mouse.click(900, 600);
  ok("clic fuera cierra el panel", await until(async () => (await panel.count()) === 0, 5000));
  await v.ctx.close();
  await o.ctx.close();
  await b.ctx.close();

  const m = await pageAs(vera, { width: 390, height: 844 });
  await m.page.goto(`${BASE}/inbox`, { waitUntil: "load" });
  await m.page.getByTestId("header-bell").waitFor({ timeout: 60000 });
  await m.page.getByTestId("header-bell").click();
  const mp = m.page.getByTestId("notifications-panel");
  await mp.waitFor();
  await until(async () => (await mp.getByTestId("notification-item").count()) > 0, 15000);
  const w = await m.page.evaluate(() => {
    const r = document.querySelector('[data-testid="notifications-panel"]').getBoundingClientRect();
    return { doc: document.documentElement.scrollWidth, vw: window.innerWidth, left: r.left, right: r.right };
  });
  ok("390 px: la campana en el encabezado y el panel cabe", w.doc <= w.vw && w.left >= 0 && w.right <= w.vw, JSON.stringify(w));
  await shot(m.page, "campana-390.png");
  await m.ctx.close();

  // Lateral contraído: la campana queda debajo de la inicial.
  const c = await pageAs(vera);
  await c.ctx.addCookies([{ name: "vocero-nav-collapsed", value: "1", domain: new URL(BASE).hostname, path: "/" }]);
  await c.page.goto(`${BASE}/inbox`, { waitUntil: "load" });
  await c.page.getByTestId("nav-bell").waitFor({ timeout: 60000 });
  const geo = await c.page.evaluate(() => {
    const bell = document.querySelector('[data-testid="nav-bell"]').getBoundingClientRect();
    const aside = document.querySelector("aside").getBoundingClientRect();
    return { bellTop: bell.top, bellLeft: bell.left, bellRight: bell.right, asideRight: aside.right };
  });
  ok("lateral contraído: la campana debajo de la inicial y dentro de la columna", geo.bellTop > 40 && geo.bellRight <= geo.asideRight, JSON.stringify(geo));
  await shot(c.page, "campana-contraido.png");
  await c.ctx.close();

  console.log("\n== 9) El reloj falla → la app sigue ==");
  const bad = await tick("no-es-fecha");
  ok("tick con fecha ilegible → 422", bad.res.status === 422, short(bad));
  const health = await fetch(`${BASE}/api/health`);
  ok("…y la app sigue sana", health.ok);
  const anon = await fetch(`${BASE}/api/notifications`);
  ok("GET /api/notifications sin sesión → 401", anon.status === 401, String(anon.status));
  const ajeno = await bruno.api("/api/notifications/read", { method: "POST", body: body({ ids: [chatN?.id ?? "ntf_x"] }) });
  ok("Bruno no puede marcar leído uno de Vera (0 cambiados)", ajeno.res.ok && ajeno.json?.updated === 0, short(ajeno));
  const malo = await vera.api("/api/notifications/read", { method: "POST", body: body({ ids: [] }) });
  ok("marcar leído sin ids → 422", malo.res.status === 422, short(malo));
}

/* ───────────────────────── main ───────────────────────── */

async function main() {
  try {
    await setup();
    browser = await chromium.launch();
    await recorrido();
  } catch (err) {
    ok("el guion terminó sin excepción", false, String(err?.stack ?? err));
  } finally {
    await browser?.close().catch(() => {});
  }
  console.log(`\n=====${checks - failures}/${checks} checks OK, ${failures} fallos =====`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
