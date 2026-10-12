/**
 * Self-test E2E — Alertas en la Bandeja (dev-tasks/05-alertas-en-la-bandeja.md).
 * Guion humano: tests/e2e/us-alertas.md
 *
 * Conduce la app real con Playwright. `window.Notification` se reemplaza por
 * un registrador (`addInitScript`): headless no muestra notificaciones
 * reales. El permiso del stub y lo registrado sobreviven a la navegación
 * (localStorage / sessionStorage de la pestaña).
 *
 *   a) owner + WhatsApp (wa-mock) + alta de un vendedor (POST /api/settings/team)
 *   b) aviso de la Bandeja «Activar avisos» (permiso `default`) → concedido
 *   c) dos pestañas (/pipeline y /contacts): entrante en una conversación NO
 *      abierta → exactamente UNA notificación entre ambas, tag `conv:<id>`,
 *      título con el nombre del contacto; título de ambas con «(N) »
 *      (N = counts.unreadConversations)
 *   d) conversación abierta y visible en la Bandeja → su entrante NO notifica
 *   e) handoff vía /api/bot/handoff (motivo cliente) → «Necesita atención humana»
 *   f) eco del teléfono (manual_reply) → NO notifica (el evento sí ocurre)
 *   g) vendedor (contexto aparte): entrante en una conversación asignada al
 *      owner → 0; en una sin asignar → 1
 *   h) «Ventana por cerrar»: último entrante hace 23 h (SQL directo) entra,
 *      hace 10 h no; counts.closing coherente; pastilla + «Cierra en …» en la
 *      UI; a 360 px la fila de pastillas no se desborda
 *   i) camino infeliz: permiso `denied` → texto de bloqueo en «Mi cuenta» y el
 *      título igual cuenta; `Notification` inexistente → sin errores de página
 *
 * Presupuesto del limitador de login: 2 POST (owner sign-up/in, vendedor).
 *
 * Uso:
 *   1) BD de E2E migrada y app corriendo con WA_MOCK_ENABLED=true,
 *      META_GRAPH_BASE_URL → wa-mock, OPENROUTER_BASE_URL → ai-mock y
 *      BOT_API_KEY (p. ej. .env.e2e, Postgres aislado :5433)
 *   2) node --env-file=.env.e2e scripts/e2e-alertas.mjs
 *
 * Requiere DATABASE_URL (traslado de last_inbound_at). Sale con 1 si algo falla.
 */

import { chromium } from "playwright";
import postgres from "postgres";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const BOT_KEY = process.env.BOT_API_KEY;
const S = Math.random().toString(36).slice(2, 8);
const PN = "PN-E2E-ALERTAS";
const H = 60 * 60 * 1000;

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

function client() {
  const jar = { cookie: "" };
  async function api(path, opts = {}) {
    const res = await fetch(`${BASE}${path}`, {
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
  return { api, jar };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* reintenta */
    }
    if (Date.now() - t0 > ms) return null;
    await sleep(250);
  }
};
const body = (o) => JSON.stringify(o);
const short = (r) => `${r.res.status} ${JSON.stringify(r.json)?.slice(0, 200)}`;

const owner = client();
const seller = client();
const OWNER_EMAIL = "e2e@vocero.test";
const OWNER_PASSWORD = "password-e2e-123";
const SELLER_EMAIL = `vend.alertas.${S}@vocero.test`;
const SELLER_PASSWORD = "password-vend-alertas-123";

const db = process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: "vocero, extensions" },
    })
  : null;

const phone = () => `52477${Math.floor(Math.random() * 9e6 + 1e6)}`;

function inbound(from, name, text = "hola, quiero informes") {
  return owner.api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({
      phoneNumberId: PN,
      from,
      name,
      text,
      waMessageId: `wamid.e2e.alertas.${S}.${Math.random().toString(36).slice(2, 10)}`,
    }),
  });
}

