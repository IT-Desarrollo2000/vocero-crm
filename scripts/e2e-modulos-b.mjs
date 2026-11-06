/**
 * Self-test E2E — 032 Fase B: Contactos «que se explican solos».
 * Guion humano: tests/e2e/us-modulos-b.md
 *
 * Contra la app VIVA (mocks), como Propietario, Vendedora (Daniela) y un
 * segundo vendedor (Marco):
 *
 *   a) API `archived`: `only` = solo archivados, `exclude` (y sin parámetro)
 *      = solo activos, `true` = todos (sentido viejo); `counts` cuadra
 *   b) UI «Activos · N / Archivados · M»: conteos de la API; «Archivados»
 *      muestra SOLO archivados
 *   c) Archivar → aviso «Archivaste a X…» → «Deshacer» lo regresa (API);
 *      «Desarchivar» desde Archivados
 *   d) acción por fila (vendedora): ventana abierta, cerrada, nunca escribió
 *      con teléfono, sin teléfono (BSUID con chat; y sin chat), Instagram
 *      (con chat a 3 días; y sin chat) si `CHANNELS` lo trae, de otro
 *      vendedor, sin tomar
 *   e) la misma fila de otro vendedor y la sin tomar vistas por el Propietario
 *   f) «Tomar y responder» asigna (API) y lleva a /inbox?contact=; si otro lo
 *      tomó antes: aviso, sin reasignar
 *   g) «Escribir primero»: 3 pasos, motivos visibles del botón, envío por
 *      wa-mock y abre el chat
 *   h) errores: carga 500 → «No se pudieron cargar los contactos.» +
 *      «Reintentar» (≠ vacío); fallo al archivar visible y sin archivar
 *   i) botones deshabilitados con su motivo (Editar, Nuevo contacto)
 *   j) ningún `title` ni ícono ⓘ en `main`; sin desborde a 390 px
 *
 * Los dos estados sin conversación que la API no puede crear (WhatsApp sin
 * teléfono, Instagram sin chat) se siembran por SQL en `vocero.contact`.
 *
 * Presupuesto del limitador de login: 3 (owner + 2 vendedores, por API).
 *
 * Uso (BD aislada RECIÉN RESETEADA, app con .env.e2e):
 *   CATALOG_STORAGE=local node --env-file=.env.e2e scripts/e2e-modulos-b.mjs
 *
 * Lee `DATABASE_URL` (siembra SQL). Con `REVISAR_DIR=<dir>` deja ahí fotos
 * del diálogo «Escribir primero» (1366 y 390) para revisarlas a ojo. Sale con código 1 si algún check falla.
 */
