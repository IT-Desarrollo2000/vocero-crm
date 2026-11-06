/**
 * Self-test E2E — 032 Fase A: Seguimiento y Citas «que se explican solos».
 * Guion humano: tests/e2e/us-modulos-a.md
 *
 * Contra la app VIVA (mocks), como Propietario, Vendedora (Daniela) y un
 * segundo vendedor (Marco):
 *
 *   Seguimiento (/pipeline)
 *    a) filtro «Mis clientes · Sin tomar · Todos»: por defecto según el rol,
 *       recordado al recargar, con sus conteos
 *    b) tarjeta ajena: «Lo atiende Marco Ríos» y SIN «Abrir chat» para la
 *       vendedora (el Propietario sí lo tiene)
 *    c) «Tomar y responder» toma (API) y lleva a /inbox?contact=; si otro lo
 *       tomó antes, lo dice y no se reasigna
 *    d) «Retomar con plantilla» con la ventana cerrada
 *    e) ganar sin monto se permite (desde el panel) y la tarjeta pide
 *       «Capturar monto»; la franja «lo que te toca» trae sus accesos
 *    f) columna vacía con texto
 *    g) error del tablero (500) → «No se pudo cargar el tablero.» +
 *       «Reintentar» que funciona; fallo al mover → aviso visible
 *    h) en vivo: un entrante por wa-mock cambia la tarjeta sin recargar
 *   Citas (/bookings)
 *    i) «¿Cómo le fue a…?» → «Sí, llegó» la deja Realizada (API)
 *    j) «Tomarla» la asigna a la vendedora (API); carrera de dos tomas →
 *       una 200 y otra 409 `already_taken`
 *    k) «Mostrar citas del Laboratorio» solo para el Propietario; zona «hora
 *       de Ciudad de México»; bloqueo con aviso de éxito
 *   Ambos
 *    l) ningún `title=` ni ícono ⓘ; sin desborde horizontal a 390 px
 *
 * Presupuesto del limitador de login: 3 (owner + 2 vendedores, por API).
 *
 * Uso (BD aislada RECIÉN RESETEADA, app con .env.e2e, AGENDA=on):
 *   CATALOG_STORAGE=local node --env-file=.env.e2e scripts/e2e-modulos-a.mjs
 *
 * Lee `DATABASE_URL` para retroceder una cita al pasado (la API no agenda
 * en el pasado). Sale con código 1 si algún check falla.
 */
import { chromium } from "playwright";
import postgres from "postgres";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const S = Math.random().toString(36).slice(2, 7);
const PN = "PN-E2E-MODA";
const WABA = "WABA-E2E-MODA";
const TZ = "America/Mexico_City";

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
  return { api, jar };
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

const owner = client();
const dani = client();
const marco = client();
const OWNER = { email: "e2e@vocero.test", password: "password-e2e-123", name: "Operador E2E" };
const DANI = { email: "daniela.moda@vocero.test", password: "password-vend-123", name: "Daniela Ortiz" };
const MARCO = { email: "marco.moda@vocero.test", password: "password-vend-456", name: "Marco Ríos" };

let seq = 0;
const phoneOf = new Map();
function phone(name) {
  if (!phoneOf.has(name)) phoneOf.set(name, `52155${String(Date.now()).slice(-5)}${String(seq++).padStart(2, "0")}`);
  return phoneOf.get(name);
}
async function conversations() {
  return (await owner.api("/api/conversations")).json?.conversations ?? [];
}
async function convOf(name) {
  return (await conversations()).find((c) => c.contact?.name === name) ?? null;
}
async function inbound(name, text, { hoursAgo = 0 } = {}) {
  const r = await owner.api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({
      phoneNumberId: PN,
      from: phone(name),
      name,
      text,
      waMessageId: `wamid.e2e.moda.${S}.${seq++}.${Math.random().toString(36).slice(2, 7)}`,
      ...(hoursAgo ? { timestamp: Math.floor(Date.now() / 1000) - hoursAgo * 3600 } : {}),
    }),
  });
  if (!r.res.ok) ok(`inbound de ${name}`, false, short(r));
  await until(async () => !!(await convOf(name)));
  return convOf(name);
}
async function board(c = owner) {
  return (await c.api("/api/pipeline/board")).json;
}

