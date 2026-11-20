/**
 * Self-test E2E — 037: ojo para ver la contraseña + aviso si falla «Marcar
 * como atendida».
 * Contrato: specs/037-ver-contrasena/spec.md (secciones A y B).
 *
 * Contra la app VIVA (mocks) y la BD AISLADA:
 *   1) /login: el campo arranca oculto; «Mostrar contraseña» lo muestra sin
 *      quitarle el foco ni mover el cursor; otro clic lo oculta; sin `title`.
 *      Con la contraseña visible y credenciales malas, enviar → vuelve a
 *      ocultarse. Con las buenas, visible y enviar → entra.
 *   2) Ajustes › Cuenta: los 3 campos con su propio ojo, independientes.
 *   3) Bandeja: el PATCH de «Marcar como atendida» interceptado en 500 →
 *      aviso «No se pudo marcar como atendida. Vuelve a intentarlo.»; sin red
 *      → «Sin conexión con el servidor.»; sin intercepción → queda atendida y
 *      sin aviso de error.
 *
 * Usa al dueño del selftest (`e2e@vocero.test`): lo registra si no existe.
 * Presupuesto del limitador de login: 3 (API, login malo y login bueno en UI).
 *
 * Uso (BD aislada, app con .env.e2e):
 *   node --env-file=.env.e2e scripts/e2e-ver-contrasena.mjs
 * Con `REVISAR_DIR=<dir>` deja capturas. Sale con 1 si algún check falla.
 */
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const S = Math.random().toString(36).slice(2, 7);
const PN = "PN-E2E-037";
const WABA = "WABA-E2E-037";
const REVISAR = process.env.REVISAR_DIR ?? null;

const SHOW = "Mostrar contraseña";
const HIDE = "Ocultar contraseña";
const MSG_ATTENDED = "No se pudo marcar como atendida. Vuelve a intentarlo.";
const MSG_OFFLINE = "Sin conexión con el servidor.";

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
const short = (r) => `${r.res.status} ${JSON.stringify(r.json)?.slice(0, 260)}`;
const shot = async (target, file) => {
  if (REVISAR) await target.screenshot({ path: `${REVISAR}/${file}`, animations: "disabled", caret: "hide" }).catch(() => {});
};

const OWNER = { email: "e2e@vocero.test", password: "password-e2e-123", name: "Operador E2E" };
const NAME = `Rosa Atendida ${S}`;
const PHONE = `52157${String(Date.now()).slice(-5)}037`;
let seq = 0;

async function convOf(name) {
  const r = await api(`/api/conversations?${new URLSearchParams({ q: name })}`);
  return (r.json?.conversations ?? []).find((c) => c.contact?.name === name) ?? null;
}
async function inbound(text) {
  const r = await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({ phoneNumberId: PN, from: PHONE, name: NAME, text, waMessageId: `wamid.e2e.037.${S}.${seq++}` }),
  });
  if (!r.res.ok) ok("inbound de la clienta", false, short(r));
  return r;
}

let conv = null;

/* ───────────────────────── setup ───────────────────────── */

async function setup() {
  console.log("== Setup ==");
  let su = await api("/api/auth/sign-up/email", { method: "POST", body: body(OWNER) });
  if (!su.res.ok) su = await api("/api/auth/sign-in/email", { method: "POST", body: body({ email: OWNER.email, password: OWNER.password }) });
  ok("owner con sesión", su.res.ok, short(su));
  const conn = await api("/api/settings/whatsapp", { method: "PUT", body: body({ wabaId: WABA, phoneNumberId: PN, token: "tok-e2e-037" }) });
  ok("WhatsApp (wa-mock)", conn.res.ok, short(conn));
  await api("/api/agent/profile", { method: "PUT", body: body({ name: "Lumi", tone: "breve", instructions: "Tienda.", enabled: false }) });

  // Chat en manos de una persona (IA en pausa) y esperando respuesta.
  await inbound("Hola, quiero informes");
  await until(async () => !!(await convOf(NAME)));
  conv = await convOf(NAME);
  ok("conversación creada", !!conv?.id, NAME);
  if (!conv) return;
  const pausa = await api(`/api/conversations/${conv.id}`, { method: "PATCH", body: body({ aiEnabled: false }) });
  ok("IA en pausa para el chat", pausa.res.ok, short(pausa));
  await inbound("¿Siguen ahí?");
  const esperando = await until(async () => (await convOf(NAME))?.awaitingSince != null);
  conv = await convOf(NAME);
  ok("la clienta queda esperando respuesta", esperando, JSON.stringify({ awaitingSince: conv?.awaitingSince, aiEnabled: conv?.aiEnabled }));

  // Precalentar las rutas (dev compila al primer pedido).
  for (const p of ["/login", "/inbox", "/settings/account"]) await api(p).catch(() => {});
}

/* ───────────────────────── navegador ───────────────────────── */

