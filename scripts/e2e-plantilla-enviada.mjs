/**
 * Self-test E2E — 033 «Plantilla enviada» y candado contra duplicados.
 * Guion humano: tests/e2e/us-plantilla-enviada.md
 *
 * Contra la app VIVA (mocks), como Propietario:
 *
 *   a) API: la misma plantilla (mismo texto) a la misma conversación en
 *      < 10 min → 409 `template_recently_sent` «Ya le enviaste este mensaje a
 *      {nombre} hace menos de 1 min.»; con `force: true` sale; otro texto
 *      sale; un envío previo `failed` no cuenta
 *   b) Bandeja, ventana cerrada: enviar → tarjeta «Plantilla enviada a Rosa ·
 *      HH:MM» con «Enviando…», el nombre de la plantilla y la nota; los pasos
 *      ya no están. Estados por wa-mock (sent/delivered/read) → recargar →
 *      «Enviada» / «Entregada» / «Leída» (la tarjeta sigue al recargar)
 *   c) «Enviar otra plantilla» → «Enviar otra plantilla a Rosa» + pasos →
 *      la misma → aviso de duplicado en «Revisa y envía» (sin el botón de
 *      envío, wa-mock sin nuevo envío) → «Cancelar» regresa el botón →
 *      otra vez → «Enviar de todos modos» → tarjeta y 2 burbujas
 *   d) último envío `failed` → los pasos con «La plantilla de las HH:MM no le
 *      llegó a …» y el motivo; sin tarjeta
 *   e) Contactos «Escribir primero» con la lista vieja (la plantilla ya salió
 *      por otra pestaña): aviso de duplicado dentro del diálogo → «Enviar de
 *      todos modos» → abre el chat con la tarjeta y 2 burbujas
 *   f) sin `title` ni ícono ⓘ en la tarjeta ni en el aviso; 390 px sin desborde
 *
 * Presupuesto del limitador de login: 1 (owner por API).
 *
 * Uso (BD aislada, app con .env.e2e):
 *   CATALOG_STORAGE=local node --env-file=.env.e2e scripts/e2e-plantilla-enviada.mjs
 *
 * Con `REVISAR_DIR=<dir>` deja ahí capturas de la tarjeta, el aviso de
 * duplicado y el aviso de envío fallido. Sale con código 1 si algún check falla.
 */
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const S = Math.random().toString(36).slice(2, 7);
const PN = "PN-E2E-033";
const WABA = "WABA-E2E-033";
const REVISAR = process.env.REVISAR_DIR ?? null;

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
const short = (r) => `${r.res.status} ${JSON.stringify(r.json)?.slice(0, 240)}`;
const shot = async (target, file) => {
  if (REVISAR) await target.screenshot({ path: `${REVISAR}/${file}`, animations: "disabled", caret: "hide" }).catch(() => {});
};

const OWNER = { email: "e2e@vocero.test", password: "password-e2e-123", name: "Operador E2E" };

