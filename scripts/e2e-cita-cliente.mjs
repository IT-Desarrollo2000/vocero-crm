/**
 * Self-test E2E de UI — 029 US-3/US-4: el cliente en el detalle de la cita y
 * los botones claros. Spec: specs/029-pedidos-ventas/spec.md (CA-4..CA-7).
 *
 * Datos (API; día D = primer lun–vie desde mañana, horario 9–18):
 *   Lucía  — llegó por un anuncio (wa-mock con referral); chat sin asignar
 *   Marco  — chat asignado a Juan
 *   Nora   — chat asignado a Juan
 *   Iris   — solo BSUID (sin teléfono)
 *   A  Lucía 10:00, del owner, sin `conversationId` (se usa la más reciente)
 *   B  Marco 11:00, la crea Ana (Vendedor) y el owner la reasigna a Juan
 *   C  Nora 12:00, sin asignar (como si la agendara la IA)
 *   X  Marco 13:00, del owner asignada a Juan (Ana no la ve)
 *   E  Iris 14:00, sin asignar · BLK bloqueo 16:00
 *
 * Recorre:
 *   CA-4 owner: panel con teléfono, copiar, canal, etapa/fuente, anuncio, y
 *        «Abrir conversación» lleva a /inbox?contact=<Lucía>
 *   CA-5 Ana, cita B (de Juan, chat de Juan): API sin canal/anuncio; UI solo
 *        teléfono y botón deshabilitado «Chat asignado a Juan…»
 *   CA-5b Ana, cita C (sin asignar, chat de Juan): datos completos y botón
 *        deshabilitado «Chat asignado a Juan…»
 *   CA-6 Ana, cita X → 404 en el endpoint
 *   extra: bloqueo → `card: null` y sin sección Cliente; BSUID → «Sin
 *        teléfono»; fallo de red → aviso + Reintentar; Lista: «Ver cliente»
 *        no dispara peticiones hasta abrirse
 *   CA-7 botones con borde visible; «Cancelar cita» rojo y con confirmación
 *        de dos pasos («No» no cancela; «Sí, cancelar» sí)
 *
 * Uso (BD AISLADA recién migrada, app con AGENDA=on y mocks; NUNCA contra la
 * BD compartida):
 *   node --env-file=.env.e2e scripts/e2e-cita-cliente.mjs
 * Navegador: chromium de Playwright; si falta, Edge (`PW_CHANNEL=msedge`).
 * Capturas en E2E_SHOTS_DIR (por omisión <tmp>/e2e-shots-029-cita).
 * Sale con código 1 si algún check falla.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const SHOTS = process.env.E2E_SHOTS_DIR ?? path.join(os.tmpdir(), "e2e-shots-029-cita");
const S = Math.random().toString(36).slice(2, 6).toUpperCase();
const PN = "PN-E2E-029-CITA";

let failures = 0;
let checks = 0;
const ok = (name, cond, extra = "") => {
  checks++;
  if (cond) console.log(`  OK  ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const soft = async (fn, ms = 20000) => {
  try {
    await fn(ms);
    return true;
  } catch {
    return false;
  }
};
const J = async (resp) => {
  try {
    return await resp.json();
  } catch {
    return null;
  }
};

/* ------------------------------------------------- fechas (zona negocio) */

function tzOffsetMin(ms, tz) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(ms));
  const g = (t) => Number(p.find((x) => x.type === t)?.value);
  return (Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")) - ms) / 60000;
}
function utcOf(day, hm, tz) {
  const [y, m, d] = day.split("-").map(Number);
  const [h, mi] = hm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - tzOffsetMin(guess, tz) * 60000;
  t = guess - tzOffsetMin(t, tz) * 60000;
  return new Date(t).toISOString();
}
const todayIn = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dow = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();

/* ------------------------------------------------------------ navegador */

fs.mkdirSync(SHOTS, { recursive: true });
const shots = [];
async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  shots.push(file);
}

async function launch() {
  const channel = process.env.PW_CHANNEL || undefined;
  try {
    return await chromium.launch({ channel });
  } catch (err) {
    if (channel) throw err;
    console.log("  (chromium de Playwright no disponible: uso Edge)");
    return chromium.launch({ channel: "msedge" });
  }
}

