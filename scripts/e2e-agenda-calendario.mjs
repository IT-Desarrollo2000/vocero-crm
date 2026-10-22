/**
 * Self-test E2E de UI — 028: agenda en calendario (Semana, Día por vendedor,
 * arrastrar para mover). Guion humano: tests/e2e/us-agenda-calendario.md.
 *
 * El navegador corre en `Asia/Tokyo` y el negocio en America/Mexico_City: las
 * horas se tienen que pintar en la zona del NEGOCIO (A10).
 *
 * Datos (API, día D = primer lun–vie desde mañana; S = el sábado de esa semana;
 * horario lun–vie 9–18, sáb 9–13, dom cerrado; rejilla 30 min, sin margen):
 *   B1 Prueba de manejo 10:00 (Juan) · B2 Servicio 12:00 (Juan)
 *   S1/S2 Servicio 14:00 (Juan / Ana, la 2.ª con confirmOverlap) → soft
 *   P2 Prueba de manejo 15:00 (Ana) · H Servicio 16:00 (Ana) + bloqueo 16–17 → hard
 *   M Servicio 09:00 (Ana) · G Servicio sáb 11:00 (owner)
 *
 * Recorre:
 *   CA-1 Semana por defecto a 1280×800; B1 a la altura de las 10:00 frente a
 *        B2 (12:00) y alto proporcional (60 vs 30 min)
 *   CA-2 S1/S2 soft y lado a lado; H hard
 *   CA-3 clic en hueco libre → Nueva cita con día y hora preseleccionados
 *   CA-5 arrastre con mouse real: a) libre (vista previa `free`, persiste);
 *        b) choque con otro vendedor → diálogo (cancelar revierte, confirmar
 *        mueve); c) Prueba sobre Prueba / fuera de horario / día cerrado →
 *        `reject` sin PATCH; d) clic simple abre el panel; red caída → error y
 *        la cita vuelve a su lugar
 *   CA-4/CA-6 Día por vendedor: columnas del owner y del Vendedor; el owner
 *        reasigna arrastrando de columna; el Vendedor no (y 403 por API)
 *   Margen: bufferMinutes=15 → el inicio slot+buffer funciona; lo que no cabe
 *        es `reject` sin servidor; el servidor rechaza un inicio desalineado
 *   stale: PATCH move con expectedStartUtc viejo → 409 `stale`
 *   CA-7 móvil 390×844 (Día, sin scroll de página) y tema oscuro (capturas)
 *   CA-8 con `--off` (AGENDA=off): /bookings y GET /api/bookings?from&to → 404
 *   R1 la 1.ª carga con rango falla (500) → `cal-load-error` + Reintentar
 *   R2 panel → Reprogramar: Escape cierra solo el diálogo; otro, el panel
 *   R3 teclado: Espacio, ↓↓, Espacio mueve 2 pasos; Enter abre el detalle
 *   R4 viewport 1280×600: auto-scroll al arrastrar; la hora final = la vista
 *        previa justo antes de soltar
 *
 * Uso (BD AISLADA recién migrada, app con AGENDA=on y mocks; reinicia el
 * server antes: el limitador de login es por IP y en memoria):
 *   node --env-file=.env.e2e scripts/e2e-agenda-calendario.mjs
 *   AGENDA=off node --env-file=.env.e2e scripts/e2e-agenda-calendario.mjs --off
 * Navegador: chromium de Playwright; si falta, Edge (`PW_CHANNEL=msedge`).
 * Capturas en E2E_SHOTS_DIR (por omisión <tmp>/e2e-shots-028).
 * Sale con código 1 si algún check falla.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const SHOTS = process.env.E2E_SHOTS_DIR ?? path.join(os.tmpdir(), "e2e-shots-028");
const OFF = process.argv.includes("--off");
const S = Math.random().toString(36).slice(2, 6).toUpperCase();
const PN = "PN-E2E-028-UI";
const BROWSER_TZ = "Asia/Tokyo";
/** px por minuto con rejilla de 30 min (`pxPerMinute`: max(0.8, 22/30)). */
const PX = 0.8;

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
/** "ese día a esa hora de pared" en `tz` → ISO UTC. */
function utcOf(day, hm, tz) {
  const [y, m, d] = day.split("-").map(Number);
  const [h, mi] = hm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - tzOffsetMin(guess, tz) * 60000;
  t = guess - tzOffsetMin(t, tz) * 60000;
  return new Date(t).toISOString();
}
const todayIn = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
const dayOf = (iso, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso));
function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dow = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();

/* ------------------------------------------------------------ navegador */

fs.mkdirSync(SHOTS, { recursive: true });
const shots = [];
async function shot(page, name, opts = {}) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false, ...opts }).catch(() => {});
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