function toBrowserCookies(jar) {
  const host = new URL(BASE).hostname;
  return jar.cookie
    .split(/;\s*/)
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf("=");
      return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: host, path: "/" };
    });
}

let browser;
/** `live`: SIN abortar /api/events (solo una pestaña así: next dev tiene pocas ranuras). */
async function newPage(actor, { viewport = { width: 1366, height: 768 }, live = false } = {}) {
  const ctx = await browser.newContext({ viewport });
  if (!live) await ctx.route("**/api/events*", (route) => route.abort());
  await ctx.addCookies(toBrowserCookies(actor.jar));
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  return { ctx, page };
}
const card = (page, name) => page.locator(`[aria-label="Abrir el trato de ${name}"]`);
const filterBtn = (page, label) => page.getByRole("button", { name: new RegExp(`^${label} · \\d+$`) });
async function gotoBoard(page) {
  await page.goto(`${BASE}/pipeline`, { waitUntil: "load", timeout: 90000 });
  await page.locator('section[aria-label^="Etapa "]').first().waitFor({ timeout: 60000 });
  await sleep(600);
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
/**
 * CA-2 en el MÓDULO (`main`): la barra lateral es de toda la app (031) y no
 * es parte de Seguimiento ni de Citas.
 */
const noTooltips = async (page, where) => {
  const main = page.locator("main");
  const titles = await main.locator("[title]").evaluateAll((els) => els.map((e) => `${e.tagName}:${e.getAttribute("title")}`));
  ok(`${where}: ningún atributo title`, titles.length === 0, JSON.stringify(titles.slice(0, 5)));
  const text = await main.innerText();
  const icons = await main.locator("svg.lucide-info, svg.lucide-circle-help, svg.lucide-help-circle").count();
  ok(`${where}: ningún ícono ⓘ`, !text.includes("ⓘ") && icons === 0, `texto ⓘ=${text.includes("ⓘ")} íconos=${icons}`);
};

/* ───────────────────────── setup ───────────────────────── */

async function setup() {
  console.log("== Setup ==");
  let su = await owner.api("/api/auth/sign-up/email", { method: "POST", body: body(OWNER) });
  if (!su.res.ok) su = await owner.api("/api/auth/sign-in/email", { method: "POST", body: body({ email: OWNER.email, password: OWNER.password }) });
  ok("owner con sesión", su.res.ok, short(su));
  const conn = await owner.api("/api/settings/whatsapp", { method: "PUT", body: body({ wabaId: WABA, phoneNumberId: PN, token: "tok-e2e-moda" }) });
  ok("WhatsApp (wa-mock)", conn.res.ok, short(conn));
  for (const [who, c] of [[DANI, dani], [MARCO, marco]]) {
    const add = await owner.api("/api/settings/team", { method: "POST", body: body(who) });
    ok(`alta de ${who.name}`, add.res.status === 201 || add.res.status === 409, short(add));
    const si = await c.api("/api/auth/sign-in/email", { method: "POST", body: body({ email: who.email, password: who.password }) });
    ok(`${who.name} inicia sesión`, si.res.ok, short(si));
  }
  const members = (await owner.api("/api/settings/team")).json?.members ?? [];
  const daniId = members.find((m) => m.email === DANI.email)?.userId;
  const marcoId = members.find((m) => m.email === MARCO.email)?.userId;
  ok("ids de los vendedores", !!daniId && !!marcoId);
  await owner.api("/api/agent/profile", { method: "PUT", body: body({ name: "Lumi", tone: "breve", instructions: "Tienda.", enabled: false }) });
  return { daniId, marcoId };
}

const N = {
  mia: `Ana Mía ${S}`,
  libre: `Beto Libre ${S}`,
  ajena: `Ceci Marco ${S}`,
  cerrada: `Dora Cerrada ${S}`,
  carrera: `Eli Carrera ${S}`,
  venta: `Fer Venta ${S}`,
  mover: `Gil Mover ${S}`,
};

async function seedPipeline({ daniId, marcoId }) {
  console.log("\n== Siembra de Seguimiento ==");
  const assign = async (name, userId) => {
    const c = await convOf(name);
    const r = await owner.api(`/api/conversations/${c?.id}/assign`, { method: "POST", body: body({ userId }) });
    if (!r.res.ok) ok(`asignar ${name}`, false, short(r));
  };
  await inbound(N.mia, "Hola, ¿tienen la sala en gris?");
  await inbound(N.libre, "Buenas, quiero información");
  await inbound(N.ajena, "¿Hacen envíos?");
  await inbound(N.cerrada, "Mándame la cotización", { hoursAgo: 30 });
  await inbound(N.carrera, "¿Cuánto cuesta el comedor?");
  await inbound(N.venta, "Ya pagué, gracias");
  await inbound(N.mover, "¿Y el envío?");
  for (const n of Object.values(N)) {
    const c = await convOf(n);
    await owner.api(`/api/conversations/${c?.id}`, { method: "PATCH", body: body({ aiEnabled: false }) });
  }
  await assign(N.mia, daniId);
  await assign(N.ajena, marcoId);
  await assign(N.cerrada, daniId);
  await assign(N.venta, daniId);
  await assign(N.mover, daniId);
  // Fer y Gil no esperan respuesta: Daniela ya les contestó.
  for (const n of [N.venta, N.mover]) {
    const c = await convOf(n);
    const r = await dani.api(`/api/conversations/${c?.id}/messages`, { method: "POST", body: body({ text: "¡Gracias! Quedo al pendiente." }) });
    if (!r.res.ok) ok(`Daniela le contesta a ${n}`, false, short(r));
  }
  const b = await board();
  ok("cada chat trae su trato en el tablero", Object.values(N).every((n) => b?.leads?.some((l) => l.contact?.name === n)), JSON.stringify(b?.leads?.map((l) => l.contact?.name)));
  return b;
}

/* ───────────────────────── Seguimiento ───────────────────────── */

async function pipelineChecks({ daniId, marcoId }, b0) {
  const stageByKind = (k) => b0.stages.find((s) => s.kind === k);
  const won = stageByKind("won");
  const lost = stageByKind("lost");
  const open = b0.stages.filter((s) => s.kind === "open");

  console.log("\n== a) Filtro por rol, recordado, con conteos ==");
  {
    const { ctx, page } = await newPage(dani);
    await gotoBoard(page);
    ok("vendedora: arranca en «Mis clientes»", (await filterBtn(page, "Mis clientes").getAttribute("aria-pressed")) === "true");
    const labels = await page.getByRole("group", { name: "Qué clientes ver" }).getByRole("button").allTextContents();
    ok("conteos «Mis clientes · 4», «Sin tomar · 2», «Todos · 7»", JSON.stringify(labels) === JSON.stringify(["Mis clientes · 4", "Sin tomar · 2", "Todos · 7"]), JSON.stringify(labels));
    ok("en «Mis clientes» no está la tarjeta de Marco", (await card(page, N.ajena).count()) === 0 && (await card(page, N.mia).count()) === 1);
    await filterBtn(page, "Sin tomar").click();
    ok("«Sin tomar» deja ver solo los sin dueño", await until(async () => (await card(page, N.libre).count()) === 1 && (await card(page, N.mia).count()) === 0, 5000));
    await filterBtn(page, "Todos").click();
    await page.reload({ waitUntil: "load" });
    await page.locator('section[aria-label^="Etapa "]').first().waitFor();
    ok("al recargar recuerda «Todos»", await until(async () => (await filterBtn(page, "Todos").getAttribute("aria-pressed")) === "true", 10000));

    console.log("\n== b) Tarjeta ajena para la vendedora ==");
    const ajena = card(page, N.ajena);
    ok("dice «Lo atiende Marco Ríos»", ((await ajena.textContent()) ?? "").includes("Lo atiende Marco Ríos"), await ajena.textContent());
    ok("…«Solo Marco abre este chat.»", ((await ajena.textContent()) ?? "").includes("Solo Marco abre este chat."));
    ok("…y SIN «Abrir chat» ni enlace a su chat", (await ajena.getByRole("link").count()) === 0);
    const mia = card(page, N.mia);
    ok("la suya: «Tú lo atiendes» + «Espera respuesta»", /Tú lo atiendes/.test((await mia.textContent()) ?? "") && /Espera respuesta/.test((await mia.textContent()) ?? ""), await mia.textContent());

    console.log("\n== d) «Retomar con plantilla» (ventana cerrada) ==");
    const cerrada = card(page, N.cerrada);
    const c = await convOf(N.cerrada);
    const retomar = cerrada.getByRole("link", { name: "Retomar con plantilla" });
    ok("la tarjeta trae «Retomar con plantilla»", (await retomar.count()) === 1, await cerrada.textContent());
    ok("…a /inbox?contact=<su contacto>", (await retomar.getAttribute("href")) === `/inbox?contact=${c?.contact?.id}`, await retomar.getAttribute("href"));
    ok("…y lo explica: «Su chat se cerró…»", ((await cerrada.textContent()) ?? "").includes("Su chat se cerró"));

    console.log("\n== f) Columna vacía con texto ==");
    const perdido = page.locator(`section[aria-label="Etapa ${lost.name}"]`);
    ok("«Perdido» vacía explica para qué es", ((await perdido.textContent()) ?? "").includes("Aquí van los que decidieron no comprar."), await perdido.textContent());
    const vacia = open.find((s) => !b0.leads.some((l) => l.stageId === s.id));
    if (vacia) {
      ok(`«${vacia.name}» vacía: «Nadie en esta etapa todavía.»`, ((await page.locator(`section[aria-label="Etapa ${vacia.name}"]`).textContent()) ?? "").includes("Nadie en esta etapa todavía."));
    }
    ok(`«${won.name}» con su subtítulo «ya compró»`, ((await page.locator(`section[aria-label="Etapa ${won.name}"] h3`).textContent()) ?? "").includes("ya compró"));

    console.log("\n== e) Ganar sin monto desde el panel ==");
    await card(page, N.venta).click();
    const drawer = page.getByRole("dialog", { name: `Trato de ${N.venta}` });
    const opened = await until(async () => {
      if (!(await drawer.isVisible().catch(() => false))) await card(page, N.venta).click();
      await sleep(400);
      return drawer.isVisible();
    }, 15000);
    ok("se abre el panel del trato", opened);
    await drawer.getByRole("button", { name: `Mover a ${won.name}` }).click();
    const wonOk = await until(async () => (await board()).leads.find((l) => l.contact?.name === N.venta)?.stageId === won.id, 15000);
    ok("se gana SIN monto (API: etapa ganada, amountCents null)", wonOk && (await board()).leads.find((l) => l.contact?.name === N.venta)?.amountCents === null);
    await page.getByRole("button", { name: "Cerrar el panel del trato" }).click().catch(() => {});
    const venta = card(page, N.venta);
    ok("la tarjeta pide «Capturar monto»", await until(async () => (await venta.getByRole("button", { name: "Capturar monto" }).count()) === 1, 10000), await venta.textContent());
    ok("…«Compró, pero falta cuánto.»", ((await venta.textContent()) ?? "").includes("Compró, pero falta cuánto."));
    const noAmount = page.getByTestId("pipeline-todo-noAmount");
    ok("franja: «Venta sin monto»", await until(async () => ((await noAmount.textContent()) ?? "").includes("Venta sin monto"), 10000));
    await noAmount.click();
    const dlg = page.getByRole("dialog", { name: "Monto y prioridad" });
    ok("…y su acceso abre el monto", await until(() => dlg.isVisible(), 5000));
    await page.keyboard.press("Escape");
    await dlg.getByRole("button", { name: "Cancelar" }).click().catch(() => {});
    const waiting = page.getByTestId("pipeline-todo-waiting");
    ok("franja: «… clientes tuyos esperan tu respuesta» → /inbox", /clientes? tuyos? espera/.test((await waiting.textContent()) ?? "") && (await waiting.getAttribute("href")) === "/inbox", await waiting.textContent());
    await noTooltips(page, "/pipeline (vendedora)");
    await ctx.close();
  }

  console.log("\n== a/b) Propietario ==");
  {
    const { ctx, page } = await newPage(owner);
    await gotoBoard(page);
    ok("propietario: arranca en «Todos»", (await filterBtn(page, "Todos").getAttribute("aria-pressed")) === "true");
    ok("propietario sí abre el chat de la tarjeta de Marco", (await card(page, N.ajena).getByRole("link", { name: "Abrir chat" }).count()) === 1);
    ok("propietario ve «Gestionar etapas»", (await page.getByRole("button", { name: "Gestionar etapas" }).count()) === 1);
    await noTooltips(page, "/pipeline (propietario)");
    await ctx.close();
  }

  console.log("\n== c) «Tomar y responder» ==");
  {
    const { ctx, page } = await newPage(dani);
    await gotoBoard(page);
    await filterBtn(page, "Sin tomar").click();
    const libre = card(page, N.libre);
    const libreConv = await convOf(N.libre);
    await libre.getByRole("button", { name: "Tomar y responder" }).click();
    ok("lleva a /inbox?contact=<id>", await until(async () => page.url().includes(`/inbox?contact=${libreConv?.contact?.id}`), 30000), page.url());
    ok("…y el chat quedó a nombre de Daniela (API)", (await convOf(N.libre))?.assignedTo?.userId === daniId, JSON.stringify((await convOf(N.libre))?.assignedTo));

    // Otro se adelanta: con la página cargada (sin SSE), el owner se lo da a Marco.
    await gotoBoard(page);
    await filterBtn(page, "Sin tomar").click();
    const carrera = card(page, N.carrera);
    await carrera.waitFor();
    const r = await owner.api(`/api/conversations/${(await convOf(N.carrera))?.id}/assign`, { method: "POST", body: body({ userId: marcoId }) });
    ok("(Marco lo toma antes por API)", r.res.ok, short(r));
    await carrera.getByRole("button", { name: "Tomar y responder" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "ya tomó el chat de" });
    ok("aviso «Otro vendedor ya tomó el chat de Eli…»", await until(async () => ((await alert.textContent()) ?? "").includes(`Otro vendedor ya tomó el chat de ${N.carrera}.`), 15000), await page.getByRole("alert").allTextContents().then((t) => t.join(" | ")));
    ok("…sigue en la página y NO se reasignó (API: Marco)", page.url().endsWith("/pipeline") && (await convOf(N.carrera))?.assignedTo?.userId === marcoId);
    await ctx.close();
  }

  console.log("\n== g) Error del tablero y fallo al mover ==");
  {
    const { ctx, page } = await newPage(dani);
    await page.route("**/api/pipeline/board", (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"code":"boom","message":"x"}}' }));
    await page.goto(`${BASE}/pipeline`, { waitUntil: "load", timeout: 90000 });
    ok("«No se pudo cargar el tablero.»", await until(async () => (await page.getByText("No se pudo cargar el tablero.").count()) === 1, 30000));
    await page.unroute("**/api/pipeline/board");
    await page.getByRole("button", { name: "Reintentar" }).click();
    ok("«Reintentar» carga el tablero", await until(async () => (await page.locator('section[aria-label^="Etapa "]').count()) > 0, 20000));

    await page.route("**/api/pipeline/leads/*", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"code":"boom","message":"falla de prueba"}}' })
        : route.continue()
    );
    const destino = open[open.length - 1];
    const antes = (await board()).leads.find((l) => l.contact?.name === N.mover)?.stageId;
    await card(page, N.mover).click();
    const drawer = page.getByRole("dialog", { name: `Trato de ${N.mover}` });
    await until(async () => {
      if (!(await drawer.isVisible().catch(() => false))) await card(page, N.mover).click();
      await sleep(400);
      return drawer.isVisible();
    }, 15000);
    await drawer.getByRole("button", { name: `Mover a ${destino.name}` }).click();
    const fail = page.getByRole("alert").filter({ hasText: "No se pudo mover" });
    ok(`aviso «No se pudo mover a Gil… a ${destino.name}; volvió a su lugar»`, await until(async () => ((await fail.textContent()) ?? "").includes(`No se pudo mover a ${N.mover} a ${destino.name}; volvió a su lugar`), 15000), await page.getByRole("alert").allTextContents().then((t) => t.join(" | ")));
    ok("…y sigue en su etapa (API)", (await board()).leads.find((l) => l.contact?.name === N.mover)?.stageId === antes);
    await ctx.close();
  }

  console.log("\n== h) En vivo (SSE) ==");
  {
    const { ctx, page } = await newPage(dani, { live: true });
    await gotoBoard(page);
    const mover = card(page, N.mover);
    ok("antes: Gil no espera respuesta", !/Espera respuesta/.test((await mover.textContent()) ?? ""), await mover.textContent());
    await sleep(1500); // que el EventSource esté conectado
    await inbound(N.mover, "¿Sigue en pie lo del envío?");
    ok("sin recargar, la tarjeta dice «Espera respuesta»", await until(async () => /Espera respuesta/.test((await mover.textContent()) ?? ""), 25000), await mover.textContent());
    await ctx.close();
  }

  console.log("\n== l) 390 px ==");
  for (const [actor, who] of [[dani, "vendedora"], [owner, "propietario"]]) {
    const { ctx, page } = await newPage(actor, { viewport: { width: 390, height: 844 } });
    await gotoBoard(page);
    ok(`/pipeline a 390 px sin desborde horizontal (${who})`, await noHScroll(page));
    await ctx.close();
  }
}

