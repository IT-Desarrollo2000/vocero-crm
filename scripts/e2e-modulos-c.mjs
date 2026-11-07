/**
 * Self-test E2E — 032 Fase C: Catálogo y Reportes «que se explican solos».
 * Guion humano: tests/e2e/us-modulos-c.md
 *
 * Contra la app VIVA (mocks), como Propietario y como Vendedora (Daniela):
 *
 *   Reportes (Propietario)
 *   a) sin pendientes: «Lo que toca hoy» dice «Nada pendiente…»; Ventas sin
 *      ventas → `sales-empty` con «Ir a Seguimiento» (lleva a /pipeline) y
 *      el embudo de hoy
 *   b) con pendientes sembrados (un chat sin responder de Daniela, una venta
 *      sin monto, una cita pasada sin resultado): cada pendiente con su
 *      enlace, y cada enlace abre su pantalla; con la venta ganada, Ventas
 *      deja `sales-empty` y muestra sus bloques
 *   c) en las seis pestañas: definición visible bajo cada KPI, ningún ⓘ ni
 *      `title` en `main` (salvo el nombre recortado de un anuncio), nada de
 *      «mediana»/«p90», la zona «hora de Ciudad de México» (no IANA)
 *   d) Agente: «Pasadas a una persona», «Mensajes que no salieron» y un
 *      error de Meta sembrado (131026) dicho en una frase, sin «(#131026)»
 *   e) «Descargar PDF» deshabilitado con su motivo visible mientras carga
 *      (respuesta retenida); al cargar, habilitado y sin motivo
 *   f) impresión del Resumen: «Lo que toca hoy» no sale; sin desborde
 *   g) la vendedora no entra a Reportes (404) ni lo ve en el menú
 *
 *   Catálogo
 *   h) vendedora: «Cómo mandar un producto», atajos con «Copiar» (lee el
 *      portapapeles con permiso; sin portapapeles, el aviso de respaldo),
 *      pausado explicado en la tarjeta y en el detalle, «Sin fotos todavía:
 *      pídele al propietario…», sin «Le falta» ni «Crear atajos»
 *   i) Propietario: resumen de faltantes, «Listo para mandar» / «Le falta: …»
 *      / «Le faltan las fotos» / pausado por producto; en el detalle
 *      «¿Listo para mandar?», «Falta crearlo» antes de «Crear atajos» y «Ya
 *      existe» después; subir una foto (CATALOG_STORAGE=local) lo deja «Listo
 *      para mandar»; tope de archivos en texto (lleno: motivo visible)
 *   j) Bandeja (Instagram): en el panel «Catálogo», el motivo de un archivo
 *      que no puede salir se lee completo, sin `title` (CA-2)
 *
 *   k) claro y oscuro, 1366 y 390 px sin desborde, en /catalog (los dos
 *      roles) y en las seis pestañas de /reports
 *
 * Presupuesto del limitador de login: 2 (owner + vendedora, por API).
 *
 * Uso (BD aislada RECIÉN RESETEADA, app con .env.e2e: mocks, AGENDA=on,
 * CHANNELS con instagram, CATALOG_STORAGE=local):
 *   CATALOG_STORAGE=local node --env-file=.env.e2e scripts/e2e-modulos-c.mjs
 *
 * Lee `DATABASE_URL` (la cita pasada se retrocede por SQL: la API no agenda
 * en el pasado). Con `REVISAR_DIR=<dir>` deja ahí fotos de cada pantalla
 * (claro/oscuro, 1366/390, Ventas con y sin ventas, impresión del Resumen).
 * Sale con código 1 si algún check falla.
 */
import { chromium } from "playwright";
import postgres from "postgres";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const S = Math.random().toString(36).slice(2, 7);
const PN = "PN-E2E-MODC";
const WABA = "WABA-E2E-MODC";
const IG = (process.env.CHANNELS ?? "").includes("instagram");
const AGENDA = !["", "off", "false", "0"].includes((process.env.AGENDA ?? "").trim().toLowerCase());
const REVISAR = process.env.REVISAR_DIR ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Foto para revisar a ojo. La app hace scroll DENTRO de un contenedor (no del
 * documento): para verla entera se agranda el viewport a su alto y se
 * restaura. `{ fullPage: false }` = solo lo visible.
 */
const shot = async (page, file, { fullPage = true } = {}) => {
  if (!REVISAR) return;
  const vp = page.viewportSize();
  if (fullPage) {
    const h = await page.evaluate(() =>
      Math.max(
        document.documentElement.scrollHeight,
        ...[...document.querySelectorAll("main, main *")]
          .filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY))
          .map((e) => e.scrollHeight + e.getBoundingClientRect().top)
      )
    );
    if (h > vp.height) await page.setViewportSize({ width: vp.width, height: Math.min(Math.ceil(h) + 40, 8000) });
    await sleep(400);
  }
  await page.screenshot({ path: `${REVISAR}/${file}`, animations: "disabled", caret: "hide" }).catch(() => {});
  if (fullPage) await page.setViewportSize(vp);
};

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
    const isForm = opts.body instanceof FormData;
    const res = await fetch(`${BASE}${p}`, {
      ...opts,
      headers: {
        ...(isForm ? {} : { "content-type": "application/json" }),
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
const OWNER = { email: "e2e@vocero.test", password: "password-e2e-123", name: "Operador E2E" };
const DANI = { email: "daniela.modc@vocero.test", password: "password-vend-123", name: "Daniela Ortiz" };

/* ---------- archivos mínimos (la política decide por la firma) ---------- */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);
const png = (n) => Buffer.concat([PNG, Buffer.from(`\n${S}-${n}`)]);
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
);
const TXT = Buffer.from("Medidas: 180 x 90 cm\nMadera de roble\n");
function upload(productId, name, data, mime) {
  const fd = new FormData();
  fd.set("file", new Blob([data], { type: mime }), name);
  return owner.api(`/api/catalog/products/${productId}/files`, { method: "POST", body: fd });
}

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
async function inbound(name, text) {
  const r = await owner.api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({ phoneNumberId: PN, from: phone(name), name, text, waMessageId: `wamid.e2e.modc.${S}.${seq++}` }),
  });
  if (!r.res.ok) ok(`inbound de ${name}`, false, short(r));
  await until(async () => !!(await convOf(name)));
  const c = await convOf(name);
  await owner.api(`/api/conversations/${c?.id}`, { method: "PATCH", body: body({ aiEnabled: false }) });
  return c;
}
async function reply(c, text) {
  const r = await owner.api(`/api/conversations/${c?.id}/messages`, { method: "POST", body: body({ text }) });
  ok(`respuesta a ${c?.contact?.name}`, r.res.ok, short(r));
}