/** Contexto con su sesión (cookies compartidas con `request`). */
async function actor(email, password, { signUp = false, viewport } = {}) {
  const ctx = await browser.newContext({
    viewport: viewport ?? { width: 1280, height: 800 },
    timezoneId: BROWSER_TZ,
  });
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

/** Clic con reintentos hasta que aparezca `expect` (hidratación de next dev). */
async function clickUntil(target, expect, tries = 8) {
  for (let i = 0; i < tries; i++) {
    await target.click({ timeout: 5000 }).catch(() => {});
    if (await soft((ms) => expect.waitFor({ timeout: Math.min(ms, 2500) }))) return true;
    await sleep(500);
  }
  return false;
}

const block = (pg, id) => pg.locator(`[data-testid="cal-booking"][data-booking-id="${id}"]`).first();
const dayCol = (pg, day) => pg.locator(`[data-testid="cal-day-column"][data-day="${day}"]`);
const sellerCol = (pg, id) => pg.locator(`[data-testid="cal-seller-column"][data-seller="${id}"]`);
const cell = (pg, col, startUtc) => col.locator(`[data-testid="cal-empty-cell"][data-start="${startUtc}"]`);

/** Abre Citas en Semana y navega hasta la semana de `day`. */
async function gotoWeek(pg, day) {
  await pg.goto(`${BASE}/bookings`, { waitUntil: "load" });
  await clickUntil(pg.getByTestId("cal-view-week"), pg.locator('[data-testid="cal-view-week"][aria-pressed="true"]'));
  await soft((ms) => pg.getByTestId("cal-day-column").first().waitFor({ timeout: ms }), 40000);
  await sleep(1200); // la fecha del navegador (Tokio) se corrige a la del negocio tras la 1.ª carga
  for (let i = 0; i < 8 && (await dayCol(pg, day).count()) === 0; i++) {
    const first = await pg.getByTestId("cal-day-column").first().getAttribute("data-day");
    await pg.getByTestId(first && first < day ? "cal-next" : "cal-prev").click();
    await sleep(900);
  }
  return soft((ms) => dayCol(pg, day).waitFor({ timeout: ms }), 15000);
}

/** El día que se ve en Día por vendedor (por las celdas; null si no hay). */
async function shownDay(pg, tz) {
  const c = pg.locator('[data-testid="cal-seller-column"] [data-testid="cal-empty-cell"]').first();
  if ((await c.count()) === 0) return null;
  const s = await c.getAttribute("data-start");
  return s ? dayOf(s, tz) : null;
}

/** Día por vendedor en `day`. */
async function gotoDay(pg, day, tz) {
  await pg.goto(`${BASE}/bookings`, { waitUntil: "load" });
  await clickUntil(pg.getByTestId("cal-view-day"), pg.locator('[data-testid="cal-view-day"][aria-pressed="true"]'));
  await soft((ms) => pg.getByTestId("cal-seller-column").first().waitFor({ timeout: ms }), 40000);
  await sleep(1200);
  for (let i = 0; i < 10; i++) {
    const d = await shownDay(pg, tz);
    if (d === day) return true;
    await pg.getByTestId(d && d > day ? "cal-prev" : "cal-next").click();
    await sleep(900);
  }
  return (await shownDay(pg, tz)) === day;
}

/**
 * Arrastre con el mouse real. El minuto destino sale del BORDE SUPERIOR del
 * bloque arrastrado (`rect.top - over.rect.top`), así que se mueve el puntero
 * exactamente lo que separa la esquina del bloque de `target` (x, y).
 * Devuelve la vista previa leída ANTES de soltar.
 */
async function dragTo(pg, src, target, { shotName, release = true } = {}) {
  await src.scrollIntoViewIfNeeded().catch(() => {});
  const sb = await src.boundingBox();
  if (!sb) return { error: "sin caja del bloque" };
  const sx = sb.x + sb.width / 2;
  const sy = sb.y + Math.min(sb.height / 2, 8);
  await pg.mouse.move(sx, sy);
  await pg.mouse.down();
  await pg.mouse.move(sx, sy + 10, { steps: 5 }); // activa el sensor (distance: 6)
  const dx = target.x - sb.x;
  const dy = target.y - sb.y + 1;
  await pg.mouse.move(sx + dx, sy + dy, { steps: 20 });
  await sleep(300);
  await pg.mouse.move(sx + dx, sy + dy + 0.5, { steps: 2 });
  await sleep(200);
  const prev = pg.getByTestId("cal-drop-preview");
  const info =
    (await prev.count()) > 0
      ? {
          state: await prev.getAttribute("data-state"),
          start: await prev.getAttribute("data-start"),
          text: (await prev.textContent())?.trim(),
        }
      : { state: null };
  if (shotName) await shot(pg, shotName);
  if (release) {
    await pg.mouse.up();
    await sleep(400);
  }
  return info;
}

/** Caja (x, y) destino: columna `col` a la altura de la celda `yCell`. */
async function targetAt(col, yCell) {
  const cb = await col.boundingBox();
  const yb = await yCell.boundingBox();
  if (!cb || !yb) return null;
  return { x: cb.x + 2, y: yb.y };
}

/** Desplazamiento del bloque respecto de su columna (px). */
async function offsetIn(pg, id, col) {
  const b = await block(pg, id).boundingBox();
  const c = await col.boundingBox();
  if (!b || !c) return null;
  return { top: b.y - c.y, height: b.height, x: b.x, width: b.width };
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

  /* ------------------------------------------------------------- CA-8 */
  const calProbe = await oraw("GET", "/api/calendar/settings");
  if (calProbe.status() === 404 || OFF) {
    console.log("\n== CA-8) AGENDA apagada ==");
    ok("modo --off: la agenda está apagada", calProbe.status() === 404, `status=${calProbe.status()}`);
    const page = await oraw("GET", "/bookings");
    ok("/bookings → 404", page.status() === 404, `status=${page.status()}`);
    const today = todayIn("America/Mexico_City");
    const rng = await oraw("GET", `/api/bookings?from=${today}&to=${addDays(today, 6)}`);
    ok("GET /api/bookings?from&to → 404", rng.status() === 404, `status=${rng.status()}`);
    const mv = await oraw("PATCH", "/api/bookings/bk_inexistente", { action: "move", startUtc: new Date().toISOString() });
    ok("PATCH move → 404", mv.status() === 404, `status=${mv.status()}`);
    const anon = await browser.newContext();
    const anonR = await anon.request.get(`${BASE}/api/bookings?from=${today}&to=${addDays(today, 6)}`);
    ok("sin sesión: GET /api/bookings?from&to → 404 (no 401)", anonR.status() === 404, `status=${anonR.status()}`);
    // La pantalla en el navegador: la página de 404 de siempre.
    const pg = await owner.ctx.newPage();
    const resp = await pg.goto(`${BASE}/bookings`, { waitUntil: "load" });
    ok("el navegador recibe 404 en /bookings", resp?.status() === 404, `status=${resp?.status()}`);
    ok("…sin calendario", (await pg.getByTestId("cal-grid").count()) === 0);
    throw new Error("__done__");
  }

  await api("PUT", "/api/settings/whatsapp", { wabaId: "WABA-028-UI", phoneNumberId: PN, token: "tok-028-ui" });
  const V1_NAME = `Juan Cal ${S}`;
  const V2_NAME = `Ana Cal ${S}`;
  const V1_EMAIL = `juan.cal.${S.toLowerCase()}@vocero.test`;
  const V2_EMAIL = `ana.cal.${S.toLowerCase()}@vocero.test`;
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
  const OWNER_ID = members.find((m) => m.email === OWNER_EMAIL)?.userId;
  ok("dos Vendedores dados de alta", Boolean(V1 && V2 && OWNER_ID));

  const work = [{ start: "09:00", end: "18:00" }];
  const settingsBody = (extra = {}) => ({
    weeklyHours: { mon: work, tue: work, wed: work, thu: work, fri: work, sat: [{ start: "09:00", end: "13:00" }], sun: [] },
    slotMinutes: 30,
    bufferMinutes: 0,
    minNoticeHours: 0,
    maxDaysAhead: 30,
    connector: "enlace-fijo",
    meetingLink: null,
    address: null,
    ...extra,
  });
  const cal = await api("PUT", "/api/calendar/settings", settingsBody());
  ok("agenda lun–vie 9–18, sáb 9–13, dom cerrado (30 min, sin margen)", !!cal?.settings, JSON.stringify(cal)?.slice(0, 200));
  const TZ = cal?.settings?.timezone ?? "America/Mexico_City";
  ok("la zona del negocio es America/Mexico_City (el navegador va en Tokio)", TZ === "America/Mexico_City", TZ);

  // D = primer lun–vie desde mañana (zona del negocio); SAT = su sábado.
  let D = addDays(todayIn(TZ), 1);
  while (dow(D) === 0 || dow(D) === 6) D = addDays(D, 1);
  const SAT = addDays(D, 6 - dow(D));
  const SUN = addDays(SAT, 1);
  const MON = addDays(D, 1 - dow(D));
  const at = (hm, day = D) => utcOf(day, hm, TZ);
  console.log(`  INFO día D=${D} · sábado=${SAT} · semana ${MON}…${SUN}`);

  // Contactos con conversación (wa-mock).
  const names = ["Beto", "Bruno", "Sara", "Sofía", "Pablo", "Hugo", "Mara", "Gabo", "Carla"].map((n) => `${n} Cal ${S}`);
  const SUF = String(Math.floor(Math.random() * 9e4) + 1e4);
  let n = 0;
  for (const name of names) {
    await oreq.post(`${BASE}/api/dev/wa-mock/inbound`, {
      headers: { origin: BASE },
      data: {
        phoneNumberId: PN,
        from: `521558${SUF}${String(n++).padStart(2, "0")}`,
        name,
        text: "hola, quiero una cita",
        waMessageId: `wamid.028ui.${S}.${n}`,
      },
    });
  }
  await sleep(2000);
  const convs = (await api("GET", "/api/conversations"))?.conversations ?? [];
  const contactId = (i) => convs.find((c) => c.contact?.name === names[i])?.contact?.id;
  ok("contactos de prueba con conversación", names.every((_, i) => contactId(i)));

  const types = (await api("GET", "/api/calendar/types"))?.types ?? [];
  const SERVICIO = types.find((t) => t.name === "Servicio");
  const PRUEBA = types.find((t) => t.name === "Prueba de manejo");
  ok("tipos sembrados (Servicio 30 min, Prueba de manejo 60 min)", SERVICIO?.durationMinutes === 30 && PRUEBA?.durationMinutes === 60, JSON.stringify(types.map((t) => [t.name, t.durationMinutes])));

  const book = async (i, typeId, startUtc, assignedUserId, confirmOverlap) => {
    const r = await oraw("POST", "/api/bookings", {
      kind: "session",
      contactId: contactId(i),
      startUtc,
      typeId,
      assignedUserId,
      ...(confirmOverlap ? { confirmOverlap: true } : {}),
    });
    return { status: r.status(), json: await J(r) };
  };
  const B1 = await book(0, PRUEBA.id, at("10:00"), V1);
  const B2 = await book(1, SERVICIO.id, at("12:00"), V1);
  const S1 = await book(2, SERVICIO.id, at("14:00"), V1);
  const S2a = await book(3, SERVICIO.id, at("14:00"), V2);
  const S2 = await book(3, SERVICIO.id, at("14:00"), V2, true);
  const P2 = await book(4, PRUEBA.id, at("15:00"), V2);
  const Hb = await book(5, SERVICIO.id, at("16:00"), V2);
  const M = await book(6, SERVICIO.id, at("09:00"), V2);
  const G = await book(7, SERVICIO.id, at("11:00", SAT), OWNER_ID);
  const blk = await oraw("POST", "/api/bookings", { kind: "block", startUtc: at("16:00"), durationMinutes: 60, notes: `bloqueo ${S}` });
  const blkJ = await J(blk);
  ok("S2 sin confirmar → 409 overlap_warning", S2a.status === 409 && S2a.json?.error?.code === "overlap_warning", JSON.stringify(S2a));
  const created = { B1, B2, S1, S2, P2, Hb, M, G };
  ok(
    "citas de prueba creadas (201)",
    Object.values(created).every((c) => c.status === 201),
    JSON.stringify(Object.fromEntries(Object.entries(created).map(([k, v]) => [k, v.status === 201 ? 201 : v.json])))
  );
  ok("bloqueo 16–17 sobre H → 201 con la cita afectada", blk.status() === 201 && (blkJ?.affected?.length ?? 0) === 1, JSON.stringify(blkJ));
  const id = Object.fromEntries(Object.entries(created).map(([k, v]) => [k, v.json?.booking?.id]));
  id.BLK = blkJ?.booking?.id;

  /** `GET /api/bookings?from&to` de la semana de D. */
  const rangeApi = async (req = oreq) =>
    J(await req.get(`${BASE}/api/bookings?from=${MON}&to=${SUN}`, { headers: { origin: BASE } }));
  const bookingOf = async (bid, req = oreq) => (await rangeApi(req))?.bookings?.find((b) => b.id === bid);
  const r0 = await rangeApi();
  ok("GET rango: hours con 5 campos y la zona del negocio", r0?.hours && ["weeklyHours", "slotMinutes", "bufferMinutes", "minNoticeHours", "timezone"].every((k) => k in r0.hours) && r0.hours.timezone === TZ, JSON.stringify(r0?.hours)?.slice(0, 200));
  ok("GET rango: overlaps S1/S2 soft y H hard", r0?.overlaps?.[id.S1] === "soft" && r0?.overlaps?.[id.S2] === "soft" && r0?.overlaps?.[id.Hb] === "hard", JSON.stringify(r0?.overlaps));

  for (const p of ["/bookings", "/api/bookings"]) await oreq.get(`${BASE}${p}`).catch(() => {});

  /* --------------------------------------------- R1: la carga con rango falla */
  console.log("\n== R1) La primera carga con rango falla → error y Reintentar ==");
  {
    const rp = await owner.ctx.newPage();
    const isRange = (url) => url.pathname === "/api/bookings" && url.searchParams.has("from");
    let failed = 0;
    const fail500 = (route) => {
      failed++;
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Falla simulada del servidor" } }) });
    };
    await rp.route(isRange, fail500);
    await rp.goto(`${BASE}/bookings`, { waitUntil: "load" });
    const le = rp.getByTestId("cal-load-error");
    ok("aparece cal-load-error (role=alert)", (await soft((ms) => le.waitFor({ timeout: ms }), 40000)) && (await le.getAttribute("role")) === "alert", `fallos=${failed}`);
    ok("…con el motivo y sin \"Cargando…\" colgado", /Falla simulada/.test((await le.textContent()) ?? "") && (await rp.getByText("Cargando…").count()) === 0, await le.textContent().catch(() => ""));
    await shot(rp, "00-error-de-carga");
    await rp.unroute(isRange, fail500);
    await le.getByRole("button", { name: "Reintentar" }).click();
    ok("Reintentar → se pinta el calendario", await soft((ms) => rp.getByTestId("cal-grid").waitFor({ timeout: ms })));
    ok("…y el error desaparece", await soft((ms) => le.waitFor({ state: "hidden", timeout: ms })));
    await rp.close();
  }

  /* ------------------------------------------------------------- CA-1 */
  console.log("\n== CA-1) Semana por defecto, posición y alto ==");
  const page = await owner.ctx.newPage();
  const patches = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH" && /\/api\/bookings\/[^/?]+$/.test(r.url())) patches.push(r.postDataJSON?.() ?? null);
  });
  await page.goto(`${BASE}/bookings`, { waitUntil: "load" });
  await soft((ms) => page.getByTestId("cal-grid").waitFor({ timeout: ms }), 40000);
  ok("a 1280×800 la vista inicial es Semana", (await page.getByTestId("cal-view-week").getAttribute("aria-pressed")) === "true");
  ok("la leyenda se ve", await page.getByTestId("cal-legend").isVisible().catch(() => false));
  ok("hay columnas lun–dom (7)", (await page.getByTestId("cal-day-column").count()) === 7);
  ok("navega hasta la semana de D", await gotoWeek(page, D));
  const colD = dayCol(page, D);
  await soft((ms) => block(page, id.B1).waitFor({ timeout: ms }));
  const o1 = await offsetIn(page, id.B1, colD);
  const o2 = await offsetIn(page, id.B2, colD);
  ok("B1 (10:00) en la columna de D", (await colD.locator(`[data-booking-id="${id.B1}"]`).count()) === 1);
  ok("B1 a la altura de las 10:00 de México (1 h bajo la apertura 9:00)", o1 && Math.abs(o1.top - 60 * PX) <= 2, JSON.stringify(o1));
  ok("B2 (12:00) 2 h más abajo que B1", o1 && o2 && Math.abs(o2.top - o1.top - 120 * PX) <= 2, JSON.stringify({ o1, o2 }));
  ok("alto proporcional: 60 min ≈ 2 × 30 min", o1 && o2 && Math.abs(o1.height - 2 * o2.height) <= 3, `h60=${o1?.height} h30=${o2?.height}`);
  ok("la etiqueta dice 10:00–11:00 (hora del negocio)", ((await block(page, id.B1).getAttribute("aria-label")) ?? "").includes("10:00–11:00"), await block(page, id.B1).getAttribute("aria-label"));
  ok("sábado con banda fuera de horario (13–18)", (await dayCol(page, SAT).getByTestId("cal-off-band").count()) >= 1);
  ok("domingo cerrado: sin huecos para crear", (await dayCol(page, SUN).getByTestId("cal-empty-cell").count()) === 0);
  await shot(page, "01-semana-citas-leyenda", { fullPage: true });

  /* ------------------------------------------------------------- CA-2 */
  console.log("\n== CA-2) Traslapes soft y hard ==");
  const s1 = block(page, id.S1);
  const s2 = block(page, id.S2);
  ok("S1 y S2 con data-overlap=soft", (await s1.getAttribute("data-overlap")) === "soft" && (await s2.getAttribute("data-overlap")) === "soft");
  const b1x = await s1.boundingBox();
  const b2x = await s2.boundingBox();
  ok("…lado a lado (x distintas, misma altura)", b1x && b2x && Math.abs(b1x.x - b2x.x) > 10 && Math.abs(b1x.y - b2x.y) <= 1, JSON.stringify({ b1x, b2x }));
  ok("H (bajo el bloqueo) con data-overlap=hard", (await block(page, id.Hb).getAttribute("data-overlap")) === "hard");
  ok("el bloqueo se pinta como bloque kind=block", (await block(page, id.BLK).getAttribute("data-kind")) === "block");
  await s1.scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, "02-traslapes-soft-hard");

  /* ------------------------------------------------------------- CA-3 */
  console.log("\n== CA-3) Clic en hueco libre → Nueva cita prellenada ==");
  const free = cell(page, colD, at("11:30"));
  const dlg = page.getByTestId("booking-dialog");
  ok("clic en el hueco de las 11:30 abre Nueva cita", await clickUntil(free, dlg));
  await dlg.getByTestId("booking-type").selectOption(SERVICIO.id).catch(() => {});
  const dayBtn = dlg.locator(`[data-testid="booking-day"][data-day="${D}"]`);
  const slotBtn = dlg.locator(`[data-testid="booking-slot"][data-start="${at("11:30")}"]`);
  await soft((ms) => slotBtn.waitFor({ timeout: ms }));
  ok("el día D queda elegido", (await dayBtn.getAttribute("aria-pressed").catch(() => null)) === "true");
  ok("la hora 11:30 queda elegida", (await slotBtn.getAttribute("aria-pressed").catch(() => null)) === "true");
  ok("sin aviso de hueco fuera de la rejilla", (await dlg.getByTestId("booking-prefill-miss").count()) === 0);
  await page.keyboard.press("Escape");
  await soft((ms) => dlg.waitFor({ state: "hidden", timeout: ms }));

  // Desde aquí los arrastres: viewport alto para que la página no se desplace.
  await page.setViewportSize({ width: 1280, height: 1400 });
  await sleep(500);

  /* ------------------------------------------------------------- CA-5 */
  console.log("\n== CA-5a) Arrastrar a un hueco libre ==");
  ok("B2 se puede arrastrar (data-draggable)", (await block(page, id.B2).getAttribute("data-draggable")) === "true");
  let t = await targetAt(colD, cell(page, colD, at("13:00")));
  let pv = await dragTo(page, block(page, id.B2), t, { shotName: "03-arrastre-vista-previa", release: false });
  ok("durante el arrastre: vista previa free a las 13:00", pv.state === "free" && pv.start === at("13:00"), JSON.stringify(pv));
  const patchWait = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes(`/api/bookings/${id.B2}`), { timeout: 15000 }).catch(() => null);
  await page.mouse.up();
  const pr = await patchWait;
  ok("al soltar: PATCH move → 200", pr?.status() === 200, String(pr?.status()));
  ok("aviso \"Cita movida a …\"", await soft((ms) => page.getByTestId("bookings-notice").filter({ hasText: "Cita movida a" }).waitFor({ timeout: ms })));
  await sleep(800);
  let ob = await offsetIn(page, id.B2, colD);
  ok("B2 quedó a la altura de las 13:00", ob && Math.abs(ob.top - 240 * PX) <= 2, JSON.stringify(ob));
  ok("GET rango: B2 a las 13:00", (await bookingOf(id.B2))?.scheduledAtUtc === at("13:00"));
  await gotoWeek(page, D);
  await soft((ms) => block(page, id.B2).waitFor({ timeout: ms }));
  ob = await offsetIn(page, id.B2, colD);
  ok("tras recargar sigue a las 13:00", ob && Math.abs(ob.top - 240 * PX) <= 2, JSON.stringify(ob));

  console.log("\n== CA-5b) Choque con otro vendedor → confirmación ==");
  const nP0 = patches.length;
  t = await targetAt(colD, cell(page, colD, at("13:00")));
  pv = await dragTo(page, block(page, id.M), t, { release: false });
  ok("vista previa soft (ocupado por otro vendedor)", pv.state === "soft", JSON.stringify(pv));
  await page.mouse.up();
  const ovd = page.getByTestId("move-overlap-dialog");
  ok("al soltar: diálogo de choque", await soft((ms) => ovd.waitFor({ timeout: ms })));
  ok("…que menciona la otra cita", /A esa hora ya hay/.test((await ovd.textContent()) ?? ""), await ovd.textContent().catch(() => ""));
  await shot(page, "04-dialogo-choque");
  await ovd.getByRole("button", { name: "Cancelar" }).click();
  await soft((ms) => ovd.waitFor({ state: "hidden", timeout: ms }));
  await sleep(500);
  ob = await offsetIn(page, id.M, colD);
  ok("cancelar: M vuelve a las 9:00", ob && Math.abs(ob.top - 0) <= 2, JSON.stringify(ob));
  ok("…y en la BD sigue a las 9:00", (await bookingOf(id.M))?.scheduledAtUtc === at("09:00"));
  ok("…(un solo PATCH, sin confirmar)", patches.length - nP0 === 1 && !patches.at(-1)?.confirmOverlap, JSON.stringify(patches.slice(nP0)));
  t = await targetAt(colD, cell(page, colD, at("13:00")));
  await dragTo(page, block(page, id.M), t);
  ok("de nuevo: diálogo de choque", await soft((ms) => ovd.waitFor({ timeout: ms })));
  await ovd.getByTestId("move-overlap-confirm").click();
  ok("confirmar → \"Cita movida a …\"", await soft((ms) => page.getByTestId("bookings-notice").filter({ hasText: "Cita movida a" }).waitFor({ timeout: ms })));
  ok("…el PATCH llevó confirmOverlap", patches.at(-1)?.confirmOverlap === true, JSON.stringify(patches.at(-1)));
  ok("GET rango: M a las 13:00", (await bookingOf(id.M))?.scheduledAtUtc === at("13:00"));
  await sleep(800);
  ok("M y B2 ahora traslapados (soft)", (await block(page, id.M).getAttribute("data-overlap")) === "soft");

  console.log("\n== CA-5c) Rechazos sin servidor ==");
  const nP1 = patches.length;
  t = await targetAt(colD, cell(page, colD, at("10:00")));
  pv = await dragTo(page, block(page, id.P2), t, { shotName: "05-arrastre-rechazo" });
  ok("Prueba de manejo sobre otra Prueba: vista previa reject", pv.state === "reject" && /Ocupado/.test(pv.text ?? ""), JSON.stringify(pv));
  const merr = page.getByTestId("cal-move-error");
  ok("cal-move-error (role=alert) con el motivo", await soft((ms) => merr.waitFor({ timeout: ms })) && (await merr.getAttribute("role")) === "alert", await merr.textContent().catch(() => ""));
  ob = await offsetIn(page, id.P2, colD);
  ok("P2 sigue a las 15:00 en pantalla", ob && Math.abs(ob.top - 360 * PX) <= 2, JSON.stringify(ob));
  // Fuera de horario: sábado a las 14:00 (cierra a las 13:00).
  t = await targetAt(dayCol(page, SAT), cell(page, colD, at("14:00")));
  pv = await dragTo(page, block(page, id.P2), t);
  ok("al sábado 14:00: reject \"Fuera de horario\"", pv.state === "reject" && /Fuera de horario/.test(pv.text ?? ""), JSON.stringify(pv));
  ok("…con cal-move-error", /Fuera de horario/.test((await merr.textContent().catch(() => "")) ?? ""), await merr.textContent().catch(() => ""));
  // Día cerrado: domingo.
  t = await targetAt(dayCol(page, SUN), cell(page, colD, at("11:00")));
  pv = await dragTo(page, block(page, id.P2), t);
  ok("al domingo: reject \"Día cerrado\"", pv.state === "reject" && /Día cerrado/.test(pv.text ?? ""), JSON.stringify(pv));
  ok("ningún rechazo llamó al servidor (0 PATCH)", patches.length === nP1, JSON.stringify(patches.slice(nP1)));
  ok("en la BD P2 sigue a las 15:00", (await bookingOf(id.P2))?.scheduledAtUtc === at("15:00"));

  console.log("\n== CA-5d) Clic simple abre el detalle ==");
  const nP2 = patches.length;
  const bb = await block(page, id.B1).boundingBox();
  await page.mouse.click(bb.x + bb.width / 2, bb.y + 8);
  const panel = page.getByTestId("booking-detail-panel");
  ok("clic sin mover → booking-detail-panel", await soft((ms) => panel.waitFor({ timeout: ms })));
  ok("…sin PATCH ni movimiento", patches.length === nP2 && (await bookingOf(id.B1))?.scheduledAtUtc === at("10:00"));
  // R2 — Escape con el diálogo de Reprogramar encima del panel.
  ok("panel → Reprogramar abre el diálogo", await clickUntil(panel.getByRole("button", { name: "Reprogramar" }), dlg));
  await page.keyboard.press("Escape");
  ok("Escape cierra SOLO el diálogo", await soft((ms) => dlg.waitFor({ state: "hidden", timeout: ms })));
  await sleep(300);
  ok("…y el panel sigue abierto", await panel.isVisible().catch(() => false));
  // Un segundo Escape (ya sin diálogo) cierra el panel.
  await page.keyboard.press("Escape");
  ok("un segundo Escape cierra el panel", await soft((ms) => panel.waitFor({ state: "hidden", timeout: ms })));
  // Detalle de una cita en conflicto.
  await block(page, id.Hb).click();
  ok("el detalle de H muestra el conflicto", await soft((ms) => panel.getByTestId("booking-detail-overlap").waitFor({ timeout: ms })));
  await shot(page, "06-panel-detalle-conflicto");
  await page.keyboard.press("Escape");
  await soft((ms) => panel.waitFor({ state: "hidden", timeout: ms }));

  console.log("\n== Camino infeliz: el PATCH move falla por red ==");
  const abortPatch = (route) => (route.request().method() === "PATCH" ? route.abort("internetdisconnected") : route.continue());
  await page.route("**/api/bookings/*", abortPatch);
  t = await targetAt(colD, cell(page, colD, at("17:00")));
  pv = await dragTo(page, block(page, id.B2), t);
  ok("vista previa free a las 17:00", pv.state === "free", JSON.stringify(pv));
  ok("cal-move-error de conexión", await soft((ms) => merr.filter({ hasText: /conexi/i }).waitFor({ timeout: ms })), await merr.textContent().catch(() => ""));
  await sleep(800);
  ob = await offsetIn(page, id.B2, colD);
  ok("B2 volvió a las 13:00", ob && Math.abs(ob.top - 240 * PX) <= 2, JSON.stringify(ob));
  await page.unroute("**/api/bookings/*", abortPatch);
  ok("en la BD B2 sigue a las 13:00", (await bookingOf(id.B2))?.scheduledAtUtc === at("13:00"));

  /* -------------------------------------------------------------- stale */
  console.log("\n== stale ==");
  const st = await oraw("PATCH", `/api/bookings/${id.B2}`, { action: "move", startUtc: at("17:30"), expectedStartUtc: at("12:00") });
  const stJ = await J(st);
  ok("PATCH move con expectedStartUtc viejo → 409 stale", st.status() === 409 && stJ?.error?.code === "stale", JSON.stringify(stJ));
  ok("…y no movió nada", (await bookingOf(id.B2))?.scheduledAtUtc === at("13:00"));

  /* ------------------------------------------------------- CA-4 y CA-6 */
  console.log("\n== CA-4) Día por vendedor (owner) ==");
  const dayOk = await gotoDay(page, D, TZ);
  ok("Día por vendedor en D", dayOk);
  const sellerIds = await page.getByTestId("cal-seller-column").evaluateAll((els) => els.map((e) => e.getAttribute("data-seller")));
  ok("owner: una columna por miembro + none", [OWNER_ID, V1, V2, "none"].every((x) => sellerIds.includes(x)) && sellerIds.length === 4, JSON.stringify(sellerIds));
  ok("B1 en la columna de Juan, S2 en la de Ana", (await sellerCol(page, V1).locator(`[data-booking-id="${id.B1}"]`).count()) === 1 && (await sellerCol(page, V2).locator(`[data-booking-id="${id.S2}"]`).count()) === 1);
  ok("el bloqueo cruza todas las columnas", (await page.locator(`[data-testid="cal-booking"][data-booking-id="${id.BLK}"]`).count()) === 4);
  await shot(page, "07-dia-por-vendedor-owner");

  console.log("\n== CA-6) Reasignar arrastrando de columna ==");
  const v1col = sellerCol(page, V1);
  const v2col = sellerCol(page, V2);
  const v1b = await v1col.boundingBox();
  const b1b = await block(page, id.B1).boundingBox();
  const v2b = await v2col.boundingBox();
  pv = await dragTo(page, block(page, id.B1), { x: v2b.x + (b1b.x - v1b.x), y: b1b.y - 1 }, { release: false });
  ok("vista previa en la columna de Ana: free, misma hora", pv.state === "free" && pv.start === at("10:00"), JSON.stringify(pv));
  const pw = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes(`/api/bookings/${id.B1}`), { timeout: 15000 }).catch(() => null);
  await page.mouse.up();
  const pwr = await pw;
  ok("PATCH move (solo userId) → 200", pwr?.status() === 200 && patches.at(-1)?.userId === V2 && patches.at(-1)?.startUtc === undefined, `${pwr?.status()} ${JSON.stringify(patches.at(-1))}`);
  const b1after = await bookingOf(id.B1);
  ok("GET: B1 ahora es de Ana, misma hora", b1after?.assignedUser?.id === V2 && b1after?.scheduledAtUtc === at("10:00"), JSON.stringify(b1after?.assignedUser));
  await sleep(800);
  ok("…y se pinta en su columna", (await v2col.locator(`[data-booking-id="${id.B1}"]`).count()) === 1);

  // El Vendedor (Juan).
  const juan = await actor(V1_EMAIL, SPASS, { viewport: { width: 1280, height: 1400 } });
  ok("login Juan (Vendedor)", juan.ok);
  const jp = await juan.ctx.newPage();
  const jpatches = [];
  jp.on("request", (r) => {
    if (r.method() === "PATCH" && /\/api\/bookings\/[^/?]+$/.test(r.url())) jpatches.push(r.postDataJSON?.() ?? null);
  });
  ok("Juan: Día por vendedor en D", await gotoDay(jp, D, TZ));
  const jIds = await jp.getByTestId("cal-seller-column").evaluateAll((els) => els.map((e) => e.getAttribute("data-seller")));
  ok("Juan solo ve su columna + none", jIds.length === 2 && jIds.includes(V1) && jIds.includes("none"), JSON.stringify(jIds));
  const anas = [id.S2, id.P2, id.Hb, id.M, id.B1];
  const seenAna = [];
  for (const x of anas) if ((await jp.locator(`[data-booking-id="${x}"]`).count()) > 0) seenAna.push(x);
  ok("Juan no ve las citas de Ana", seenAna.length === 0, JSON.stringify(seenAna));
  ok("Juan ve las suyas (B2, S1)", (await block(jp, id.B2).count()) === 1 && (await block(jp, id.S1).count()) === 1);
  await shot(jp, "08-dia-por-vendedor-vendedor");
  const jv1 = await sellerCol(jp, V1).boundingBox();
  const jnone = await sellerCol(jp, "none").boundingBox();
  const jb2 = await block(jp, id.B2).boundingBox();
  pv = await dragTo(jp, block(jp, id.B2), { x: jnone.x + (jb2.x - jv1.x), y: jb2.y - 1 });
  ok("Juan arrastra a \"Sin asignar\": reject \"Solo el Propietario reasigna\"", pv.state === "reject" && /Solo el Propietario reasigna/.test(pv.text ?? ""), JSON.stringify(pv));
  ok("…cal-move-error con el motivo", await soft((ms) => jp.getByTestId("cal-move-error").filter({ hasText: "Solo el Propietario reasigna" }).waitFor({ timeout: ms })));
  ok("…sin PATCH y sigue siendo suya", jpatches.length === 0 && (await bookingOf(id.B2))?.assignedUser?.id === V1, JSON.stringify(jpatches));
  const j403 = await juan.req.fetch(`${BASE}/api/bookings/${id.B2}`, { method: "PATCH", headers: { origin: BASE }, data: { action: "move", userId: null } });
  ok("API: Vendedor PATCH move con userId → 403", j403.status() === 403, String(j403.status()));
  const j403b = await juan.req.fetch(`${BASE}/api/bookings/${id.B2}`, { method: "PATCH", headers: { origin: BASE }, data: { action: "move", startUtc: at("17:30"), userId: V1 } });
  ok("…también con hora + userId → 403", j403b.status() === 403, String(j403b.status()));
  await juan.ctx.close();

  /* ------------------------------------------------------------ R3 teclado */
  console.log("\n== R3) Arrastre con teclado y Enter ==");
  ok("Semana en la semana de D", await gotoWeek(page, D));
  await soft((ms) => block(page, id.G).waitFor({ timeout: ms }));
  ok("G (sáb 11:00) se puede arrastrar", (await block(page, id.G).getAttribute("data-draggable")) === "true");
  const nPk = patches.length;
  await block(page, id.G).focus();
  await page.keyboard.press("Space");
  await sleep(300);
  await page.keyboard.press("ArrowDown");
  await sleep(250);
  await page.keyboard.press("ArrowDown");
  await sleep(350);
  const kpv = page.getByTestId("cal-drop-preview");
  const kinfo = (await kpv.count()) ? { state: await kpv.getAttribute("data-state"), start: await kpv.getAttribute("data-start"), text: await kpv.textContent() } : null;
  ok("Espacio + ↓↓: vista previa free 2 pasos abajo (12:00)", kinfo?.state === "free" && kinfo?.start === at("12:00", SAT), JSON.stringify(kinfo));
  const kw = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes(`/api/bookings/${id.G}`), { timeout: 15000 }).catch(() => null);
  await page.keyboard.press("Space");
  const kwr = await kw;
  ok("Espacio suelta → PATCH 200", kwr?.status() === 200, String(kwr?.status()));
  ok("GET: G a las 12:00 del sábado", (await bookingOf(id.G))?.scheduledAtUtc === at("12:00", SAT));
  ok("(un solo PATCH)", patches.length - nPk === 1, JSON.stringify(patches.slice(nPk)));
  await sleep(600);
  const panelAfterKb = await page.getByTestId("booking-detail-panel").isVisible().catch(() => false);
  ok("soltar con Espacio no abre además el panel", !panelAfterKb);
  if (panelAfterKb) {
    await page.keyboard.press("Escape");
    await sleep(300);
  }
  // Enter sin arrastrar abre el detalle.
  const nPe = patches.length;
  await block(page, id.B2).focus();
  await page.keyboard.press("Enter");
  const kpanel = page.getByTestId("booking-detail-panel");
  ok("Enter sobre un bloque abre booking-detail-panel", await soft((ms) => kpanel.waitFor({ timeout: ms })));
  ok("…sin PATCH", patches.length === nPe);
  await page.keyboard.press("Escape");
  await soft((ms) => kpanel.waitFor({ state: "hidden", timeout: ms }));

  /* -------------------------------------------------------------- margen */
  console.log("\n== Margen: bufferMinutes=15 ==");
  const cal15 = await api("PUT", "/api/calendar/settings", settingsBody({ bufferMinutes: 15 }));
  ok("margen de 15 min guardado", cal15?.settings?.bufferMinutes === 15, JSON.stringify(cal15?.settings?.bufferMinutes));
  ok("Semana en la semana de D", await gotoWeek(page, D));
  const colS = dayCol(page, SAT);
  await soft((ms) => block(page, id.G).waitFor({ timeout: ms }));
  // Rejilla del sábado: 9:00, 9:45, 10:30… Apuntar a las 10:00 salta a 9:45.
  const nP3 = patches.length;
  t = await targetAt(colS, cell(page, colS, at("10:00", SAT)));
  pv = await dragTo(page, block(page, id.G), t, { release: false });
  ok("apuntar a las 10:00 → la vista previa salta a 9:45 (slot+buffer)", pv.state === "free" && pv.start === at("09:45", SAT), JSON.stringify(pv));
  const avail = (await api("GET", `/api/calendar/availability?typeId=${SERVICIO.id}&excludeBookingId=${id.G}`))?.slots ?? [];
  ok("9:45 del sábado está en la disponibilidad del servidor", avail.some((s) => s.startUtc === at("09:45", SAT)), JSON.stringify(avail.filter((s) => s.dayIso === SAT).map((s) => s.startUtc)).slice(0, 300));
  const pm = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes(`/api/bookings/${id.G}`), { timeout: 15000 }).catch(() => null);
  await page.mouse.up();
  const pmr = await pm;
  ok("soltar en 9:45 → PATCH 200", pmr?.status() === 200, String(pmr?.status()));
  ok("GET: G a las 9:45", (await bookingOf(id.G))?.scheduledAtUtc === at("09:45", SAT));
  await sleep(800);
  // 12:45 sí es de la rejilla de 45 pero la cita (30 min) no cabe antes de las 13:00.
  const nP4 = patches.length;
  t = await targetAt(colS, cell(page, colS, at("12:30", SAT)));
  pv = await dragTo(page, block(page, id.G), t);
  ok("a las 12:45 del sábado: reject \"No cabe antes del cierre\"", pv.state === "reject" && /No cabe/.test(pv.text ?? ""), JSON.stringify(pv));
  ok("…sin llamar al servidor", patches.length === nP4, JSON.stringify(patches.slice(nP4)));
  ok("(PATCHs de la sección: solo el de 9:45)", patches.length - nP3 === 1);
  const mis = await oraw("PATCH", `/api/bookings/${id.G}`, { action: "move", startUtc: at("10:00", SAT) });
  ok("por API, un inicio desalineado (10:00 con margen) → 409 slot_taken", mis.status() === 409 && (await J(mis))?.error?.code === "slot_taken", String(mis.status()));
  await api("PUT", "/api/calendar/settings", settingsBody());

  /* ---------------------------------------------------- R4 auto-scroll */
  console.log("\n== R4) Auto-scroll al arrastrar (viewport bajo) ==");
  {
    const K = await book(8, SERVICIO.id, at("09:30"), OWNER_ID);
    ok("(API) K Servicio 9:30 del owner", K.status === 201, JSON.stringify(K.json));
    const kid = K.json?.booking?.id;
    const ap = await owner.ctx.newPage();
    await ap.setViewportSize({ width: 1280, height: 600 });
    ok("Semana en D (1280×600)", await gotoWeek(ap, D));
    await soft((ms) => block(ap, kid).waitFor({ timeout: ms }));
    const gridL = ap.getByTestId("cal-grid");
    await gridL.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await gridL.evaluate((el) => (el.scrollTop = 0));
    await sleep(300);
    const g0 = await gridL.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, st: el.scrollTop }));
    ok("la rejilla tiene scroll interno", g0.sh > g0.ch, JSON.stringify(g0));
    const gb = await gridL.boundingBox();
    const kb = await block(ap, kid).boundingBox();
    const sx = kb.x + kb.width / 2;
    const sy = kb.y + Math.min(kb.height / 2, 8);
    await ap.mouse.move(sx, sy);
    await ap.mouse.down();
    await ap.mouse.move(sx, sy + 10, { steps: 5 });
    const edgeY = gb.y + gb.height - 6;
    await ap.mouse.move(sx, edgeY, { steps: 15 });
    for (let i = 0; i < 20; i++) {
      await ap.mouse.move(sx, edgeY + (i % 2 ? 0.5 : -0.5));
      await sleep(100);
    }
    const g1 = await gridL.evaluate((el) => el.scrollTop);
    ok("el contenedor se desplazó solo (auto-scroll)", g1 > g0.st, `scrollTop ${g0.st} → ${g1}`);
    // Ya abajo: apunta al hueco de las 17:00 y suelta.
    const c17 = await cell(ap, dayCol(ap, D), at("17:00")).boundingBox();
    if (c17) await ap.mouse.move(sx, c17.y + (sy - kb.y) + 1, { steps: 8 });
    await sleep(400);
    const apv = ap.getByTestId("cal-drop-preview");
    const ainfo = (await apv.count()) ? { state: await apv.getAttribute("data-state"), start: await apv.getAttribute("data-start"), text: await apv.textContent() } : null;
    await shot(ap, "13-auto-scroll-vista-previa");
    ok("vista previa free en la tarde", ainfo?.state === "free" && !!ainfo.start && Date.parse(ainfo.start) >= Date.parse(at("15:00")), JSON.stringify(ainfo));
    const aw = ap.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes(`/api/bookings/${kid}`), { timeout: 15000 }).catch(() => null);
    await ap.mouse.up();
    const awr = await aw;
    ok("soltar → PATCH 200", awr?.status() === 200, String(awr?.status()));
    const kAfter = (await bookingOf(kid))?.scheduledAtUtc;
    ok("la hora final es la que mostraba la vista previa", !!ainfo?.start && kAfter === ainfo.start, `${kAfter} vs ${ainfo?.start}`);
    await ap.close();
  }

  /* ------------------------------------------------------------- CA-7 */
  console.log("\n== CA-7) Móvil y tema oscuro ==");
  const state = await owner.ctx.storageState();
  const cookiesOnly = { cookies: state.cookies, origins: [] };
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: cookiesOnly, isMobile: true, hasTouch: true, timezoneId: BROWSER_TZ });
  const mp = await mctx.newPage();
  await mp.goto(`${BASE}/bookings`, { waitUntil: "load" });
  await soft((ms) => mp.getByTestId("cal-grid").waitFor({ timeout: ms }), 40000);
  ok("a 390×844 la vista inicial es Día", (await mp.getByTestId("cal-view-day").getAttribute("aria-pressed")) === "true");
  const over1 = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok("Día: sin scroll horizontal de página", over1 <= 0, `overflow=${over1}px`);
  await gotoDay(mp, D, TZ);
  await shot(mp, "09-movil-dia");
  await clickUntil(mp.getByTestId("cal-view-week"), mp.locator('[data-testid="cal-view-week"][aria-pressed="true"]'));
  await soft((ms) => mp.getByTestId("cal-day-column").first().waitFor({ timeout: ms }));
  const over2 = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const gridScroll = await mp.getByTestId("cal-grid").evaluate((el) => el.scrollWidth > el.clientWidth);
  ok("Semana en móvil: sin scroll de página (el calendario se desplaza dentro)", over2 <= 0 && gridScroll, `overflow=${over2}px gridScroll=${gridScroll}`);
  await shot(mp, "10-movil-semana");
  await mctx.close();

  const dctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, storageState: cookiesOnly, timezoneId: BROWSER_TZ });
  await dctx.addCookies([{ name: "vocero-theme", value: "dark", url: BASE }]);
  const dp = await dctx.newPage();
  ok("oscuro: Semana en D", await gotoWeek(dp, D));
  ok("html[data-theme=dark]", (await dp.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "dark");
  ok("oscuro: la leyenda se ve", await dp.getByTestId("cal-legend").isVisible());
  const bg = await block(dp, id.B2).evaluate((el) => getComputedStyle(el).backgroundColor);
  const page_bg = await dp.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok("oscuro: los bloques tienen fondo propio (no transparente ni igual al de la página)", bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg) && bg !== page_bg, `${bg} vs ${page_bg}`);
  const hardBorder = await block(dp, id.Hb).evaluate((el) => getComputedStyle(el).borderTopColor);
  ok("oscuro: el conflicto (hard) se distingue", (await block(dp, id.Hb).getAttribute("data-overlap")) === "hard" && !!hardBorder, hardBorder);
  await shot(dp, "11-oscuro-semana", { fullPage: true });
  const dmctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: cookiesOnly, isMobile: true, hasTouch: true, timezoneId: BROWSER_TZ });
  await dmctx.addCookies([{ name: "vocero-theme", value: "dark", url: BASE }]);
  const dmp = await dmctx.newPage();
  await gotoDay(dmp, D, TZ);
  await shot(dmp, "12-oscuro-movil-dia");
  await dmctx.close();
  await dctx.close();
} catch (err) {
  if (err?.message !== "__done__") {
    failures++;
    console.error("ERROR FATAL:", err);
  }
} finally {
  await browser.close().catch(() => {});
  if (shots.length) {
    console.log("\nCapturas:");
    for (const s of shots) console.log(`  - ${s}`);
  }
  console.log(`\n===== ${checks - failures} OK / ${failures} FAIL =====`);
  process.exit(failures > 0 ? 1 : 0);
}