let seq = 0;
const phoneOf = new Map();
function phone(name) {
  if (!phoneOf.has(name)) phoneOf.set(name, `52155${String(Date.now()).slice(-5)}${String(seq++).padStart(2, "0")}`);
  return phoneOf.get(name);
}
async function convOf(name) {
  const list = (await api("/api/conversations")).json?.conversations ?? [];
  return list.find((c) => c.contact?.name === name) ?? null;
}
async function inbound(name, text, { hoursAgo = 0 } = {}) {
  const r = await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({
      phoneNumberId: PN,
      from: phone(name),
      name,
      text,
      waMessageId: `wamid.e2e.033.${S}.${seq++}`,
      ...(hoursAgo ? { timestamp: Math.floor(Date.now() / 1000) - hoursAgo * 3600 } : {}),
    }),
  });
  if (!r.res.ok) ok(`inbound de ${name}`, false, short(r));
  await until(async () => !!(await convOf(name)));
  const c = await convOf(name);
  await api(`/api/conversations/${c?.id}`, { method: "PATCH", body: body({ aiEnabled: false }) });
  return c;
}
const outbox = async () => (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
const templatesTo = async (tel) =>
  (await outbox()).filter((o) => o.body?.type === "template" && String(o.body?.to ?? "").endsWith(tel.slice(-10)));
const messagesOf = async (convId) => (await api(`/api/conversations/${convId}/messages`)).json?.messages ?? [];
const status = (waMessageId, s, extra = {}) =>
  api("/api/dev/wa-mock/status", { method: "POST", body: body({ waMessageId, status: s, ...extra }) });

const TPL = `retomar_cotizacion_${S}`;
const TPL2 = `promo_${S}`;
const TPL_BODY = "Hola {{1}}, ¿retomamos tu cotización?";
const N = {
  rosa: `Rosa Cerrada ${S}`,
  api: `Paco Api ${S}`,
  falla: `Tere Falla ${S}`,
  ceci: `Ceci Nunca ${S}`,
};
const first = (n) => n.split(" ")[0];
const rendered = (n) => `Hola ${first(n)}, ¿retomamos tu cotización?`;

/* ───────────────────────── setup ───────────────────────── */

async function setup() {
  console.log("== Setup ==");
  let su = await api("/api/auth/sign-up/email", { method: "POST", body: body(OWNER) });
  if (!su.res.ok) su = await api("/api/auth/sign-in/email", { method: "POST", body: body({ email: OWNER.email, password: OWNER.password }) });
  ok("owner con sesión", su.res.ok, short(su));
  const conn = await api("/api/settings/whatsapp", { method: "PUT", body: body({ wabaId: WABA, phoneNumberId: PN, token: "tok-e2e-033" }) });
  ok("WhatsApp (wa-mock)", conn.res.ok, short(conn));
  await api("/api/agent/profile", { method: "PUT", body: body({ name: "Lumi", tone: "breve", instructions: "Tienda.", enabled: false }) });
  for (const t of [
    { name: TPL, body: TPL_BODY },
    { name: TPL2, body: "Hola {{1}}, esta semana hay {{2}} en salas." },
  ]) {
    await api("/api/templates", { method: "POST", body: body({ ...t, language: "es_MX", category: "UTILITY" }) });
    await api("/api/dev/wa-mock/template-status", { method: "POST", body: body({ wabaId: WABA, name: t.name, language: "es_MX", event: "APPROVED", notify: false }) });
  }
  await api("/api/templates/sync", { method: "POST" });
  const all = (await api("/api/templates")).json?.templates ?? [];
  const tpl = all.find((t) => t.name === TPL);
  ok("plantillas aprobadas", tpl?.status === "approved" && all.find((t) => t.name === TPL2)?.status === "approved", JSON.stringify(all.map((t) => [t.name, t.status])));
  return tpl;
}

/* ───────────────────────── a) API ───────────────────────── */

async function apiChecks(tpl) {
  console.log("\n== a) API: candado de 10 min ==");
  const c = await inbound(N.api, "¿Me mandas la cotización?", { hoursAgo: 30 });
  ok("conversación con la ventana cerrada", c?.windowOpen === false, JSON.stringify({ windowOpen: c?.windowOpen }));
  const send = (extra = {}) =>
    api(`/api/conversations/${c?.id}/messages/template`, { method: "POST", body: body({ templateId: tpl?.id, variables: ["Paco"], ...extra }) });
  const r1 = await send();
  ok("primer envío → 200", r1.res.ok, short(r1));
  const r2 = await send();
  ok("la misma otra vez → 409 template_recently_sent", r2.res.status === 409 && r2.json?.error?.code === "template_recently_sent", short(r2));
  ok("…«Ya le enviaste este mensaje a Paco hace menos de 1 min.»", r2.json?.error?.message === "Ya le enviaste este mensaje a Paco hace menos de 1 min.", r2.json?.error?.message);
  ok("…y no salió nada a Meta (wa-mock: 1 plantilla)", (await templatesTo(phone(N.api))).length === 1);
  const r3 = await send({ force: true });
  ok("con force: true → 200", r3.res.ok, short(r3));
  const r4 = await api(`/api/conversations/${c?.id}/messages/template`, { method: "POST", body: body({ templateId: tpl?.id, variables: ["Francisco"] }) });
  ok("otro texto (otro valor) → 200: el candado es por texto", r4.res.ok, short(r4));
  ok("wa-mock: 3 plantillas a Paco", (await templatesTo(phone(N.api))).length === 3);

  // Un envío previo `failed` no cuenta para el candado.
  const f = await inbound(N.falla, "Hola, ¿siguen abiertos?", { hoursAgo: 30 });
  const sendF = () => api(`/api/conversations/${f?.id}/messages/template`, { method: "POST", body: body({ templateId: tpl?.id, variables: ["Tere"] }) });
  const f1 = await sendF();
  ok("Tere: primer envío → 200", f1.res.ok, short(f1));
  const wamid = (await templatesTo(phone(N.falla))).at(-1)?.waMessageId;
  const st = await status(wamid, "failed", { errorCode: 131026, errorMessage: "Message undeliverable" });
  ok("wa-mock marca la de Tere como failed", st.res.ok, short(st));
  ok("…el hilo la ve failed", await until(async () => (await messagesOf(f?.id)).at(-1)?.status === "failed", 10000));
  const f2 = await sendF();
  ok("la misma tras un failed → 200 (el fallido no cuenta)", f2.res.ok, short(f2));
  const wamid2 = (await templatesTo(phone(N.falla))).at(-1)?.waMessageId;
  await status(wamid2, "failed", { errorCode: 131026, errorMessage: "Message undeliverable" });
  await until(async () => (await messagesOf(f?.id)).at(-1)?.status === "failed", 10000);
  return { tere: f };
}

/* ───────────────────────── navegador ───────────────────────── */

let browser;
function toBrowserCookies() {
  const host = new URL(BASE).hostname;
  return jar.cookie
    .split(/;\s*/)
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf("=");
      return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: host, path: "/" };
    });
}
async function newPage({ viewport = { width: 1366, height: 768 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  // Sin SSE: lo que se ve sale del servidor al cargar (y al recargar).
  await ctx.route("**/api/events*", (route) => route.abort());
  await ctx.addCookies(toBrowserCookies());
  // 033: en cada carga, ¿se asomó algún paso (`template-option`) antes de
  // la tarjeta? Se observa el DOM desde antes de que corra la app.
  await ctx.addInitScript(() => {
    const w = window;
    w.__e2e033 = { stepsBeforeCard: false, cardSeen: false, loadingSeen: false };
    const check = () => {
      const st = w.__e2e033;
      if (document.querySelector("[data-testid=\"template-thread-loading\"]")) st.loadingSeen = true;
      if (document.querySelector("[data-testid=\"template-sent-card\"]")) st.cardSeen = true;
      else if (!st.cardSeen && document.querySelector("[data-testid=\"template-option\"]")) st.stepsBeforeCard = true;
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  return { ctx, page };
}
const noTitles = async (loc, where) => {
  const titles = await loc.locator("[title]").count();
  const icons = await loc.locator("svg.lucide-info, svg.lucide-circle-help, svg.lucide-help-circle").count();
  const text = (await loc.innerText()) ?? "";
  ok(`${where}: sin title ni ícono ⓘ`, titles === 0 && icons === 0 && !text.includes("ⓘ"), `titles=${titles} icons=${icons}`);
};
const HHMM = /\b\d{2}:\d{2}\b/;
const bubbles = (page, text) => page.locator("span.whitespace-pre-wrap", { hasText: text }).filter({ hasNotText: "Así le va a llegar" });

async function bandejaChecks(tpl, { tere }) {
  console.log("\n== b) Bandeja: tarjeta «Plantilla enviada» ==");
  const rosa = await inbound(N.rosa, "Mándame la cotización", { hoursAgo: 30 });
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/inbox?contact=${rosa?.contact?.id}`, { waitUntil: "load", timeout: 90000 });
  const sender = page.getByTestId("template-sender");
  // La primera compilación de /inbox en next dev puede pasar del minuto.
  await sender.waitFor({ timeout: 90000 });
  ok("ventana cerrada: los pasos «Para escribirle a Rosa, usa un mensaje aprobado»", ((await sender.textContent()) ?? "").includes("Para escribirle a Rosa, usa un mensaje aprobado"));
  await sender.locator(`input[type="radio"][value="${tpl?.id}"]`).check();
  const v1 = page.locator("#template-variable-1");
  ok("el espacio 1 viene con «Rosa»", await until(async () => (await v1.inputValue()) === "Rosa", 10000), await v1.inputValue().catch(() => ""));
  await sender.getByRole("button", { name: "Enviar plantilla" }).click();

  const card = page.getByTestId("template-sent-card");
  ok("tras enviar aparece la tarjeta", await until(async () => await card.isVisible(), 20000));
  const cardText = async () => ((await card.textContent()) ?? "").replace(/ /g, " ");
  const t1 = await cardText();
  ok("«Plantilla enviada a Rosa · HH:MM»", /Plantilla enviada a Rosa · \d{2}:\d{2}/.test(t1), t1);
  const bubbleHour = await page.locator("span.text-text-4", { hasText: HHMM }).last().textContent();
  ok("…con la misma hora que la burbuja", t1.includes(`· ${bubbleHour?.trim()}`), `${t1} vs ${bubbleHour}`);
  // El nombre se reconoce por el texto (GET /api/templates): llega después.
  ok("«Retomar cotizacion …» entre comillas", await until(async () => (await cardText()).includes(`«Retomar cotizacion ${S}»`), 15000), await cardText());
  ok("chip «Enviando…» (wa-mock no confirma solo)", ((await page.getByTestId("template-sent-status").textContent()) ?? "") === "Enviando…");
  ok("«Cuando Rosa te conteste, podrás escribirle normal. No hace falta enviarla otra vez.»", t1.includes("Cuando Rosa te conteste, podrás escribirle normal. No hace falta enviarla otra vez."), t1);
  ok("los pasos ya no están", (await page.getByTestId("template-sender").count()) === 0);
  ok("botón «Enviar otra plantilla»", await card.getByRole("button", { name: "Enviar otra plantilla" }).isVisible());
  await noTitles(card, "tarjeta");
  await shot(page.locator("#composer"), "033-tarjeta-enviada.png");

  const wamid = (await templatesTo(phone(N.rosa))).at(-1)?.waMessageId;
  for (const [s, label] of [["sent", "Enviada"], ["delivered", "Entregada"], ["read", "Leída"]]) {
    const r = await status(wamid, s);
    if (!r.res.ok) ok(`wa-mock status ${s}`, false, short(r));
    await until(async () => (await messagesOf(rosa?.id)).at(-1)?.status === s, 10000);
    await page.reload({ waitUntil: "load" });
    await card.waitFor({ timeout: 60000 });
    ok(`al recargar sigue la tarjeta con «${label}»`, await until(async () => ((await page.getByTestId("template-sent-status").textContent()) ?? "") === label, 15000), await page.getByTestId("template-sent-status").textContent().catch(() => ""));
    const w = await page.evaluate(() => window.__e2e033);
    ok(`…y los pasos nunca se asomaron antes de la tarjeta (recarga «${label}»)`, w?.cardSeen === true && w?.stepsBeforeCard === false && (await page.getByTestId("template-option").count()) === 0, JSON.stringify(w));
  }
  ok("tras recargar, la tarjeta también reconoce la plantilla", await until(async () => (await cardText()).includes(`«Retomar cotizacion ${S}»`), 15000), await cardText());
  await shot(page.locator("#composer"), "033-tarjeta-leida.png");

  console.log("\n== c) «Enviar otra plantilla» + aviso de duplicado ==");
  await card.getByRole("button", { name: "Enviar otra plantilla" }).click();
  ok("vuelven los pasos", await until(async () => await sender.isVisible(), 10000));
  ok("encabezado «Enviar otra plantilla a Rosa»", ((await sender.textContent()) ?? "").includes("Enviar otra plantilla a Rosa"), (await sender.textContent())?.slice(0, 120));
  await sender.locator(`input[type="radio"][value="${tpl?.id}"]`).check();
  await until(async () => (await v1.inputValue()) === "Rosa", 10000);
  const ob0 = (await templatesTo(phone(N.rosa))).length;
  await sender.getByRole("button", { name: "Enviar plantilla" }).click();
  const warn = page.getByTestId("template-duplicate-warning");
  ok("aviso de duplicado", await until(async () => await warn.isVisible(), 15000));
  const wt = ((await warn.textContent()) ?? "").replace(/ /g, " ");
  ok("«Ya le enviaste este mensaje a Rosa hace menos de 1 min.» (o «hace N min.»)", /Ya le enviaste este mensaje a Rosa hace (menos de 1|\d+) min\./.test(wt), wt);
  ok("«Si lo mandas otra vez, le llegará repetido. Mientras Rosa no conteste, no hace falta reenviarlo.»", wt.includes("Si lo mandas otra vez, le llegará repetido. Mientras Rosa no conteste, no hace falta reenviarlo."), wt);
  ok("el aviso es role=alert", (await warn.getAttribute("role")) === "alert");
  ok("va en «Revisa y envía», en lugar del botón «Enviar plantilla»", (await sender.getByRole("button", { name: "Enviar plantilla" }).count()) === 0);
  ok("…y no salió nada a Meta", (await templatesTo(phone(N.rosa))).length === ob0);
  await noTitles(warn, "aviso de duplicado");
  await warn.scrollIntoViewIfNeeded();
  await shot(warn.locator("xpath=.."), "033-aviso-duplicado.png");
  await warn.getByRole("button", { name: "Cancelar" }).click();
  ok("«Cancelar» regresa el botón normal", await until(async () => (await warn.count()) === 0 && (await sender.getByRole("button", { name: "Enviar plantilla" }).isVisible()), 5000));
  await sender.getByRole("button", { name: "Enviar plantilla" }).click();
  await warn.waitFor({ timeout: 15000 });
  await warn.getByRole("button", { name: "Enviar de todos modos" }).click();
  ok("«Enviar de todos modos» → vuelve la tarjeta", await until(async () => await card.isVisible(), 20000));
  ok("…con el envío nuevo («Enviando…»)", await until(async () => ((await page.getByTestId("template-sent-status").textContent()) ?? "") === "Enviando…", 10000));
  ok("wa-mock: una plantilla más", (await templatesTo(phone(N.rosa))).length === ob0 + 1);
  ok("2 burbujas de esa plantilla en el hilo", await until(async () => (await bubbles(page, rendered(N.rosa)).count()) === 2, 15000), String(await bubbles(page, rendered(N.rosa)).count()));
  await until(async () => (await cardText()).includes("«Retomar"), 15000);
  await shot(page, "033-bandeja-tras-reenvio.png");
  ok("API: 2 mensajes de plantilla con ese texto", (await messagesOf(rosa?.id)).filter((m) => m.origin === "template" && m.text === rendered(N.rosa)).length === 2);

  console.log("\n== b2) 390 px ==");
  const m = await newPage({ viewport: { width: 390, height: 844 } });
  await m.page.goto(`${BASE}/inbox?contact=${rosa?.contact?.id}`, { waitUntil: "load", timeout: 90000 });
  const mcard = m.page.getByTestId("template-sent-card");
  ok("390 px: la tarjeta", await until(async () => await mcard.isVisible(), 60000));
  const w390 = await m.page.evaluate(() => window.__e2e033);
  ok("390 px: abrir el chat → tarjeta sin que se asomen los pasos antes", w390?.cardSeen === true && w390?.stepsBeforeCard === false, JSON.stringify(w390));
  ok("390 px: sin desborde horizontal", await m.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await shot(m.page, "033-tarjeta-390.png");
  await m.ctx.close();

  console.log("\n== d) último envío fallido ==");
  await page.goto(`${BASE}/inbox?contact=${tere?.contact?.id}`, { waitUntil: "load", timeout: 90000 });
  await sender.waitFor({ timeout: 60000 });
  const failed = page.getByTestId("template-last-failed");
  ok("aviso de envío fallido arriba de los pasos", await until(async () => await failed.isVisible(), 15000));
  const ft = ((await failed.textContent()) ?? "").replace(/ /g, " ");
  ok("«La plantilla de las HH:MM no le llegó a Tere.»", /La plantilla de las \d{2}:\d{2} no le llegó a Tere\./.test(ft), ft);
  const lastErr = (await messagesOf(tere?.id)).at(-1)?.error;
  const conPunto = lastErr && /[.!?…]$/.test(lastErr.trim()) ? lastErr.trim() : `${lastErr?.trim()}.`;
  ok("…con el motivo del mensaje cerrado con punto y «Revísala abajo y vuelve a enviarla.»", !!lastErr && ft.includes(`${conPunto} Revísala abajo y vuelve a enviarla.`), `${ft} | ${lastErr}`);
  ok("…sin «) Revísala» (puntuación)", !/[^.!?…] Revísala/.test(ft), ft);
  ok("sin tarjeta de éxito", (await page.getByTestId("template-sent-card").count()) === 0);
  ok("el aviso es role=alert", (await failed.getAttribute("role")) === "alert");
  await shot(page.locator("#composer"), "033-envio-fallido.png");
  await ctx.close();
}

async function contactosChecks(tpl) {
  console.log("\n== e) Contactos «Escribir primero» con la lista vieja ==");
  const alta = await api("/api/contacts", { method: "POST", body: body({ name: N.ceci, phone: phone(N.ceci), source: "referido" }) });
  ok("alta a mano (nunca escribió)", alta.res.status === 201, short(alta));
  const ceciId = (await api(`/api/contacts?q=${encodeURIComponent(N.ceci)}`)).json?.contacts?.[0]?.id;
  ok("id del contacto", !!ceciId);
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/contacts`, { waitUntil: "load", timeout: 90000 });
  await page.getByLabel("Buscar contacto").waitFor({ timeout: 60000 });
  await page.getByLabel("Buscar contacto").fill(N.ceci);
  const btn = page.getByRole("button", { name: `Escribir primero a ${N.ceci}` });
  ok("la fila ofrece «Escribir primero»", await until(async () => (await btn.count()) === 1, 30000));

  // Otra pestaña (o un compañero) ya se la mandó: esta lista no se enteró.
  const pre = await api(`/api/contacts/${ceciId}/start-conversation`, { method: "POST", body: body({ templateId: tpl?.id, variables: ["Ceci"] }) });
  ok("(otra pestaña) la plantilla ya salió → 200", pre.res.ok, short(pre));
  const again = await api(`/api/contacts/${ceciId}/start-conversation`, { method: "POST", body: body({ templateId: tpl?.id, variables: ["Ceci"] }) });
  ok("API start-conversation repetida → 409 template_recently_sent", again.res.status === 409 && again.json?.error?.code === "template_recently_sent", short(again));

  await btn.click();
  const dlg = page.getByRole("dialog", { name: `Escribir primero a ${N.ceci}` });
  await dlg.waitFor();
  const steps = dlg.getByTestId("first-message");
  await steps.waitFor({ timeout: 20000 });
  await steps.locator(`input[type="radio"][value="${tpl?.id}"]`).check();
  const v1 = dlg.locator("#first-template-variable-1");
  ok("el espacio 1 viene con «Ceci»", await until(async () => (await v1.inputValue()) === "Ceci", 10000));
  const ob0 = (await templatesTo(phone(N.ceci))).length;
  await dlg.getByRole("button", { name: "Enviar y abrir el chat" }).click();
  const warn = dlg.getByTestId("template-duplicate-warning");
  ok("aviso de duplicado dentro del diálogo", await until(async () => await warn.isVisible(), 15000));
  const wt = ((await warn.textContent()) ?? "").replace(/ /g, " ");
  ok("«Ya le enviaste este mensaje a Ceci hace … min.»", /Ya le enviaste este mensaje a Ceci hace (menos de 1|\d+) min\./.test(wt), wt);
  ok("sin el botón «Enviar y abrir el chat» mientras tanto", (await dlg.getByRole("button", { name: "Enviar y abrir el chat" }).count()) === 0);
  ok("…y no salió nada a Meta", (await templatesTo(phone(N.ceci))).length === ob0);
  await shot(page, "033-aviso-duplicado-contactos.png");
  await warn.getByRole("button", { name: "Enviar de todos modos" }).click();
  ok("abre su chat: /inbox?contact=<id>", await until(async () => page.url().includes(`/inbox?contact=${ceciId}`), 30000), page.url());
  ok("…con la tarjeta «Plantilla enviada a Ceci»", await until(async () => ((await page.getByTestId("template-sent-card").textContent()) ?? "").includes("Plantilla enviada a Ceci"), 60000));
  ok("wa-mock: una plantilla más", (await templatesTo(phone(N.ceci))).length === ob0 + 1);
  ok("2 burbujas de esa plantilla", await until(async () => (await bubbles(page, rendered(N.ceci)).count()) === 2, 15000), String(await bubbles(page, rendered(N.ceci)).count()));
  await ctx.close();
}

async function main() {
  const tpl = await setup();
  const seeded = await apiChecks(tpl);
  browser = await chromium.launch();
  try {
    await bandejaChecks(tpl, seeded);
    await contactosChecks(tpl);
  } catch (err) {
    ok("033: recorrido con Playwright", false, String(err));
  } finally {
    await browser.close();
  }
  console.log(`\n${failures === 0 ? "TODO VERDE" : "CON FALLOS"} — ${checks - failures}/${checks} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