function toBrowserCookies(jar, dark) {
  const host = new URL(BASE).hostname;
  return [
    ...jar.cookie
      .split(/;\s*/)
      .filter(Boolean)
      .map((pair) => {
        const i = pair.indexOf("=");
        return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: host, path: "/" };
      }),
    { name: "vocero-theme", value: dark ? "dark" : "light", domain: host, path: "/" },
  ];
}

let browser;
async function newPage(actor, { viewport = { width: 1366, height: 768 }, dark = false, permissions = null, noClipboard = false } = {}) {
  const ctx = await browser.newContext({ viewport });
  await ctx.route("**/api/events*", (route) => route.abort());
  await ctx.addCookies(toBrowserCookies(actor.jar, dark));
  if (permissions) await ctx.grantPermissions(permissions, { origin: BASE });
  await ctx.addInitScript((noClip) => {
    if (noClip) {
      try {
        Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined, configurable: true });
      } catch {}
    }
    document.addEventListener("DOMContentLoaded", () => {
      const s = document.createElement("style");
      s.textContent = "nextjs-portal{display:none!important}";
      document.head.appendChild(s);
    });
  }, noClipboard);
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  return { ctx, page };
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
/**
 * CA-2 en el MÓDULO (`main`). `allowTruncatedName`: en Anuncios el nombre de
 * un anuncio recortado lleva su nombre completo en `title` (aceptado).
 */
const noTooltips = async (page, where, { allowTruncatedName = false } = {}) => {
  const main = page.locator("main");
  const titles = await main.locator("[title]").evaluateAll(
    (els, allow) =>
      els
        .filter((e) => !(allow && e.tagName === "SPAN" && e.classList.contains("truncate") && e.getAttribute("title") === e.textContent))
        .map((e) => `${e.tagName}:${e.getAttribute("title")}`),
    allowTruncatedName
  );
  ok(`${where}: ningún atributo title`, titles.length === 0, JSON.stringify(titles.slice(0, 5)));
  const text = await main.innerText();
  const icons = await main.locator("svg.lucide-info, svg.lucide-circle-help, svg.lucide-help-circle, svg.lucide-circle-question-mark").count();
  ok(`${where}: ningún ícono ⓘ`, !text.includes("ⓘ") && icons === 0, `texto ⓘ=${text.includes("ⓘ")} íconos=${icons}`);
};

/* ───────────────────────── setup ───────────────────────── */

const N = {
  atendida: `Andrea Cruz ${S}`,
  espera: `Bruno Díaz ${S}`,
  venta: `Carla Mena ${S}`,
};

async function setup() {
  console.log("== Setup ==");
  let su = await owner.api("/api/auth/sign-up/email", { method: "POST", body: body(OWNER) });
  if (!su.res.ok) su = await owner.api("/api/auth/sign-in/email", { method: "POST", body: body({ email: OWNER.email, password: OWNER.password }) });
  ok("owner con sesión", su.res.ok, short(su));
  const conn = await owner.api("/api/settings/whatsapp", { method: "PUT", body: body({ wabaId: WABA, phoneNumberId: PN, token: "tok-e2e-modc" }) });
  ok("WhatsApp (wa-mock)", conn.res.ok, short(conn));
  await owner.api("/api/agent/profile", { method: "PUT", body: body({ name: "Lumi", tone: "breve", instructions: "Mueblería.", enabled: false }) });
  const add = await owner.api("/api/settings/team", { method: "POST", body: body(DANI) });
  ok(`alta de ${DANI.name}`, add.res.status === 201 || add.res.status === 409, short(add));
  const si = await dani.api("/api/auth/sign-in/email", { method: "POST", body: body({ email: DANI.email, password: DANI.password }) });
  ok(`${DANI.name} inicia sesión`, si.res.ok, short(si));
  const members = (await owner.api("/api/settings/team")).json?.members ?? [];
  return { daniId: members.find((m) => m.email === DANI.email)?.userId ?? null };
}

/* ───────────────────────── Reportes ───────────────────────── */

const TABS = [
  ["summary", "Resumen"],
  ["agent", "Agente"],
  ...(AGENDA ? [["bookings", "Citas"]] : []),
  ["sales", "Ventas"],
  ["sellers", "Vendedores"],
  ["ads", "Anuncios"],
];

/** Espera a que la pestaña termine de cargar (el botón del PDF se habilita). */
async function gotoReport(page, tab, qs = "") {
  await page.goto(`${BASE}/reports/${tab}${qs}`, { waitUntil: "load", timeout: 90000 });
  await page.getByTestId("report-print").waitFor({ timeout: 60000 });
  const loaded = await until(async () => await page.getByTestId("report-print").isEnabled(), 60000);
  await until(async () => (await page.locator("main [aria-busy='true']").count()) === 0, 20000);
  await sleep(500);
  return loaded;
}