async function convByName(name) {
  return until(async () => {
    const convs = (await owner.api("/api/conversations")).json?.conversations ?? [];
    return convs.find((c) => c.contact?.name === name) ?? null;
  });
}

async function unreadConversations() {
  return (await owner.api("/api/conversations/counts")).json?.unreadConversations ?? null;
}

/**
 * Stub de `Notification`: `permission` vive en localStorage (sobrevive a la
 * navegación) y `requestPermission` lo cambia a `grantTo`; cada aviso se
 * anota en sessionStorage (`__e2eNotes`, por pestaña). `mode: "none"` borra
 * la API (navegador sin soporte).
 */
function notificationStub(cfg) {
  if (cfg.mode === "none") {
    try {
      delete window.Notification;
    } catch {}
    try {
      Object.defineProperty(window, "Notification", { value: undefined, configurable: true, writable: true });
    } catch {}
    return;
  }
  const PERM = "__e2ePerm";
  const NOTES = "__e2eNotes";
  const readPerm = () => localStorage.getItem(PERM) ?? cfg.permission;
  const record = (n) => {
    const all = JSON.parse(sessionStorage.getItem(NOTES) ?? "[]");
    all.push(n);
    sessionStorage.setItem(NOTES, JSON.stringify(all));
  };
  class FakeNotification {
    constructor(title, opts = {}) {
      this.title = title;
      this.body = opts.body;
      this.tag = opts.tag;
      this.data = opts.data;
      this.onclick = null;
      record({ title, body: opts.body ?? null, tag: opts.tag ?? null, url: opts.data?.url ?? null });
    }
    close() {}
    static get permission() {
      return readPerm();
    }
    static async requestPermission() {
      if (cfg.grantTo) localStorage.setItem(PERM, cfg.grantTo);
      return readPerm();
    }
  }
  window.Notification = FakeNotification;
}

async function notes(page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem("__e2eNotes") ?? "[]"));
}
async function totalNotes(pages) {
  let all = [];
  for (const p of pages) all = all.concat(await notes(p));
  return all;
}

function toCookies(jar) {
  return jar.cookie
    .split("; ")
    .filter(Boolean)
    .map((kv) => {
      const i = kv.indexOf("=");
      return { name: kv.slice(0, i), value: kv.slice(i + 1), url: BASE };
    });
}

/** Activa las alertas desde el aviso de la Bandeja (permiso `default`). */
async function activateFromBanner(page, who) {
  await page.goto(`${BASE}/inbox`, { waitUntil: "load" });
  const btn = page.getByRole("button", { name: "Activar avisos" });
  await btn.waitFor({ timeout: 20000 }).catch(() => {});
  ok(`${who}: aviso «Activar avisos» visible con permiso default`, (await btn.count()) > 0);
  await btn.click().catch(() => {});
  const gone = await until(async () => (await page.getByRole("button", { name: "Activar avisos" }).count()) === 0, 10000);
  ok(`${who}: tras conceder, el aviso desaparece`, !!gone);
  const prefsOn = await page.evaluate(() =>
    Object.keys(localStorage).some(
      (k) => k.startsWith("vocero.alerts.v1.") && JSON.parse(localStorage.getItem(k) ?? "{}").notifications === true
    )
  );
  ok(`${who}: preferencia de notificaciones encendida`, prefsOn);
}