import { chromium } from "playwright";
import postgres from "postgres";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const S = Math.random().toString(36).slice(2, 7);
const PN = "PN-E2E-MODB";
const WABA = "WABA-E2E-MODB";
const IG = (process.env.CHANNELS ?? "").includes("instagram");
/** Opcional: carpeta donde dejar fotos del diálogo para revisarlas a ojo. */
const REVISAR = process.env.REVISAR_DIR ?? null;
const shot = async (page, file) => {
  if (REVISAR) await page.screenshot({ path: `${REVISAR}/${file}`, animations: "disabled", caret: "hide" }).catch(() => {});
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
const DANI = { email: "daniela.modb@vocero.test", password: "password-vend-123", name: "Daniela Ortiz" };
const MARCO = { email: "marco.modb@vocero.test", password: "password-vend-456", name: "Marco Ríos" };

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
async function inbound(name, text, { hoursAgo = 0, bsuid = null } = {}) {
  const r = await owner.api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({
      phoneNumberId: PN,
      ...(bsuid ? { fromUserId: bsuid } : { from: phone(name) }),
      name,
      text,
      waMessageId: `wamid.e2e.modb.${S}.${seq++}.${Math.random().toString(36).slice(2, 7)}`,
      ...(hoursAgo ? { timestamp: Math.floor(Date.now() / 1000) - hoursAgo * 3600 } : {}),
    }),
  });
  if (!r.res.ok) ok(`inbound de ${name}`, false, short(r));
  await until(async () => !!(await convOf(name)));
  return convOf(name);
}
async function contactsApi(c, qs) {
  return (await c.api(`/api/contacts?${qs}`)).json;
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
async function newPage(actor, { viewport = { width: 1366, height: 768 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  await ctx.route("**/api/events*", (route) => route.abort());
  await ctx.addCookies(toBrowserCookies(actor.jar));
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  return { ctx, page };
}
const rows = (page) => page.locator("main ul > li");
const row = (page, name) => rows(page).filter({ has: page.getByText(name, { exact: true }) });
const segBtn = (page, label) => page.getByRole("button", { name: new RegExp(`^${label} · \\d+$`) });
const segCount = async (page, label) => Number(((await segBtn(page, label).textContent()) ?? "").split("·")[1]?.trim());
async function gotoContacts(page) {
  await page.goto(`${BASE}/contacts`, { waitUntil: "load", timeout: 90000 });
  await page.getByLabel("Buscar contacto").waitFor({ timeout: 60000 });
  await until(async () => (await rows(page).count()) > 0, 30000);
  await sleep(600);
}
async function rowNames(page) {
  return rows(page).evaluateAll((lis) => lis.map((li) => li.querySelector("span.truncate")?.textContent?.trim() ?? ""));
}
const statusOf = async (page, name) => ((await row(page, name).getByTestId("contact-status").textContent()) ?? "").replace(/ /g, " ");
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
/** CA-2 en el MÓDULO (`main`): la barra lateral es de toda la app (031). */
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
  const conn = await owner.api("/api/settings/whatsapp", { method: "PUT", body: body({ wabaId: WABA, phoneNumberId: PN, token: "tok-e2e-modb" }) });
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
  // Dos plantillas: así «Elige el mensaje» arranca sin elegir (motivo visible).
  for (const t of [
    { name: `bienvenida_${S}`, body: "Hola {{1}}, soy de la tienda. ¿En qué te podemos ayudar?" },
    { name: `promo_${S}`, body: "Hola {{1}}, esta semana hay {{2}} en salas." },
  ]) {
    await owner.api("/api/templates", { method: "POST", body: body({ ...t, language: "es_MX", category: "UTILITY" }) });
    await owner.api("/api/dev/wa-mock/template-status", { method: "POST", body: body({ wabaId: WABA, name: t.name, language: "es_MX", event: "APPROVED", notify: false }) });
  }
  await owner.api("/api/templates/sync", { method: "POST" });
  const approved = ((await owner.api("/api/templates")).json?.templates ?? []).filter((t) => t.status === "approved");
  ok("2 plantillas aprobadas", approved.length === 2, JSON.stringify(approved.map((t) => [t.name, t.status])));
  return { daniId, marcoId };
}

const N = {
  abierta: `Ana Abierta ${S}`,
  cerrada: `Beto Cerrada ${S}`,
  nunca: `Ceci Nunca ${S}`,
  bsuid: `Dora Bsuid ${S}`,
  sinTel: `Eli SinTel ${S}`,
  ig: `Fer Insta ${S}`,
  igSin: `Gil InstaSin ${S}`,
  ajena: `Hugo Marco ${S}`,
  libre: `Iris Libre ${S}`,
  carrera: `Juan Carrera ${S}`,
  arch1: `Karla Archivada ${S}`,
  arch2: `Luis Archivar ${S}`,
  fallo: `Mara Fallo ${S}`,
};

async function seed({ daniId, marcoId }) {
  console.log("\n== Siembra ==");
  const assign = async (name, userId) => {
    const c = await convOf(name);
    const r = await owner.api(`/api/conversations/${c?.id}/assign`, { method: "POST", body: body({ userId }) });
    if (!r.res.ok) ok(`asignar ${name}`, false, short(r));
  };
  await inbound(N.abierta, "Hola, ¿tienen la sala en gris?");
  await inbound(N.cerrada, "Mándame la cotización", { hoursAgo: 30 });
  await inbound(N.bsuid, "Hola, vi su anuncio", { bsuid: `MX.bsuid.${S}` });
  await inbound(N.ajena, "¿Hacen envíos?");
  await inbound(N.libre, "Buenas, quiero información");
  await inbound(N.carrera, "¿Cuánto cuesta el comedor?");
  await inbound(N.arch1, "Gracias, ya no");
  await inbound(N.arch2, "Luego te aviso");
  await inbound(N.fallo, "Lo pienso");
  for (const n of [N.abierta, N.cerrada, N.bsuid, N.ajena, N.libre, N.carrera, N.arch1, N.arch2, N.fallo]) {
    const c = await convOf(n);
    await owner.api(`/api/conversations/${c?.id}`, { method: "PATCH", body: body({ aiEnabled: false }) });
  }
  for (const n of [N.abierta, N.cerrada, N.bsuid, N.arch1, N.arch2, N.fallo]) await assign(n, daniId);
  await assign(N.ajena, marcoId);

  const nunca = await owner.api("/api/contacts", { method: "POST", body: body({ name: N.nunca, phone: phone(N.nunca), source: "referido" }) });
  ok("alta a mano (nunca escribió)", nunca.res.status === 201, short(nunca));

  if (IG) {
    const acc = `1784${String(Date.now()).slice(-6)}`;
    let r = await owner.api("/api/settings/instagram", { method: "PUT", body: body({ source: "meta", igUserId: acc, token: "tok-e2e-modb-ig" }) });
    ok("conectar Instagram (mock)", r.res.ok, short(r));
    r = await owner.api("/api/dev/wa-mock/channel-inbound", {
      method: "POST",
      body: body({ channel: "instagram", accountId: acc, senderId: `ig${S}1`, text: "¿Tienen envíos?", mid: `mid.e2e.modb.${S}`, timestamp: Date.now() - 3 * 24 * 3600 * 1000 }),
    });
    ok("DM de Instagram de hace 3 días", r.res.ok, short(r));
    let ig = null;
    await until(async () => {
      ig = (await conversations()).find((c) => c.channel === "instagram") ?? null;
      return !!ig;
    });
    ok("conversación de Instagram", !!ig);
    await owner.api(`/api/conversations/${ig?.id}`, { method: "PATCH", body: body({ aiEnabled: false }) });
    await owner.api(`/api/contacts/${ig?.contact?.id}`, { method: "PATCH", body: body({ name: N.ig }) });
    await assign(N.ig, daniId);
  }

  // Estados sin conversación que la API no crea: WhatsApp sin teléfono
  // (BSUID cuyo chat no existe) e Instagram sin chat.
  const orgId = (await convOf(N.abierta))?.contact?.id;
  const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const org = await sql`select organization_id from vocero.contact where id = ${orgId}`;
    const o = org[0]?.organization_id;
    await sql`insert into vocero.contact (id, organization_id, wa_identity, name, channel) values (${`ct_e2e_sintel_${S}`}, ${o}, ${`bsuid:MX.sintel.${S}`}, ${N.sinTel}, 'whatsapp')`;
    if (IG) {
      await sql`insert into vocero.contact (id, organization_id, wa_identity, name, channel) values (${`ct_e2e_igsin_${S}`}, ${o}, ${`ig:igsin${S}`}, ${N.igSin}, 'instagram')`;
    }
    ok("contactos sin conversación sembrados (SQL)", true);
  } catch (err) {
    ok("contactos sin conversación sembrados (SQL)", false, String(err));
  } finally {
    await sql.end();
  }

  // Uno ya archivado (para «Desarchivar»).
  const a1 = await convOf(N.arch1);
  const ar = await owner.api(`/api/contacts/${a1?.contact?.id}`, { method: "PATCH", body: body({ archived: true }) });
  ok(`${N.arch1} archivado de inicio`, ar.res.ok, short(ar));
}

/* ───────────────────────── a) API ───────────────────────── */

async function apiChecks() {
  console.log("\n== a) API: archived=only|exclude|true + counts ==");
  const q = `q=${encodeURIComponent(S)}&limit=200`;
  const only = await contactsApi(owner, `${q}&archived=only`);
  const excl = await contactsApi(owner, `${q}&archived=exclude`);
  const def = await contactsApi(owner, q);
  const all = await contactsApi(owner, `${q}&archived=true`);
  ok("archived=only: solo archivados", (only?.contacts ?? []).length > 0 && only.contacts.every((c) => c.archivedAt), JSON.stringify(only?.contacts?.map((c) => [c.name, c.archivedAt])));
  ok("…y es Karla", only?.contacts?.length === 1 && only.contacts[0].name === N.arch1);
  ok("archived=exclude: ninguno archivado", (excl?.contacts ?? []).every((c) => !c.archivedAt) && !excl.contacts.some((c) => c.name === N.arch1));
  ok("sin parámetro = exclude", def?.total === excl?.total);
  ok("archived=true conserva el sentido viejo (todos)", all?.total === (excl?.total ?? 0) + (only?.total ?? 0), `${all?.total} vs ${excl?.total}+${only?.total}`);
  ok("counts cuadra con los totales", only?.counts?.archived === only?.total && only?.counts?.active === excl?.total && excl?.counts?.archived === only?.total, JSON.stringify(only?.counts));
  ok("trae viewer, teamMode y businessTimezone", !!excl?.viewer?.userId && typeof excl?.teamMode === "boolean" && typeof excl?.businessTimezone === "string");
  const ab = excl?.contacts?.find((c) => c.name === N.abierta);
  ok("cada contacto trae su conversación (id, canal, ventana)", !!ab?.conversation?.id && ab.conversation.channel === "whatsapp" && ab.conversation.window?.open === true, JSON.stringify(ab?.conversation));
  const nunca = excl?.contacts?.find((c) => c.name === N.nunca);
  ok("…y null si no tiene", nunca && nunca.conversation === null);
  // El vendedor ve lo mismo del directorio (no filtra por asignación).
  const dv = await contactsApi(dani, `${q}&archived=exclude`);
  ok("la vendedora ve el mismo directorio", dv?.total === excl?.total, `${dv?.total} vs ${excl?.total}`);
  return { activeTotal: excl?.counts?.active, archivedTotal: excl?.counts?.archived };
}

/* ───────────────────────── b–e) UI ───────────────────────── */

async function segmentChecks(page) {
  console.log("\n== b) Activos / Archivados (filtro real) ==");
  await gotoContacts(page);
  const fresh = await contactsApi(dani, "archived=exclude");
  ok("arranca en «Activos»", (await segBtn(page, "Activos").getAttribute("aria-pressed")) === "true");
  ok(`conteos del segmentado = API (Activos · ${fresh?.counts?.active}, Archivados · ${fresh?.counts?.archived})`,
    (await segCount(page, "Activos")) === fresh?.counts?.active && (await segCount(page, "Archivados")) === fresh?.counts?.archived,
    JSON.stringify(await page.getByRole("group", { name: "Qué contactos ver" }).getByRole("button").allTextContents()));
  ok("en Activos no está el archivado", (await row(page, N.arch1).count()) === 0);
  await segBtn(page, "Archivados").click();
  ok("«Archivados» muestra SOLO archivados", await until(async () => {
    const names = await rowNames(page);
    return names.length === 1 && names[0] === N.arch1;
  }, 15000), JSON.stringify(await rowNames(page)));
  ok("…con su insignia «Archivado» y «Desarchivar»", (await row(page, N.arch1).getByText("Archivado", { exact: true }).count()) === 1 && (await row(page, N.arch1).getByRole("button", { name: `Desarchivar a ${N.arch1}` }).count()) === 1);
  await noTooltips(page, "/contacts Archivados");

  console.log("\n== c) Archivar → Deshacer; Desarchivar ==");
  await segBtn(page, "Activos").click();
  await until(async () => (await row(page, N.arch2).count()) === 1, 15000);
  const before = await segCount(page, "Archivados");
  await row(page, N.arch2).getByRole("button", { name: `Archivar a ${N.arch2}` }).click();
  const notice = page.getByRole("status").filter({ hasText: `Archivaste a ${N.arch2}` });
  ok("aviso «Archivaste a Luis… Ya no aparece en Activos.»", await until(async () => ((await notice.textContent()) ?? "").includes(`Archivaste a ${N.arch2}. Ya no aparece en Activos.`), 15000));
  const id2 = (await convOf(N.arch2))?.contact?.id;
  const archivedApi = async () => (await owner.api(`/api/contacts/${id2}`)).json?.contact?.archivedAt ?? null;
  ok("…archivado de verdad (API)", await until(async () => !!(await archivedApi()), 10000));
  ok("…sale de Activos y «Archivados» sube", await until(async () => (await row(page, N.arch2).count()) === 0 && (await segCount(page, "Archivados")) === before + 1, 10000));
  await notice.getByRole("button", { name: "Deshacer" }).click();
  ok("«Deshacer» lo regresa (API: sin archivar)", await until(async () => !(await archivedApi()), 10000));
  ok("…y vuelve a la lista", await until(async () => (await row(page, N.arch2).count()) === 1 && (await segCount(page, "Archivados")) === before, 10000));
  await segBtn(page, "Archivados").click();
  await until(async () => (await row(page, N.arch1).count()) === 1, 15000);
  await row(page, N.arch1).getByRole("button", { name: `Desarchivar a ${N.arch1}` }).click();
  ok("«Desarchivar»: aviso «Desarchivaste a Karla… Volvió a Activos.»", await until(async () => ((await page.getByRole("status").filter({ hasText: "Desarchivaste a" }).textContent()) ?? "").includes(`Desarchivaste a ${N.arch1}. Volvió a Activos.`), 15000));
  const id1 = (await convOf(N.arch1))?.contact?.id;
  ok("…desarchivado (API)", await until(async () => !(await owner.api(`/api/contacts/${id1}`)).json?.contact?.archivedAt, 10000));
  ok("Archivados vacío explica qué es", await until(async () => (await page.getByText("No hay contactos archivados").count()) === 1, 10000));
  await segBtn(page, "Activos").click();
  await until(async () => (await rows(page).count()) > 3, 15000);
}

async function rowChecks(page, { daniId }) {
  console.log("\n== d) Acción por fila (vendedora) ==");
  const abierta = row(page, N.abierta);
  const sAb = await statusOf(page, N.abierta);
  ok("abierta: «Te escribió … · puedes escribirle libremente … más»", /^Te escribió .+ · puedes escribirle libremente .+ más$/.test(sAb), sAb);
  const abLink = abierta.getByRole("link", { name: `Abrir chat: ${N.abierta}` });
  ok("…«Abrir chat» a /inbox?contact=", (await abLink.getAttribute("href")) === `/inbox?contact=${(await convOf(N.abierta))?.contact?.id}`);
  ok("…meta «tú lo atiendes»", ((await abierta.textContent()) ?? "").includes("tú lo atiendes"));

  const sCe = await statusOf(page, N.cerrada);
  ok("cerrada: «No te escribe desde hace 30 h · para retomarlo usa un mensaje aprobado»", sCe === "No te escribe desde hace 30 h · para retomarlo usa un mensaje aprobado", sCe);
  ok("…«Retomar con plantilla» a su chat", (await row(page, N.cerrada).getByRole("link", { name: `Retomar con plantilla: ${N.cerrada}` }).getAttribute("href")) === `/inbox?contact=${(await convOf(N.cerrada))?.contact?.id}`);

  const sNu = await statusOf(page, N.nunca);
  ok("nunca escribió: «Nunca te ha escrito · el primer mensaje tiene que ser uno aprobado»", sNu === "Nunca te ha escrito · el primer mensaje tiene que ser uno aprobado", sNu);
  ok("…«Escribir primero»", (await row(page, N.nunca).getByRole("button", { name: `Escribir primero a ${N.nunca}` }).count()) === 1);

  const bs = row(page, N.bsuid);
  const sBs = await statusOf(page, N.bsuid);
  ok("BSUID con chat: ventana abierta y «Abrir chat»", /puedes escribirle libremente/.test(sBs) && (await bs.getByRole("link", { name: `Abrir chat: ${N.bsuid}` }).count()) === 1, sBs);
  const bsMeta = (await bs.locator("p.text-muted-foreground").first().textContent()) ?? "";
  ok("…la fila dice «Sin teléfono» (meta sin dígitos)", bsMeta.startsWith("Sin teléfono") && !/\d{4}/.test(bsMeta), bsMeta);

  const sSt = await statusOf(page, N.sinTel);
  ok("sin teléfono y sin chat: «Sin teléfono: no hay a dónde mandarle el primer mensaje…»", sSt.startsWith("Sin teléfono: no hay a dónde mandarle el primer mensaje"), sSt);
  ok("…sin botón de acción (el motivo es la línea)", (await row(page, N.sinTel).locator("a, button").filter({ hasNotText: /^(Editar|Archivar)$/ }).count()) === 0);

  if (IG) {
    const sIg = await statusOf(page, N.ig);
    ok("Instagram a 3 días: «Por Instagram puedes contestarle 4 días más; después…»", /^Por Instagram puedes contestarle \d+ días? más; después, solo cuando te vuelva a escribir$/.test(sIg), sIg);
    ok("…«Abrir chat» (discreto)", (await row(page, N.ig).getByRole("link", { name: `Abrir chat: ${N.ig}` }).count()) === 1);
    const sIs = await statusOf(page, N.igSin);
    ok("Instagram sin chat: «Por Instagram solo puedes contestarle cuando te escriba»", sIs === "Por Instagram solo puedes contestarle cuando te escriba", sIs);
    ok("…sin «Escribir primero»", (await row(page, N.igSin).getByRole("button", { name: /Escribir primero/ }).count()) === 0);
  } else {
    console.log("  (CHANNELS sin instagram: las filas de Instagram quedan en tests/unit/contact-row.test.ts)");
  }

  const aj = row(page, N.ajena);
  const sAj = await statusOf(page, N.ajena);
  ok("de otro vendedor: «Lo atiende Marco Ríos · solo Marco abre su chat»", sAj === "Lo atiende Marco Ríos · solo Marco abre su chat", sAj);
  ok("…y SIN enlace a su chat ni «Tomar»", (await aj.getByRole("link").count()) === 0 && (await aj.getByRole("button", { name: /Tomar/ }).count()) === 0);

  const li = row(page, N.libre);
  ok("sin tomar: «Tomar y responder»", (await li.getByRole("button", { name: `Tomar y responder: ${N.libre}` }).count()) === 1);
  ok("…meta «nadie lo atiende todavía»", ((await li.textContent()) ?? "").includes("nadie lo atiende todavía"));
  void daniId;
}

async function ownerRowChecks() {
  console.log("\n== e) Las mismas filas vistas por el Propietario ==");
  const { ctx, page } = await newPage(owner);
  await gotoContacts(page);
  const aj = row(page, N.ajena);
  ok("de Marco: «Abrir chat» (el Propietario abre cualquier chat)", (await aj.getByRole("link", { name: `Abrir chat: ${N.ajena}` }).count()) === 1);
  ok("…meta «lo atiende Marco Ríos»", ((await aj.textContent()) ?? "").includes("lo atiende Marco Ríos"));
  ok("…y su estado es el de la ventana, no «solo Marco abre…»", /puedes escribirle libremente/.test(await statusOf(page, N.ajena)), await statusOf(page, N.ajena));
  const li = row(page, N.libre);
  ok("sin tomar: «Abrir chat» y NO «Tomar y responder» (no se auto-asigna)", (await li.getByRole("link", { name: `Abrir chat: ${N.libre}` }).count()) === 1 && (await li.getByRole("button", { name: /Tomar y responder/ }).count()) === 0);
  await noTooltips(page, "/contacts (propietario)");
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(800);
  ok("propietario a 390 px: sin desborde horizontal", await noHScroll(page));
  await ctx.close();
}

async function takeChecks({ daniId, marcoId }) {
  console.log("\n== f) «Tomar y responder» ==");
  const { ctx, page } = await newPage(dani);
  await gotoContacts(page);
  const libreConv = await convOf(N.libre);
  await row(page, N.libre).getByRole("button", { name: `Tomar y responder: ${N.libre}` }).click();
  ok("lleva a /inbox?contact=<id>", await until(async () => page.url().includes(`/inbox?contact=${libreConv?.contact?.id}`), 30000), page.url());
  ok("…y el chat quedó a nombre de Daniela (API)", (await convOf(N.libre))?.assignedTo?.userId === daniId, JSON.stringify((await convOf(N.libre))?.assignedTo));

  await gotoContacts(page);
  const carrera = row(page, N.carrera);
  await carrera.waitFor();
  const r = await owner.api(`/api/conversations/${(await convOf(N.carrera))?.id}/assign`, { method: "POST", body: body({ userId: marcoId }) });
  ok("(Marco lo toma antes por API)", r.res.ok, short(r));
  await carrera.getByRole("button", { name: `Tomar y responder: ${N.carrera}` }).click();
  const alert = page.getByRole("alert").filter({ hasText: "ya tomó el chat de" });
  ok("aviso «… ya tomó el chat de Juan…»", await until(async () => ((await alert.textContent()) ?? "").includes(`ya tomó el chat de ${N.carrera}.`), 15000), await page.getByRole("alert").allTextContents().then((t) => t.join(" | ")));
  ok("…sigue en /contacts y NO se reasignó (API: Marco)", page.url().endsWith("/contacts") && (await convOf(N.carrera))?.assignedTo?.userId === marcoId);
  ok("…y la fila ya dice «Lo atiende Marco Ríos»", await until(async () => (await statusOf(page, N.carrera)).startsWith("Lo atiende Marco Ríos"), 15000), await statusOf(page, N.carrera));
  await ctx.close();
}

async function writeFirstChecks() {
  console.log("\n== g) «Escribir primero» en 3 pasos ==");
  const { ctx, page } = await newPage(dani);
  await gotoContacts(page);
  const ob0 = ((await owner.api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  await row(page, N.nunca).getByRole("button", { name: `Escribir primero a ${N.nunca}` }).click();
  const dlg = page.getByRole("dialog", { name: `Escribir primero a ${N.nunca}` });
  await dlg.waitFor();
  ok("título «Escribirle a Ceci por primera vez»", await until(async () => ((await dlg.textContent()) ?? "").includes("Escribirle a Ceci por primera vez"), 20000), (await dlg.textContent())?.slice(0, 200));
  const steps = dlg.getByTestId("first-message");
  await steps.waitFor({ timeout: 20000 });
  const txt = (await steps.textContent()) ?? "";
  ok("los pasos «Elige el mensaje» y «Revisa y envía»", txt.includes("Elige el mensaje") && txt.includes("Revisa y envía"));
  ok("sin jerga («Valor de {{1}}», nombre técnico con idioma)", !txt.includes("Valor de") && !/\(es_MX\)/.test(txt));
  const send = dlg.getByRole("button", { name: "Enviar y abrir el chat" });
  ok("sin elegir: botón deshabilitado con su motivo visible", (await send.isDisabled()) && (await dlg.getByText("Elige un mensaje para poder enviarlo.").isVisible()));
  await steps.getByTestId("template-option").filter({ hasText: "¿En qué te podemos ayudar?" }).click();
  const v1 = dlg.locator("#first-template-variable-1");
  ok("paso 2 «Completa los espacios» con el nombre ya puesto («Ceci»)", await until(async () => (await v1.inputValue()) === "Ceci", 5000), await v1.inputValue().catch(() => ""));
  await v1.fill("");
  ok("espacio vacío: «Llena el espacio 1 para poder enviarla.»", (await send.isDisabled()) && (await dlg.getByText("Llena el espacio 1 para poder enviarla.").isVisible()));
  await v1.fill("Ceci");
  ok("vista previa con el nombre", ((await dlg.getByTestId("template-preview").textContent()) ?? "").includes("Hola Ceci, soy de la tienda."));
  await noTooltips(page, "/contacts con «Escribir primero» abierto");
  await shot(page, "modb-escribir-primero-1366.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(600);
  await shot(page, "modb-escribir-primero-390.png");
  ok("diálogo a 390 px: sin desborde horizontal", await noHScroll(page));
  await page.setViewportSize({ width: 1366, height: 768 });
  await send.click();
  const nuncaId = (await contactsApi(owner, `q=${encodeURIComponent(N.nunca)}`))?.contacts?.[0]?.id;
  ok("abre su chat: /inbox?contact=<id>", await until(async () => page.url().includes(`/inbox?contact=${nuncaId}`), 30000), page.url());
  const sent = await until(async () => {
    const ob = (await owner.api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
    // El teléfono se normaliza (521→52): basta con sus 10 dígitos finales.
    return ob.slice(ob0).some((o) => {
      const s = JSON.stringify(o);
      return s.includes(`bienvenida_${S}`) && s.includes("Ceci") && s.includes(phone(N.nunca).slice(-10));
    });
  }, 20000);
  ok("la plantilla salió por wa-mock (nombre, parámetro y teléfono)", sent);
  ok("…y ahora tiene conversación (API)", !!(await contactsApi(owner, `q=${encodeURIComponent(N.nunca)}`))?.contacts?.[0]?.conversation?.id);
  await ctx.close();
}

async function errorChecks() {
  console.log("\n== h) Errores: carga y archivar ==");
  const { ctx, page } = await newPage(dani);
  const isList = (url, method) => method === "GET" && new URL(url).pathname === "/api/contacts";
  await page.route("**/api/contacts*", (route) =>
    isList(route.request().url(), route.request().method())
      ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"code":"boom","message":"x"}}' })
      : route.continue()
  );
  await page.goto(`${BASE}/contacts`, { waitUntil: "load", timeout: 90000 });
  ok("«No se pudieron cargar los contactos.»", await until(async () => (await page.getByText("No se pudieron cargar los contactos.").count()) === 1, 30000));
  ok("…distinto del vacío (sin «Sin contactos»)", (await page.getByText("Sin contactos", { exact: true }).count()) === 0);
  await page.unroute("**/api/contacts*");
  await page.getByRole("button", { name: "Reintentar" }).click();
  ok("«Reintentar» carga la lista", await until(async () => (await rows(page).count()) > 0, 20000));

  await page.getByLabel("Buscar contacto").fill(`zzz-nadie-${S}`);
  ok("búsqueda sin coincidencias: «Sin resultados» (vacío ≠ error)", await until(async () => (await page.getByText("Sin resultados").count()) === 1 && (await page.getByText("No se pudieron cargar").count()) === 0, 15000));
  await page.getByLabel("Buscar contacto").fill("");
  await until(async () => (await row(page, N.fallo).count()) === 1, 15000);

  await page.route("**/api/contacts/*", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"code":"boom","message":"falla de prueba"}}' })
      : route.continue()
  );
  await row(page, N.fallo).getByRole("button", { name: `Archivar a ${N.fallo}` }).click();
  const alert = page.getByRole("alert").filter({ hasText: "No se pudo archivar" });
  ok("aviso «No se pudo archivar a Mara…: falla de prueba.»", await until(async () => ((await alert.textContent()) ?? "").includes(`No se pudo archivar a ${N.fallo}: falla de prueba.`), 15000), await page.getByRole("alert").allTextContents().then((t) => t.join(" | ")));
  const idF = (await convOf(N.fallo))?.contact?.id;
  ok("…y NO se archivó (API) y sigue en la lista", !(await owner.api(`/api/contacts/${idF}`)).json?.contact?.archivedAt && (await row(page, N.fallo).count()) === 1);
  ok("el aviso de error se cierra a mano («Cerrar el aviso»)", await (async () => {
    await page.getByRole("button", { name: "Cerrar el aviso" }).click();
    return until(async () => (await alert.count()) === 0, 5000);
  })());
  await page.unroute("**/api/contacts/*");
  await ctx.close();
}

async function disabledChecks() {
  console.log("\n== i) Botones deshabilitados con su motivo ==");
  const { ctx, page } = await newPage(dani);
  await gotoContacts(page);
  await row(page, N.abierta).getByRole("button", { name: "Editar" }).click();
  const ed = page.getByRole("dialog", { name: "Editar contacto" });
  await ed.waitFor();
  await ed.locator("#edit-name").fill("");
  ok("Editar sin nombre: «Guardar» deshabilitado + «Escribe un nombre para poder guardar.»", (await ed.getByRole("button", { name: "Guardar" }).isDisabled()) && (await ed.getByText("Escribe un nombre para poder guardar.").isVisible()));
  await ed.getByRole("button", { name: "Cancelar" }).click();
  await page.getByRole("button", { name: "Nuevo contacto" }).click();
  const create = page.getByRole("button", { name: "Crear contacto" });
  await create.waitFor();
  ok("Nuevo contacto vacío: «Crear contacto» deshabilitado + «Escribe su nombre para poder crearlo.»", await until(async () => (await create.isDisabled()) && (await page.getByText("Escribe su nombre para poder crearlo.").isVisible()), 15000));
  await noTooltips(page, "/contacts con «Nuevo contacto» abierto");
  await ctx.close();
}

async function layoutChecks() {
  console.log("\n== j) Sin tooltips; móvil sin desborde (vendedora) ==");
  const { ctx, page } = await newPage(dani);
  await gotoContacts(page);
  await noTooltips(page, "/contacts (vendedora)");
  ok("1366: sin desborde horizontal", await noHScroll(page));
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(800);
  ok("390 px: sin desborde horizontal", await noHScroll(page));
  const wide = await rows(page).evaluateAll((lis) => lis.filter((li) => li.scrollWidth > li.clientWidth + 1).length);
  ok("390 px: ninguna fila se desborda por dentro", wide === 0, String(wide));
  await ctx.close();
}

async function main() {
  browser = await chromium.launch();
  try {
    const ids = await setup();
    await seed(ids);
    await apiChecks();
    {
      const { ctx, page } = await newPage(dani);
      await segmentChecks(page);
      await rowChecks(page, ids);
      await ctx.close();
    }
    await ownerRowChecks();
    await takeChecks(ids);
    await writeFirstChecks();
    await errorChecks();
    await disabledChecks();
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
