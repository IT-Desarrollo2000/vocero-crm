/**
 * Self-test E2E de UI — 023: agenda presencial (tipos de cita, vendedores y
 * choques). Guion humano: tests/e2e/us-agenda-presencial.md. El contrato por
 * API lo cubre scripts/e2e-agenda-presencial.mjs.
 *
 * Recorre como usuario (Playwright, selectores `data-testid`):
 *   a) Owner, Ajustes → Agenda: siembra de tipos; crea "Entrega" (45 min);
 *      Garantía a 40 min; dirección; todo persiste al recargar; los conectores
 *      remotos ("Cómo se entrega la reunión", "Tu sala de siempre") no se ven
 *   b) Owner, Citas → Nueva cita: buscar contacto, Servicio, día y horario
 *      libre → aviso y fila con tipo y vendedor
 *   c) Vendedor, Bandeja → Agendar: el MISMO horario sale "Ocupado"
 *      (`data-busy`) con el detalle; guardar → diálogo de choque → confirmar
 *   d) Vendedor: con una Prueba de manejo ya agendada, ese horario (y su
 *      traslape parcial) NO aparece en la rejilla de Prueba de manejo
 *   e) Owner: filtros por vendedor y tipo; reasignar a un vendedor ocupado →
 *      "Ese vendedor ya tiene una cita a esa hora"; a uno libre → ok
 *   f) Vendedora: no ve la cita de otro vendedor; "Mías" filtra bien
 *   g) Reprogramar desde Citas con el diálogo → hora nueva
 *   h) Camino infeliz: el POST de guardar falla por red → `booking-error`,
 *      el diálogo no se cuelga; reintento → se crea
 *   i) Móvil 390×844: Nueva cita abre, se elige horario, sin scroll lateral
 *
 * Capturas en E2E_SHOTS_DIR (por omisión <tmp>/e2e-shots-023).
 *
 * Uso (BD AISLADA recién migrada, app con AGENDA=on y mocks; reinicia el
 * server antes: el limitador de login es por IP y en memoria):
 *   node --env-file=.env.e2e scripts/e2e-agenda-presencial-ui.mjs
 * Navegador: chromium de Playwright; si falta, Edge (`PW_CHANNEL=msedge`).
 * Sale con código 1 si algún check falla.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const SHOTS = process.env.E2E_SHOTS_DIR ?? path.join(os.tmpdir(), "e2e-shots-023");
const S = Math.random().toString(36).slice(2, 6).toUpperCase();
const PN = "PN-E2E-023-UI";
const MIN = 60_000;
const H = 60 * MIN;

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
const iso = (ms) => new Date(ms).toISOString();
const soft = async (fn, ms = 20000) => {
  try {
    await fn(ms);
    return true;
  } catch {
    return false;
  }
};

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

/** Un contexto de navegador con su sesión (cookies compartidas con `request`). */
async function actor(email, password, { signUp = false, viewport } = {}) {
  const ctx = await browser.newContext({ viewport: viewport ?? { width: 1400, height: 900 } });
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

const J = async (resp) => {
  try {
    return await resp.json();
  } catch {
    return null;
  }
};

try {
  /* ---------------------------------------------------------------- setup */
  console.log("== Setup (API) ==");
  const OWNER_EMAIL = "e2e@vocero.test";
  const PASS = "password-e2e-123";
  const owner = await actor(OWNER_EMAIL, PASS, { signUp: true });
  ok("login owner", owner.ok);
  const oreq = owner.req;
  const api = async (method, p, data) =>
    J(await oreq.fetch(`${BASE}${p}`, { method, headers: { origin: BASE }, ...(data ? { data } : {}) }));

  await api("PUT", "/api/settings/whatsapp", { wabaId: "WABA-023-UI", phoneNumberId: PN, token: "tok-023-ui" });
  const V1_NAME = `Juan UI ${S}`;
  const V2_NAME = `Ana UI ${S}`;
  const V1_EMAIL = `juan.ui.${S.toLowerCase()}@vocero.test`;
  const V2_EMAIL = `ana.ui.${S.toLowerCase()}@vocero.test`;
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
  const allDay = [{ start: "00:00", end: "23:30" }];
  const cal = await api("PUT", "/api/calendar/settings", {
    weeklyHours: { mon: allDay, tue: allDay, wed: allDay, thu: allDay, fri: allDay, sat: allDay, sun: allDay },
    slotMinutes: 30,
    bufferMinutes: 0,
    minNoticeHours: 0,
    maxDaysAhead: 7,
    connector: "enlace-fijo",
    meetingLink: null,
    address: null,
  });
  ok("agenda 24/7 (rejilla 30 min, sin margen)", !!cal?.settings);

  let n = 0;
  const SUF = String(Math.floor(Math.random() * 9e4) + 1e4);
  const names = {
    b: `Beto Cliente ${S}`,
    c: `Carla Cliente ${S}`,
    d: `Diego Cliente ${S}`,
    h: `Hugo Cliente ${S}`,
    m: `Mara Cliente ${S}`,
  };
  for (const name of Object.values(names)) {
    await oreq.post(`${BASE}/api/dev/wa-mock/inbound`, {
      headers: { origin: BASE },
      data: {
        phoneNumberId: PN,
        from: `521557${SUF}${String(n++).padStart(2, "0")}`,
        name,
        text: "hola, quiero una cita",
        waMessageId: `wamid.023ui.${S}.${n}`,
      },
    });
  }
  await sleep(2000);
  const convs = (await api("GET", "/api/conversations"))?.conversations ?? [];
  const conv = (name) => convs.find((c) => c.contact?.name === name);
  ok("contactos de prueba con conversación", Object.values(names).every((nm) => conv(nm)));
  // Carla: conversación asignada a Juan (la abre él en la Bandeja).
  await api("POST", `/api/conversations/${conv(names.c)?.id}/assign`, { userId: V1 });

  const types = (await api("GET", "/api/calendar/types"))?.types ?? [];
  const T = (nm) => types.find((t) => t.name === nm);
  const SERVICIO = T("Servicio");
  const PRUEBA = T("Prueba de manejo");
  ok("siembra de tipos disponible", Boolean(SERVICIO && PRUEBA));

  /** Rejilla del owner para un tipo (sin vendedor). */
  const grid = async (typeId, seller = "none") =>
    (await api("GET", `/api/calendar/availability?typeId=${typeId}&sellerId=${seller}`))?.slots ?? [];
  const t0 = Date.now();
  const pickFree = (slots, minMs, avoid = []) =>
    slots.find(
      (s) => Date.parse(s.startUtc) >= minMs && s.conflicts.length === 0 && !avoid.includes(s.startUtc)
    );

  // Precalentar rutas (next dev compila cada una en su primera petición).
  for (const p of ["/bookings", "/inbox", "/settings/calendar"]) await oreq.get(`${BASE}${p}`).catch(() => {});

  const page = await owner.ctx.newPage();
  /** Clic con reintentos hasta que aparezca `expect` (hidratación de next dev). */
  async function clickUntil(pg, target, expect, tries = 8) {
    for (let i = 0; i < tries; i++) {
      await target.click({ timeout: 5000 }).catch(() => {});
      if (await soft((ms) => expect.waitFor({ timeout: Math.min(ms, 2500) }))) return true;
      await sleep(500);
    }
    return false;
  }
  const dialog = (pg) => pg.getByTestId("booking-dialog");
  /**
   * 028 — Citas abre en Semana en computadora (Día en celular); este guion
   * revisa la Lista, así que la elige (queda recordada en localStorage).
   */
  async function asList(pg) {
    await clickUntil(pg, pg.getByTestId("cal-view-list"), pg.locator('[data-testid="cal-view-list"][aria-pressed="true"]'));
  }
  /** Llena el diálogo de Nueva cita hasta elegir el horario. */
  async function fillDialog(pg, { contactName, typeId, slot, seller }) {
    const d = dialog(pg);
    if (contactName) {
      await d.getByTestId("booking-contact-search").fill(contactName);
      const opt = d.getByTestId("booking-contact-option").filter({ hasText: contactName }).first();
      await opt.waitFor({ timeout: 15000 });
      await opt.click();
    }
    await d.getByTestId("booking-type").selectOption(typeId);
    if (seller) await d.getByTestId("booking-seller").selectOption(seller);
    if (!slot) return;
    const day = d.locator(`[data-testid="booking-day"][data-day="${slot.dayIso}"]`);
    await day.waitFor({ timeout: 20000 });
    await day.click();
    const btn = d.locator(`[data-testid="booking-slot"][data-start="${slot.startUtc}"]`);
    await btn.waitFor({ timeout: 10000 });
    await btn.click();
  }
  const rowsOf = (pg) => pg.locator("section").filter({ has: pg.getByRole("heading", { name: /^Citas/ }) }).locator("ul > li");
  const rowOf = (pg, text) => rowsOf(pg).filter({ hasText: text });
  const bookingsApi = async () => (await api("GET", "/api/bookings"))?.bookings ?? [];

  /* -------------------------------------------------------------------- a */
  console.log("\n== a) Owner, Ajustes → Agenda ==");
  await page.goto(`${BASE}/settings/calendar`, { waitUntil: "load" });
  const card = page.getByTestId("appointment-types-card");
  await soft((ms) => card.getByTestId("appointment-type-row").nth(3).waitFor({ timeout: ms }), 30000);
  const rowNames = await card
    .getByTestId("appointment-type-row")
    .evaluateAll((rows) => rows.map((r) => r.querySelector('input[aria-label^="Nombre de"]')?.value ?? ""));
  ok(
    "la tarjeta Tipos de cita muestra la siembra",
    ["Prueba de manejo", "Servicio", "Garantía", "Otro"].every((x) => rowNames.includes(x)),
    JSON.stringify(rowNames)
  );
  ok(
    "no se ven \"Cómo se entrega la reunión\" ni \"Tu sala de siempre\"",
    (await page.getByText("Cómo se entrega la reunión").count()) === 0 &&
      (await page.getByText("Tu sala de siempre").count()) === 0
  );
  // Alta: "Entrega", 45 min.
  await card.getByTestId("appointment-type-new-name").fill("Entrega");
  await card.getByTestId("appointment-type-new-duration").fill("45");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/calendar/types") && r.request().method() === "POST", { timeout: 15000 }).catch(() => null);
  await card.getByTestId("appointment-type-add").click();
  const createdRes = await created;
  ok("alta de \"Entrega\" → 201", createdRes?.status() === 201, String(createdRes?.status()));
  await soft((ms) => page.getByLabel("Nombre de Entrega").waitFor({ timeout: ms }), 10000);
  ok("\"Entrega\" aparece en la tabla", (await page.getByLabel("Nombre de Entrega").count()) === 1);
  // Edición: Garantía a 40 min (se guarda al salir del campo).
  const dur = page.getByLabel("Duración de Garantía en minutos");
  await dur.fill("40");
  const patched = page.waitForResponse((r) => r.url().includes("/api/calendar/types/") && r.request().method() === "PATCH", { timeout: 15000 }).catch(() => null);
  await dur.press("Tab");
  const patchedRes = await patched;
  ok("Garantía a 40 min → PATCH 200", patchedRes?.status() === 200, String(patchedRes?.status()));
  // Dirección.
  const ADDRESS = `Blvd. Bernardo Quintana 100, Querétaro ${S}`;
  await page.getByTestId("agenda-address").fill(ADDRESS);
  await page.getByRole("button", { name: "Guardar", exact: true }).first().click();
  ok("guardar la agenda → \"Guardado\"", await soft((ms) => page.getByText("Guardado", { exact: true }).waitFor({ timeout: ms })));
  await shot(page, "a-ajustes-tipos");
  await page.reload({ waitUntil: "load" });
  await soft((ms) => page.getByLabel("Nombre de Entrega").waitFor({ timeout: ms }), 30000);
  ok("tras recargar: \"Entrega\" sigue (45 min)", (await page.getByLabel("Duración de Entrega en minutos").inputValue().catch(() => "")) === "45");
  ok("tras recargar: Garantía 40 min", (await page.getByLabel("Duración de Garantía en minutos").inputValue().catch(() => "")) === "40");
  ok("tras recargar: la dirección persiste", (await page.getByTestId("agenda-address").inputValue().catch(() => "")) === ADDRESS);
  const settingsApi = (await api("GET", "/api/calendar/settings"))?.settings;
  ok("…y la API la tiene", settingsApi?.address === ADDRESS, JSON.stringify(settingsApi?.address));

  /* -------------------------------------------------------------------- b */
  console.log("\n== b) Owner, Citas → Nueva cita ==");
  const gServ = await grid(SERVICIO.id);
  const slotB = pickFree(gServ, t0 + 26 * H);
  ok("hay un horario libre de Servicio", !!slotB);
  await page.goto(`${BASE}/bookings`, { waitUntil: "load" });
  await asList(page);
  ok("Nueva cita abre el diálogo", await clickUntil(page, page.getByTestId("bookings-new"), dialog(page)));
  await fillDialog(page, { contactName: names.b, typeId: SERVICIO.id, slot: slotB });
  await page.getByTestId("booking-save").click();
  ok("aviso \"Cita agendada para …\"", await soft((ms) => page.getByTestId("bookings-notice").filter({ hasText: "Cita agendada para" }).waitFor({ timeout: ms })));
  ok("el diálogo se cierra", await soft((ms) => dialog(page).waitFor({ state: "hidden", timeout: ms })));
  const rowB = rowOf(page, names.b);
  await soft((ms) => rowB.first().waitFor({ timeout: ms }));
  ok("la fila muestra el tipo Servicio", (await rowB.first().textContent())?.includes("Servicio"));
  ok("…y el vendedor (el owner)", (await rowB.first().getByTestId("booking-seller-name").textContent())?.trim() === "Operador E2E");
  const bB = (await bookingsApi()).find((b) => b.contact?.name === names.b);
  ok("la API confirma la cita en ese horario", bB?.scheduledAtUtc === slotB?.startUtc && bB?.type?.id === SERVICIO.id, JSON.stringify(bB && { at: bB.scheduledAtUtc, type: bB.type }));

  /* -------------------------------------------------------------------- c */
  console.log("\n== c) Vendedor en la Bandeja: Agendar sobre un horario ocupado ==");
  const juan = await actor(V1_EMAIL, SPASS);
  ok("login Juan (Vendedor)", juan.ok);
  const jp = await juan.ctx.newPage();
  await jp.goto(`${BASE}/inbox`, { waitUntil: "load" });
  const convRow = jp.locator("li[data-conversation-id]", { hasText: names.c }).first();
  ok("Juan ve la conversación de Carla", await soft((ms) => convRow.waitFor({ timeout: ms }), 30000));
  await convRow.locator("button").first().click();
  ok("Agendar abre el diálogo", await clickUntil(jp, jp.getByTestId("inbox-schedule"), dialog(jp)));
  ok("el contacto viene prellenado", (await dialog(jp).getByTestId("booking-contact").textContent())?.includes(names.c));
  ok("el Vendedor no elige vendedor", (await dialog(jp).getByTestId("booking-seller").count()) === 0);
  await fillDialog(jp, { typeId: SERVICIO.id });
  const dayC = dialog(jp).locator(`[data-testid="booking-day"][data-day="${slotB.dayIso}"]`);
  await soft((ms) => dayC.waitFor({ timeout: ms }));
  await dayC.click();
  const busySlot = dialog(jp).locator(`[data-testid="booking-slot"][data-start="${slotB.startUtc}"]`);
  await soft((ms) => busySlot.waitFor({ timeout: ms }));
  ok("el MISMO horario aparece con data-busy=\"true\"", (await busySlot.getAttribute("data-busy")) === "true");
  ok("…con el detalle (tipo y vendedor) en su etiqueta", /Servicio/.test((await busySlot.getAttribute("aria-label")) ?? "") && /Operador E2E/.test((await busySlot.getAttribute("aria-label")) ?? ""), await busySlot.getAttribute("aria-label"));
  await busySlot.click();
  const det = dialog(jp).getByTestId("booking-slot-conflicts");
  ok("al elegirlo se ve el aviso \"A esa hora ya hay otra cita\"", await soft((ms) => det.waitFor({ timeout: ms })) && /Servicio/.test((await det.textContent()) ?? ""));
  await shot(jp, "c-rejilla-ocupado");
  await dialog(jp).getByTestId("booking-save").click();
  const ov = jp.getByTestId("booking-overlap-dialog");
  ok("guardar → diálogo de choque", await soft((ms) => ov.waitFor({ timeout: ms })));
  ok("…con \"A esa hora ya hay 1 cita\"", /A esa hora ya hay 1 cita/.test((await ov.textContent()) ?? ""), await ov.textContent());
  await shot(jp, "c-dialogo-choque");
  await ov.getByTestId("booking-overlap-confirm").click();
  ok("confirmar → el diálogo se cierra", await soft((ms) => dialog(jp).waitFor({ state: "hidden", timeout: ms })));
  const bC = (await bookingsApi()).find((b) => b.contact?.name === names.c && b.scheduledAtUtc === slotB.startUtc);
  ok("se creó la cita de Juan a la misma hora", bC?.assignedUser?.id === V1 && bC?.status === "agendada", JSON.stringify(bC?.assignedUser));

  /* -------------------------------------------------------------------- d */
  console.log("\n== d) Vendedor: Prueba de manejo ya ocupada no aparece ==");
  const gPrueba = await grid(PRUEBA.id);
  const slotD = pickFree(gPrueba, t0 + 40 * H);
  const pdRes = await oreq.post(`${BASE}/api/bookings`, {
    headers: { origin: BASE },
    data: { kind: "session", contactId: conv(names.d)?.contact?.id, startUtc: slotD?.startUtc, typeId: PRUEBA.id, assignedUserId: V2 },
  });
  ok("(API) owner agenda una Prueba de manejo para Ana", pdRes.status() === 201, String(pdRes.status()));
  const jb = await juan.ctx.newPage();
  await jb.goto(`${BASE}/bookings`, { waitUntil: "load" });
  ok("Juan abre Nueva cita", await clickUntil(jb, jb.getByTestId("bookings-new"), dialog(jb)));
  await fillDialog(jb, { contactName: names.m, typeId: PRUEBA.id });
  const dayD = dialog(jb).locator(`[data-testid="booking-day"][data-day="${slotD.dayIso}"]`);
  await soft((ms) => dayD.waitFor({ timeout: ms }));
  await dayD.click();
  await soft((ms) => dialog(jb).getByTestId("booking-slot").first().waitFor({ timeout: ms }));
  const sD = Date.parse(slotD.startUtc);
  const countAt = async (ms) => dialog(jb).locator(`[data-testid="booking-slot"][data-start="${iso(ms)}"]`).count();
  ok("la rejilla de ese día tiene horarios", (await dialog(jb).getByTestId("booking-slot").count()) > 0);
  ok("el horario de la Prueba de manejo NO aparece", (await countAt(sD)) === 0);
  ok("…ni sus traslapes parciales (−30 / +30)", (await countAt(sD - 30 * MIN)) === 0 && (await countAt(sD + 30 * MIN)) === 0);
  await jb.keyboard.press("Escape");
  await jb.close();

  /* -------------------------------------------------------------------- e */
  console.log("\n== e) Owner: filtros y reasignación ==");
  await page.goto(`${BASE}/bookings`, { waitUntil: "load" });
  await asList(page);
  await soft((ms) => rowsOf(page).first().waitFor({ timeout: ms }), 30000);
  const total = await rowsOf(page).count();
  await page.getByTestId("bookings-seller-filter").selectOption(V1);
  await soft((ms) => page.waitForResponse((r) => r.url().includes(`sellerId=${V1}`), { timeout: ms }));
  await sleep(500);
  const sellersShown = await rowsOf(page).getByTestId("booking-seller-name").allTextContents();
  ok("filtro por vendedor (Juan): solo sus citas", sellersShown.length > 0 && sellersShown.every((t) => t.trim() === V1_NAME), JSON.stringify(sellersShown));
  await page.getByTestId("bookings-seller-filter").selectOption("all");
  await page.getByTestId("bookings-type-filter").selectOption(PRUEBA.id);
  await soft((ms) => page.waitForResponse((r) => r.url().includes(`typeId=${PRUEBA.id}`), { timeout: ms }));
  await sleep(500);
  const typeRows = await rowsOf(page).allTextContents();
  ok("filtro por tipo (Prueba de manejo)", typeRows.length > 0 && typeRows.length < total && typeRows.every((t) => t.includes("Prueba de manejo")), `n=${typeRows.length}/${total}`);
  await shot(page, "e-citas-filtros");
  await page.getByTestId("bookings-type-filter").selectOption("all");
  await sleep(800);
  // Reasignar la cita de Beto (owner, slotB) a Juan, que ya tiene otra a esa hora.
  const rowBeto = rowOf(page, names.b).first();
  await rowBeto.getByTestId("booking-reassign").click();
  await rowBeto.getByTestId("booking-reassign-select").selectOption(V1);
  await rowBeto.getByTestId("booking-reassign-save").click();
  ok(
    "reasignar a un vendedor ocupado → \"Ese vendedor ya tiene una cita a esa hora\"",
    await soft((ms) => page.getByRole("alert").filter({ hasText: "Ese vendedor ya tiene una cita a esa hora" }).waitFor({ timeout: ms }))
  );
  await rowBeto.getByTestId("booking-reassign-select").selectOption(V2);
  await rowBeto.getByTestId("booking-reassign-save").click();
  ok("reasignar a una vendedora libre → \"Cita reasignada.\"", await soft((ms) => page.getByTestId("bookings-notice").filter({ hasText: "Cita reasignada." }).waitFor({ timeout: ms })));
  await sleep(500);
  ok("la fila muestra a Ana", (await rowOf(page, names.b).first().getByTestId("booking-seller-name").textContent())?.trim() === V2_NAME);

  /* -------------------------------------------------------------------- f */
  console.log("\n== f) Vendedora: visibilidad ==");
  const ana = await actor(V2_EMAIL, SPASS);
  ok("login Ana (Vendedora)", ana.ok);
  const ap = await ana.ctx.newPage();
  await ap.goto(`${BASE}/bookings`, { waitUntil: "load" });
  await asList(ap);
  await soft((ms) => rowsOf(ap).first().waitFor({ timeout: ms }), 30000);
  const anaRows = await rowsOf(ap).allTextContents();
  ok("Ana NO ve la cita de Juan (Carla)", anaRows.length > 0 && !anaRows.some((t) => t.includes(names.c)), JSON.stringify(anaRows.length));
  ok("Ana ve las suyas (Beto reasignada, Prueba de manejo de Diego)", anaRows.some((t) => t.includes(names.b)) && anaRows.some((t) => t.includes(names.d)));
  ok("Ana no tiene el botón Reasignar", (await ap.getByTestId("booking-reassign").count()) === 0);
  await ap.getByTestId("bookings-seller-filter").selectOption("mine");
  await sleep(500);
  const mine = await rowsOf(ap).getByTestId("booking-seller-name").allTextContents();
  ok("\"Mías\": solo citas de Ana", mine.length >= 2 && mine.every((t) => t.trim() === V2_NAME), JSON.stringify(mine));

  /* -------------------------------------------------------------------- g */
  console.log("\n== g) Reprogramar desde Citas ==");
  const bBeto = (await bookingsApi()).find((b) => b.contact?.name === names.b);
  const resched = (await api("GET", `/api/calendar/availability?excludeBookingId=${bBeto?.id}`))?.slots ?? [];
  const slotG = pickFree(resched, t0 + 30 * H, [bBeto?.scheduledAtUtc]);
  const rowG = rowOf(page, names.b).first();
  ok("Reprogramar abre el diálogo", await clickUntil(page, rowG.getByRole("button", { name: "Reprogramar" }), dialog(page)));
  ok("el diálogo es \"Reprogramar cita\" (sin tipo ni contacto que elegir)", (await dialog(page).getByTestId("booking-type").count()) === 0 && /Reprogramar cita/.test((await dialog(page).textContent()) ?? ""));
  const dayG = dialog(page).locator(`[data-testid="booking-day"][data-day="${slotG.dayIso}"]`);
  await soft((ms) => dayG.waitFor({ timeout: ms }));
  await dayG.click();
  await dialog(page).locator(`[data-testid="booking-slot"][data-start="${slotG.startUtc}"]`).click();
  await dialog(page).getByTestId("booking-save").click();
  ok("aviso \"Cita reprogramada para …\"", await soft((ms) => page.getByTestId("bookings-notice").filter({ hasText: "Cita reprogramada para" }).waitFor({ timeout: ms })));
  const moved = (await bookingsApi()).find((b) => b.id === bBeto?.id);
  ok("la API tiene la hora nueva", moved?.scheduledAtUtc === slotG?.startUtc, `${moved?.scheduledAtUtc} vs ${slotG?.startUtc}`);
  await sleep(500);
  ok("la fila muestra la hora nueva", (await rowOf(page, names.b).first().textContent())?.includes(`${moved?.date} · ${moved?.time}`), `${moved?.date} · ${moved?.time}`);

  /* -------------------------------------------------------------------- h */
  console.log("\n== h) Camino infeliz: falla de red al guardar ==");
  const slotH = pickFree(await grid(SERVICIO.id, "none"), t0 + 48 * H);
  ok("Nueva cita abre el diálogo", await clickUntil(page, page.getByTestId("bookings-new"), dialog(page)));
  await fillDialog(page, { contactName: names.h, typeId: SERVICIO.id, slot: slotH, seller: "none" });
  const abortPost = (route) => (route.request().method() === "POST" ? route.abort("internetdisconnected") : route.continue());
  await page.route("**/api/bookings", abortPost);
  await dialog(page).getByTestId("booking-save").click();
  const err = dialog(page).getByTestId("booking-error");
  ok("se ve el error de red en el diálogo", await soft((ms) => err.waitFor({ timeout: ms })), await err.textContent().catch(() => ""));
  ok("…el diálogo sigue abierto y Guardar habilitado (no se cuelga)", (await dialog(page).isVisible()) && (await dialog(page).getByTestId("booking-save").isEnabled()));
  await page.unroute("**/api/bookings", abortPost);
  await dialog(page).getByTestId("booking-save").click();
  ok("reintento → se crea", await soft((ms) => dialog(page).waitFor({ state: "hidden", timeout: ms })));
  const bH = (await bookingsApi()).find((b) => b.contact?.name === names.h);
  ok("…sin vendedor, como se eligió", bH?.scheduledAtUtc === slotH?.startUtc && bH?.assignedUser === null, JSON.stringify(bH?.assignedUser));

  /* -------------------------------------------------------------------- i */
  console.log("\n== i) Móvil 390×844 ==");
  const state = await owner.ctx.storageState();
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: state, isMobile: true, hasTouch: true });
  const mp = await mctx.newPage();
  await mp.goto(`${BASE}/bookings`, { waitUntil: "load" });
  ok("Nueva cita abre el diálogo en móvil", await clickUntil(mp, mp.getByTestId("bookings-new"), dialog(mp)));
  await fillDialog(mp, { contactName: names.m, typeId: SERVICIO.id });
  const first = dialog(mp).locator('[data-testid="booking-slot"]:not([data-busy])').first();
  ok("hay horarios en la rejilla", await soft((ms) => first.waitFor({ timeout: ms })));
  await first.scrollIntoViewIfNeeded().catch(() => {});
  await first.click();
  ok("se puede elegir un horario", (await first.getAttribute("aria-pressed")) === "true");
  ok("Guardar queda habilitado", await dialog(mp).getByTestId("booking-save").isEnabled());
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok("sin scroll horizontal en la página", overflow <= 1, `overflow=${overflow}px`);
  await shot(mp, "i-movil-nueva-cita");
  await mctx.close();
} catch (err) {
  failures++;
  console.error("ERROR FATAL:", err);
} finally {
  await browser.close().catch(() => {});
  if (shots.length) {
    console.log("\nCapturas:");
    for (const s of shots) console.log(`  - ${s}`);
  }
  console.log(`\n===== ${checks - failures} OK / ${failures} FAIL =====`);
  process.exit(failures > 0 ? 1 : 0);
}