/* ───────────────────────── Citas ───────────────────────── */

function dayIso(offset) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
}
/** Inicio UTC de `hour` (Ciudad de México, UTC−6 todo el año). */
function at(offset, hour) {
  const [y, m, d] = dayIso(offset).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour + 6)).toISOString();
}

async function seedBookings({ daniId }) {
  console.log("\n== Siembra de Citas ==");
  const day = [{ start: "07:00", end: "21:00" }];
  const cal = await owner.api("/api/calendar/settings", {
    method: "PUT",
    body: body({
      weeklyHours: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day },
      slotMinutes: 30,
      bufferMinutes: 0,
      minNoticeHours: 0,
      maxDaysAhead: 14,
      connector: "enlace-fijo",
      meetingLink: null,
      reminderEnabled: false,
    }),
  });
  ok("horario de la agenda", cal.res.ok, short(cal));
  const t = await owner.api("/api/calendar/types", { method: "POST", body: body({ name: `Visita ${S}`, durationMinutes: 60 }) });
  ok("tipo de cita", t.res.ok, short(t));
  const typeId = t.json?.type?.id ?? ((await owner.api("/api/calendar/types")).json?.types ?? []).find((x) => x.name === `Visita ${S}`)?.id;

  const B = { pasada: `Pao Pasada ${S}`, libre: `Uri Libre ${S}`, carrera: `Rita Carrera ${S}` };
  const ids = {};
  for (const [k, name, startUtc, assignedUserId] of [
    ["pasada", B.pasada, at(1, 9), daniId],
    ["libre", B.libre, at(1, 12), null],
    ["carrera", B.carrera, at(1, 15), null],
  ]) {
    const c = await inbound(name, "Quiero una cita");
    const r = await owner.api("/api/bookings", {
      method: "POST",
      body: body({ kind: "session", contactId: c?.contact?.id, conversationId: c?.id, startUtc, typeId, assignedUserId, confirmOverlap: true }),
    });
    ok(`cita de ${name}`, r.res.status === 201, short(r));
    ids[k] = r.json?.booking?.id;
  }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const moved = await sql`update vocero.booking set scheduled_at = scheduled_at - interval '2 days' where id = ${ids.pasada}`;
    ok("la cita de Pao queda AYER (sin resultado)", moved.count === 1);
  } finally {
    await sql.end();
  }
  return { B, ids };
}

