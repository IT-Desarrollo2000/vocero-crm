/**
 * Self-test E2E — 031 guía para vendedores (`/ayuda`) + pantallas que se
 * explican solas. Guion humano: tests/e2e/us-ayuda.md
 *
 *   a) sin sesión, `/ayuda` → `/login?next=%2Fayuda`; login de la vendedora →
 *      `/ayuda` con «Guía rápida de <nombre de la instancia>»
 *   b) `/inbox?contact=<id>` sin sesión → login → vuelve ahí
 *   c) `next` externo o malformado (`//evil.com`, `https://evil.com`,
 *      `/%2F%2Fevil.com`, `/\evil.com`) → tras el login, `/inbox` del mismo
 *      origen (sin redirección abierta)
 *   d) menú «Ayuda» → `/ayuda`; cada tarjeta del índice apunta a un `id` que
 *      existe en la página
 *   e) con `AGENDA` encendida está el tema de citas (y con Instagram en
 *      `CHANNELS`, su párrafo). Segunda pasada con `--off` (server con
 *      `AGENDA=off CHANNELS=whatsapp`): ni citas ni Instagram/Messenger.
 *      032: `#seguimiento` en las dos pasadas (sin hablar de citas en la
 *      `--off`) y los rótulos nuevos de Seguimiento y Citas. Fase B:
 *      `#contactos` en las dos pasadas, tras `#seguimiento`, con sus rótulos
 *      y su «¿Y en Instagram y Messenger?» solo con esos canales
 *   f) pantallas (como vendedora): ventana abierta (barra de tiempo, menú
 *      «Adjuntar», `accept` de «Documento»), ventana cerrada sin plantillas y
 *      con una plantilla de 2 espacios (prellenado, motivo, envío con los dos
 *      parámetros), franja de la IA + pregunta al escribir + «Atender yo» /
 *      «Devolver a la IA», Buzón con descripción y «Tomar» por fila, resumen
 *      sin chat abierto, y ningún botón «Ayuda: …» (los «?» se retiraron)
 *   g) `/ayuda` e `/inbox` a 1366×768 y a 360 px sin scroll horizontal
 *   h) el compositor sigue enviando texto normal (outbox del wa-mock)
 *
 * Presupuesto del limitador de login (10 / 10 min por IP y ruta): pasada
 * normal = 7 de `sign-in` (API vendedora + 6 en el navegador); `--off` = 2.
 * Reinicia el server entre corridas si ves 429.
 *
 * Uso (BD aislada, recién reseteada para que «sin plantillas» se vea):
 *   1) app con .env.e2e (mocks; AGENDA=on; CHANNELS con instagram)
 *      node --env-file=.env.e2e scripts/e2e-ayuda.mjs
 *   2) app reiniciada con AGENDA=off CHANNELS=whatsapp
 *      AGENDA=off CHANNELS=whatsapp node --env-file=.env.e2e scripts/e2e-ayuda.mjs --off
 *
 * Sale con código 1 si algún check falla.
 */
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const OFF = process.argv.includes("--off");
const S = Math.random().toString(36).slice(2, 8);
const PN = "PN-E2E-AYUDA";
const WABA = "WABA-E2E-AYUDA";

let failures = 0;
let checks = 0;