const browser = await launch();

async function actor(email, password, { signUp = false, colorScheme } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...(colorScheme ? { colorScheme } : {}),
  });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE }).catch(() => {});
  const req = ctx.request;
  let r = null;
  if (signUp) {
    r = await req.post(`${BASE}/api/auth/sign-up/email`, {
      headers: { origin: BASE },
      data: { email, password, name: "Operador E2E" },
    });
  }
  if (!r?.ok()) {
    r = await req.post(`${BASE}/api/auth/sign-in/email`, {
      headers: { origin: BASE },
      data: { email, password },
    });
  }
  return { ctx, req, ok: r.ok() };
}

async function clickUntil(target, expect, tries = 8) {
  for (let i = 0; i < tries; i++) {
    await target.click({ timeout: 5000 }).catch(() => {});
    if (await soft((ms) => expect.waitFor({ timeout: Math.min(ms, 2500) }))) return true;
    await sleep(500);
  }
  return false;
}

const rowsOf = (pg) =>
  pg.locator("section").filter({ has: pg.getByRole("heading", { name: /^Citas/ }) }).locator("ul > li");
const rowOf = (pg, text) => rowsOf(pg).filter({ hasText: text }).first();

/** Citas en vista Lista. */
async function gotoList(pg) {
  await pg.goto(`${BASE}/bookings`, { waitUntil: "load" });
  await clickUntil(pg.getByTestId("cal-view-list"), pg.locator('[data-testid="cal-view-list"][aria-pressed="true"]'));
  return soft((ms) => rowsOf(pg).first().waitFor({ timeout: ms }), 40000);
}

/** Abre la tarjeta del cliente de la fila de `name` en la Lista. */
async function openListCard(pg, name) {
  const row = rowOf(pg, name);
  const card = row.getByTestId("booking-client-card");
  await clickUntil(row.getByTestId("booking-client-toggle"), card);
  return { row, card };
}

/* =============================================================== guion */

const OWNER_EMAIL = "e2e@vocero.test";
const PASS = "password-e2e-123";