async function reportsEmptyChecks() {
  console.log("\n== a) Sin pendientes: «Nada pendiente»; Ventas sin ventas ==");
  const c = await inbound(N.atendida, "Hola, ¿tienen salas en gris?");
  await reply(c, "¡Hola Andrea! Sí, en gris Oxford.");
  const { ctx, page } = await newPage(owner);
  ok("Resumen cargó", await gotoReport(page, "summary"));
  const today = page.getByTestId("summary-today");
  ok("«Lo que toca hoy» visible", await until(async () => await today.isVisible(), 20000));
  const t = (await today.innerText().catch(() => "")) ?? "";
  ok("sin pendientes: «Nada pendiente: nadie espera respuesta…»", t.includes("Nada pendiente") && (await today.locator("[data-today]").count()) === 0, t);

  ok("Ventas cargó", await gotoReport(page, "sales"));
  const empty = page.getByTestId("sales-empty");
  ok("Ventas sin ventas → `sales-empty`", await until(async () => await empty.isVisible(), 20000));
  const et = (await empty.innerText().catch(() => "")) ?? "";
  ok("explica cómo se registra una venta («Una venta se cuenta cuando…» «Cliente»)", et.includes("Una venta se cuenta cuando") && et.includes("«Cliente»"), et.slice(0, 200));
  ok("muestra el embudo de hoy (`sales-empty-funnel`)", await page.getByTestId("sales-empty-funnel").isVisible());
  ok("…con la etapa «Nuevo» y su conteo", ((await page.getByTestId("sales-empty-funnel").innerText()) ?? "").includes("Nuevo"));
  ok("sin ventas no se pintan los KPI de ventas", (await page.getByTestId("kpi-sales-won").count()) === 0);
  await shot(page, "modc-ventas-sin-ventas-1366.png");
  const go = empty.getByRole("link", { name: "Ir a Seguimiento" });
  ok("«Ir a Seguimiento» → /pipeline", (await go.getAttribute("href"))?.startsWith("/pipeline"), String(await go.getAttribute("href")));
  await go.click();
  ok("…y abre Seguimiento", await until(async () => new URL(page.url()).pathname === "/pipeline", 30000), page.url());
  await ctx.close();
}

function shopSlot(offsetDays, hour) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays, hour + 6)).toISOString();
}