async function bookingById(id) {
  const r = await owner.api(`/api/bookings?from=${dayIso(-3)}&to=${dayIso(3)}`);
  return (r.json?.bookings ?? []).find((b) => b.id === id) ?? null;
}

async function bookingsChecks({ daniId, marcoId }, { B, ids }) {
  console.log("\n== i) «¿Cómo le fue a…?» ==");
  {
    const { ctx, page } = await newPage(dani);
    await page.goto(`${BASE}/bookings`, { waitUntil: "load", timeout: 90000 });
    const outcome = page.getByTestId("bookings-todo-outcome");
    ok(`«¿Cómo le fue a ${B.pasada}?»`, await until(async () => ((await outcome.textContent()) ?? "").includes(`¿Cómo le fue a ${B.pasada}?`), 40000), await page.getByTestId("bookings-todo").textContent().catch(() => ""));
    ok("…con «Sí, llegó», «No asistió» y «Reprogramar»", (await outcome.getByRole("button", { name: "Sí, llegó" }).count()) === 1 && (await outcome.getByRole("button", { name: "No asistió" }).count()) === 1 && (await outcome.getByRole("button", { name: "Reprogramar" }).count()) === 1);
    ok("zona: «Horarios en hora de Ciudad de México.»", ((await page.getByTestId("bookings-tz").textContent()) ?? "").trim() === "Horarios en hora de Ciudad de México.", await page.getByTestId("bookings-tz").textContent());
    await page.getByTestId("bookings-todo-arrived").click();
    ok("«Sí, llegó» → Realizada (API)", await until(async () => (await bookingById(ids.pasada))?.status === "realizada", 15000), JSON.stringify((await bookingById(ids.pasada))?.status));
    ok("…y la pregunta se va", await until(async () => (await page.getByTestId("bookings-todo-outcome").count()) === 0, 15000));

    console.log("\n== j) «Tomarla» ==");
    const free = page.getByTestId("bookings-todo-unassigned");
    ok("«2 citas sin vendedor» con «Tomarla»", await until(async () => ((await free.textContent()) ?? "").includes("2 citas sin vendedor"), 15000), await free.textContent().catch(() => ""));
    ok("…la primera es la de Uri", (await free.getAttribute("data-booking-id")) === ids.libre);
    await page.getByTestId("bookings-todo-take").click();
    ok("«Tomarla» → asignada a Daniela (API)", await until(async () => (await bookingById(ids.libre))?.assignedUser?.id === daniId, 15000), JSON.stringify((await bookingById(ids.libre))?.assignedUser));
    ok("…aviso «Tomaste la cita de Uri…»", await until(async () => ((await page.getByTestId("bookings-notice").textContent()) ?? "").includes(`Tomaste la cita de ${B.libre}`), 10000));

    console.log("\n== k) Vendedora: sin «Mostrar citas del Laboratorio»; bloqueo ==");
    ok("no ve «Mostrar citas del Laboratorio»", (await page.getByTestId("cal-toggle-tests").count()) === 0 && !(await page.locator("body").innerText()).includes("Mostrar citas del Laboratorio"));
    ok("filtro «Mías · Sin vendedor · Todas»", JSON.stringify(await page.getByRole("group", { name: "Qué citas ver" }).getByRole("button").allTextContents()) === JSON.stringify(["Mías", "Sin vendedor", "Todas"]));
    const block = page.getByTestId("bookings-block-section");
    ok("«Bloquear un horario · cierra la agenda de todo el negocio…»", ((await block.locator("summary").textContent()) ?? "").includes("cierra la agenda de todo el negocio"));
    await block.locator("summary").click();
    await page.locator("#block-start").fill(`${dayIso(2)}T18:00`);
    await page.locator("#block-min").fill("30");
    await block.getByRole("button", { name: "Bloquear" }).click();
    const res = page.getByTestId("bookings-block-result");
    ok("aviso de éxito «Listo: bloqueaste …»", await until(async () => ((await res.textContent()) ?? "").includes("Listo: bloqueaste"), 15000), await block.textContent());
    await noTooltips(page, "/bookings (vendedora, semana)");
    await ctx.close();
  }

  console.log("\n== j) Carrera: dos tomas casi simultáneas ==");
  {
    const take = (c) => c.api(`/api/bookings/${ids.carrera}`, { method: "PATCH", body: body({ action: "take" }) });
    const rs = await Promise.all([take(dani), take(marco)]);
    const codes = rs.map((r) => r.res.status).sort();
    ok("una 200 y otra 409", JSON.stringify(codes) === "[200,409]", rs.map(short).join(" | "));
    const loser = rs.find((r) => r.res.status === 409);
    ok("…la 409 es `already_taken`", loser?.json?.error?.code === "already_taken", loser ? short(loser) : "");
    const winner = rs.find((r) => r.res.status === 200);
    const final = (await bookingById(ids.carrera))?.assignedUser?.id;
    ok("…y la cita es de quien ganó (API)", !!final && final === winner?.json?.assignedUserId && [daniId, marcoId].includes(final), JSON.stringify({ final, w: winner?.json }));
  }

  console.log("\n== k) Propietario ==");
  {
    const { ctx, page } = await newPage(owner);
    await page.goto(`${BASE}/bookings`, { waitUntil: "load", timeout: 90000 });
    await page.getByTestId("cal-legend").waitFor({ timeout: 60000 });
    ok("propietario sí ve «Mostrar citas del Laboratorio»", await until(async () => (await page.getByTestId("cal-toggle-tests").count()) === 1, 10000));
    await noTooltips(page, "/bookings (propietario, semana)");
    await page.getByTestId("cal-view-day").click().catch(() => {});
    await sleep(1500);
    await noTooltips(page, "/bookings (propietario, día)");
    await ctx.close();
  }

  console.log("\n== l) 390 px ==");
  for (const [actor, who] of [[dani, "vendedora"], [owner, "propietario"]]) {
    const { ctx, page } = await newPage(actor, { viewport: { width: 390, height: 844 } });
    await page.goto(`${BASE}/bookings`, { waitUntil: "load", timeout: 90000 });
    await page.getByTestId("bookings-todo").waitFor({ timeout: 60000 });
    await sleep(1500);
    ok(`/bookings a 390 px sin desborde horizontal (${who})`, await noHScroll(page));
    await ctx.close();
  }
}

async function main() {
  browser = await chromium.launch();
  try {
    const ids = await setup();
    const b0 = await seedPipeline(ids);
    await pipelineChecks(ids, b0);
    const bk = await seedBookings(ids);
    await bookingsChecks(ids, bk);
  } finally {
    await browser.close();
  }
}

main()
  .catch((err) => {
    failures++;
    console.error("ERROR inesperado:", err);
  })
  .finally(() => {
    console.log(`\n===== ${checks - failures}/${checks} checks OK, ${failures} fallos =====`);
    process.exit(failures > 0 ? 1 : 0);
  });