try {
  console.log("== Setup (API) ==");
  const owner = await actor(OWNER_EMAIL, PASS, { signUp: true });
  ok("login owner", owner.ok);
  const oreq = owner.req;
  const raw = (req) => async (method, p, data) =>
    req.fetch(`${BASE}${p}`, { method, headers: { origin: BASE }, ...(data ? { data } : {}) });
  const oraw = raw(oreq);
  const api = async (method, p, data) => J(await oraw(method, p, data));

  const probe = await oraw("GET", "/api/calendar/settings");
  if (probe.status() === 404) {
    ok("la agenda está encendida (AGENDA=on)", false, "GET /api/calendar/settings → 404");
    throw new Error("__done__");
  }

  await api("PUT", "/api/settings/whatsapp", { wabaId: "WABA-029-CITA", phoneNumberId: PN, token: "tok-029-cita" });
  const V1_NAME = `Juan Cli ${S}`;
  const V2_NAME = `Ana Cli ${S}`;
  const V1_EMAIL = `juan.cli.${S.toLowerCase()}@vocero.test`;
  const V2_EMAIL = `ana.cli.${S.toLowerCase()}@vocero.test`;
  const SPASS = "password-vend-123";
  for (const [name, email] of [
    [V1_NAME, V1_EMAIL],
    [V2_NAME, V2_EMAIL],
  ]) {
    await api("POST", "/api/settings/team", { name, email, password: SPASS });
  }
  const members = (await api("GET", "/api/settings/team"))?.members ?? [];
  const V1 = members.find((m) => m.email === V1_EMAIL)?.userId;
  const V2 = members.find((m) => m.email === V2_EMAIL)?.userId;
  ok("dos Vendedores dados de alta", Boolean(V1 && V2));

  const work = [{ start: "09:00", end: "18:00" }];
  const cal = await api("PUT", "/api/calendar/settings", {
    weeklyHours: { mon: work, tue: work, wed: work, thu: work, fri: work, sat: [], sun: [] },
    slotMinutes: 30,
    bufferMinutes: 0,
    minNoticeHours: 0,
    maxDaysAhead: 30,
    connector: "enlace-fijo",
    meetingLink: null,
    address: null,
  });
  ok("agenda lun–vie 9–18", !!cal?.settings, JSON.stringify(cal)?.slice(0, 200));
  const TZ = cal?.settings?.timezone ?? "America/Mexico_City";
  let D = addDays(todayIn(TZ), 1);
  while (dow(D) === 0 || dow(D) === 6) D = addDays(D, 1);
  const at = (hm) => utcOf(D, hm, TZ);
  console.log(`  INFO día D=${D}`);

  // Contactos con conversación (wa-mock). Lucía llega por un anuncio.
  const N = {
    lucia: `Lucía Cli ${S}`,
    marco: `Marco Cli ${S}`,
    nora: `Nora Cli ${S}`,
    iris: `Iris Cli ${S}`,
  };
  const SUF = String(Math.floor(Math.random() * 9e4) + 1e4);
  const AD_HEADLINE = `Promo 029 ${S}`;
  const inbound = (data, i) =>
    oreq.post(`${BASE}/api/dev/wa-mock/inbound`, {
      headers: { origin: BASE },
      data: { phoneNumberId: PN, text: "hola, quiero una cita", waMessageId: `wamid.029cli.${S}.${i}`, ...data },
    });
  const LUCIA_PHONE = `521559${SUF}01`;
  await inbound(
    {
      from: LUCIA_PHONE,
      name: N.lucia,
      ctwaClid: `clid-029-${S}`,
      adHeadline: AD_HEADLINE,
      adSourceId: `ad-029-${S}`,
      adSourceType: "ad",
    },
    1
  );
  await inbound({ from: `521559${SUF}02`, name: N.marco }, 2);
  await inbound({ from: `521559${SUF}03`, name: N.nora }, 3);
  await inbound({ fromUserId: `bsuid-029-${S}`, name: N.iris }, 4);
  await sleep(2000);
  const convs = (await api("GET", "/api/conversations"))?.conversations ?? [];
  const convOf = (name) => convs.find((c) => c.contact?.name === name);
  ok("contactos de prueba con conversación", Object.values(N).every((n) => convOf(n)?.contact?.id), JSON.stringify(convs.map((c) => c.contact?.name)));
  const cid = (k) => convOf(N[k])?.contact?.id;
  const cvid = (k) => convOf(N[k])?.id;

  const types = (await api("GET", "/api/calendar/types"))?.types ?? [];
  const SERVICIO = types.find((t) => t.name === "Servicio") ?? types[0];
  ok("hay un tipo de cita", Boolean(SERVICIO?.id));

  const ana = await actor(V2_EMAIL, SPASS);
  ok("login Ana (Vendedor)", ana.ok);
  const araw = raw(ana.req);

  const book = async (rawFn, body) => {
    const r = await rawFn("POST", "/api/bookings", { kind: "session", typeId: SERVICIO.id, ...body });
    const j = await J(r);
    return { status: r.status(), id: j?.booking?.id, json: j };
  };
  const A = await book(oraw, { contactId: cid("lucia"), startUtc: at("10:00"), assignedUserId: null });
  const B = await book(araw, { contactId: cid("marco"), startUtc: at("11:00") });
  const C = await book(oraw, { contactId: cid("nora"), startUtc: at("12:00"), assignedUserId: null, conversationId: cvid("nora") });
  const X = await book(oraw, { contactId: cid("marco"), startUtc: at("13:00"), assignedUserId: V1 });
  const E = await book(oraw, { contactId: cid("iris"), startUtc: at("14:00"), assignedUserId: null });
  const created = { A, B, C, X, E };
  ok(
    "citas creadas (201)",
    Object.values(created).every((c) => c.status === 201),
    JSON.stringify(Object.fromEntries(Object.entries(created).map(([k, v]) => [k, v.status === 201 ? 201 : v.json])))
  );
  const reassign = await oraw("PATCH", `/api/bookings/${B.id}`, { action: "assign", userId: V1 });
  ok("el owner reasigna B (creada por Ana) a Juan", reassign.ok(), `status=${reassign.status()}`);
  const blk = await oraw("POST", "/api/bookings", { kind: "block", startUtc: at("16:00"), durationMinutes: 60, notes: `bloqueo ${S}` });
  const BLK = (await J(blk))?.booking?.id;
  ok("bloqueo creado", blk.status() === 201 && Boolean(BLK));
  // Los chats se asignan DESPUÉS de crear las citas: Ana agenda a Marco
  // mientras su chat aún está sin asignar.
  for (const k of ["marco", "nora"]) {
    const r = await oraw("POST", `/api/conversations/${cvid(k)}/assign`, { userId: V1 });
    ok(`chat de ${k} asignado a Juan`, r.ok(), `status=${r.status()}`);
  }

  const clientApi = async (rawFn, id) => {
    const r = await rawFn("GET", `/api/bookings/${id}/client`);
    return { status: r.status(), json: await J(r) };
  };

  /* ------------------------------------------------------------- API */
  console.log("\n== API: GET /api/bookings/[id]/client ==");
  const oA = await clientApi(oraw, A.id);
  ok("owner, A: 200 con datos completos", oA.status === 200 && oA.json?.card?.restricted === false, JSON.stringify(oA));
  ok("…teléfono, canal y anuncio", oA.json?.card?.phone === convOf(N.lucia)?.contact?.phone && oA.json?.card?.channel === "whatsapp" && oA.json?.card?.anuncio?.headline === AD_HEADLINE, JSON.stringify(oA.json?.card));
  ok("…conversación de Lucía (la más reciente) y se puede abrir", oA.json?.card?.conversation?.id === cvid("lucia") && oA.json?.card?.conversation?.canOpenChat === true);

  const aB = await clientApi(araw, B.id);
  const cardB = aB.json?.card ?? {};
  ok("CA-5 Ana, B: 200 restringida", aB.status === 200 && cardB.restricted === true, JSON.stringify(aB));
  ok("CA-5 …con teléfono y sin canal/etapa/prioridad/fuente/anuncio", Boolean(cardB.phone) && ["channel", "stageName", "priority", "source", "anuncio"].every((k) => !(k in cardB)), JSON.stringify(cardB));
  ok("CA-5 …botón: no puede abrir; responsable Juan", cardB.conversation?.canOpenChat === false && cardB.conversation?.assignedUserName === V1_NAME, JSON.stringify(cardB.conversation));

  const aC = await clientApi(araw, C.id);
  ok("CA-5b Ana, C (sin asignar, chat de Juan): completa", aC.status === 200 && aC.json?.card?.restricted === false && aC.json?.card?.channel === "whatsapp", JSON.stringify(aC));
  ok("CA-5b …pero no puede abrir el chat", aC.json?.card?.conversation?.canOpenChat === false && aC.json?.card?.conversation?.assignedUserName === V1_NAME);

  const aX = await clientApi(araw, X.id);
  ok("CA-6 Ana, X (de Juan, no la ve): 404", aX.status === 404, `status=${aX.status}`);
  const aBlk = await clientApi(oraw, BLK);
  ok("bloqueo: card null", aBlk.status === 200 && aBlk.json?.card === null, JSON.stringify(aBlk));
  const oE = await clientApi(oraw, E.id);
  ok("BSUID: phone null", oE.status === 200 && oE.json?.card?.phone === null, JSON.stringify(oE.json?.card));
  const nope = await clientApi(oraw, "bk_inexistente");
  ok("cita inexistente: 404", nope.status === 404);

  /* ------------------------------------------------------- CA-4 (UI) */
  console.log("\n== CA-4) Owner: tarjeta del cliente en la Lista y apertura del chat ==");
  const page = await owner.ctx.newPage();
  const clientCalls = [];
  page.on("request", (r) => {
    if (/\/api\/bookings\/[^/]+\/client$/.test(new URL(r.url()).pathname)) clientCalls.push(r.url());
  });
  ok("Lista cargada", await gotoList(page));
  await sleep(800);
  ok("la Lista no pide clientes antes de abrir «Ver cliente»", clientCalls.length === 0, `peticiones=${clientCalls.length}`);
  const { card: cardA } = await openListCard(page, N.lucia);
  ok("«Ver cliente» muestra la tarjeta", await soft((ms) => cardA.waitFor({ timeout: ms })));
  ok("…una sola petición", clientCalls.length === 1, `peticiones=${clientCalls.length}`);
  ok("…teléfono", ((await cardA.getByTestId("booking-client-phone").getAttribute("data-phone")) ?? "") !== "");
  ok("…canal WhatsApp", (await cardA.getByTestId("booking-client-channel").textContent())?.includes("WhatsApp"));
  ok("…fuente (Anuncio)", (await cardA.getByTestId("booking-client-source").count()) === 1);
  ok("…tarjeta del anuncio", ((await cardA.locator("[data-anuncio-origen]").textContent()) ?? "").includes(AD_HEADLINE));
  await cardA.getByTestId("booking-client-copy").click().catch(() => {});
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  ok("copiar teléfono", clip === null || /\d{8,}/.test(clip), `clip=${clip}`);
  await shot(page, "01-owner-cliente-lista");
  const open = cardA.getByTestId("booking-open-chat");
  ok("«Abrir conversación» habilitado", (await open.getAttribute("data-can-open")) === "true");
  await open.click();
  ok("lleva a /inbox?contact=<Lucía>", await soft((ms) => page.waitForURL((u) => u.pathname === "/inbox" && u.searchParams.get("contact") === cid("lucia"), { timeout: ms })), page.url());
  ok("…y la Bandeja muestra a Lucía", await soft((ms) => page.getByText(N.lucia).first().waitFor({ timeout: ms })));

  console.log("\n== Bloqueo y BSUID ==");
  await gotoList(page);
  const blkRow = rowOf(page, `bloqueo ${S}`);
  ok("el bloqueo aparece en la Lista", (await blkRow.count()) === 1);
  ok("…sin «Ver cliente»", (await blkRow.getByTestId("booking-client-toggle").count()) === 0);
  const { card: cardE } = await openListCard(page, N.iris);
  ok("BSUID: «Sin teléfono»", (await cardE.getByTestId("booking-client-phone").textContent())?.includes("Sin teléfono"));

  console.log("\n== Fallo al cargar → aviso + Reintentar ==");
  await gotoList(page);
  await page.route("**/api/bookings/*/client", (route) => route.fulfill({ status: 500, body: "boom" }));
  const rowFail = rowOf(page, N.lucia);
  await clickUntil(rowFail.getByTestId("booking-client-toggle"), rowFail.getByTestId("booking-client-error"));
  ok("aviso «No se pudieron cargar los datos del cliente»", ((await rowFail.getByTestId("booking-client-error").textContent()) ?? "").includes("No se pudieron cargar los datos del cliente"));
  ok("…el resto de la fila sigue (Reprogramar)", (await rowFail.getByRole("button", { name: "Reprogramar" }).count()) === 1);
  await page.unroute("**/api/bookings/*/client");
  await rowFail.getByRole("button", { name: "Reintentar" }).click();
  ok("Reintentar carga la tarjeta", await soft((ms) => rowFail.getByTestId("booking-client-card").waitFor({ timeout: ms })));

  /* ------------------------------------------------- CA-5 / CA-5b (UI) */
  console.log("\n== CA-5 / CA-5b) Ana (Vendedor) ==");
  const apage = await ana.ctx.newPage();
  ok("Lista de Ana", await gotoList(apage));
  const { card: aCardB } = await openListCard(apage, N.marco);
  ok("CA-5 tarjeta restringida", (await aCardB.getAttribute("data-restricted")) === "true");
  ok("CA-5 …con teléfono", ((await aCardB.getByTestId("booking-client-phone").getAttribute("data-phone")) ?? "") !== "");
  ok("CA-5 …sin canal ni anuncio", (await aCardB.getByTestId("booking-client-channel").count()) === 0 && (await aCardB.locator("[data-anuncio-origen]").count()) === 0);
  const btnB = aCardB.getByTestId("booking-open-chat");
  ok("CA-5 …botón deshabilitado «Chat asignado a Juan…»", (await btnB.isDisabled()) && ((await btnB.textContent()) ?? "").includes(`Chat asignado a ${V1_NAME}`), await btnB.textContent().catch(() => ""));
  ok("CA-6 Ana no ve la cita X en su Lista", (await rowsOf(apage).filter({ hasText: N.marco }).count()) === 1);
  const { card: aCardC } = await openListCard(apage, N.nora);
  ok("CA-5b tarjeta completa", (await aCardC.getAttribute("data-restricted")) === "false");
  ok("CA-5b …con canal", (await aCardC.getByTestId("booking-client-channel").count()) === 1);
  const btnC = aCardC.getByTestId("booking-open-chat");
  ok("CA-5b …botón deshabilitado «Chat asignado a Juan…»", (await btnC.isDisabled()) && ((await btnC.textContent()) ?? "").includes(`Chat asignado a ${V1_NAME}`));
  await shot(apage, "02-vendedor-restringida-y-completa");

  /* ----------------------------------------------------------- CA-7 */
  console.log("\n== CA-7) Botones y «Cancelar cita» con confirmación ==");
  await gotoList(page);
  const rowC = rowOf(page, N.nora);
  const cancelBtn = rowC.getByTestId("booking-cancel");
  ok("«Cancelar cita» visible", ((await cancelBtn.textContent()) ?? "").trim() === "Cancelar cita");
  const styles = await cancelBtn.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { border: cs.borderTopColor, color: cs.color, width: cs.borderTopWidth };
  });
  ok("…rojo (borde y texto del mismo tono) con borde visible", styles.border === styles.color && styles.width !== "0px", JSON.stringify(styles));
  for (const name of ["Reprogramar", "No asistió"]) {
    const w = await rowC.getByRole("button", { name, exact: true }).evaluate((el) => getComputedStyle(el).borderTopWidth);
    ok(`«${name}» con borde visible`, w !== "0px", w);
  }
  ok("grupos «Resultado» y «Cambios»", (await rowC.getByRole("group", { name: "Resultado" }).count()) === 1 && (await rowC.getByRole("group", { name: "Cambios" }).count()) === 1);
  await cancelBtn.click();
  ok("primer clic: «¿Cancelar esta cita?»", await soft((ms) => rowC.getByText("¿Cancelar esta cita?").waitFor({ timeout: ms })));
  await shot(page, "03-confirmar-cancelar");
  await rowC.getByRole("button", { name: "No", exact: true }).click();
  ok("«No» vuelve al botón sin cancelar", await soft((ms) => rowC.getByTestId("booking-cancel").waitFor({ timeout: ms })));
  const stillC = (await api("GET", "/api/bookings"))?.bookings?.find((b) => b.id === C.id);
  ok("…la cita sigue agendada", stillC?.status === "agendada", stillC?.status);
  await rowC.getByTestId("booking-cancel").click();
  await rowC.getByTestId("booking-cancel-confirm").click();
  await sleep(1500);
  const cancelled = (await api("GET", "/api/bookings"))?.bookings?.find((b) => b.id === C.id);
  ok("«Sí, cancelar» cancela la cita", cancelled?.status === "cancelada", cancelled?.status);

  console.log("\n== Tema oscuro (captura) ==");
  const dark = await actor(OWNER_EMAIL, PASS, { colorScheme: "dark" });
  await dark.ctx.addCookies([{ name: "vocero-theme", value: "dark", url: BASE }]);
  const dpage = await dark.ctx.newPage();
  await gotoList(dpage);
  ok("html[data-theme=dark]", (await dpage.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "dark");
  const { row: dRow } = await openListCard(dpage, N.lucia);
  const dStyles = await dRow.getByRole("button", { name: "Reprogramar", exact: true }).evaluate((el) => {
    const cs = getComputedStyle(el);
    return { border: cs.borderTopColor, bg: getComputedStyle(document.body).backgroundColor };
  });
  ok("oscuro: el borde de «Reprogramar» se distingue del fondo", dStyles.border !== dStyles.bg, JSON.stringify(dStyles));
  await shot(dpage, "04-oscuro-cliente-y-botones");
} catch (err) {
  if (err?.message !== "__done__") {
    failures++;
    console.log(`  FAIL excepción: ${err?.stack ?? err}`);
  }
} finally {
  await browser.close().catch(() => {});
  console.log(`\nCapturas: ${shots.length ? shots.join("\n  ") : "(ninguna)"}`);
  console.log(`\n${checks - failures}/${checks} checks OK`);
  process.exit(failures ? 1 : 0);
}