let browser;
async function newPage({ withSession, viewport = { width: 1440, height: 950 } }) {
  const ctx = await browser.newContext({ viewport });
  // Sin SSE: el guion solo mira el resultado del PATCH y del refetch.
  await ctx.route("**/api/events*", (route) => route.abort());
  if (withSession) {
    const host = new URL(BASE);
    await ctx.addCookies(
      jar.cookie.split("; ").filter(Boolean).map((kv) => {
        const i = kv.indexOf("=");
        return { name: kv.slice(0, i), value: kv.slice(i + 1), domain: host.hostname, path: "/" };
      })
    );
  }
  const page = await ctx.newPage();
  return { ctx, page };
}

/** Espera a que React enganche los manejadores (el HTML del servidor llega antes). */
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

const typeOf = (loc) => loc.getAttribute("type");
const eyeOf = (page, id) => page.locator(`#${id} + button`);
const activeId = (page) => page.evaluate(() => document.activeElement?.id ?? null);

/* ───────────────────────── 1) Login ───────────────────────── */

async function login() {
  console.log("\n== 1) Login ==");
  const { ctx, page } = await newPage({ withSession: false });
  try {
    await page.goto(`${BASE}/login`, { waitUntil: "load" });
    const pw = page.locator("#password");
    await pw.waitFor({ timeout: 60000 });
    await waitHydrated(page, "#password + button");
    const eye = eyeOf(page, "password");

    ok("arranca oculta (type=password)", (await typeOf(pw)) === "password");
    ok("botón «Mostrar contraseña», aria-pressed=false", (await eye.getAttribute("aria-label")) === SHOW && (await eye.getAttribute("aria-pressed")) === "false");
    ok("el botón es type=button", (await eye.getAttribute("type")) === "button");
    ok("el botón no tiene title (sin tooltips)", (await eye.getAttribute("title")) === null);

    await page.locator("#email").fill(OWNER.email);
    await pw.click();
    await pw.fill("clave-equivocada-037");
    // Cursor a la mitad: el ojo no debe moverlo.
    await pw.evaluate((el) => el.setSelectionRange(5, 5));
    await eye.click();
    ok("clic → type=text", (await typeOf(pw)) === "text");
    ok("el botón pasa a «Ocultar contraseña», aria-pressed=true", (await eye.getAttribute("aria-label")) === HIDE && (await eye.getAttribute("aria-pressed")) === "true");
    ok("el foco sigue en el campo", (await activeId(page)) === "password", String(await activeId(page)));
    // Tras el siguiente cuadro (la restauración corre en requestAnimationFrame).
    const sel = await pw.evaluate(
      (el) =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r([el.selectionStart, el.selectionEnd])))
        )
    );
    ok("el cursor no se movió", sel[0] === 5 && sel[1] === 5, JSON.stringify(sel));
    await shot(page, "037-login-visible.png");
    await eye.click();
    ok("otro clic → type=password", (await typeOf(pw)) === "password");
    ok("y vuelve a «Mostrar contraseña»", (await eye.getAttribute("aria-label")) === SHOW);
    ok("el foco sigue en el campo tras ocultar", (await activeId(page)) === "password");

    // Credenciales malas con la contraseña visible → al enviar se oculta.
    await eye.click();
    ok("(malas) visible antes de enviar", (await typeOf(pw)) === "text");
    await page.getByRole("button", { name: "Entrar" }).click();
    ok("(malas) al enviar vuelve a type=password", await until(async () => (await typeOf(pw)) === "password", 5000));
    ok(
      "(malas) muestra el error y sigue en /login",
      await until(async () => (await page.getByText("Correo o contraseña incorrectos.").count()) > 0, 20000) && new URL(page.url()).pathname === "/login",
      page.url()
    );

    // Buenas, visibles, enviar → entra.
    await pw.fill(OWNER.password);
    await eye.click();
    ok("(buenas) visible antes de enviar", (await typeOf(pw)) === "text" && (await pw.inputValue()) === OWNER.password);
    await page.getByRole("button", { name: "Entrar" }).click();
    ok("(buenas) entra (sale de /login)", await until(async () => new URL(page.url()).pathname !== "/login", 60000), page.url());
  } finally {
    await ctx.close().catch(() => {});
  }
}

/* ───────────────────────── 2) Cuenta ───────────────────────── */

