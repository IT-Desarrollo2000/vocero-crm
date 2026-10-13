/**
 * Self-test E2E — respuestas rápidas (dev-tasks/09, parte b).
 * Guion humano: tests/e2e/us-respuestas-rapidas.md
 *
 *   a) owner: CRUD de /api/quick-replies — alta (atajo normalizado), 422
 *      unknown_variable nombrando la variable, 409 duplicate_shortcut sin
 *      distinguir mayúsculas, PATCH (reordenar, 404, 422, 409), DELETE
 *   b) vendedor: GET 200; POST/PATCH/DELETE 403; /settings/quick-replies 404
 *   c) Playwright como vendedor, conversación con ventana abierta: escribe
 *      `/hor` → aparece el selector; Enter → el campo queda con
 *      `Hola María, …` (variables resueltas) y NO se envió; Enter otra vez →
 *      sale el texto renderizado (y la conversación queda suya)
 *   d) camino infeliz: ventana de 24 h cerrada → sin campo de texto (solo
 *      plantillas) y un POST con el texto → 409 window_closed
 *
 * Selectores de UI que asume (coordinados con la tarea 09-B):
 *   - campo del compositor: placeholder "Escribe una respuesta…" (textarea)
 *   - selector: role="listbox" con aria-label "Respuestas rápidas", y cada
 *     respuesta como role="option" cuyo texto incluye "/<atajo>" y el título
 *   - enlace directo a la conversación: /inbox?contact=<contactId>
 *   - página de Ajustes: /settings/quick-replies (404 al Vendedor)
 *
 * Presupuesto del limitador de login: 2 (owner + vendedor); Playwright
 * reutiliza las cookies del jar.
 *
 * Uso:
 *   1) BD migrada (0015) y app con WA_MOCK_ENABLED=true y META_GRAPH_BASE_URL
 *      → wa-mock (p. ej. .env.e2e, BD aislada en :5433)
 *   2) node --env-file=.env.e2e scripts/e2e-respuestas-rapidas.mjs
 *
 * Sale con código 1 si algún check falla.
 */
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const S = Math.random().toString(36).slice(2, 8);
const PN = "PN-E2E-QR";

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
const SELLER_EMAIL = `vend.qr.${S}@vocero.test`;
const SELLER_PASSWORD = "password-vend-123";
const SELLER_NAME = `Vendedora QR ${S}`;
const BODY = "Hola {{nombre}}, abrimos de 9 a 6. — {{vendedor}}";
const COMPOSER = "Escribe una respuesta…";

function signIn(c, email, password) {
  return c.api("/api/auth/sign-in/email", {
    method: "POST",
    body: body({ email, password }),
  });
}

