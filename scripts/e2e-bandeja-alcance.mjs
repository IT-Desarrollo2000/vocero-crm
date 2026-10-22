/**
 * Self-test E2E de UI — 027: la Bandeja por alcance (Buzón · Mis chats ·
 * Equipo). Guion: tests/e2e/us-bandeja-alcance.md. El contrato por API
 * (partición, counts.scopes, 422) lo cubre `bandejaAlcanceChecks` de
 * scripts/e2e-selftest.mjs.
 *
 * Recorre como usuario (Playwright):
 *   a) Vendedor recién dado de alta (sin chats propios): abre en "Mis chats",
 *      pestañas "Mis chats · Buzón" (sin "Equipo"), vacío "Aún no tienes
 *      chats." con "Ir al Buzón (N)" y, en el panel derecho, "Hay N chats
 *      esperando en el Buzón" + "Ver el Buzón" (US-6); ambos llevan al Buzón.
 *      Con el Buzón vacío (el dueño se lo asigna un momento y lo devuelve):
 *      "El Buzón también está vacío por ahora." sin botón ni recordatorio
 *   b) en vivo: el dueño le asigna un chat → el total de "Mis chats" sube y
 *      lleva punto de acento (no leídas, pestaña no activa) (US-2)
 *   c) contestar desde el Buzón: la fila sale del Buzón, el hilo sigue
 *      abierto con "Este chat ahora está en Mis chats · Ir"; "Ir" cambia de
 *      pestaña con el chat seleccionado (CA-4)
 *   d) "Devolver al buzón" → "ahora está en Buzón" → Ir (CA-5)
 *   e) búsqueda con texto: "Buscando en todos tus chats" y encuentra chats de
 *      ambos alcances (CA-6)
 *   f) enlaces viejos `filter=mine`, `filter=unassigned`, `unassigned=1`
 *      (CA-7) y el último alcance recordado al volver sin `scope=` (US-5)
 *   g) Propietario: abre en "Buzón", pestañas "Buzón · Equipo · Mis chats";
 *      Equipo trae el chat del vendedor; `?contact=` cambia al alcance del
 *      chat (CA-2 en UI)
 *   h) móvil 390 px: el selector cabe (ningún `button[aria-pressed]` fuera
 *      de la pantalla) y sin scroll horizontal
 *
 * CA-8 (sin modo equipo no hay selector) necesita una organización de UN
 * solo usuario: lo fija el unit de `effectiveFilters` y el resto de guiones
 * de un solo usuario (la Bandeja sin selector ni `scope=`).
 *
 * Uso (BD AISLADA, app viva con mocks; reinicia el server antes: el
 * limitador de login es por IP y en memoria):
 *   node --env-file=.env.e2e scripts/e2e-bandeja-alcance.mjs
 * Navegador: chromium de Playwright; si falta, Edge (`PW_CHANNEL=msedge`).
 * Presupuesto del limitador: 2 POST de login (dueño, vendedor).
 * Sale con código 1 si algún check falla.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const SHOTS = process.env.E2E_SHOTS_DIR ?? path.join(os.tmpdir(), "e2e-shots-027");
const S = Math.random().toString(36).slice(2, 6).toUpperCase();
const PN = "PN-E2E-027-UI";

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
/** Reintenta `fn` hasta que devuelva algo truthy o venza el plazo. */
const until = async (fn, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  return null;
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

/* --------------------------- localizadores UI --------------------------- */
const tab = (page, scope) => page.locator(`button[data-scope="${scope}"]`);
const pressed = async (page, scope) => (await tab(page, scope).getAttribute("aria-pressed")) === "true";
const rowByText = (page, t) => page.locator("li[data-conversation-id]", { hasText: t });
const row = (page, id) => page.locator(`li[data-conversation-id="${id}"]`);
/** La fila seleccionada lleva la barra de acento (`span.bg-brand`). */
const isSelected = async (page, id) => (await row(page, id).locator("span.bg-brand").count()) > 0;
const scopeNote = (page) => page.getByRole("note", { name: "El chat cambió de lugar" });
/** Total que pinta una pestaña (su `aria-label` es "Etiqueta: N[, con no leídas]"). */
const tabTotal = async (page, scope) => {
  const label = (await tab(page, scope).getAttribute("aria-label").catch(() => "")) ?? "";
  const m = /:\s*(\d+)/.exec(label);
  return m ? Number(m[1]) : -1;
};
const scopeOfUrl = (page) => new URL(page.url()).searchParams.get("scope");

try {
  /* ---------------------------------------------------------------- setup */
  console.log("== Setup (API) ==");
  const OWNER_EMAIL = "e2e@vocero.test";
  const OWNER_PASS = "password-e2e-123";
  const owner = await actor(OWNER_EMAIL, OWNER_PASS, { signUp: true });
  ok("login owner", owner.ok);
  const api = async (method, p, data) =>
    J(await owner.req.fetch(`${BASE}${p}`, { method, headers: { origin: BASE }, ...(data ? { data } : {}) }));
  await api("PUT", "/api/settings/whatsapp", { wabaId: "WABA-027-UI", phoneNumberId: PN, token: "tok-027-ui" });

  const SELLER_EMAIL = `vend.alcance.${S.toLowerCase()}@vocero.test`;
  const SELLER_PASS = "password-vend-027";
  const SELLER_NAME = `Vendedor Alcance ${S}`;
  const alta = await owner.req.post(`${BASE}/api/settings/team`, {
    headers: { origin: BASE },
    data: { name: SELLER_NAME, email: SELLER_EMAIL, password: SELLER_PASS },
  });
  ok("alta del Vendedor", alta.status() === 201, String(alta.status()));

  let n = 0;
  const SUF = String(Math.floor(Math.random() * 9e4) + 1e4);
  const phone = () => `521554${SUF}${String(n++).padStart(2, "0")}`;
  const inbound = (from, name, text = "hola, informes") =>
    owner.req.post(`${BASE}/api/dev/wa-mock/inbound`, {
      headers: { origin: BASE },
      data: { phoneNumberId: PN, from, name, text, waMessageId: `wamid.027ui.${S}.${n}.${Date.now()}` },
    });
  const names = {
    b1: `Buzón Uno ${S}`,
    b2: `Buzón Dos ${S}`,
    mine: `Propia ${S}`,
    own: `Del Dueño ${S}`,
  };
  for (const nm of Object.values(names)) await inbound(phone(), nm);
  await sleep(2000);
  const convs = (await api("GET", `/api/conversations?q=${encodeURIComponent(S)}`))?.conversations ?? [];
  const conv = (name) => convs.find((c) => c.contact?.name === name);
  ok("las 4 conversaciones de prueba existen sin asignar",
     Object.values(names).every((nm) => conv(nm) && conv(nm).assignedTo === null));
  const ownerId = (await api("GET", "/api/auth/get-session"))?.user?.id;
  const team = (await api("GET", "/api/settings/team"))?.members ?? [];
  const sellerId = team.find((m) => m.email === SELLER_EMAIL || m.name === SELLER_NAME)?.userId;
  ok("ids de dueño y vendedor", !!ownerId && !!sellerId, JSON.stringify({ ownerId, sellerId }));
  // El de "Del Dueño" se asigna ya (no cambia nada para el vendedor: no lo ve).
  await api("POST", `/api/conversations/${conv(names.own)?.id}/assign`, { userId: ownerId });

  // `next dev` compila cada ruta en su primera petición: se precalientan.
  for (const p of ["/inbox", "/api/conversations/counts", "/api/conversations?limit=1"]) {
    await owner.req.get(`${BASE}${p}`).catch(() => {});
  }

  /* -------------------------------------------------------------------- a */
  console.log("\n== a) Vendedor sin chats propios: Mis chats vacío recuerda el Buzón (US-6) ==");
  const seller = await actor(SELLER_EMAIL, SELLER_PASS);
  ok("login Vendedor", seller.ok);
  const sapi = async (p) => J(await seller.req.get(`${BASE}${p}`));
  const sp = await seller.ctx.newPage();
  await sp.goto(`${BASE}/inbox`, { waitUntil: "load" });
  await soft((ms) => tab(sp, "mine").waitFor({ timeout: ms }), 30000);
  ok("el selector de alcance se pinta", (await tab(sp, "mine").count()) === 1 && (await tab(sp, "inbox").count()) === 1);
  ok("default del Vendedor: Mis chats", await pressed(sp, "mine"));
  ok("el Vendedor NO tiene pestaña Equipo", (await tab(sp, "team").count()) === 0);
  const orden = await sp.locator("button[data-scope]").evaluateAll((bs) => bs.map((b) => b.dataset.scope));
  ok("orden del Vendedor: Mis chats · Buzón", JSON.stringify(orden) === JSON.stringify(["mine", "inbox"]), JSON.stringify(orden));
  ok("scope=mine en la URL (modo equipo)", await until(async () => scopeOfUrl(sp) === "mine"), sp.url());
  ok("ya no hay vista «Mías» en el renglón de estado", (await sp.getByRole("button", { name: /^Mías/ }).count()) === 0);
  const sc0 = (await sapi("/api/conversations/counts"))?.scopes;
  const N = sc0?.inbox?.all ?? 0;
  ok("(setup) el Buzón del vendedor tiene chats", N >= 3, JSON.stringify(sc0));
  const goInbox = sp.getByRole("button", { name: `Ir al Buzón (${N})` });
  ok("vacío de Mis chats: «Aún no tienes chats.» + «Ir al Buzón (N)»",
     await soft((ms) => goInbox.waitFor({ timeout: ms })) && (await sp.getByText("Aún no tienes chats.").count()) > 0);
  const reminder = sp.getByTestId("inbox-reminder");
  ok("panel derecho: «Hay N chats esperando en el Buzón»",
     await soft((ms) => reminder.waitFor({ timeout: ms })) &&
       ((await reminder.textContent()) ?? "").includes(`Hay ${N} chats esperando en el Buzón`),
     (await reminder.textContent().catch(() => "")) ?? "");
  await shot(sp, "a-vendedor-mis-chats-vacio");
  await sp.getByRole("button", { name: "Ver el Buzón" }).click();
  ok("«Ver el Buzón» cambia al Buzón", await until(async () => await pressed(sp, "inbox")));
  ok("…y lo pinta (trae Buzón Uno)", await soft((ms) => rowByText(sp, names.b1).first().waitFor({ timeout: ms })));
  ok("en el Buzón no hay recordatorio", (await sp.getByTestId("inbox-reminder").count()) === 0);
  ok("en el Buzón la fila no repite «Sin asignar» (el alcance ya lo dice)",
     (await rowByText(sp, names.b1).first().getByText("Sin asignar", { exact: true }).count()) === 0);
  await tab(sp, "mine").click();
  await soft((ms) => goInbox.waitFor({ timeout: ms }));
  await goInbox.click();
  ok("«Ir al Buzón (N)» también lleva al Buzón", await until(async () => await pressed(sp, "inbox")));

  // CA-10 con N = 0: el dueño se queda un momento con todo el Buzón y luego
  // lo devuelve (la BD de E2E es compartida entre guiones).
  console.log("\n== a2) Buzón vacío: sin botón ni recordatorio (CA-10, N = 0) ==");
  const taken = ((await api("GET", "/api/conversations?assigned=unassigned"))?.conversations ?? []).map((c) => c.id);
  try {
    for (const id of taken) await api("POST", `/api/conversations/${id}/assign`, { userId: ownerId });
    ok("(setup) el Buzón queda vacío", (await sapi("/api/conversations/counts"))?.scopes?.inbox?.all === 0);
    await sp.goto(`${BASE}/inbox?scope=mine`, { waitUntil: "load" });
    ok("Mis chats vacío: «El Buzón también está vacío por ahora.»",
       await soft((ms) => sp.getByText("El Buzón también está vacío por ahora.").waitFor({ timeout: ms }), 30000));
    ok("…sin botón «Ir al Buzón»", (await sp.getByRole("button", { name: /^Ir al Buzón/ }).count()) === 0);
    ok("…y sin recordatorio en el panel derecho", (await sp.getByTestId("inbox-reminder").count()) === 0);
  } finally {
    // Pase lo que pase, el Buzón compartido vuelve como estaba.
    for (const id of taken) await api("POST", `/api/conversations/${id}/assign`, { userId: null });
  }
  ok("(limpieza) el Buzón vuelve a tener sus N chats", (await sapi("/api/conversations/counts"))?.scopes?.inbox?.all === N);
  await sp.goto(`${BASE}/inbox?scope=inbox`, { waitUntil: "load" });
  await soft((ms) => rowByText(sp, names.b1).first().waitFor({ timeout: ms }), 30000);

  /* -------------------------------------------------------------------- b */
  console.log("\n== b) En vivo: le asignan un chat → Mis chats sube con punto (US-2) ==");
  const mineBefore = await tabTotal(sp, "mine");
  await api("POST", `/api/conversations/${conv(names.mine)?.id}/assign`, { userId: sellerId });
  ok("el total de Mis chats sube sin recargar",
     !!(await until(async () => (await tabTotal(sp, "mine")) === mineBefore + 1, 20000)),
     `${mineBefore} → ${await tabTotal(sp, "mine")}`);
  ok("Mis chats (no activa, con no leídas) lleva el punto de acento",
     !!(await until(async () => (await tab(sp, "mine").getByTestId("scope-unread-dot").count()) === 1, 15000)));
  ok("el Buzón (activo) no lleva punto", (await tab(sp, "inbox").getByTestId("scope-unread-dot").count()) === 0);
  ok("la asignada sale del Buzón", !!(await until(async () => (await rowByText(sp, names.mine).count()) === 0, 15000)));

  /* -------------------------------------------------------------------- c */
  console.log("\n== c) Contestar desde el Buzón: el chat se muda, el hilo sigue (CA-4) ==");
  const b1 = conv(names.b1);
  const inboxBefore = await tabTotal(sp, "inbox");
  const mineBefore2 = await tabTotal(sp, "mine");
  await rowByText(sp, names.b1).first().locator("button").first().click();
  const box = sp.getByPlaceholder("Escribe una respuesta");
  await soft((ms) => box.waitFor({ timeout: ms }));
  await box.fill(`te atiendo yo ${S}`);
  await box.press("Enter");
  ok("la fila sale del Buzón", !!(await until(async () => (await row(sp, b1.id).count()) === 0, 20000)));
  ok("el hilo sigue abierto (el compositor sigue ahí)", await box.isVisible().catch(() => false));
  const note = scopeNote(sp);
  ok("aviso «Este chat ahora está en Mis chats»",
     await soft((ms) => note.waitFor({ timeout: ms })) && ((await note.textContent()) ?? "").includes("Este chat ahora está en Mis chats"),
     (await note.textContent().catch(() => "")) ?? "");
  ok("contadores ±1 (Buzón −1, Mis chats +1)",
     !!(await until(async () => (await tabTotal(sp, "inbox")) === inboxBefore - 1 && (await tabTotal(sp, "mine")) === mineBefore2 + 1, 15000)),
     `inbox ${inboxBefore}→${await tabTotal(sp, "inbox")} mine ${mineBefore2}→${await tabTotal(sp, "mine")}`);
  await shot(sp, "c-aviso-mis-chats");
  await note.getByRole("button", { name: "Ir" }).click();
  ok("«Ir» cambia a Mis chats", await until(async () => await pressed(sp, "mine")));
  ok("…con el chat en la lista y seleccionado",
     !!(await until(async () => (await row(sp, b1.id).count()) === 1 && (await isSelected(sp, b1.id)), 15000)));
  ok("…y el aviso desaparece", !!(await until(async () => (await scopeNote(sp).count()) === 0, 5000)));

  /* -------------------------------------------------------------------- d */
  console.log("\n== d) Devolver al buzón (CA-5) ==");
  const devolver = sp.getByRole("button", { name: "Devolver al buzón" });
  ok("el Vendedor ve «Devolver al buzón» en su chat", await soft((ms) => devolver.first().waitFor({ timeout: ms })));
  ok("ya no existe «Liberar conversación»", (await sp.getByRole("button", { name: "Liberar conversación" }).count()) === 0);
  await devolver.first().click();
  ok("aviso «Este chat ahora está en Buzón»",
     !!(await until(async () => ((await scopeNote(sp).textContent().catch(() => "")) ?? "").includes("Este chat ahora está en Buzón"), 15000)));
  await scopeNote(sp).getByRole("button", { name: "Ir" }).click();
  ok("«Ir» lleva al Buzón con el chat seleccionado",
     !!(await until(async () => (await pressed(sp, "inbox")) && (await isSelected(sp, b1.id)), 15000)));

  /* -------------------------------------------------------------------- e */
  console.log("\n== e) Búsqueda en todos los alcances (CA-6) ==");
  const search = sp.getByLabel("Buscar conversación");
  await search.fill(S);
  ok("aviso «Buscando en todos tus chats»", await soft((ms) => sp.getByText("Buscando en todos tus chats").waitFor({ timeout: ms })));
  ok("encuentra el de Mis chats y los del Buzón a la vez",
     !!(await until(async () => (await rowByText(sp, names.mine).count()) > 0 && (await rowByText(sp, names.b2).count()) > 0, 15000)));
  ok("con búsqueda, la fila dice de quién es", (await rowByText(sp, names.mine).first().getByText("Tuya").count()) > 0);
  ok("y nunca trae chats ajenos (Del Dueño)", (await rowByText(sp, names.own).count()) === 0);
  await sp.getByRole("button", { name: "Limpiar búsqueda" }).click();
  await sleep(800);

  /* -------------------------------------------------------------------- f */
  console.log("\n== f) Enlaces viejos y alcance recordado (CA-7, US-5) ==");
  await sp.goto(`${BASE}/inbox?filter=mine`, { waitUntil: "load" });
  ok("/inbox?filter=mine → Mis chats", !!(await until(async () => await pressed(sp, "mine"), 20000)));
  ok("…y la URL queda scope=mine sin filter=mine",
     !!(await until(async () => scopeOfUrl(sp) === "mine" && !new URL(sp.url()).searchParams.has("filter"))), sp.url());
  await sp.goto(`${BASE}/inbox?filter=unassigned`, { waitUntil: "load" });
  ok("/inbox?filter=unassigned → Buzón", !!(await until(async () => await pressed(sp, "inbox"), 20000)));
  await sp.goto(`${BASE}/inbox?unassigned=1`, { waitUntil: "load" });
  ok("/inbox?unassigned=1 → Buzón", !!(await until(async () => await pressed(sp, "inbox"), 20000)));
  ok("…sin dejar unassigned=1 en la URL",
     !!(await until(async () => !new URL(sp.url()).searchParams.has("unassigned"))), sp.url());
  // Último usado: Buzón. Sin `scope=` en la URL, la Bandeja vuelve a él.
  await sp.goto(`${BASE}/inbox`, { waitUntil: "load" });
  ok("sin scope= abre en el último alcance usado (Buzón)", !!(await until(async () => await pressed(sp, "inbox"), 20000)));
  await tab(sp, "mine").click();
  await until(async () => await pressed(sp, "mine"));
  await sp.goto(`${BASE}/inbox`, { waitUntil: "load" });
  ok("…y si el último fue Mis chats, Mis chats", !!(await until(async () => await pressed(sp, "mine"), 20000)));
  await sp.goto(`${BASE}/inbox?scope=team`, { waitUntil: "load" });
  ok("scope=team para el Vendedor → Mis chats (no ve chats ajenos)",
     !!(await until(async () => (await pressed(sp, "mine")) && (await rowByText(sp, names.own).count()) === 0, 20000)));

  /* -------------------------------------------------------------------- g */
  console.log("\n== g) Propietario: Buzón · Equipo · Mis chats ==");
  const op = await owner.ctx.newPage();
  await op.goto(`${BASE}/inbox`, { waitUntil: "load" });
  await soft((ms) => tab(op, "inbox").waitFor({ timeout: ms }), 30000);
  ok("default del Propietario: Buzón", await pressed(op, "inbox"));
  const ordenO = await op.locator("button[data-scope]").evaluateAll((bs) => bs.map((b) => b.dataset.scope));
  ok("orden del Propietario: Buzón · Equipo · Mis chats",
     JSON.stringify(ordenO) === JSON.stringify(["inbox", "team", "mine"]), JSON.stringify(ordenO));
  ok("el Buzón trae Buzón Dos y no la del vendedor",
     await soft((ms) => rowByText(op, names.b2).first().waitFor({ timeout: ms })) && (await rowByText(op, names.mine).count()) === 0);
  await tab(op, "team").click();
  ok("Equipo trae el chat del vendedor", await soft((ms) => rowByText(op, names.mine).first().waitFor({ timeout: ms })));
  ok("…con el nombre de quien lo atiende", (await rowByText(op, names.mine).first().getByText(SELLER_NAME).count()) > 0);
  ok("…y no los del dueño", (await rowByText(op, names.own).count()) === 0);
  await tab(op, "mine").click();
  ok("Mis chats del dueño trae el suyo", await soft((ms) => rowByText(op, names.own).first().waitFor({ timeout: ms })));
  const oc = (await api("GET", "/api/conversations/counts"))?.scopes;
  ok("los totales de las pestañas = counts.scopes",
     !!(await until(async () =>
       (await tabTotal(op, "inbox")) === oc?.inbox?.all &&
       (await tabTotal(op, "team")) === oc?.team?.all &&
       (await tabTotal(op, "mine")) === oc?.mine?.all, 15000)),
     JSON.stringify({ oc, ui: [await tabTotal(op, "inbox"), await tabTotal(op, "team"), await tabTotal(op, "mine")] }));
  // `?contact=` de un chat de Equipo estando en Buzón: cambia de alcance.
  await tab(op, "inbox").click();
  await until(async () => await pressed(op, "inbox"));
  await op.goto(`${BASE}/inbox?scope=inbox&contact=${encodeURIComponent(conv(names.mine).contact.id)}`, { waitUntil: "load" });
  ok("?contact= de un chat del vendedor → pestaña Equipo", !!(await until(async () => await pressed(op, "team"), 20000)));
  ok("…con la fila seleccionada y sin aviso",
     !!(await until(async () => (await isSelected(op, conv(names.mine).id)) && (await scopeNote(op).count()) === 0, 15000)));
  // El dueño pasa al Buzón un chat abierto en Equipo → aviso "ahora está en Buzón".
  const resp = op.getByRole("combobox", { name: "Responsable" });
  if (await resp.count()) {
    await resp.first().selectOption("");
    ok("el dueño lo deja sin asignar → «ahora está en Buzón»",
       !!(await until(async () => ((await scopeNote(op).textContent().catch(() => "")) ?? "").includes("Este chat ahora está en Buzón"), 15000)));
  } else {
    ok("selector Responsable visible para el dueño", false);
  }
  await shot(op, "g-propietario-equipo");

  /* -------------------------------------------------------------------- h */
  console.log("\n== h) Móvil 390 px ==");
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await seller.ctx.storageState() });
  const mp = await mctx.newPage();
  await mp.goto(`${BASE}/inbox?scope=inbox`, { waitUntil: "load" });
  await soft((ms) => tab(mp, "inbox").waitFor({ timeout: ms }), 30000);
  const overflow = await mp.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    pills: [...document.querySelectorAll("button[aria-pressed]")]
      .map((b) => b.getBoundingClientRect().right)
      .some((r) => r > window.innerWidth + 1),
  }));
  ok("390 px: sin scroll horizontal y el selector dentro de la pantalla",
     overflow.page <= 0 && !overflow.pills, JSON.stringify(overflow));
  const box390 = await mp.locator('[role="group"][aria-label="Alcance de la Bandeja"]').boundingBox();
  ok("el selector ocupa el ancho de la columna", !!box390 && box390.width >= 390 - 40, JSON.stringify(box390));
  await shot(mp, "h-movil-390");
  // En móvil el hilo ocupa la pantalla: el aviso también se ve ahí.
  await rowByText(mp, names.b2).first().locator("button").first().click();
  const tomar = mp.getByRole("button", { name: "Tomar conversación" });
  if (await soft((ms) => tomar.first().waitFor({ timeout: ms }))) {
    await tomar.first().click();
    ok("móvil: tras Tomar, aviso «ahora está en Mis chats»",
       !!(await until(async () => ((await scopeNote(mp).textContent().catch(() => "")) ?? "").includes("Este chat ahora está en Mis chats"), 15000)));
    const hOverflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok("móvil: el hilo con el aviso sin scroll horizontal", hOverflow <= 0, `overflow=${hOverflow}`);
  } else {
    ok("móvil: botón Tomar en el hilo", false);
  }
  await mctx.close();

  // Limpieza: lo de prueba vuelve al Buzón (como llegó).
  for (const nm of [names.mine, names.own, names.b2]) {
    await api("POST", `/api/conversations/${conv(nm)?.id}/assign`, { userId: null });
  }
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