async function cuenta() {
  console.log("\n== 2) Ajustes › Cuenta ==");
  const { ctx, page } = await newPage({ withSession: true });
  try {
    await page.goto(`${BASE}/settings/account`, { waitUntil: "load" });
    const ids = ["account-current", "account-new", "account-confirm"];
    await page.locator(`#${ids[0]}`).waitFor({ timeout: 60000 });
    for (const id of ids) await waitHydrated(page, `#${id} + button`);
    const types = async () => Promise.all(ids.map((id) => typeOf(page.locator(`#${id}`))));

    ok("los 3 arrancan ocultos", (await types()).every((t) => t === "password"), JSON.stringify(await types()));
    for (const id of ids) {
      const eye = eyeOf(page, id);
      ok(`${id}: tiene su ojo sin title`, (await eye.count()) === 1 && (await eye.getAttribute("aria-label")) === SHOW && (await eye.getAttribute("title")) === null);
    }
    await eyeOf(page, "account-new").click();
    let t = await types();
    ok("mostrar «Nueva» no cambia las otras", t[0] === "password" && t[1] === "text" && t[2] === "password", JSON.stringify(t));
    await eyeOf(page, "account-confirm").click();
    t = await types();
    ok("mostrar «Repite» deja «Nueva» como estaba", t[0] === "password" && t[1] === "text" && t[2] === "text", JSON.stringify(t));
    await eyeOf(page, "account-new").click();
    t = await types();
    ok("ocultar «Nueva» no oculta «Repite»", t[0] === "password" && t[1] === "password" && t[2] === "text", JSON.stringify(t));
    await shot(page, "037-cuenta.png");
  } finally {
    await ctx.close().catch(() => {});
  }
}

/* ───────────────────────── 3) Bandeja ───────────────────────── */

async function bandeja() {
  console.log("\n== 3) Bandeja: aviso si falla «Marcar como atendida» ==");
  if (!conv) return ok("hay conversación para la Bandeja", false);
  const { ctx, page } = await newPage({ withSession: true });
  const isPatch = (req) => req.method() === "PATCH" && new URL(req.url()).pathname === `/api/conversations/${conv.id}`;
  const status = page.getByRole("status").filter({ hasText: /./ });
  const notice = (text) => page.getByRole("status").filter({ hasText: text });
  const box = page.getByTestId("attention-status");

  async function attend() {
    await box.getByRole("button", { name: "Marcar como atendida" }).click({ timeout: 60000 });
    await box.getByRole("button", { name: "Seguir atendiendo yo" }).click();
  }
  async function closeNotice() {
    const x = page.getByRole("button", { name: "Cerrar aviso" });
    if (await x.count()) await x.first().click().catch(() => {});
  }

  try {
    await page.goto(`${BASE}/inbox?contact=${conv.contact.id}`, { waitUntil: "load" });
    await box.waitFor({ timeout: 60000 });
    ok("el chat muestra «Marcar como atendida»", (await box.getByRole("button", { name: "Marcar como atendida" }).count()) === 1);

    // a) servidor responde 500.
    const fail500 = async (route) => {
      if (isPatch(route.request())) {
        await route.fulfill({ status: 500, contentType: "application/json", body: body({ error: { message: "boom" } }) });
      } else await route.fallback();
    };
    await page.route("**/api/conversations/**", fail500);
    await attend();
    ok("500 → aviso «No se pudo marcar como atendida…»", await until(async () => (await notice(MSG_ATTENDED).count()) === 1, 10000), await status.allInnerTexts().catch(() => []).then(String));
    await shot(page, "037-bandeja-aviso.png");
    ok("500 → la clienta sigue esperando", (await convOf(NAME))?.awaitingSince != null);
    await page.unroute("**/api/conversations/**", fail500);
    await closeNotice();

    // b) sin red.
    const abort = async (route) => {
      if (isPatch(route.request())) await route.abort();
      else await route.fallback();
    };
    await page.route("**/api/conversations/**", abort);
    await attend();
    ok("sin red → aviso «Sin conexión con el servidor.»", await until(async () => (await notice(MSG_OFFLINE).count()) === 1, 10000), await status.allInnerTexts().catch(() => []).then(String));
    await page.unroute("**/api/conversations/**", abort);
    await closeNotice();
    ok("el aviso se cierra", await until(async () => (await notice(MSG_OFFLINE).count()) === 0, 5000));

    // c) sin intercepción → guarda y no avisa.
    const resp = page.waitForResponse((r) => isPatch(r.request()), { timeout: 30000 });
    await attend();
    const r = await resp.catch(() => null);
    ok("sin intercepción → PATCH 200", r?.ok() === true, String(r?.status()));
    await sleep(800);
    ok("sin aviso de error", (await notice(MSG_ATTENDED).count()) === 0 && (await notice(MSG_OFFLINE).count()) === 0, await status.allInnerTexts().catch(() => []).then(String));
    ok("queda atendida (API: awaitingSince null)", await until(async () => (await convOf(NAME))?.awaitingSince === null, 10000));
    ok("queda atendida (pantalla)", await until(async () => /Atendida/.test(await box.innerText()), 15000), await box.innerText().catch(() => ""));
  } finally {
    await ctx.close().catch(() => {});
  }
}

/* ───────────────────────── main ───────────────────────── */

async function main() {
  try {
    await setup();
    browser = await chromium.launch();
    await login();
    await cuenta();
    await bandeja();
  } catch (err) {
    ok("el guion terminó sin excepción", false, String(err?.stack ?? err));
  } finally {
    await browser?.close().catch(() => {});
  }
  console.log(`\n=====${checks - failures}/${checks} checks OK, ${failures} fallos =====`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