async function main() {
  if (!BOT_KEY || BOT_KEY.length < 16) {
    console.error("BOT_API_KEY ausente o corta: /api/bot/handoff no puede correr.");
    process.exit(1);
  }
  if (!db) {
    console.error("DATABASE_URL ausente: el guion necesita la BD de E2E.");
    process.exit(1);
  }

  console.log("== a) Owner, WhatsApp y vendedor ==");
  let su = await owner.api("/api/auth/sign-up/email", {
    method: "POST",
    body: body({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: "Operador E2E" }),
  });
  if (!su.res.ok) {
    su = await owner.api("/api/auth/sign-in/email", {
      method: "POST",
      body: body({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
    });
  }
  ok("owner con sesión", su.res.ok, short(su));
  const conn = await owner.api("/api/settings/whatsapp", {
    method: "PUT",
    body: body({ wabaId: "WABA-E2E-ALERTAS", phoneNumberId: PN, token: "tok-e2e-alertas" }),
  });
  ok("owner conecta WhatsApp (wa-mock)", conn.res.ok, short(conn));
  const add = await owner.api("/api/settings/team", {
    method: "POST",
    body: body({ name: `Vendedor Alertas ${S}`, email: SELLER_EMAIL, password: SELLER_PASSWORD }),
  });
  ok("alta del vendedor → 201", add.res.status === 201, short(add));
  const team = (await owner.api("/api/settings/team")).json?.members ?? [];
  const ownerUserId = team.find((m) => m.email === OWNER_EMAIL)?.userId;
  ok("userId del owner", !!ownerUserId);
  const sIn = await seller.api("/api/auth/sign-in/email", {
    method: "POST",
    body: body({ email: SELLER_EMAIL, password: SELLER_PASSWORD }),
  });
  ok("el vendedor inicia sesión", sIn.res.ok, short(sIn));

  const browser = await chromium.launch();
  try {
    console.log("\n== b) Aviso de la Bandeja → permiso concedido ==");
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies(toCookies(owner.jar));
    await ctx.addInitScript(notificationStub, { permission: "default", grantTo: "granted" });
    const p1 = await ctx.newPage();
    const pageErrors = [];
    p1.on("pageerror", (e) => pageErrors.push(String(e)));
    await activateFromBanner(p1, "owner");

    console.log("\n== c) Dos pestañas, un entrante → una sola notificación ==");
    await p1.goto(`${BASE}/pipeline`, { waitUntil: "load" });
    const p2 = await ctx.newPage();
    p2.on("pageerror", (e) => pageErrors.push(String(e)));
    await p2.goto(`${BASE}/contacts`, { waitUntil: "load" });
    await sleep(2500); // líder (Web Locks) + SSE conectado en ambas
    const pages = [p1, p2];
    const base0 = (await totalNotes(pages)).length;

    const ana = { phone: phone(), name: `Ana Alertas ${S}` };
    ok("inbound de Ana entregado", (await inbound(ana.phone, ana.name)).res.ok);
    const anaConv = await convByName(ana.name);
    ok("conversación de Ana creada", !!anaConv);
    await until(async () => (await totalNotes(pages)).length > base0, 15000);
    await sleep(2500); // por si una segunda pestaña avisara tarde
    let all = await totalNotes(pages);
    const fresh = all.slice(base0);
    ok("exactamente UNA notificación entre las dos pestañas", fresh.length === 1, JSON.stringify(fresh));
    ok(`tag conv:<id> (${anaConv?.id})`, fresh[0]?.tag === `conv:${anaConv?.id}`, JSON.stringify(fresh[0]));
    ok("título = nombre del contacto", fresh[0]?.title === ana.name, JSON.stringify(fresh[0]));
    ok("clic lleva a /inbox?contact=<contactId>", fresh[0]?.url === `/inbox?contact=${anaConv?.contact?.id}`, JSON.stringify(fresh[0]));

    const n1 = await unreadConversations();
    for (const [i, p] of pages.entries()) {
      const t = await until(async () => {
        const title = await p.title();
        return title.startsWith(`(${n1}) `) ? title : null;
      }, 10000);
      ok(`pestaña ${i + 1}: título con «(${n1}) » (= counts.unreadConversations)`, !!t, await p.title());
    }
    // El punto se dibuja tras cargar el icono de la marca (en dev, la ruta
    // del favicon compila en frío): esperar.
    const readIcon = () =>
      p1.evaluate(() => document.querySelector('link[rel~="icon"]')?.getAttribute("href") ?? "");
    await until(async () => (await readIcon()).startsWith("data:image/png"), 15000);
    const icon = await readIcon();
    ok("favicon con punto (data:image/png)", icon.startsWith("data:image/png"), icon.slice(0, 40));

    console.log("\n== d) Conversación abierta y visible → no notifica ==");
    await p1.goto(`${BASE}/inbox?contact=${encodeURIComponent(anaConv.contact.id)}`, { waitUntil: "load" });
    await p1.getByRole("button", { name: "Volver a las conversaciones" }).waitFor({ state: "attached", timeout: 20000 }).catch(() => {});
    await sleep(1200); // presencia por BroadcastChannel
    all = await totalNotes(pages);
    const base1 = all.length;
    ok("inbound 2 de Ana (con su hilo abierto)", (await inbound(ana.phone, ana.name, "otra pregunta")).res.ok);
    await until(async () => {
      const msgs = (await owner.api(`/api/conversations/${anaConv.id}/messages`)).json?.messages ?? [];
      return msgs.some((m) => m.text === "otra pregunta");
    }, 15000);
    await sleep(3000);
    all = await totalNotes(pages);
    ok("0 notificaciones nuevas con la conversación a la vista", all.length === base1, JSON.stringify(all.slice(base1)));
    await p1.goto(`${BASE}/pipeline`, { waitUntil: "load" });
    await sleep(1200);

    console.log("\n== e) Handoff por el cerebro externo → «Necesita atención humana» ==");
    const beto = { phone: phone(), name: `Beto Alertas ${S}` };
    ok("inbound de Beto", (await inbound(beto.phone, beto.name)).res.ok);
    const betoConv = await convByName(beto.name);
    await until(async () => (await totalNotes(pages)).some((n) => n.title === beto.name), 15000);
    const betoNow = (await owner.api(`/api/conversations?ids=${betoConv.id}`)).json?.conversations?.[0];
    ok("Beto sin handoff previo", betoNow?.handoffAt === null, JSON.stringify(betoNow?.handoffAt));
    const base2 = (await totalNotes(pages)).length;
    const ho = await owner.api("/api/bot/handoff", {
      method: "POST",
      headers: { "x-api-key": BOT_KEY },
      body: body({ conversationId: betoConv.id, reason: "cliente", note: `Pide hablar con alguien ${S}` }),
    });
    ok("POST /api/bot/handoff → 200", ho.res.ok, short(ho));
    await until(async () => (await totalNotes(pages)).length > base2, 15000);
    await sleep(2000);
    all = await totalNotes(pages);
    const hoNotes = all.slice(base2);
    ok("una notificación de escalamiento", hoNotes.length === 1, JSON.stringify(hoNotes));
    ok("título «Necesita atención humana»", hoNotes[0]?.title === "Necesita atención humana", JSON.stringify(hoNotes[0]));
    ok("el cuerpo trae el motivo en español", /humano/i.test(hoNotes[0]?.body ?? ""), JSON.stringify(hoNotes[0]));

    console.log("\n== f) Eco del teléfono (manual_reply) → no notifica ==");
    const caro = { phone: phone(), name: `Caro Alertas ${S}` };
    ok("inbound de Caro", (await inbound(caro.phone, caro.name)).res.ok);
    const caroConv = await convByName(caro.name);
    await until(async () => (await totalNotes(pages)).some((n) => n.title === caro.name), 15000);
    await sleep(1500);
    const base3 = (await totalNotes(pages)).length;
    const echo = await owner.api("/api/dev/wa-mock/echo", {
      method: "POST",
      body: body({ phoneNumberId: PN, to: caro.phone, text: `te contesto yo ${S}` }),
    });
    ok("eco del teléfono entregado", echo.res.ok, short(echo));
    const paused = await until(async () => {
      const c = (await owner.api(`/api/conversations?ids=${caroConv.id}`)).json?.conversations?.[0];
      return c?.handoffReason === "manual_reply" ? c : null;
    }, 15000);
    ok("la conversación quedó en pausa por manual_reply", !!paused);
    await sleep(3000);
    all = await totalNotes(pages);
    ok("0 notificaciones por el eco", all.length === base3, JSON.stringify(all.slice(base3)));

    const n2 = await unreadConversations();
    const t2 = await until(async () => ((await p2.title()).startsWith(`(${n2}) `) ? true : null), 10000);
    ok(`título sigue a counts: «(${n2}) »`, !!t2, await p2.title());

    console.log("\n== g) Vendedor: solo lo suyo y lo sin asignar ==");
    const sctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await sctx.addCookies(toCookies(seller.jar));
    await sctx.addInitScript(notificationStub, { permission: "default", grantTo: "granted" });
    const sp = await sctx.newPage();
    sp.on("pageerror", (e) => pageErrors.push(String(e)));
    await activateFromBanner(sp, "vendedor");
    await sp.goto(`${BASE}/pipeline`, { waitUntil: "load" });
    await sleep(2000);
    const asg = await owner.api(`/api/conversations/${anaConv.id}/assign`, {
      method: "POST",
      body: body({ userId: ownerUserId }),
    });
    ok("owner se asigna la conversación de Ana", asg.res.ok, short(asg));
    await sleep(1000);
    const sBase = (await notes(sp)).length;
    ok("inbound 3 de Ana (asignada al owner)", (await inbound(ana.phone, ana.name, "sigo aquí")).res.ok);
    await sleep(4000);
    ok("vendedor: 0 notificaciones de la conversación ajena", (await notes(sp)).length === sBase, JSON.stringify((await notes(sp)).slice(sBase)));
    const dani = { phone: phone(), name: `Dani Alertas ${S}` };
    ok("inbound de Dani (sin asignar)", (await inbound(dani.phone, dani.name)).res.ok);
    const daniConv = await convByName(dani.name);
    await until(async () => (await notes(sp)).length > sBase, 15000);
    await sleep(1500);
    const sNew = (await notes(sp)).slice(sBase);
    ok("vendedor: 1 notificación de la sin asignar", sNew.length === 1 && sNew[0]?.tag === `conv:${daniConv?.id}`, JSON.stringify(sNew));
    await sctx.close();

    console.log("\n== h) «Ventana por cerrar» ==");
    await db`update conversation set last_inbound_at = ${new Date(Date.now() - 23 * H)} where id = ${caroConv.id}`;
    await db`update conversation set last_inbound_at = ${new Date(Date.now() - 10 * H)} where id = ${betoConv.id}`;
    const counts = (await owner.api("/api/conversations/counts")).json;
    const closingList = (await owner.api("/api/conversations?limit=50&filter=closing")).json?.conversations ?? [];
    ok("filter=closing incluye la de hace 23 h", closingList.some((c) => c.id === caroConv.id), JSON.stringify(closingList.map((c) => c.id)));
    ok("filter=closing excluye la de hace 10 h", !closingList.some((c) => c.id === betoConv.id));
    ok("counts.closing coherente con la lista", counts?.closing === closingList.length, `${counts?.closing} vs ${closingList.length}`);
    const pill = p1.getByRole("button", { name: /Ventana por cerrar/ });
    await p1.goto(`${BASE}/inbox`, { waitUntil: "load" });
    await pill.first().waitFor({ timeout: 20000 }).catch(() => {});
    ok("pastilla «Ventana por cerrar» visible", (await pill.count()) > 0);
    // `/counts` llega después de pintar la pastilla (arranca en 0): esperar.
    const pillRe = new RegExp(`Ventana por cerrar\\s*${counts?.closing}$`);
    await until(async () => pillRe.test((await pill.first().innerText()).trim()), 10000);
    const pillTxt = (await pill.first().innerText().catch(() => "")).replace(/\s+/g, " ");
    ok(`la pastilla cuenta ${counts?.closing}`, pillTxt.includes(String(counts?.closing)), pillTxt);
    await pill.first().click().catch(() => {});
    const row = p1.locator(`[data-conversation-id="${caroConv.id}"]`);
    await row.waitFor({ timeout: 15000 }).catch(() => {});
    ok("la de hace 23 h aparece con la pastilla activa", (await row.count()) > 0);
    const chip = (await row.locator('[data-testid="closing-chip"]').first().innerText().catch(() => "")).trim();
    ok("renglón con «Cierra en …» (~59m)", /^Cierra en (59m|1h 0m|58m)$/.test(chip), chip);
    ok("la de hace 10 h no aparece", (await p1.locator(`[data-conversation-id="${betoConv.id}"]`).count()) === 0);

    const mctx = await browser.newContext({ viewport: { width: 360, height: 760 } });
    await mctx.addCookies(toCookies(owner.jar));
    const mp = await mctx.newPage();
    await mp.goto(`${BASE}/inbox`, { waitUntil: "load" });
    await mp.getByRole("button", { name: /Ventana por cerrar/ }).first().waitFor({ timeout: 20000 }).catch(() => {});
    const overflow = await mp.evaluate(() => ({
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      pills: [...document.querySelectorAll("button[aria-pressed]")]
        .map((b) => b.getBoundingClientRect().right)
        .some((r) => r > window.innerWidth + 1),
    }));
    ok("360 px: sin scroll horizontal y pastillas dentro de la pantalla", overflow.page <= 0 && !overflow.pills, JSON.stringify(overflow));
    await mctx.close();
    await ctx.close();

    console.log("\n== i) Camino infeliz ==");
    const dctx = await browser.newContext();
    await dctx.addCookies(toCookies(owner.jar));
    await dctx.addInitScript(notificationStub, { permission: "denied" });
    const dp = await dctx.newPage();
    dp.on("pageerror", (e) => pageErrors.push(String(e)));
    await dp.goto(`${BASE}/settings/account`, { waitUntil: "load" });
    const blocked = await until(async () => (await dp.getByText(/Bloqueaste las notificaciones/).count()) > 0, 15000);
    ok("permiso denied → «Bloqueaste las notificaciones…» con instrucciones", !!blocked);
    const n3 = await unreadConversations();
    const t3 = await until(async () => ((await dp.title()).startsWith(`(${n3}) `) ? true : null), 10000);
    ok("con permiso denied el título igual cuenta", !!t3 || n3 === 0, await dp.title());
    await dp.goto(`${BASE}/inbox`, { waitUntil: "load" });
    await sleep(1500);
    ok("permiso denied → sin aviso «Activar avisos» en la Bandeja", (await dp.getByRole("button", { name: "Activar avisos" }).count()) === 0);
    await dctx.close();

    const nctx = await browser.newContext();
    await nctx.addCookies(toCookies(owner.jar));
    await nctx.addInitScript(notificationStub, { mode: "none" });
    const np = await nctx.newPage();
    const noneErrors = [];
    np.on("pageerror", (e) => noneErrors.push(String(e)));
    await np.goto(`${BASE}/inbox`, { waitUntil: "load" });
    await sleep(1500);
    await np.goto(`${BASE}/settings/account`, { waitUntil: "load" });
    await np.getByText(/no permite notificaciones/).first().waitFor({ timeout: 15000 }).catch(() => {});
    ok("sin Notification → el panel explica el motivo", (await np.getByText(/no permite notificaciones/).count()) > 0);
    ok("sin Notification → 0 errores de página", noneErrors.length === 0, noneErrors.join(" | "));
    await nctx.close();

    ok("0 errores de página en todo el recorrido", pageErrors.length === 0, pageErrors.join(" | "));
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (err) {
  failures++;
  console.error("  FAIL excepción no controlada:", err);
} finally {
  await db?.end();
}
console.log(`\n${checks} checks — ${failures === 0 ? "TODO VERDE" : `${failures} FALLO(S)`}`);
process.exit(failures ? 1 : 0);