function ok(name, cond, extra = "") {
  checks++;
  if (cond) {
    console.log(`  OK  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

/** Cliente HTTP con su propio cookie jar (una sesión por actor). */
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
    if (setCookie.length) {
      jar.cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    }
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
    } catch {
      /* reintenta */
    }
    if (Date.now() - t0 > ms) return false;
    await sleep(250);
  }
};
const body = (o) => JSON.stringify(o);
const short = (r) => `${r.res.status} ${JSON.stringify(r.json)?.slice(0, 200)}`;

const owner = client();
const seller = client();

const OWNER_EMAIL = "e2e@vocero.test";
const OWNER_PASSWORD = "password-e2e-123";
// Fija: la pasada `--off` (otro arranque del server) entra con la misma.
const SELLER_EMAIL = "vend.ayuda@vocero.test";
const SELLER_PASSWORD = "password-vend-123";
const SELLER_NAME = "Vendedora Ayuda";
const COMPOSER = "Escribe una respuesta…";

function signIn(c, email, password) {
  return c.api("/api/auth/sign-in/email", {
    method: "POST",
    body: body({ email, password }),
  });
}

const phone = () => `52155${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;

async function listConversations(c) {
  return (await c.api("/api/conversations")).json?.conversations ?? [];
}
async function findByName(c, name) {
  return (await listConversations(c)).find((cv) => cv.contact?.name === name) ?? null;
}
async function outbox() {
  return (await owner.api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
}

/** Cookies del jar de Node → cookies del navegador (sin gastar logins). */
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

/** Contexto nuevo; con `actor`, ya con su sesión. SSE fuera (ranuras de next dev). */
async function newPage({ actor = null, viewport = { width: 1366, height: 768 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  await ctx.route("**/api/events*", (route) => route.abort());
  if (actor) await ctx.addCookies(toBrowserCookies(actor.jar));
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  return { ctx, page };
}

/** Espera a que React hidrate el formulario (si no, el submit es nativo). */
async function waitHydrated(page, selector) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return !!el && Object.keys(el).some((k) => k.startsWith("__react"));
    },
    selector,
    { timeout: 60000 }
  );
}

async function browserLogin(page, email, password) {
  await page.getByLabel("Correo").waitFor();
  await waitHydrated(page, "form");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

const noHorizontalScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function setupActors() {
  console.log("== Setup ==");
  let su = await owner.api("/api/auth/sign-up/email", {
    method: "POST",
    body: body({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: "Operador E2E" }),
  });
  if (!su.res.ok) su = await signIn(owner, OWNER_EMAIL, OWNER_PASSWORD);
  ok("owner registrado o con sesión", su.res.ok, short(su));
  const conn = await owner.api("/api/settings/whatsapp", {
    method: "PUT",
    body: body({ wabaId: WABA, phoneNumberId: PN, token: "tok-e2e-ayuda" }),
  });
  ok("owner conecta WhatsApp (wa-mock)", conn.res.ok, short(conn));
  const add = await owner.api("/api/settings/team", {
    method: "POST",
    body: body({ name: SELLER_NAME, email: SELLER_EMAIL, password: SELLER_PASSWORD }),
  });
  ok("alta de la vendedora (201, o ya existía)", add.res.status === 201 || add.res.status === 409, short(add));
  const si = await signIn(seller, SELLER_EMAIL, SELLER_PASSWORD);
  ok("la vendedora inicia sesión (API)", si.res.ok, short(si));
  const members = (await owner.api("/api/settings/team")).json?.members ?? [];
  const sellerId = members.find((m) => m.email === SELLER_EMAIL)?.userId ?? null;
  ok("id de la vendedora", !!sellerId, JSON.stringify(members.map((m) => m.email)));
  const brand = (await owner.api("/api/settings/branding")).json?.branding?.name ?? null;
  ok("nombre de la instancia", typeof brand === "string" && brand.length > 0, String(brand));
  return { sellerId, brand };
}

/** Inbound por el wa-mock; devuelve la conversación ya creada. */
async function inbound(name, text, { hoursAgo = 0 } = {}) {
  const r = await owner.api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({
      phoneNumberId: PN,
      from: phone(),
      name,
      text,
      waMessageId: `wamid.e2e.ayuda.${S}.${Math.random().toString(36).slice(2, 8)}`,
      ...(hoursAgo ? { timestamp: Math.floor(Date.now() / 1000) - hoursAgo * 3600 } : {}),
    }),
  });
  ok(`inbound de ${name}`, r.res.ok, short(r));
  await until(async () => !!(await findByName(owner, name)));
  return findByName(owner, name);
}

// ── e) --off ────────────────────────────────────────────────────────────

async function offPass() {
  console.log("== e) Segunda pasada: AGENDA=off, CHANNELS=whatsapp ==");
  let r = await signIn(owner, OWNER_EMAIL, OWNER_PASSWORD);
  ok("owner con sesión", r.res.ok, short(r));
  r = await signIn(seller, SELLER_EMAIL, SELLER_PASSWORD);
  ok("vendedora con sesión (de la pasada normal)", r.res.ok, short(r));
  const cal = await owner.api("/api/calendar/settings");
  ok("la agenda está apagada (GET /api/calendar/settings → 404)", cal.res.status === 404, short(cal));
  const { ctx, page } = await newPage({ actor: seller });
  await page.goto(`${BASE}/ayuda`, { waitUntil: "load", timeout: 90000 });
  await page.locator("h1").waitFor();
  ok("sin artículo #citas", (await page.locator("#citas").count()) === 0);
  ok("ni tarjeta del índice a #citas", (await page.locator('nav[aria-label="Temas de la guía"] a[href="#citas"]').count()) === 0);
  const text = await page.locator("body").innerText();
  ok("ni «El cliente quiere una cita»", !text.includes("El cliente quiere una cita"));
  ok("sin texto de Instagram ni Messenger", !/Instagram|Messenger/.test(text), (text.match(/.{0,60}(Instagram|Messenger).{0,60}/) ?? [""])[0]);
  ok("los demás temas siguen (#plantillas, #archivos)", (await page.locator("#plantillas").count()) === 1 && (await page.locator("#archivos").count()) === 1);
  // 032 — Seguimiento no depende de la agenda: está, y sin hablar de citas.
  const seg = page.locator("#seguimiento");
  ok("#seguimiento sigue con la agenda apagada", (await seg.count()) === 1);
  ok("…y no habla de citas", !/[Cc]ita/.test((await seg.innerText().catch(() => "")) ?? ""));
  // 032 fase B — Contactos tampoco depende de un módulo; sin IG/Messenger
  // encendidos no trae su «¿Y en …?» (el chequeo de todo el body ya lo cubre).
  const cont = page.locator("#contactos");
  ok("#contactos sigue con la agenda apagada", (await cont.count()) === 1);
  ok("…sin «¿Y en …?» de canales", !((await cont.innerText().catch(() => "")) ?? "").includes("¿Y en "));
  await ctx.close();
}

// ── a)–c) regreso tras el login ─────────────────────────────────────────

async function loginReturnChecks(brand, someContactId) {
  console.log("\n== a) /ayuda sin sesión → login → /ayuda ==");
  {
    const { ctx, page } = await newPage();
    await page.goto(`${BASE}/ayuda`, { waitUntil: "load", timeout: 90000 });
    const u = new URL(page.url());
    ok("sin sesión → /login?next=%2Fayuda", u.pathname === "/login" && u.search === "?next=%2Fayuda", page.url());
    await browserLogin(page, SELLER_EMAIL, SELLER_PASSWORD);
    ok("tras el login, la URL final es /ayuda", await until(async () => new URL(page.url()).pathname === "/ayuda", 60000), page.url());
    const h1 = page.locator("h1");
    ok(
      `y dice «Guía rápida de ${brand}»`,
      await until(async () => ((await h1.textContent()) ?? "").trim() === `Guía rápida de ${brand}`, 30000),
      await h1.textContent().catch(() => "")
    );
    await ctx.close();
  }

  console.log("\n== b) /inbox?contact=… sin sesión → login → vuelve ahí ==");
  {
    const { ctx, page } = await newPage();
    const target = `/inbox?contact=${encodeURIComponent(someContactId)}`;
    await page.goto(`${BASE}${target}`, { waitUntil: "load", timeout: 90000 });
    const u = new URL(page.url());
    ok("sin sesión → /login con next de la ruta pedida", u.pathname === "/login" && u.searchParams.get("next") === target, page.url());
    await browserLogin(page, SELLER_EMAIL, SELLER_PASSWORD);
    ok(
      "tras el login vuelve a /inbox?contact=<id>",
      await until(async () => {
        const v = new URL(page.url());
        return v.pathname === "/inbox" && v.searchParams.get("contact") === someContactId;
      }, 60000),
      page.url()
    );
    await ctx.close();
  }

  console.log("\n== c) next externo o malformado → /inbox del mismo origen ==");
  for (const evil of ["//evil.com", "https://evil.com", "/%2F%2Fevil.com", "/\\evil.com"]) {
    const { ctx, page } = await newPage();
    await page.goto(`${BASE}/login?next=${encodeURIComponent(evil)}`, { waitUntil: "load", timeout: 90000 });
    await browserLogin(page, SELLER_EMAIL, SELLER_PASSWORD);
    const landed = await until(async () => {
      const v = new URL(page.url());
      return v.origin === new URL(BASE).origin && v.pathname === "/inbox";
    }, 60000);
    ok(`next=${evil} → /inbox (mismo origen)`, landed, page.url());
    await ctx.close();
  }
}

// ── d) + e) on: página Ayuda ─────────────────────────────────────────────

async function helpPageChecks() {
  console.log("\n== d) Menú «Ayuda» y el índice ==");
  const { ctx, page } = await newPage({ actor: seller });
  await page.goto(`${BASE}/inbox`, { waitUntil: "load", timeout: 90000 });
  // El del menú (el resumen sin chat abierto trae otro enlace «Ayuda»).
  const link = page.locator('a[href="/ayuda"][aria-label="Ayuda"]');
  await link.waitFor();
  // Un clic recién cargado puede caer antes de hidratar: reintenta solo si
  // a los pocos segundos no navegó (reclicar a cada vuelta cancela la carga).
  let went = false;
  for (let i = 0; i < 4 && !went; i++) {
    await link.click();
    went = await until(async () => new URL(page.url()).pathname === "/ayuda", 8000);
  }
  ok("el enlace «Ayuda» del menú lleva a /ayuda", went, page.url());
  await page.locator("h1").waitFor();
  const hrefs = await page
    .locator('nav[aria-label="Temas de la guía"] a')
    .evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  ok("el índice tiene tarjetas", hrefs.length >= 6, JSON.stringify(hrefs));
  const missing = await page.evaluate(
    (list) => list.filter((h) => !h?.startsWith("#") || !document.getElementById(h.slice(1))),
    hrefs
  );
  ok("cada tarjeta apunta a un id que existe", missing.length === 0, JSON.stringify(missing));

  console.log("\n== e) Con AGENDA y CHANNELS encendidos ==");
  ok("hay tema de citas (#citas en el índice y en la página)", hrefs.includes("#citas") && (await page.locator("#citas").count()) === 1);
  ok("y el párrafo de Instagram en #archivos", ((await page.locator("#archivos").innerText()) ?? "").includes("Instagram:"));

  // 032 — Tema Seguimiento nuevo y Citas al día (rótulos de la pantalla de hoy).
  ok("hay tema Seguimiento (#seguimiento en el índice y en la página)", hrefs.includes("#seguimiento") && (await page.locator("#seguimiento").count()) === 1);
  ok("…justo después de «¿Qué chats me tocan?»", hrefs.indexOf("#seguimiento") === hrefs.indexOf("#mis-chats") + 1, JSON.stringify(hrefs));
  const segText = (await page.locator("#seguimiento").innerText().catch(() => "")) ?? "";
  for (const label of ["Mis clientes", "Sin tomar", "Tomar y responder", "Retomar con plantilla", "Capturar monto", "Lo atiende"]) {
    ok(`#seguimiento cita «${label}»`, segText.includes(label));
  }
  const citasText = (await page.locator("#citas").innerText().catch(() => "")) ?? "";
  for (const label of ["¿Cómo le fue a", "Sí, llegó", "Tomarla", "Sin vendedor", "Bloquear un horario", "todo el negocio"]) {
    ok(`#citas cita «${label}»`, citasText.includes(label));
  }
  ok("#citas ya no dice «Sin asignar» ni «Mostrar pruebas»", !/Sin asignar|Mostrar pruebas/.test(citasText));

  // 032 fase B — Tema Contactos, justo después de Seguimiento.
  ok("hay tema Contactos (#contactos en el índice y en la página)", hrefs.includes("#contactos") && (await page.locator("#contactos").count()) === 1);
  ok("…justo después de Seguimiento", hrefs.indexOf("#contactos") === hrefs.indexOf("#seguimiento") + 1, JSON.stringify(hrefs));
  const contText = (await page.locator("#contactos").innerText().catch(() => "")) ?? "";
  for (const label of [
    "Activos",
    "Archivados",
    "Abrir chat",
    "Tomar y responder",
    "Retomar con plantilla",
    "Escribir primero",
    "Enviar y abrir el chat",
    "Archivar",
    "Deshacer",
    "Desarchivar",
    "Nuevo contacto",
    "Sin teléfono",
    "Lo atiende",
    "¿Y en Instagram y Messenger?",
  ]) {
    ok(`#contactos cita «${label}»`, contText.includes(label));
  }
  ok("#contactos ya no dice «Ver archivados»", !contText.includes("Ver archivados"));
  await ctx.close();
}

// ── f) + h) pantallas ────────────────────────────────────────────────────

async function screensChecks({ sellerId }) {
  console.log("\n== f) Datos: conversaciones ==");
  // Corridas previas: que «sin plantillas» se vea (Meta rechaza las aprobadas).
  const prev = ((await owner.api("/api/templates")).json?.templates ?? []).filter((t) => t.status === "approved");
  if (prev.length > 0) {
    for (const t of prev) {
      await owner.api("/api/dev/wa-mock/template-status", {
        method: "POST",
        body: body({ wabaId: WABA, name: t.name, language: t.language, event: "REJECTED", notify: false }),
      });
    }
    await owner.api("/api/templates/sync", { method: "POST" });
  }
  const stillApproved = ((await owner.api("/api/templates")).json?.templates ?? []).filter((t) => t.status === "approved");
  ok(
    "sin plantillas aprobadas al empezar (para ver «sin plantillas»)",
    stillApproved.length === 0,
    `quedan ${stillApproved.length} de una corrida previa: resetea la BD aislada y vuelve a correr`
  );
  // El agente apagado mientras se siembra: nadie le contesta a estos chats.
  await owner.api("/api/agent/profile", { method: "PUT", body: body({ enabled: false }) });

  const OPEN = `Lucía Abierta ${S}`;
  const CLOSED = `Rosa Cerrada ${S}`;
  const BUZON = `Pedro Buzón ${S}`;
  const AI = `Marta Robot ${S}`;
  const open = await inbound(OPEN, "Hola, ¿tienen envío a domicilio?");
  const closed = await inbound(CLOSED, "hola de hace dos días", { hoursAgo: 48 });
  const buzon = await inbound(BUZON, "Buenas tardes, quiero información");
  for (const c of [open, closed, buzon]) {
    await owner.api(`/api/conversations/${c?.id}`, { method: "PATCH", body: body({ aiEnabled: false }) });
  }
  ok("ventana abierta y cerrada como se esperaba", open?.windowOpen === true && closed?.windowOpen === false, JSON.stringify({ o: open?.windowOpen, c: closed?.windowOpen }));

  const { ctx, page } = await newPage({ actor: seller });
  const noHelpButtons = async (where) =>
    ok(`${where}: ningún botón «Ayuda: …» (los «?» se fueron)`, (await page.locator('[aria-label^="Ayuda:"]').count()) === 0);

  console.log("\n== f) Ventana abierta: tiempo + menú «Adjuntar» ==");
  await page.goto(`${BASE}/inbox?contact=${open?.contact?.id}`, { waitUntil: "load", timeout: 90000 });
  const input = page.getByPlaceholder(COMPOSER);
  await input.waitFor();
  const bar = page.getByTestId("window-bar");
  ok("se ve «Puedes escribirle libremente … más»", await until(async () => /Puedes escribirle libremente .+ más/.test((await bar.textContent()) ?? ""), 20000), await bar.textContent().catch(() => ""));
  await noHelpButtons("ventana abierta");
  const attach = page.getByRole("button", { name: "Adjuntar archivo" });
  const menu = page.getByRole("menu", { name: "¿Qué quieres mandar?" });
  const opened = await until(async () => {
    if ((await menu.count()) === 0) await attach.click();
    await sleep(300);
    return await menu.isVisible();
  }, 30000);
  ok("«Adjuntar» abre un role=\"menu\"", opened);
  ok("con «JPG o PNG · hasta 5 MB»", ((await menu.textContent()) ?? "").includes("JPG o PNG · hasta 5 MB"), await menu.textContent().catch(() => ""));
  ok("y «Enviar ubicación» / «Compartir contacto»", (await menu.getByRole("menuitem", { name: "Enviar ubicación" }).count()) === 1 && (await menu.getByRole("menuitem", { name: "Compartir contacto" }).count()) === 1);
  ok("aria-expanded=true en el botón", (await attach.getAttribute("aria-expanded")) === "true");
  await page.keyboard.press("Escape");
  ok("Esc cierra el menú", await until(async () => (await menu.count()) === 0, 5000));
  ok("y el foco vuelve a «Adjuntar»", await until(async () => await attach.evaluate((el) => el === document.activeElement), 3000));
  await attach.click();
  await menu.waitFor();
  const chooserP = page.waitForEvent("filechooser", { timeout: 15000 }).catch(() => null);
  await menu.locator('[role="menuitem"][data-kind="document"]').click();
  const chooser = await chooserP;
  ok("«Documento» abre el selector de archivos", !!chooser);
  const accept = (await page.locator('input[type="file"]').first().getAttribute("accept")) ?? "";
  ok(
    "con `accept` de documentos (pdf/docx/xlsx, sin imágenes)",
    accept.includes(".pdf") && accept.includes(".docx") && accept.includes(".xlsx") && !/\.jpe?g|\.png|image\//.test(accept),
    accept
  );

  console.log("\n== h) El compositor sigue enviando texto normal ==");
  const TEXT = `Sí, tenemos envío ${S}`;
  await input.fill(TEXT);
  await input.press("Enter");
  const sent = await until(async () => (await outbox()).some((o) => o.body?.type === "text" && o.body?.text?.body === TEXT), 20000);
  ok("el texto llega al outbox del wa-mock (type text)", sent);

  console.log("\n== f) Ventana cerrada sin plantillas ==");
  await page.goto(`${BASE}/inbox?contact=${closed?.contact?.id}`, { waitUntil: "load", timeout: 90000 });
  if (stillApproved.length === 0) {
    const empty = page.getByTestId("no-templates");
    const emptyText = () => empty.textContent({ timeout: 2000 }).catch(() => "");
    ok("«Todavía no puedes retomar este chat»", await until(async () => ((await emptyText()) ?? "").includes("Todavía no puedes retomar este chat"), 30000));
    ok("para la vendedora: «Avísale al propietario…» (no le ofrece crearla)", ((await emptyText()) ?? "").includes("Avísale al propietario") && (await empty.getByRole("link", { name: /Crear una plantilla/ }).count()) === 0);
    ok("sin caja de texto", (await page.getByPlaceholder(COMPOSER).count()) === 0);
    await noHelpButtons("sin plantillas");
  }

  console.log("\n== f) Plantilla con 2 espacios: 3 pasos ==");
  const TPL = `retomar_${S}`;
  const created = await owner.api("/api/templates", {
    method: "POST",
    body: body({ name: TPL, language: "es_MX", category: "UTILITY", body: "Hola {{1}}, te comparto la cotización de {{2}}." }),
  });
  ok("owner crea la plantilla", created.res.ok, short(created));
  await owner.api("/api/dev/wa-mock/template-status", {
    method: "POST",
    body: body({ wabaId: WABA, name: TPL, language: "es_MX", event: "APPROVED", notify: false }),
  });
  await owner.api("/api/templates/sync", { method: "POST" });
  const tpl = ((await owner.api("/api/templates")).json?.templates ?? []).find((t) => t.name === TPL);
  ok("Meta la aprueba (status approved)", tpl?.status === "approved", tpl?.status);

  await page.goto(`${BASE}/inbox?contact=${closed?.contact?.id}`, { waitUntil: "load", timeout: 90000 });
  const sender = page.getByTestId("template-sender");
  ok("«Para escribirle a Rosa, usa un mensaje aprobado»", await until(async () => ((await sender.textContent()) ?? "").includes("Para escribirle a Rosa, usa un mensaje aprobado"), 30000), await sender.textContent().catch(() => ""));
  ok("pasos «Elige el mensaje» y «Completa los espacios»", ((await sender.textContent()) ?? "").includes("Elige el mensaje") && ((await sender.textContent()) ?? "").includes("Completa los espacios"));
  // Con una sola aprobada ya viene elegida; si hubiera más, se elige la nuestra.
  const radio = page.locator(`input[type="radio"][value="${tpl?.id}"]`);
  if ((await radio.count()) > 0 && !(await radio.isChecked())) await radio.check();
  const v1 = page.locator("#template-variable-1");
  const v2 = page.locator("#template-variable-2");
  ok("el espacio 1 viene con el primer nombre (Rosa)", await until(async () => (await v1.inputValue()) === "Rosa", 10000), await v1.inputValue().catch(() => ""));
  const sendBtn = sender.getByRole("button", { name: "Enviar plantilla" });
  ok("«Enviar plantilla» deshabilitado", await sendBtn.isDisabled());
  ok("con «Llena el espacio 2 para poder enviarla.»", ((await sender.textContent()) ?? "").includes("Llena el espacio 2 para poder enviarla."));
  ok("la vista previa marca «falta este espacio»", ((await page.getByTestId("template-preview").textContent()) ?? "").includes("falta este espacio"));
  await v2.fill("la sala Lisboa");
  ok("al llenarlo se habilita", await until(async () => !(await sendBtn.isDisabled()), 5000));
  await sendBtn.click();
  const tplSent = await until(async () => {
    const ob = await outbox();
    const last = [...ob].reverse().find((o) => o.body?.type === "template");
    const params = last?.body?.template?.components?.find((c) => c.type === "body")?.parameters ?? [];
    return last?.body?.template?.name === TPL && params[0]?.text === "Rosa" && params[1]?.text === "la sala Lisboa";
  }, 20000);
  ok("el outbox registra type template con los dos parámetros", tplSent, JSON.stringify((await outbox()).filter((o) => o.body?.type === "template").slice(-1)));

  console.log("\n== f) Franja de la IA + pregunta al escribir ==");
  const prof = await owner.api("/api/agent/profile", {
    method: "PUT",
    body: body({ name: "Asistente", tone: "cálido", instructions: "Vendemos muebles.", enabled: true }),
  });
  ok("owner enciende el agente", prof.res.ok, short(prof));
  const sp = (await seller.api("/api/agent/profile")).json;
  ok("la vendedora lee el estado del agente (aiConfigured + enabled)", sp?.aiConfigured === true && sp?.profile?.enabled === true, JSON.stringify(sp));
  const ai = await inbound(AI, "Hola, me lo llevo");
  ok("la IA le contesta (outbox)", await until(async () => (await outbox()).some((o) => o.body?.to && JSON.stringify(o.body).includes("Te aparto el producto")), 30000));
  await page.goto(`${BASE}/inbox?contact=${ai?.contact?.id}`, { waitUntil: "load", timeout: 90000 });
  const strip = page.getByTestId("who-answers");
  ok("franja «La IA está respondiendo a Marta»", await until(async () => (await strip.getAttribute("data-state")) === "ai" && ((await strip.textContent()) ?? "").includes("La IA está respondiendo a Marta"), 30000), await strip.textContent().catch(() => ""));
  await noHelpButtons("chat con IA");
  const aiInput = page.getByPlaceholder(COMPOSER);
  const prompt = page.getByTestId("ai-prompt");
  const asked = await until(async () => {
    await aiInput.fill("");
    await aiInput.pressSequentially("o", { delay: 30 });
    await sleep(300);
    return await prompt.isVisible();
  }, 30000);
  ok("al escribir un carácter: «¿La pausamos mientras atiendes tú?»", asked && ((await prompt.textContent()) ?? "").includes("¿La pausamos mientras atiendes tú?"));
  await prompt.getByRole("button", { name: "No, que siga" }).click();
  ok("«No, que siga» la oculta", await until(async () => (await prompt.count()) === 0, 5000));
  await aiInput.pressSequentially("k, sigo", { delay: 30 });
  await sleep(500);
  ok("y no vuelve al seguir escribiendo", (await prompt.count()) === 0);
  // Otro chat y de regreso (sin recargar): sigue sin preguntar en ese chat.
  await aiInput.fill("");
  // Elegir una fila no cambia `?contact=`: se mira la cabecera del hilo.
  const rowOf = (name) => page.locator("li[data-conversation-id]").filter({ hasText: name }).locator("button").first();
  const threadIs = (name) => page.locator("section header").filter({ hasText: name });
  const openRow = async (name) => {
    for (let i = 0; i < 4; i++) {
      await rowOf(name).click();
      if (await until(async () => (await threadIs(name).count()) > 0, 5000)) return true;
    }
    return false;
  };
  const switched = await openRow(BUZON);
  const back = switched && (await openRow(AI));
  ok("se puede ir a otro chat y volver sin recargar", switched && back, `${switched}/${back}`);
  // Regresión: la franja compartía llave con el Composer y se acumulaba.
  ok("tras cambiar de chat hay UNA sola franja (la de este chat)", (await strip.count()) === 1 && (await strip.getAttribute("data-state")) === "ai", `${await strip.count()} franjas`);
  await page.getByPlaceholder(COMPOSER).pressSequentially("x", { delay: 30 });
  await sleep(500);
  ok("de vuelta en ese chat (misma sesión de la página) no vuelve a preguntar", (await prompt.count()) === 0);
  await page.getByPlaceholder(COMPOSER).fill("");
  ok("sin enviar nada de lo escrito", !(await outbox()).some((o) => JSON.stringify(o.body).includes("ok, sigo")));

  const take = strip.getByRole("button", { name: "Atender yo" });
  await take.click();
  ok("«Atender yo» → franja «Tú atiendes este chat»", await until(async () => (await strip.getAttribute("data-state")) === "human" && ((await strip.textContent()) ?? "").includes("Tú atiendes este chat"), 20000), await strip.textContent().catch(() => ""));
  let row = await findByName(owner, AI);
  ok("por API: asignada a la vendedora y aiEnabled=false", row?.assignedTo?.userId === sellerId && row?.aiEnabled === false, JSON.stringify({ a: row?.assignedTo, ai: row?.aiEnabled }));
  await strip.getByRole("button", { name: "Devolver a la IA" }).click();
  ok("«Devolver a la IA» → franja de la IA otra vez", await until(async () => (await strip.getAttribute("data-state")) === "ai", 20000));
  row = await findByName(owner, AI);
  ok("por API: aiEnabled=true", row?.aiEnabled === true, JSON.stringify({ ai: row?.aiEnabled }));

  console.log("\n== f) Buzón: descripción + «Tomar» por fila ==");
  await page.goto(`${BASE}/inbox?scope=inbox`, { waitUntil: "load", timeout: 90000 });
  const desc = page.getByTestId("scope-description");
  ok("descripción visible bajo las pestañas", await until(async () => (await desc.isVisible()) && ((await desc.textContent()) ?? "").includes("Chats que nadie ha tomado"), 30000), await desc.textContent().catch(() => ""));
  await noHelpButtons("Buzón");
  const takeRow = page.getByRole("button", { name: `Tomar el chat de ${BUZON}` });
  ok("la fila del Buzón trae «Tomar el chat de …»", await until(async () => (await takeRow.count()) === 1, 30000));
  const taken = await until(async () => {
    if ((await takeRow.count()) > 0 && !(await takeRow.isDisabled())) await takeRow.click();
    await sleep(800);
    return (await findByName(owner, BUZON))?.assignedTo?.userId === sellerId;
  }, 30000);
  ok("«Tomar» → la conversación pasa a Mis chats (API)", taken);
  ok("…sin abrir el chat por el clic", !new URL(page.url()).searchParams.get("contact") && (await page.getByPlaceholder(COMPOSER).count()) === 0, page.url());
  ok("…y la fila sale del Buzón", await until(async () => (await takeRow.count()) === 0, 20000));

  console.log("\n== f) Sin chat abierto: «lo que te toca ahora» ==");
  await page.goto(`${BASE}/inbox?scope=mine`, { waitUntil: "load", timeout: 90000 });
  const summary = page.getByTestId("inbox-summary");
  await summary.waitFor();
  const counts = (await seller.api("/api/conversations/counts?assigned=me")).json;
  const pending = (counts?.human ?? 0) > 0 || (counts?.closing ?? 0) > 0 || (counts?.scopes?.inbox?.all ?? 0) > 0;
  const expected = pending ? "Esto es lo que te toca ahora:" : "Todo al día.";
  ok(
    `resumen «${expected}» (según los contadores)`,
    await until(async () => ((await summary.textContent()) ?? "").includes(expected), 20000),
    `${JSON.stringify({ human: counts?.human, closing: counts?.closing, inbox: counts?.scopes?.inbox?.all })} · ${await summary.textContent().catch(() => "")}`
  );
  ok("saluda a la vendedora por su nombre", ((await summary.textContent()) ?? "").includes("Hola, Vendedora"));
  await noHelpButtons("resumen");
  await ctx.close();
}

// ── g) sin scroll horizontal ─────────────────────────────────────────────

async function overflowChecks() {
  console.log("\n== g) Sin scroll horizontal ==");
  for (const vp of [
    { width: 1366, height: 768 },
    { width: 360, height: 740 },
  ]) {
    const { ctx, page } = await newPage({ actor: seller, viewport: vp });
    for (const path of ["/ayuda", "/inbox"]) {
      await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 90000 });
      await page.locator("h1, [data-testid='inbox-summary'], [aria-label='Alcance de la Bandeja']").first().waitFor();
      await sleep(800);
      const w = await page.evaluate(() => `${document.documentElement.scrollWidth}/${window.innerWidth}`);
      ok(`${path} a ${vp.width} px sin scroll horizontal`, await noHorizontalScroll(page), w);
    }
    await ctx.close();
  }
}

async function main() {
  browser = await chromium.launch();
  try {
    if (OFF) {
      await offPass();
      return;
    }
    const { sellerId, brand } = await setupActors();
    const cal = await owner.api("/api/calendar/settings");
    ok("pasada normal: la agenda está encendida (si no, corre con --off)", cal.res.ok, short(cal));
    // Un contacto para el regreso de (b): el de una conversación cualquiera.
    const first = await inbound(`Contacto Regreso ${S}`, "hola");
    await owner.api(`/api/conversations/${first?.id}`, { method: "PATCH", body: body({ aiEnabled: false }) });
    await loginReturnChecks(brand, first?.contact?.id);
    await helpPageChecks();
    await screensChecks({ sellerId });
    await overflowChecks();
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
    console.log(`\n${checks - failures}/${checks} checks OK`);
    process.exit(failures > 0 ? 1 : 0);
  });