async function seedPending({ daniId }) {
  console.log("\n== b) Siembra de pendientes ==");
  const espera = await inbound(N.espera, "¿Me pasas el precio del comedor?");
  const as = await owner.api(`/api/conversations/${espera?.id}/assign`, { method: "POST", body: body({ userId: daniId }) });
  ok(`${N.espera} a nombre de Daniela (sin responder)`, as.res.ok, short(as));

  const venta = await inbound(N.venta, "Ya hice la transferencia.");
  await reply(venta, "¡Gracias, Carla! Te aviso cuando salga.");
  const board = (await owner.api("/api/pipeline/board")).json;
  const won = board?.stages?.find((s) => s.kind === "won");
  const lead = board?.leads?.find((l) => l.contact?.name === N.venta);
  const mv = await owner.api(`/api/pipeline/leads/${lead?.id}`, { method: "PATCH", body: body({ stageId: won?.id }) });
  ok(`${N.venta} → «${won?.name}» sin monto (venta)`, mv.res.ok, short(mv));

  // Un saliente que Meta rechaza con un código conocido.
  await reply(venta, "Te comparto la factura.");
  const outbox = (await owner.api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  const waMessageId = outbox.at(-1)?.waMessageId;
  const st = await owner.api("/api/dev/wa-mock/status", {
    method: "POST",
    body: body({ waMessageId, status: "failed", errorCode: 131026, errorMessage: "Message undeliverable" }),
  });
  ok("Meta rechaza un saliente (131026)", st.res.ok, short(st));

  if (AGENDA) {
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
    const typeId = t.json?.type?.id ?? ((await owner.api("/api/calendar/types")).json?.types ?? []).find((x) => x.name === `Visita ${S}`)?.id;
    const at = await convOf(N.atendida);
    const bk = await owner.api("/api/bookings", {
      method: "POST",
      body: body({ kind: "session", contactId: at?.contact?.id, conversationId: at?.id, startUtc: shopSlot(1, 10), typeId, assignedUserId: daniId, confirmOverlap: true }),
    });
    ok("cita de Andrea", bk.res.status === 201, short(bk));
    const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
    try {
      const moved = await sql`update vocero.booking set scheduled_at = scheduled_at - interval '2 days' where id = ${bk.json?.booking?.id}`;
      ok("la cita queda AYER, sin resultado", moved.count === 1);
    } finally {
      await sql.end();
    }
  }
}

async function todayChecks() {
  console.log("\n== b) «Lo que toca hoy» con pendientes y sus enlaces ==");
  const { ctx, page } = await newPage(owner);
  ok("Resumen cargó", await gotoReport(page, "summary"));
  const today = page.getByTestId("summary-today");
  const keys = await today.locator("[data-today]").evaluateAll((els) => els.map((e) => e.getAttribute("data-today")));
  const want = ["pending", "team-pending", "without-amount", ...(AGENDA ? ["to-mark"] : [])];
  ok(`pendientes: ${want.join(", ")}`, want.every((k) => keys.includes(k)), JSON.stringify(keys));
  const t = (await today.innerText()) ?? "";
  ok("«persona espera respuesta» · «Ir a la Bandeja»", t.includes("persona espera respuesta") && t.includes("Ir a la Bandeja"), t);
  ok("«sin responder de Daniela Ortiz» · «Ver Vendedores»", t.includes("sin responder de Daniela Ortiz") && t.includes("Ver Vendedores"), t);
  ok("«venta sin monto: no suma al total» · «Captúralo en Seguimiento»", t.includes("venta sin monto") && t.includes("Captúralo en Seguimiento"), t);
  if (AGENDA) ok("«cita ya pasó y nadie marcó si vino» · «Márcalas en Citas»", t.includes("cita ya pasó") && t.includes("Márcalas en Citas"), t);
  ok("ya no dice «Nada pendiente»", !t.includes("Nada pendiente"));
  await shot(page, "modc-resumen-con-pendientes-1366.png");

  // Cada enlace: se hace clic y la pantalla de destino aparece.
  const dest = {
    // Bruno es de Daniela: el Buzón (lo que abre el Propietario) no lo mostraría.
    pending: { path: "/inbox", ready: (p) => p.getByText(N.espera).first() },
    "team-pending": { path: "/reports/sellers", ready: (p) => p.getByTestId("sellers-roster") },
    "without-amount": { path: "/pipeline", ready: (p) => p.getByText(N.venta).first() },
    "to-mark": { path: "/bookings", ready: (p) => p.getByTestId("bookings-todo") },
  };
  for (const k of want) {
    // Con un rango explícito en la URL: el enlace a Vendedores lo conserva.
    await gotoReport(page, "summary", "?range=7d");
    const link = page.getByTestId("summary-today").locator(`[data-today="${k}"] a`);
    const href = await link.getAttribute("href");
    await link.click();
    const arrived = await until(async () => new URL(page.url()).pathname === dest[k].path, 30000);
    const shown = arrived && (await dest[k].ready(page).waitFor({ timeout: 45000 }).then(() => true).catch(() => false));
    ok(`enlace «${k}» (${href}) abre ${dest[k].path} con su contenido`, arrived && shown, page.url());
    if (k === "pending") ok("…a «Equipo · Por atender» (el pendiente es de Daniela)", href === "/inbox?scope=team&filter=human", String(href));
    if (k === "team-pending") ok("…conservando el rango del reporte", new URL(page.url()).searchParams.get("range") === "7d", page.url());
  }

  console.log("\n== b) Ventas con una venta ganada ==");
  ok("Ventas cargó", await gotoReport(page, "sales"));
  ok("con una venta: sin `sales-empty`", (await page.getByTestId("sales-empty").count()) === 0);
  ok("…y con sus bloques (KPI de ventas, «Ventas por día»)", (await page.getByTestId("kpi-sales-won").isVisible()) && (await page.getByText("Ventas por día").count()) > 0);
  ok("«1 venta sin monto» avisada en Ventas", (await page.getByTestId("sales-without-amount").count()) === 1);
  await shot(page, "modc-ventas-con-venta-1366.png");
  await ctx.close();
}

async function tabsChecks() {
  console.log("\n== c) + d) Las pestañas: definiciones, sin ⓘ, sin jerga, zona legible ==");
  const { ctx, page } = await newPage(owner);
  for (const [tab, label] of TABS) {
    ok(`${label}: cargó`, await gotoReport(page, tab));
    const main = page.locator("main");
    const kpis = main.locator('[role="group"][data-testid^="kpi-"]');
    const n = await kpis.count();
    const defs = await kpis.evaluateAll((els) =>
      els.map((e) => {
        const d = document.getElementById(e.getAttribute("aria-describedby") ?? "");
        const r = d?.getBoundingClientRect();
        return { id: e.getAttribute("data-testid"), text: d?.textContent?.trim() ?? "", visible: !!r && r.height > 0 && getComputedStyle(d).visibility !== "hidden" };
      })
    );
    const bad = defs.filter((d) => d.text.length < 12 || !d.visible);
    ok(`${label}: ${n} KPI, cada uno con su definición visible`, (tab === "ads" || n > 0) && bad.length === 0, JSON.stringify(bad));
    await noTooltips(page, `/reports/${tab}`, { allowTruncatedName: tab === "ads" });
    const text = (await main.innerText()) ?? "";
    ok(`${label}: sin «mediana» ni «p90»`, !/mediana|p90|percentil/i.test(text), (text.match(/.{0,40}(mediana|p90|percentil).{0,40}/i) ?? [""])[0]);
    const page2 = (await page.locator("body").innerText()) ?? "";
    ok(`${label}: la zona dice «hora de Ciudad de México», no «America/Mexico_City»`, page2.includes("hora de Ciudad de México") && !page2.includes("America/Mexico_City"));
    if (tab === "agent") {
      ok("Agente: «Pasadas a una persona» (antes «Escalamientos»)", text.includes("Pasadas a una persona") && !text.includes("Escalamientos"));
      ok("Agente: «Mensajes que no salieron»", text.includes("Mensajes que no salieron"));
      const why = main.getByRole("list", { name: "Por qué no salieron" });
      const wt = (await why.innerText().catch(() => "")) ?? "";
      ok("el error de Meta 131026 dicho en una frase", wt.includes("El destinatario no puede recibir mensajes de WhatsApp"), wt);
      ok("…con el código aparte («código Meta 131026») y sin el crudo «(#131026)»", wt.includes("código Meta 131026") && !wt.includes("(#131026)"), wt);
    }
  }
  await ctx.close();
}

async function printReasonChecks() {
  console.log("\n== e) «Descargar PDF»: motivo visible mientras carga ==");
  const { ctx, page } = await newPage(owner);
  let hold = true;
  await ctx.route("**/api/reports/summary*", async (route) => {
    while (hold) await sleep(200);
    await route.continue();
  });
  await page.goto(`${BASE}/reports/summary`, { waitUntil: "load", timeout: 90000 });
  const btn = page.getByTestId("report-print");
  await btn.waitFor();
  const reason = page.getByTestId("report-print-reason");
  ok("cargando: «Descargar PDF» deshabilitado", await btn.isDisabled());
  ok("…con el motivo a la vista: «Se activa cuando el reporte termina de cargar.»", (await reason.isVisible()) && ((await reason.textContent()) ?? "").includes("Se activa cuando el reporte termina de cargar"));
  ok("…y el botón lo anuncia (`aria-describedby`)", (await btn.getAttribute("aria-describedby")) === "report-print-reason");
  ok("…sin `title`", (await btn.getAttribute("title")) === null);
  hold = false;
  ok("al cargar: habilitado y sin motivo", await until(async () => (await btn.isEnabled()) && (await reason.count()) === 0, 60000));
  await ctx.close();
}

async function printChecks() {
  console.log("\n== f) Impresión del Resumen ==");
  const { ctx, page } = await newPage(owner);
  await gotoReport(page, "summary");
  await page.emulateMedia({ media: "print" });
  await sleep(600);
  ok("en papel no sale «Lo que toca hoy»", !(await page.getByTestId("summary-today").isVisible()));
  ok("en papel sí sale el encabezado del reporte", await page.getByTestId("report-print-header").isVisible());
  ok("en papel no salen las pestañas ni el botón", !(await page.getByTestId("report-print").isVisible()));
  ok("en papel, sin desborde horizontal", await noHScroll(page));
  const kpiHelp = await page.getByTestId("kpi-summary-persons").innerText();
  ok("en papel la definición del KPI sigue ahí", kpiHelp.length > 20, kpiHelp);
  await shot(page, "modc-resumen-impresion.png");
  if (REVISAR) await page.pdf({ path: `${REVISAR}/modc-resumen.pdf`, format: "Letter", printBackground: true }).catch(() => {});
  await ctx.close();
}

async function sellerNoReports() {
  console.log("\n== g) La vendedora no entra a Reportes ==");
  const r = await dani.api("/reports/summary");
  ok("GET /reports/summary como vendedora → 404", r.res.status === 404, String(r.res.status));
  const api = await dani.api("/api/reports/summary");
  ok("GET /api/reports/summary como vendedora → 403/404", [403, 404].includes(api.res.status), String(api.res.status));
  const { ctx, page } = await newPage(dani);
  await page.goto(`${BASE}/catalog`, { waitUntil: "load", timeout: 90000 });
  await page.getByTestId("catalog-how-to-send").waitFor({ timeout: 60000 });
  ok("sin «Reportes» en el menú de la vendedora", (await page.getByRole("link", { name: "Reportes" }).count()) === 0);
  await ctx.close();
}

/* ───────────────────────── Catálogo ───────────────────────── */

const P = {};
async function seedCatalog() {
  console.log("\n== Siembra del catálogo ==");
  const cat = await owner.api("/api/catalog/categories", { method: "POST", body: body({ name: `Salas ${S}` }) });
  const cid = cat.json?.category?.id;
  const mk = async (key, data) => {
    const r = await owner.api("/api/catalog/products", { method: "POST", body: body({ categoryId: cid, ...data }) });
    ok(`producto ${data.name}`, r.res.status === 201, short(r));
    P[key] = { id: r.json?.product?.id, ...data };
  };
  const code = (c) => `${c}${S}`.toUpperCase();
  await mk("lista", { name: `Sala modular Lisboa ${S}`, code: code("SAL"), price: "$18,900" });
  await mk("sinFicha", { name: `Comedor Nogal ${S}`, code: code("COM"), price: "$24,500" });
  await mk("pausado", { name: `Comedor Roble ${S}`, code: code("ROB"), price: "$16,800" });
  await mk("sinCodigo", { name: `Mesa de centro ${S}`, price: "$6,200" });
  await mk("sinFotos", { name: `Librero Roble ${S}`, code: code("LIB"), price: "$9,400" });
  let n = 0;
  for (const [k, files] of [
    ["lista", ["foto", "foto", "pdf", "txt"]],
    ["sinFicha", ["foto"]],
    ["sinCodigo", ["pdf"]],
    ["sinFotos", ["pdf"]],
  ]) {
    for (const f of files) {
      const r =
        f === "foto"
          ? await upload(P[k].id, `foto-${n}.png`, png(n++), "image/png")
          : f === "pdf"
            ? await upload(P[k].id, `ficha-${n++}.pdf`, PDF, "application/pdf")
            : await upload(P[k].id, `medidas-${n++}.txt`, TXT, "text/plain");
      ok(`${P[k].name}: ${f}`, r.res.status === 201, short(r));
    }
  }
  const off = await owner.api(`/api/catalog/products/${P.pausado.id}`, { method: "PATCH", body: body({ active: false }) });
  ok(`${P.pausado.name} pausado`, off.res.ok, short(off));
  // Atajos: los dos de Lisboa y solo el de fotos de Nogal (como el diseño).
  const lc = (k) => P[k].code.toLowerCase();
  for (const [k, kind, attach] of [["lista", "fotos", "images"], ["lista", "ficha", "documents"], ["sinFicha", "fotos", "images"]]) {
    const r = await owner.api("/api/quick-replies", {
      method: "POST",
      body: body({ shortcut: `${kind}_${lc(k)}`, title: `${kind} ${P[k].name}`, body: `Te comparto ${kind === "fotos" ? "las fotos" : "la ficha"} de {{producto}}`, productId: P[k].id, attach }),
    });
    ok(`atajo /${kind}_${lc(k)}`, r.res.status === 201, short(r));
  }
}

const card = (page, key) => page.locator(`[data-testid="catalog-product"][data-product-id="${P[key].id}"]`);
const cardBox = (page, key) => page.locator("main ul[aria-label='Productos'] > li").filter({ has: card(page, key) });
async function gotoCatalog(page) {
  await page.goto(`${BASE}/catalog`, { waitUntil: "load", timeout: 90000 });
  await page.locator('[data-testid="catalog-product"]').first().waitFor({ timeout: 60000 });
  await sleep(800);
}

async function sellerCatalogChecks() {
  console.log("\n== h) Catálogo como vendedora ==");
  const { ctx, page } = await newPage(dani, { permissions: ["clipboard-read", "clipboard-write"] });
  await gotoCatalog(page);
  const how = page.getByTestId("catalog-how-to-send");
  const ht = (await how.innerText().catch(() => "")) ?? "";
  ok("«Para mandarle un producto a un cliente:» con sus 2 pasos", ht.includes("Para mandarle un producto a un cliente:") && ht.includes("Abre su chat en la Bandeja") && ht.includes("Toca «Catálogo»"), ht);
  ok("…y que aquí solo se consulta", ht.includes("los productos los carga el propietario"));
  ok("la vendedora no ve el resumen de faltantes", (await page.getByTestId("catalog-summary").count()) === 0);

  const lista = cardBox(page, "lista");
  const sc = lista.getByTestId("catalog-shortcut");
  ok("Lisboa: sus 2 atajos con «Copiar»", (await sc.count()) === 2 && (await lista.getByRole("button", { name: /^Copiar \// }).count()) === 2);
  ok("Lisboa: «Escríbelo en el chat para mandarlo:»", ((await lista.innerText()) ?? "").includes("Escríbelo en el chat para mandarlo:"));
  const fotos = `/fotos_${P.lista.code.toLowerCase()}`;
  const copyBtn = lista.getByRole("button", { name: `Copiar ${fotos}` });
  await copyBtn.click();
  ok("«Copiar» → «Copiado»", await until(async () => ((await copyBtn.textContent()) ?? "").includes("Copiado"), 5000));
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `ERR ${e}`);
  ok(`el portapapeles tiene ${fotos}`, clip === fotos, clip);
  ok("…y vuelve a «Copiar» después", await until(async () => ((await copyBtn.textContent()) ?? "").trim() === "Copiar", 6000));

  const nogal = cardBox(page, "sinFicha");
  const nt = (await nogal.innerText()) ?? "";
  ok("Nogal: un atajo y «Sin ficha PDF. Desde «Catálogo» en el chat puedes mandar solo las fotos.»", (await nogal.getByTestId("catalog-shortcut").count()) === 1 && nt.includes("Sin ficha PDF"), nt);
  const mesa = cardBox(page, "sinCodigo");
  const mt = (await mesa.innerText()) ?? "";
  ok("Mesa sin código: «Sin atajo todavía: mándalo desde «Catálogo» en el chat.»", mt.includes("Sin atajo todavía"), mt);
  ok("Mesa sin fotos: «Sin fotos todavía: pídele al propietario que las suba.»", mt.includes("Sin fotos todavía: pídele al propietario que las suba."), mt);
  const pausa = cardBox(page, "pausado");
  const pt = (await pausa.innerText()) ?? "";
  ok("pausado: «Pausado: no se puede mandar»", (await pausa.getByTestId("catalog-readiness").getAttribute("data-state")) === "paused" && pt.includes("Pausado: no se puede mandar"), pt);
  ok("…y por qué: «El propietario lo pausó (por ejemplo, porque se agotó)…»", pt.includes("El propietario lo pausó"), pt);
  const all = (await page.locator("main").innerText()) ?? "";
  ok("la vendedora no ve «Le falta» ni «Listo para mandar»", !all.includes("Le falta") && !all.includes("Listo para mandar"));
  await noTooltips(page, "/catalog (vendedora)");

  // Detalle del pausado.
  await card(page, "pausado").click();
  const det = page.getByTestId("catalog-detail");
  await det.waitFor();
  ok("detalle del pausado: su motivo (`catalog-paused-reason`)", ((await det.getByTestId("catalog-paused-reason").textContent()) ?? "").includes("El propietario lo pausó"));
  ok("…y «Mientras esté pausado, sus atajos no aparecen en el chat.»", ((await det.getByTestId("catalog-shortcuts").innerText()) ?? "").includes("Mientras esté pausado"));
  await noTooltips(page, "/catalog detalle pausado (vendedora)");
  await det.getByRole("button", { name: "Cerrar detalle" }).click();

  // Detalle de Lisboa: atajos con «Copiar», sin gestión.
  await card(page, "lista").click();
  await det.waitFor();
  ok("detalle (vendedora): los atajos con «Copiar»", (await det.getByTestId("catalog-shortcuts").getByTestId("catalog-shortcut").count()) === 2);
  ok("…«Cópialo y pégalo en el chat del cliente…»", ((await det.getByTestId("catalog-shortcuts").innerText()) ?? "").includes("Cópialo y pégalo"));
  ok("…sin «¿Listo para mandar?» ni «Crear atajos»", (await det.getByTestId("catalog-ready-checks").count()) === 0 && (await det.getByRole("button", { name: "Crear atajos" }).count()) === 0);
  ok("…el tope de archivos en texto («4 de 20»)", ((await det.getByTestId("catalog-file-count").textContent()) ?? "").includes("4 de 20"));
  await ctx.close();

  console.log("\n== h) Sin portapapeles: el aviso de respaldo ==");
  {
    const { ctx: c2, page: p2 } = await newPage(dani, { noClipboard: true });
    await gotoCatalog(p2);
    const b = cardBox(p2, "lista").getByRole("button", { name: `Copiar ${fotos}` });
    await b.click();
    ok(`«No se pudo copiar: escribe ${fotos} en el chat.»`, await until(async () => (await cardBox(p2, "lista").getByText(`No se pudo copiar: escribe ${fotos} en el chat.`).count()) === 1, 5000));
    await c2.close();
  }
}

async function ownerCatalogChecks() {
  console.log("\n== i) Catálogo como Propietario ==");
  const { ctx, page } = await newPage(owner);
  await gotoCatalog(page);
  const sum = page.getByTestId("catalog-summary");
  const st = (await sum.innerText().catch(() => "")) ?? "";
  ok("resumen: «2 productos no se pueden mandar completos todavía»", (await sum.getAttribute("data-state")) === "missing" && st.includes("2 productos no se pueden mandar completos todavía"), st);
  ok("…qué le falta a cada uno (Mesa sin código, Librero sin fotos)", st.includes(`${P.sinCodigo.name} no tiene fotos y no tiene código`) && st.includes(`${P.sinFotos.name} no tiene fotos`), st);
  ok("…la nota de la ficha y la del pausado", st.includes("solo le falta la ficha PDF") && st.includes("1 producto está pausado"), st);
  ok("la vista del Propietario no lleva «Cómo mandar un producto»", (await page.getByTestId("catalog-how-to-send").count()) === 0);
  const label = async (k) => ((await cardBox(page, k).getByTestId("catalog-readiness").textContent()) ?? "").trim();
  ok("Lisboa: «Listo para mandar»", (await label("lista")) === "Listo para mandar", await label("lista"));
  ok("Nogal: «Le falta: ficha PDF»", (await label("sinFicha")) === "Le falta: ficha PDF", await label("sinFicha"));
  ok("Mesa: «Le falta: fotos y código»", (await label("sinCodigo")) === "Le falta: fotos y código", await label("sinCodigo"));
  ok("Librero: «Le falta: fotos y atajos»", (await label("sinFotos")) === "Le falta: fotos y atajos", await label("sinFotos"));
  ok("Roble: «Pausado: no se puede mandar»", (await label("pausado")) === "Pausado: no se puede mandar", await label("pausado"));
  await noTooltips(page, "/catalog (Propietario)");

  console.log("\n== i) Detalle: «¿Listo para mandar?», atajos antes y después ==");
  await card(page, "sinFotos").click();
  const det = page.getByTestId("catalog-detail");
  await det.waitFor();
  const checksBox = det.getByTestId("catalog-ready-checks");
  const ct = (await checksBox.innerText().catch(() => "")) ?? "";
  ok("«¿Listo para mandar?» con lo que tiene y lo que le falta", ct.includes("¿Listo para mandar?") && ct.includes("Precio: $9,400") && ct.includes("Sin fotos") && ct.includes("Sin atajos todavía"), ct);
  const pend = det.getByTestId("catalog-shortcut-pending");
  const pstates = await pend.evaluateAll((els) => els.map((e) => [e.getAttribute("data-status"), e.textContent]));
  ok("antes: los dos atajos «Falta crearlo»", pstates.length === 2 && pstates.every(([s, t]) => s === "missing" && t.includes("Falta crearlo")), JSON.stringify(pstates));
  await noTooltips(page, "/catalog detalle (Propietario)");
  const create = det.getByTestId("catalog-shortcuts").getByRole("button", { name: "Crear atajos" });
  await create.click();
  ok("después: los dos atajos ligados (con «Copiar») y sin «Falta crearlo»", await until(async () => (await det.getByTestId("catalog-shortcuts").getByTestId("catalog-shortcut").count()) === 2 && (await pend.count()) === 0, 20000));
  ok("…«Ya existen los dos; volver a tocarlo no cambia nada.»", await until(async () => ((await det.getByTestId("catalog-shortcuts").innerText()) ?? "").includes("Ya existen los dos"), 10000));
  const results = await det.getByTestId("catalog-shortcut-result").evaluateAll((els) => els.map((e) => e.getAttribute("data-status")));
  ok("…y el resultado de cada uno («created»)", results.length === 2 && results.every((s) => s === "created"), JSON.stringify(results));
  ok("la tarjeta pasa a «Le faltan las fotos»", await until(async () => (await label("sinFotos")) === "Le faltan las fotos", 10000), await label("sinFotos"));

  console.log("\n== i) Subir una foto lo deja «Listo para mandar» ==");
  await det.getByTestId("catalog-upload-input").setInputFiles({ name: "librero.png", mimeType: "image/png", buffer: png("ui") });
  ok("subida terminada", await until(async () => (await det.locator('[data-testid="catalog-upload"][data-status="done"]').count()) === 1, 30000));
  ok("«¿Listo para mandar?» ya no acusa faltantes", await until(async () => (await checksBox.getAttribute("data-state")) === "ready", 15000));
  ok("la tarjeta dice «Listo para mandar»", await until(async () => (await label("sinFotos")) === "Listo para mandar", 15000), await label("sinFotos"));
  ok("el resumen baja a «1 producto no se puede mandar completo todavía»", await until(async () => ((await sum.innerText()) ?? "").includes("1 producto no se puede mandar completo todavía"), 10000));
  const fc = (await det.getByTestId("catalog-file-count").textContent()) ?? "";
  ok("tope en texto: «2 de 20 · caben 18 más»", fc.includes("2 de 20") && fc.includes("caben 18 más"), fc);
  ok("…y «Hasta 20 archivos por producto.»", ((await det.innerText()) ?? "").includes("Hasta 20 archivos por producto."));
  await det.getByRole("button", { name: "Cerrar detalle" }).click();

  console.log("\n== i) Lleno: el motivo se lee junto al botón ==");
  let n = 100;
  for (let i = 0; i < 16; i++) await upload(P.lista.id, `extra-${i}.png`, png(n++), "image/png");
  await gotoCatalog(page);
  await card(page, "lista").click();
  await det.waitFor();
  const fc2 = (await det.getByTestId("catalog-file-count").textContent()) ?? "";
  ok("«20 de 20 · ya no caben más»", fc2.includes("20 de 20") && fc2.includes("ya no caben más"), fc2);
  const full = det.getByTestId("catalog-files-full");
  ok("motivo visible: «Ya tiene los 20 archivos que caben…: borra uno para subir otro.»", (await full.isVisible()) && ((await full.textContent()) ?? "").includes("borra uno para subir otro"));
  const upBtn = det.getByRole("button", { name: "Subir fotos o ficha" });
  ok("«Subir fotos o ficha» deshabilitado y descrito por el motivo, sin `title`", (await upBtn.isDisabled()) && (await upBtn.getAttribute("aria-describedby")) === "cf-full" && (await upBtn.getAttribute("title")) === null);
  await shot(page, "modc-catalogo-detalle-lleno-1366.png");
  await ctx.close();
}

async function panelChecks() {
  console.log("\n== j) Bandeja: motivo visible en el panel «Catálogo» (CA-2) ==");
  if (!IG) {
    console.log("  (CHANNELS sin instagram: se omite; el .txt sí sale por WhatsApp)");
    return;
  }
  const acc = "17841400000077";
  let r = await owner.api("/api/settings/instagram", { method: "PUT", body: body({ source: "meta", igUserId: acc, token: "tok-e2e-modc-ig" }) });
  ok("Instagram (mock)", r.res.ok, short(r));
  r = await owner.api("/api/dev/wa-mock/channel-inbound", {
    method: "POST",
    body: body({ channel: "instagram", accountId: acc, senderId: `ig-modc-${S}`, text: "¿Me mandas las medidas?", mid: `mid.e2e.modc.${S}` }),
  });
  ok("DM de Instagram", r.res.ok, short(r));
  let ig = null;
  await until(async () => {
    ig = (await conversations()).find((c) => c.channel === "instagram") ?? null;
    return !!ig;
  });
  ok("chat de Instagram", !!ig);
  await owner.api(`/api/conversations/${ig?.id}`, { method: "PATCH", body: body({ aiEnabled: false }) });
  for (const [vp, name] of [[{ width: 1366, height: 768 }, "1366"], [{ width: 390, height: 844 }, "390"]]) {
    const { ctx, page } = await newPage(owner, { viewport: vp });
    await page.goto(`${BASE}/inbox?contact=${ig?.contact?.id}`, { waitUntil: "load", timeout: 90000 });
    await page.locator("#composer").waitFor({ timeout: 60000 });
    const btn = page.getByRole("button", { name: "Catálogo", exact: true });
    const panel = page.getByRole("dialog", { name: "Catálogo" });
    ok(`${name}: panel «Catálogo» abierto`, await until(async () => {
      if ((await panel.count()) === 0) await btn.click();
      await sleep(500);
      return await panel.isVisible();
    }, 30000));
    await panel.getByRole("list", { name: "Productos" }).getByRole("button").filter({ hasText: P.lista.name }).click();
    const files = panel.getByRole("list", { name: "Archivos" });
    await files.waitFor();
    const row = files.locator("li").filter({ hasText: /^medidas-/ });
    await until(async () => (await row.count()) === 1, 10000);
    const titles = await panel.locator("[title]").evaluateAll((els) => els.map((e) => `${e.tagName}:${e.getAttribute("title")}`));
    ok(`${name}: el panel no explica nada con \`title\``, titles.length === 0, JSON.stringify(titles.slice(0, 4)));
    const reason = row.getByTestId("catalog-file-reason");
    const rt = (await reason.textContent().catch(() => "")) ?? "";
    ok(`${name}: el .txt dice por qué no sale («Instagram solo acepta…»)`, rt.includes("Instagram solo acepta"), rt);
    const clipped = await reason.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1).catch(() => true);
    ok(`${name}: …completo, sin recortar`, !clipped);
    ok(`${name}: su casilla deshabilitada`, await row.locator('input[type="checkbox"]').isDisabled());
    if (name === "390") ok("390: sin desborde horizontal con el panel abierto", await noHScroll(page));
    await shot(page, `modc-panel-catalogo-ig-${name}.png`, { fullPage: false });
    await ctx.close();
  }
}

/* ───────────────────────── k) claro/oscuro, 1366/390 ───────────────────────── */

async function layoutChecks() {
  console.log("\n== k) Claro y oscuro, 1366 y 390 px ==");
  for (const dark of [false, true]) {
    for (const [vp, vpName] of [[{ width: 1366, height: 768 }, "1366"], [{ width: 390, height: 844 }, "390"]]) {
      const tag = `${dark ? "oscuro" : "claro"} ${vpName}`;
      for (const [actor, who] of [[dani, "vend"], [owner, "prop"]]) {
        const { ctx, page } = await newPage(actor, { viewport: vp, dark });
        await gotoCatalog(page);
        ok(`/catalog ${who} ${tag}: tema aplicado`, (await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) === (dark ? "dark" : "light"));
        ok(`/catalog ${who} ${tag}: sin desborde horizontal`, await noHScroll(page));
        const wide = await page.locator("main ul[aria-label='Productos'] > li").evaluateAll((lis) => lis.filter((li) => li.scrollWidth > li.clientWidth + 1).length);
        ok(`/catalog ${who} ${tag}: ninguna tarjeta se desborda por dentro`, wide === 0, String(wide));
        await shot(page, `modc-${who}-catalogo-${dark ? "oscuro" : "claro"}-${vpName}.png`);
        if (who === "prop") {
          await card(page, "sinFicha").click();
          await page.getByTestId("catalog-detail").waitFor();
          await sleep(500);
          ok(`/catalog detalle ${tag}: sin desborde horizontal`, await noHScroll(page));
          await shot(page, `modc-prop-catalogo-detalle-${dark ? "oscuro" : "claro"}-${vpName}.png`, { fullPage: false });
          await page.getByTestId("catalog-detail").getByRole("button", { name: "Cerrar detalle" }).click();
          for (const [tab] of TABS) {
            await gotoReport(page, tab);
            ok(`/reports/${tab} ${tag}: sin desborde horizontal`, await noHScroll(page));
            await shot(page, `modc-prop-reportes-${tab}-${dark ? "oscuro" : "claro"}-${vpName}.png`);
          }
        }
        await ctx.close();
      }
    }
  }
}

async function main() {
  browser = await chromium.launch();
  try {
    const ids = await setup();
    await reportsEmptyChecks();
    await seedPending(ids);
    await todayChecks();
    await tabsChecks();
    await printReasonChecks();
    await printChecks();
    await seedCatalog();
    await sellerNoReports();
    await sellerCatalogChecks();
    await ownerCatalogChecks();
    await panelChecks();
    await layoutChecks();
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