const phone = () => `52155${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;

async function findByName(c, name) {
  const list = (await c.api("/api/conversations")).json?.conversations ?? [];
  return list.find((cv) => cv.contact?.name === name) ?? null;
}
async function outboxTexts() {
  const ob = (await owner.api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  return ob.map((o) => JSON.stringify(o.body));
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

async function main() {
  console.log("== Setup ==");
  let su = await owner.api("/api/auth/sign-up/email", {
    method: "POST",
    body: body({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: "Operador E2E" }),
  });
  if (!su.res.ok) su = await signIn(owner, OWNER_EMAIL, OWNER_PASSWORD);
  ok("owner registrado o con sesión", su.res.ok, short(su));
  const conn = await owner.api("/api/settings/whatsapp", {
    method: "PUT",
    body: body({ wabaId: "WABA-E2E-QR", phoneNumberId: PN, token: "tok-e2e-qr" }),
  });
  ok("owner conecta WhatsApp (wa-mock)", conn.res.ok, short(conn));
  const add = await owner.api("/api/settings/team", {
    method: "POST",
    body: body({ name: SELLER_NAME, email: SELLER_EMAIL, password: SELLER_PASSWORD }),
  });
  ok("alta del vendedor → 201", add.res.status === 201, short(add));
  ok("el vendedor inicia sesión", (await signIn(seller, SELLER_EMAIL, SELLER_PASSWORD)).res.ok);

  // Corridas previas: que `/hor` solo encuentre la de esta corrida.
  const previas = (await owner.api("/api/quick-replies")).json?.quickReplies ?? [];
  for (const q of previas.filter((q) => q.shortcut.startsWith("hor"))) {
    await owner.api(`/api/quick-replies/${q.id}`, { method: "DELETE" });
  }

  console.log("\n== a) CRUD como Propietario ==");
  let r = await owner.api("/api/quick-replies", {
    method: "POST",
    body: body({ shortcut: " /Horario ", title: "Horario", body: BODY }),
  });
  ok("POST /horario → 201 con el atajo normalizado", r.res.status === 201 && r.json?.quickReply?.shortcut === "horario" && r.json?.quickReply?.body === BODY, short(r));
  const horario = r.json?.quickReply;
  r = await owner.api("/api/quick-replies", {
    method: "POST",
    body: body({ shortcut: `tel${S}`, title: "Teléfono", body: "Llámanos: {{telefono}}" }),
  });
  ok(
    "{{telefono}} → 422 unknown_variable nombrando la variable",
    r.res.status === 422 && r.json?.error?.code === "unknown_variable" && r.json?.error?.message?.includes("{{telefono}}"),
    short(r)
  );
  r = await owner.api("/api/quick-replies", {
    method: "POST",
    body: body({ shortcut: "HORARIO", title: "Otro", body: "x" }),
  });
  ok("atajo duplicado en mayúsculas → 409 duplicate_shortcut", r.res.status === 409 && r.json?.error?.code === "duplicate_shortcut", short(r));
  r = await owner.api("/api/quick-replies", {
    method: "POST",
    body: body({ shortcut: "con espacio", title: "x", body: "x" }),
  });
  ok("atajo inválido → 422 invalid_body", r.res.status === 422 && r.json?.error?.code === "invalid_body", short(r));
  r = await owner.api("/api/quick-replies", {
    method: "POST",
    body: body({ shortcut: `UBI${S.toUpperCase()}`, title: "Ubicación", body: "Estamos en {{negocio}}" }),
  });
  ok("POST ubicación → 201 (al final por position)", r.res.status === 201 && r.json?.quickReply?.position > (horario?.position ?? -1), short(r));
  const ubi = r.json?.quickReply;
  r = await owner.api(`/api/quick-replies/${ubi?.id}`, { method: "PATCH", body: body({ position: 0 }) });
  ok("PATCH reordenar → 200", r.res.status === 200 && r.json?.quickReply?.position === 0, short(r));
  // Como "subir" en Ajustes (`movePositions`): también se manda la del que
  // baja; con empate de position el GET desempata por createdAt asc.
  r = await owner.api(`/api/quick-replies/${horario?.id}`, { method: "PATCH", body: body({ position: 1 }) });
  ok("PATCH del que baja → 200", r.res.status === 200 && r.json?.quickReply?.position === 1, short(r));
  r = await owner.api(`/api/quick-replies/${ubi?.id}`, { method: "PATCH", body: body({ body: "{{direccion}}" }) });
  ok("PATCH con variable desconocida → 422", r.res.status === 422 && r.json?.error?.code === "unknown_variable", short(r));
  r = await owner.api(`/api/quick-replies/${ubi?.id}`, { method: "PATCH", body: body({ shortcut: "Horario" }) });
  ok("PATCH a un atajo ocupado → 409", r.res.status === 409 && r.json?.error?.code === "duplicate_shortcut", short(r));
  r = await owner.api(`/api/quick-replies/${ubi?.id}`, { method: "PATCH", body: body({}) });
  ok("PATCH vacío → 422 invalid_body", r.res.status === 422, short(r));
  r = await owner.api("/api/quick-replies/qr_inexistente", { method: "PATCH", body: body({ title: "x" }) });
  ok("PATCH inexistente → 404", r.res.status === 404, short(r));
  const listed = (await owner.api("/api/quick-replies")).json?.quickReplies ?? [];
  const posUbi = listed.findIndex((q) => q.id === ubi?.id);
  const posHor = listed.findIndex((q) => q.id === horario?.id);
  ok("GET lista ordenada por position", posUbi !== -1 && posHor !== -1 && posUbi < posHor, JSON.stringify(listed.map((q) => [q.shortcut, q.position])));
  r = await owner.api(`/api/quick-replies/${ubi?.id}`, { method: "DELETE" });
  ok("DELETE → 200 { ok: true }", r.res.status === 200 && r.json?.ok === true, short(r));
  r = await owner.api(`/api/quick-replies/${ubi?.id}`, { method: "DELETE" });
  ok("DELETE otra vez → 404", r.res.status === 404, short(r));

  console.log("\n== b) Vendedor: lee, no escribe ==");
  r = await seller.api("/api/quick-replies");
  ok("GET → 200 con la lista", r.res.status === 200 && (r.json?.quickReplies ?? []).some((q) => q.id === horario?.id), short(r));
  for (const [method, path, payload] of [
    ["POST", "/api/quick-replies", { shortcut: `x${S}`, title: "x", body: "x" }],
    ["PATCH", `/api/quick-replies/${horario?.id}`, { title: "HACK" }],
    ["DELETE", `/api/quick-replies/${horario?.id}`],
  ]) {
    r = await seller.api(path, { method, ...(payload ? { body: body(payload) } : {}) });
    ok(`${method} ${path} → 403 forbidden`, r.res.status === 403 && r.json?.error?.code === "forbidden", short(r));
  }
  const page404 = await fetch(`${BASE}/settings/quick-replies`, {
    headers: { cookie: seller.jar.cookie },
    redirect: "manual",
  });
  ok("vendedor: /settings/quick-replies → 404", page404.status === 404, `${page404.status}`);
  const pageOwner = await fetch(`${BASE}/settings/quick-replies`, {
    headers: { cookie: owner.jar.cookie },
    redirect: "manual",
  });
  ok("owner: /settings/quick-replies → 200", pageOwner.status === 200, `${pageOwner.status}`);

  console.log("\n== c) Compositor: `/hor` + Enter inserta sin enviar ==");
  const name = `María López ${S}`;
  const inb = await owner.api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({ phoneNumberId: PN, from: phone(), name, text: "hola", waMessageId: `wamid.e2e.qr.${S}` }),
  });
  ok("inbound entregado", inb.res.ok, short(inb));
  ok("la conversación aparece", await until(async () => !!(await findByName(owner, name))));
  const conv = await findByName(owner, name);
  // Sin agente: el outbox solo debe tener lo que envíe la vendedora.
  await owner.api(`/api/conversations/${conv?.id}`, { method: "PATCH", body: body({ aiEnabled: false }) });
  await sleep(1500);
  await owner.api("/api/dev/wa-mock/outbox", { method: "DELETE" });
  const RENDERED = `Hola María, abrimos de 9 a 6. — ${SELLER_NAME}`;
  await composerChecks(conv, RENDERED);

  console.log("\n== d) Ventana cerrada: solo plantillas ==");
  const oldName = `Ventana Cerrada ${S}`;
  const oldInb = await owner.api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({
      phoneNumberId: PN,
      from: phone(),
      name: oldName,
      text: "hola de hace dos días",
      waMessageId: `wamid.e2e.qr.old.${S}`,
      timestamp: Math.floor(Date.now() / 1000) - 48 * 3600,
    }),
  });
  ok("inbound viejo (48 h) entregado", oldInb.res.ok, short(oldInb));
  ok("la conversación aparece", await until(async () => !!(await findByName(owner, oldName))));
  const old = await findByName(owner, oldName);
  ok("con la ventana cerrada (replyMode ≠ free)", old?.windowOpen === false && old?.replyMode !== "free", JSON.stringify({ w: old?.windowOpen, m: old?.replyMode }));
  r = await seller.api(`/api/conversations/${old?.id}/messages`, {
    method: "POST",
    body: body({ text: RENDERED }),
  });
  ok("POST del texto de la respuesta rápida → 409 window_closed", r.res.status === 409 && r.json?.error?.code === "window_closed", short(r));
  await closedWindowCheck(old);
}

async function withSellerPage(fn) {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    // SSE fuera: cada stream vivo ocupa una ranura de `next dev`.
    await ctx.route("**/api/events*", (route) => route.abort());
    await ctx.addCookies(toBrowserCookies(seller.jar));
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    await fn(page);
    await ctx.close();
  } finally {
    await browser.close();
  }
}

async function composerChecks(conv, rendered) {
  await withSellerPage(async (page) => {
    await page.goto(`${BASE}/inbox?contact=${conv?.contact?.id}`, { waitUntil: "load", timeout: 90000 });
    const input = page.getByPlaceholder(COMPOSER);
    await input.waitFor();
    const picker = page.getByRole("listbox", { name: "Respuestas rápidas" });
    // En next dev la primera tecla puede caer antes de hidratar: reintenta.
    const opened = await until(async () => {
      await input.fill("");
      await input.pressSequentially("/hor", { delay: 40 });
      await sleep(400);
      return (await picker.count()) > 0 && (await picker.isVisible());
    }, 30000);
    ok("escribir `/hor` abre el selector (listbox \"Respuestas rápidas\")", opened);
    const option = picker.getByRole("option").filter({ hasText: "horario" });
    ok("el selector ofrece /horario", (await option.count()) > 0);

    await input.press("Enter");
    const filled = await until(async () => (await input.inputValue()) === rendered, 5000);
    ok("Enter inserta el texto con variables resueltas", filled, JSON.stringify(await input.inputValue()));
    ok("el selector se cerró", (await picker.count()) === 0 || !(await picker.isVisible()));
    await sleep(1000);
    ok("y NO se envió nada (outbox sin el texto)", !(await outboxTexts()).some((t) => t.includes("abrimos de 9 a 6")));

    await input.press("Enter");
    const sent = await until(async () => (await outboxTexts()).some((t) => t.includes(rendered)), 15000);
    ok("Enter otra vez → sale el texto renderizado", sent);
    const after = await findByName(owner, conv?.contact?.name);
    ok("la conversación quedó asignada a la vendedora (responder = tomar)", after?.assignedTo?.name === SELLER_NAME, JSON.stringify(after?.assignedTo));

    // Un `/` legítimo a media palabra no abre nada.
    await input.fill("");
    await input.pressSequentially("1/2 kilo", { delay: 30 });
    await sleep(400);
    ok('"1/2 kilo" no abre el selector', (await picker.count()) === 0 || !(await picker.isVisible()));
    await input.fill("");
  });
}

async function closedWindowCheck(conv) {
  await withSellerPage(async (page) => {
    await page.goto(`${BASE}/inbox?contact=${conv?.contact?.id}`, { waitUntil: "load", timeout: 90000 });
    await until(async () => (await page.getByText(conv?.contact?.name ?? "").count()) > 0, 30000);
    await sleep(1500);
    ok(
      "ventana cerrada: el compositor no tiene campo de texto (no hay `/`)",
      (await page.getByPlaceholder(COMPOSER).count()) === 0
    );
    ok(
      "ni selector de respuestas rápidas",
      (await page.getByRole("listbox", { name: "Respuestas rápidas" }).count()) === 0
    );
  });
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
