/**
 * 031 (CA-5) — Capturas de la guía `/ayuda` → `public/ayuda/*.png`.
 *
 * Las PNG quedan PÚBLICAS (como todo `public/`): solo datos FICTICIOS. Este
 * guion siembra una instancia de ejemplo («Mueblería Demo», vendedora
 * «Daniela Ortiz», clientes Laura Gómez, Carlos Ruiz, Ana Torres, Jorge
 * Méndez y Sofía Castro con teléfonos 52155000000xx) y toma cada estado a
 * 1366×768, tema claro, como VENDEDORA, recortado al área que explica el tema.
 * Los nombres de archivo son los del campo `captura` de
 * `src/lib/help/topics.ts`.
 *
 *   ventana-abierta.png    barra «Puedes escribirle libremente … más»
 *   respuestas-rapidas.png chips rotulados + selector `/`
 *   adjunto.png            menú «Adjuntar» abierto
 *   catalogo.png           panel Catálogo con un producto abierto
 *   cita.png               diálogo «Agendar» con tipo, día y horario
 *   ventana-cerrada.png    «Para escribirle a Carlos, usa un mensaje aprobado»
 *   plantilla-enviar.png   plantilla elegida, un espacio lleno y otro vacío
 *   ia.png                 franja «La IA está respondiendo a Ana» + pregunta
 *   mis-chats.png          Buzón con «Tomar», descripción y «lo que te toca»
 *   seguimiento.png        (032) tablero con el filtro, la franja y los chips
 *                          («Lo atiende Marco Ríos», «Tomar y responder»…)
 *   citas.png              (032) Citas con «¿Cómo le fue a…?», hoy/mañana y
 *                          «1 cita sin vendedor» con «Tomarla»
 *
 * 032 — Para esas dos se siembra además un segundo vendedor («Marco Ríos»,
 * sin iniciar sesión), Mónica Pérez y Raúl Sánchez, los tratos en sus etapas
 * y citas (una pasada sin resultado: se crea a futuro y se RETROCEDE por SQL,
 * porque la API no agenda en el pasado). Va DESPUÉS de las capturas de 031
 * para no cambiarlas.
 *
 * Con `--revisar <dir>` además deja en <dir> la página /ayuda completa (por
 * tramos), tres pantallas en tema OSCURO y (032) `/pipeline` y `/bookings`
 * como vendedora y propietario, claro y oscuro, a 1366×768 y 390×844, para
 * revisarlas a ojo (no se publican).
 *
 * Uso: BD aislada RECIÉN RESETEADA (la lista debe tener solo estos clientes)
 * y app con .env.e2e (mocks, AGENDA=on, CATALOG_STORAGE=local):
 *   node --env-file=.env.e2e scripts/ayuda-capturas.mjs [--revisar <dir>]
 *
 * Presupuesto del limitador de login: 2 (owner + vendedora).
 * Sale con código 1 si alguna captura no se pudo tomar.
 */
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import postgres from "postgres";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const OUT = path.join(process.cwd(), "public", "ayuda");
const reviewIdx = process.argv.indexOf("--revisar");
const REVIEW = reviewIdx > -1 ? process.argv[reviewIdx + 1] : null;
const PN = "PN-AYUDA-DEMO";
const WABA = "WABA-AYUDA-DEMO";
const VIEWPORT = { width: 1366, height: 768 };
const MAX_BYTES = 400 * 1024;

let failures = 0;
function ok(name, cond, extra = "") {
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
const short = (r) => `${r.res.status} ${JSON.stringify(r.json)?.slice(0, 200)}`;

const owner = client();
const seller = client();
const OWNER_EMAIL = "e2e@vocero.test";
const OWNER_PASSWORD = "password-e2e-123";
const SELLER_EMAIL = "daniela.ortiz@vocero.test";
const SELLER_PASSWORD = "password-vend-123";
const SELLER_NAME = "Daniela Ortiz";

const C = {
  laura: { name: "Laura Gómez", phone: "5215500000011" },
  carlos: { name: "Carlos Ruiz", phone: "5215500000012" },
  ana: { name: "Ana Torres", phone: "5215500000013" },
  jorge: { name: "Jorge Méndez", phone: "5215500000014" },
  sofia: { name: "Sofía Castro", phone: "5215500000015" },
  // 032 — solo para Seguimiento.
  monica: { name: "Mónica Pérez", phone: "5215500000016" },
  raul: { name: "Raúl Sánchez", phone: "5215500000017" },
};
// 032 — Segundo vendedor: solo se da de alta (no inicia sesión).
const MARCO = { name: "Marco Ríos", email: "marco.rios@vocero.test", password: "password-vend-456" };

let wamid = 0;
async function inbound(who, text, { minutesAgo = 0 } = {}) {
  const r = await owner.api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({
      phoneNumberId: PN,
      from: who.phone,
      name: who.name,
      text,
      waMessageId: `wamid.ayuda.demo.${Date.now()}.${wamid++}`,
      ...(minutesAgo ? { timestamp: Math.floor(Date.now() / 1000) - minutesAgo * 60 } : {}),
    }),
  });
  if (!r.res.ok) throw new Error(`inbound ${who.name}: ${short(r)}`);
  await until(async () => !!(await conv(who)));
  return conv(who);
}
async function conv(who) {
  const list = (await owner.api("/api/conversations")).json?.conversations ?? [];
  return list.find((c) => c.contact?.name === who.name) ?? null;
}

function toBrowserCookies(jar, extra = []) {
  const host = new URL(BASE).hostname;
  return [
    ...jar.cookie
      .split(/;\s*/)
      .filter(Boolean)
      .map((pair) => {
        const i = pair.indexOf("=");
        return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: host, path: "/" };
      }),
    ...extra.map((c) => ({ ...c, domain: host, path: "/" })),
  ];
}

let browser;
async function newPage({ dark = false, viewport = VIEWPORT, as = seller, storage = {} } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.route("**/api/events*", (route) => route.abort());
  await ctx.addCookies(
    toBrowserCookies(as.jar, [{ name: "vocero-theme", value: dark ? "dark" : "light" }])
  );
  // Panel «Detalles» cerrado (el hilo a lo ancho, como lo ve quien atiende)
  // y sin el indicador de `next dev` en la esquina.
  await ctx.addInitScript((extra) => {
    try {
      localStorage.setItem("vocero.panelOpen", "false");
      for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
    } catch {}
    document.addEventListener("DOMContentLoaded", () => {
      const s = document.createElement("style");
      s.textContent = "nextjs-portal{display:none!important}";
      document.head.appendChild(s);
    });
  }, storage);
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  return { ctx, page };
}

/** Recorta a la unión de las cajas de `locators` (+ margen), dentro del viewport. */
async function clipOf(page, locators, { pad = 0, top = 0, left = null, right = null } = {}) {
  const boxes = [];
  for (const l of locators) {
    const b = await l.boundingBox();
    if (b) boxes.push(b);
  }
  if (boxes.length === 0) throw new Error("sin cajas para recortar");
  const vw = page.viewportSize();
  let x0 = Math.min(...boxes.map((b) => b.x)) - pad;
  let y0 = Math.min(...boxes.map((b) => b.y)) - pad - top;
  let x1 = Math.max(...boxes.map((b) => b.x + b.width)) + pad;
  let y1 = Math.max(...boxes.map((b) => b.y + b.height)) + pad;
  if (left !== null) x0 = left;
  if (right !== null) x1 = right;
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(vw.width, Math.ceil(x1));
  y1 = Math.min(vw.height, Math.ceil(y1));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

async function save(page, file, clip, dir = OUT) {
  const p = path.join(dir, file);
  await page.mouse.move(0, 0);
  await sleep(300);
  await page.screenshot({ path: p, clip, animations: "disabled", caret: "hide" });
  const size = statSync(p).size;
  ok(`${file} (${clip.width}×${clip.height}, ${Math.round(size / 1024)} KB)`, dir !== OUT || size <= MAX_BYTES, `pesa ${size} bytes (> ${MAX_BYTES})`);
}

/** Abre el chat de `who` como vendedora y espera el compositor o su estado. */
async function openChat(page, who) {
  const c = await conv(who);
  await page.goto(`${BASE}/inbox?contact=${c?.contact?.id}`, { waitUntil: "load", timeout: 90000 });
  await page.locator("#composer").waitFor();
  await page.locator("section header").filter({ hasText: who.name }).waitFor();
  await sleep(1200);
}

/** La columna del hilo (la que tiene el compositor). */
const threadCol = (page) => page.locator("section").filter({ has: page.locator("#composer") }).last();

/** Foto ficticia del catálogo: un degradado con el nombre, renderizado aquí. */
async function productPhoto(label, from, to) {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 480 } });
  const page = await ctx.newPage();
  await page.setContent(
    `<div style="width:640px;height:480px;display:flex;align-items:flex-end;justify-content:flex-start;background:linear-gradient(135deg,${from},${to});font:600 34px system-ui,sans-serif;color:#fff;padding:28px;box-sizing:border-box">${label}</div>`
  );
  const buf = await page.screenshot({ type: "png" });
  await ctx.close();
  return buf;
}

async function seed() {
  console.log("== Siembra (datos ficticios) ==");
  let su = await owner.api("/api/auth/sign-up/email", {
    method: "POST",
    body: body({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: "Ricardo Salas" }),
  });
  if (!su.res.ok) su = await owner.api("/api/auth/sign-in/email", { method: "POST", body: body({ email: OWNER_EMAIL, password: OWNER_PASSWORD }) });
  ok("owner con sesión", su.res.ok, short(su));
  const br = (await owner.api("/api/settings/branding")).json?.branding;
  const brand = await owner.api("/api/settings/branding", { method: "PUT", body: body({ ...br, name: "Mueblería Demo" }) });
  ok("nombre de la instancia «Mueblería Demo»", brand.res.ok, short(brand));
  const conn = await owner.api("/api/settings/whatsapp", { method: "PUT", body: body({ wabaId: WABA, phoneNumberId: PN, token: "tok-ayuda-demo" }) });
  ok("WhatsApp (wa-mock)", conn.res.ok, short(conn));
  const add = await owner.api("/api/settings/team", { method: "POST", body: body({ name: SELLER_NAME, email: SELLER_EMAIL, password: SELLER_PASSWORD }) });
  ok("alta de Daniela", add.res.status === 201 || add.res.status === 409, short(add));
  const si = await seller.api("/api/auth/sign-in/email", { method: "POST", body: body({ email: SELLER_EMAIL, password: SELLER_PASSWORD }) });
  ok("Daniela inicia sesión", si.res.ok, short(si));
  const members = (await owner.api("/api/settings/team")).json?.members ?? [];
  const danielaId = members.find((m) => m.email === SELLER_EMAIL)?.userId;

  // Agente apagado mientras se siembra: nadie contesta solo.
  await owner.api("/api/agent/profile", {
    method: "PUT",
    body: body({ name: "Lumi", tone: "cálido y breve", instructions: "Mueblería: salas, comedores y recámaras.", enabled: false }),
  });

  // Respuestas rápidas.
  for (const q of [
    { shortcut: "horario", title: "Horario", body: "Hola {{nombre}}, abrimos de lunes a sábado de 10 a 19 h. — {{vendedor}}" },
    { shortcut: "pagos", title: "Formas de pago", body: "Aceptamos tarjeta, transferencia y hasta 12 meses sin intereses." },
    { shortcut: "envio", title: "Envío", body: "El envío en la ciudad es gratis y llega en 3 a 5 días hábiles." },
    { shortcut: "ubicacion", title: "Ubicación", body: "Estamos en Av. de los Pinos 120, Col. Centro. ¡Te esperamos en {{negocio}}!" },
    { shortcut: "garantia", title: "Garantía", body: "Todos nuestros muebles tienen 1 año de garantía." },
  ]) {
    await owner.api("/api/quick-replies", { method: "POST", body: body(q) });
  }

  // Plantillas aprobadas (dos: así «Elige el mensaje» tiene opciones).
  for (const t of [
    { name: "seguimiento_cotizacion", body: "Hola {{1}}, ¿pudiste revisar la cotización de {{2}}? Si tienes dudas, con gusto te ayudo." },
    { name: "recordatorio_visita", body: "Hola {{1}}, te esperamos en la tienda. ¿Te aparto un horario para que veas los muebles?" },
  ]) {
    await owner.api("/api/templates", { method: "POST", body: body({ ...t, language: "es_MX", category: "UTILITY" }) });
    await owner.api("/api/dev/wa-mock/template-status", { method: "POST", body: body({ wabaId: WABA, name: t.name, language: "es_MX", event: "APPROVED", notify: false }) });
  }
  await owner.api("/api/templates/sync", { method: "POST" });
  const approved = ((await owner.api("/api/templates")).json?.templates ?? []).filter((t) => t.status === "approved");
  ok("2 plantillas aprobadas", approved.length === 2, JSON.stringify(approved.map((t) => [t.name, t.status])));

  // Catálogo: una categoría y un producto con dos fotos y una ficha.
  const cat = await owner.api("/api/catalog/categories", { method: "POST", body: body({ name: "Salas" }) });
  await owner.api("/api/catalog/categories", { method: "POST", body: body({ name: "Comedores" }) });
  const prod = await owner.api("/api/catalog/products", {
    method: "POST",
    body: body({ name: "Sala modular Lisboa", code: "SAL-014", categoryId: cat.json?.category?.id, price: "$18,900", description: "Sala modular de 3 piezas en tela antimanchas." }),
  });
  ok("producto del catálogo", prod.res.status === 201, short(prod));
  const pid = prod.json?.product?.id;
  await owner.api("/api/catalog/products", { method: "POST", body: body({ name: "Comedor Nogal 6 sillas", code: "COM-006", price: "$24,500" }) });
  for (const [file, from, to] of [
    ["lisboa-gris.png", "#6b7280", "#374151"],
    ["lisboa-arena.png", "#d6c3a5", "#a68a64"],
  ]) {
    const fd = new FormData();
    fd.set("file", new Blob([await productPhoto("Sala Lisboa", from, to)], { type: "image/png" }), file);
    const up = await owner.api(`/api/catalog/products/${pid}/files`, { method: "POST", body: fd });
    ok(`foto ${file}`, up.res.ok, short(up));
  }
  const pdf = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
  );
  const fd = new FormData();
  fd.set("file", new Blob([pdf], { type: "application/pdf" }), "ficha-lisboa.pdf");
  const upPdf = await owner.api(`/api/catalog/products/${pid}/files`, { method: "POST", body: fd });
  ok("ficha PDF", upPdf.res.ok, short(upPdf));

  // Agenda: horario de tienda y un tipo de cita propio.
  const day = [{ start: "10:00", end: "19:00" }];
  const agenda = await owner.api("/api/calendar/settings", {
    method: "PUT",
    body: body({
      weeklyHours: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: [] },
      slotMinutes: 30,
      bufferMinutes: 0,
      minNoticeHours: 0,
      maxDaysAhead: 14,
      connector: "enlace-fijo",
      meetingLink: null,
      reminderEnabled: false,
    }),
  });
  ok("horario de la agenda", agenda.res.ok, short(agenda));
  const types = (await owner.api("/api/calendar/types?all=1")).json?.types ?? [];
  for (const t of types) await owner.api(`/api/calendar/types/${t.id}`, { method: "PATCH", body: body({ active: false }) });
  const visita = await owner.api("/api/calendar/types", { method: "POST", body: body({ name: "Visita a la tienda", durationMinutes: 60 }) });
  ok("tipo de cita «Visita a la tienda»", visita.res.ok, short(visita));
  await owner.api("/api/calendar/types", { method: "POST", body: body({ name: "Medición a domicilio", durationMinutes: 60 }) });

  // Conversaciones.
  await inbound(C.sofia, "¿Tienen sillas para exterior?", { minutesAgo: 95 });
  await inbound(C.jorge, "Buenas tardes, ¿hacen envíos a Puebla?", { minutesAgo: 22 * 60 + 40 });
  await inbound(C.carlos, "Me interesa el comedor Nogal, ¿me mandas la cotización?", { minutesAgo: 30 * 60 });
  await inbound(C.laura, "Hola, ¿tienen la sala modular Lisboa en gris?", { minutesAgo: 12 });
  for (const who of [C.sofia, C.jorge, C.carlos, C.laura]) {
    const c = await conv(who);
    await owner.api(`/api/conversations/${c?.id}`, { method: "PATCH", body: body({ aiEnabled: false }) });
  }
  const laura = await conv(C.laura);
  const reply = await seller.api(`/api/conversations/${laura?.id}/messages`, {
    method: "POST",
    body: body({ text: "¡Hola Laura! Sí, la tenemos en gris Oxford y en arena. ¿Te mando fotos?" }),
  });
  ok("Daniela le responde a Laura", reply.res.ok, short(reply));
  await inbound(C.laura, "Sí, porfa. ¿Y cuánto tarda la entrega?");
  const carlos = await conv(C.carlos);
  const as = await owner.api(`/api/conversations/${carlos?.id}/assign`, { method: "POST", body: body({ userId: danielaId }) });
  ok("Carlos a nombre de Daniela", as.res.ok, short(as));
  return { danielaId };
}

async function enableAgentAndAna() {
  const r = await owner.api("/api/agent/profile", { method: "PUT", body: body({ enabled: true }) });
  ok("agente encendido", r.res.ok, short(r));
  await inbound(C.ana, "Hola, vi la mesa de centro Roble en su página. ¡Me lo llevo! ¿Cómo pago?");
  const replied = await until(async () => {
    const ob = (await owner.api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
    return ob.some((o) => JSON.stringify(o.body).includes("Te aparto el producto"));
  }, 30000);
  ok("la IA le contesta a Ana", replied);
}

async function captures() {
  console.log("\n== Capturas (claro, 1366×768, como vendedora) ==");
  mkdirSync(OUT, { recursive: true });
  const { ctx, page } = await newPage();

  // Ventana abierta + respuestas rápidas + Adjuntar + Catálogo + Cita (Laura).
  await openChat(page, C.laura);
  const composer = page.locator("#composer");
  await page.getByTestId("window-bar").waitFor();
  await page.getByTestId("quick-reply-chips").waitFor();
  await sleep(500);
  const col = threadCol(page);
  const colBox = await col.boundingBox();
  await save(page, "ventana-abierta.png", await clipOf(page, [col]));

  const input = page.locator("#composer-input");
  const picker = page.getByRole("listbox", { name: "Respuestas rápidas" });
  const opened = await until(async () => {
    await input.fill("");
    await input.pressSequentially("/", { delay: 40 });
    await sleep(500);
    return await picker.isVisible();
  }, 30000);
  ok("selector `/` abierto", opened);
  await save(page, "respuestas-rapidas.png", await clipOf(page, [composer, picker], { top: 16, left: colBox.x, right: colBox.x + colBox.width }));
  await input.press("Escape");
  await input.fill("");

  const attach = page.getByRole("button", { name: "Adjuntar archivo" });
  const menu = page.getByRole("menu", { name: "¿Qué quieres mandar?" });
  ok("menú «Adjuntar» abierto", await until(async () => {
    if ((await menu.count()) === 0) await attach.click();
    await sleep(400);
    return await menu.isVisible();
  }, 30000));
  await save(page, "adjunto.png", await clipOf(page, [composer, menu], { top: 16, left: colBox.x, right: colBox.x + colBox.width }));
  await page.keyboard.press("Escape");

  const catBtn = page.getByRole("button", { name: "Catálogo", exact: true });
  const panel = page.getByRole("dialog", { name: "Catálogo" });
  ok("panel Catálogo abierto", await until(async () => {
    if ((await panel.count()) === 0) await catBtn.click();
    await sleep(500);
    return await panel.isVisible();
  }, 30000));
  await panel.getByRole("list", { name: "Productos" }).getByRole("button").filter({ hasText: "Sala modular Lisboa" }).click();
  await panel.getByRole("list", { name: "Archivos" }).waitFor();
  const firstFile = panel.getByRole("list", { name: "Archivos" }).locator('input[type="checkbox"]').first();
  await firstFile.check();
  // Miniaturas (`loading="lazy"`): que estén pintadas antes de la foto.
  const thumbs = panel.locator("img");
  ok("miniaturas del catálogo cargadas", await until(async () =>
    (await thumbs.count()) >= 2 &&
    (await thumbs.evaluateAll((imgs) => imgs.every((i) => i.complete && i.naturalWidth > 0))), 20000));
  await sleep(500);
  await save(page, "catalogo.png", await clipOf(page, [panel], { pad: 8 }));
  await panel.getByRole("button", { name: "Cerrar catálogo" }).click();

  const agendar = page.getByRole("button", { name: "Agendar cita" });
  const dialog = page.getByTestId("booking-dialog");
  ok("diálogo «Agendar» abierto", await until(async () => {
    if ((await dialog.count()) === 0) await agendar.click();
    await sleep(600);
    return await dialog.isVisible();
  }, 30000));
  const typeSel = dialog.getByTestId("booking-type");
  const visitaOpt = typeSel.locator("option").filter({ hasText: "Visita a la tienda" });
  await until(async () => (await visitaOpt.count()) > 0 && (await typeSel.isEnabled()), 20000);
  await typeSel.selectOption((await visitaOpt.getAttribute("value")) ?? "");
  // Un día con horarios libres (mañana en adelante, para no depender de la hora).
  const days = dialog.getByTestId("booking-day");
  await until(async () => (await days.count()) > 1, 20000);
  let picked = false;
  for (let i = 1; i < (await days.count()) && !picked; i++) {
    await days.nth(i).click();
    await sleep(900);
    const slots = dialog.locator('[data-testid="booking-slot"]:not([disabled])');
    if ((await slots.count()) > 2) {
      await slots.nth(2).click();
      picked = true;
    }
  }
  ok("día y horario elegidos", picked);
  await dialog.getByLabel("Notas (opcional)").fill("Quiere ver la sala Lisboa en gris.").catch(() => {});
  await sleep(500);
  await save(page, "cita.png", await clipOf(page, [dialog], { pad: 8 }));
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Cerrar" }).click().catch(() => {});

  // Ventana cerrada (Carlos): primero sin elegir, luego elegida con un hueco.
  await openChat(page, C.carlos);
  const sender = page.getByTestId("template-sender");
  await sender.waitFor();
  await sleep(800);
  const col2 = await threadCol(page).boundingBox();
  await save(page, "ventana-cerrada.png", await clipOf(page, [threadCol(page)]));
  await sender.getByTestId("template-option").filter({ hasText: "cotización" }).click();
  await page.locator("#template-variable-1").waitFor();
  await until(async () => (await page.locator("#template-variable-1").inputValue()) === "Carlos", 5000);
  await sleep(500);
  await save(page, "plantilla-enviar.png", await clipOf(page, [composer], { left: col2.x, right: col2.x + col2.width }));

  // IA (Ana): franja + la pregunta al empezar a escribir.
  await enableAgentAndAna();
  await openChat(page, C.ana);
  const strip = page.getByTestId("who-answers");
  ok("franja de la IA", await until(async () => (await strip.getAttribute("data-state")) === "ai", 30000));
  const aiInput = page.locator("#composer-input");
  ok("pregunta «¿La pausamos…?»", await until(async () => {
    await aiInput.fill("");
    await aiInput.pressSequentially("C", { delay: 40 });
    await sleep(400);
    return await page.getByTestId("ai-prompt").isVisible();
  }, 30000));
  await save(page, "ia.png", await clipOf(page, [threadCol(page)]));
  await aiInput.fill("");

  // Buzón: pestañas con descripción, «Tomar» por fila, «lo que te toca».
  await page.goto(`${BASE}/inbox?scope=inbox`, { waitUntil: "load", timeout: 90000 });
  await page.getByTestId("scope-description").waitFor();
  await page.getByTestId("inbox-summary").waitFor();
  await until(async () => (await page.getByTestId("row-take").count()) >= 2, 20000);
  await sleep(1200);
  await save(page, "mis-chats.png", { x: 0, y: 0, ...VIEWPORT });
  await ctx.close();
}

// ── 032: Seguimiento y Citas ────────────────────────────────────────────

const TZ = "America/Mexico_City";

/**
 * Inicio (UTC ISO) a la `hour` del negocio, `offsetDays` días desde hoy,
 * saltando el domingo (la tienda cierra). Devuelve también cuántos días se
 * movió de verdad, para retroceder la cita pasada con un intervalo exacto.
 */
function shopSlot(offsetDays, hour) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  let off = offsetDays;
  while (new Date(Date.UTC(y, m - 1, d + off, 12)).getUTCDay() === 0) off++;
  // Ciudad de México: UTC−6 todo el año (sin horario de verano desde 2022).
  return { off, iso: new Date(Date.UTC(y, m - 1, d + off, hour + 6)).toISOString() };
}

async function seedModules({ danielaId }) {
  console.log("\n== 032: siembra de Seguimiento y Citas (datos ficticios) ==");
  // Nadie contesta solo mientras se siembra (Ana ya habló con la IA).
  await owner.api("/api/agent/profile", { method: "PUT", body: body({ enabled: false }) });
  const add = await owner.api("/api/settings/team", { method: "POST", body: body(MARCO) });
  ok("alta de Marco Ríos", add.res.status === 201 || add.res.status === 409, short(add));
  const members = (await owner.api("/api/settings/team")).json?.members ?? [];
  const marcoId = members.find((m) => m.email === MARCO.email)?.userId;

  const assign = async (who, userId, label) => {
    const c = await conv(who);
    const r = await owner.api(`/api/conversations/${c?.id}/assign`, { method: "POST", body: body({ userId }) });
    ok(`${who.name} a nombre de ${label}`, r.res.ok, short(r));
  };
  await assign(C.jorge, marcoId, "Marco");
  for (const [who, minutesAgo, text, answer] of [
    [C.monica, 19 * 60, "¿El comedor Nogal viene con las 6 sillas?", "Sí, Mónica: las 6 sillas vienen incluidas."],
    [C.raul, 5 * 60, "Ya hice la transferencia del librero.", "¡Gracias, Raúl! Te aviso cuando salga la entrega."],
  ]) {
    const c = await inbound(who, text, { minutesAgo });
    await owner.api(`/api/conversations/${c?.id}`, { method: "PATCH", body: body({ aiEnabled: false }) });
    await assign(who, danielaId, "Daniela");
    const r = await seller.api(`/api/conversations/${c?.id}/messages`, { method: "POST", body: body({ text: answer }) });
    ok(`Daniela le responde a ${who.name}`, r.res.ok, short(r));
  }

  const types = (await owner.api("/api/calendar/types")).json?.types ?? [];
  const visita = types.find((t) => t.name === "Visita a la tienda");
  const med = types.find((t) => t.name === "Medición a domicilio");
  const book = async (who, type, slot, assignedUserId) => {
    const c = await conv(who);
    const r = await owner.api("/api/bookings", {
      method: "POST",
      body: body({ kind: "session", contactId: c?.contact?.id, conversationId: c?.id, startUtc: slot.iso, typeId: type?.id, assignedUserId, confirmOverlap: true }),
    });
    ok(`cita de ${who.name}`, r.res.status === 201, short(r));
    return r.json?.booking?.id ?? null;
  };
  await book(C.laura, visita, shopSlot(1, 11), danielaId);
  await book(C.carlos, med, shopSlot(1, 16), danielaId);
  await book(C.jorge, visita, shopSlot(1, 12), null);
  // Pasada sin resultado: la API no agenda en el pasado; se crea a futuro y
  // se retrocede con un intervalo relativo (`scheduled_at` no tiene zona).
  const past = shopSlot(1, 17);
  const sofiaId = await book(C.sofia, visita, past, danielaId);
  const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const moved = await sql`update vocero.booking set scheduled_at = scheduled_at - make_interval(days => ${past.off + 1}) where id = ${sofiaId}`;
    ok("la cita de Sofía queda en el pasado (ayer, sin resultado)", moved.count === 1);
  } finally {
    await sql.end();
  }

  // Las etapas AL FINAL: agendar adelanta el trato una etapa (023).
  const board = (await owner.api("/api/pipeline/board")).json;
  const stages = board?.stages ?? [];
  const stage = (name) => stages.find((s) => s.name === name);
  const leadOf = (who) => (board?.leads ?? []).find((l) => l.contact?.name === who.name);
  for (const [who, st, extra] of [
    [C.sofia, "Nuevo", {}],
    [C.jorge, "Nuevo", {}],
    [C.monica, "En conversación", {}],
    [C.carlos, "Interesado", { amountCents: 2450000, priority: "alta" }],
    [C.laura, "Interesado", { priority: "media" }],
    [C.ana, "Cliente", { amountCents: 1890000 }],
    [C.raul, "Cliente", {}],
  ]) {
    const l = leadOf(who);
    const s = stage(st);
    const r = l && s
      ? await owner.api(`/api/pipeline/leads/${l.id}`, { method: "PATCH", body: body({ stageId: s.id, ...extra }) })
      : null;
    ok(`${who.name} → ${st}`, !!r?.res.ok, r ? short(r) : `lead=${!!l} etapa=${!!s}`);
  }
}

async function moduleCaptures({ danielaId }) {
  console.log("\n== 032: capturas de Seguimiento y Citas (claro, 1366×768, como vendedora) ==");
  // «Todos», para que se vea la tarjeta de otro vendedor («Lo atiende Marco»).
  const { ctx, page } = await newPage({ storage: { [`vocero.pipelineFilter.${danielaId}`]: "all" } });
  await page.goto(`${BASE}/pipeline`, { waitUntil: "load", timeout: 90000 });
  ok("tablero con «Lo atiende Marco Ríos»", await until(async () => (await page.getByText("Lo atiende Marco Ríos").count()) === 1, 30000));
  ok("franja «lo que te toca» con accesos", await until(async () => (await page.locator('[data-testid^="pipeline-todo-"]').count()) >= 2, 20000));
  ok("filtro en «Todos»", (await page.getByRole("button", { name: /^Todos · / }).getAttribute("aria-pressed")) === "true");
  await sleep(1000);
  await save(page, "seguimiento.png", { x: 0, y: 0, ...VIEWPORT });

  await page.goto(`${BASE}/bookings`, { waitUntil: "load", timeout: 90000 });
  const todo = page.getByTestId("bookings-todo");
  ok("«¿Cómo le fue a Sofía Castro?»", await until(async () => ((await page.getByTestId("bookings-todo-outcome").textContent()) ?? "").includes("¿Cómo le fue a Sofía Castro?"), 30000));
  ok("«1 cita sin vendedor» con «Tomarla»", await until(async () => (await page.getByTestId("bookings-todo-take").count()) === 1, 20000));
  await page.getByTestId("cal-legend").waitFor();
  await sleep(1200);
  const main = await page.getByTestId("bookings-tz").boundingBox();
  await save(
    page,
    "citas.png",
    await clipOf(page, [page.getByTestId("bookings-tz"), todo, page.getByTestId("cal-legend")], {
      pad: 16,
      left: (main?.x ?? 16) - 16,
    })
  );
  await ctx.close();
}

/** 032 — Revisión a ojo de /pipeline y /bookings (no se publica). */
async function reviewModules() {
  if (!REVIEW) return;
  for (const [as, who] of [[seller, "vend"], [owner, "prop"]]) {
    for (const dark of [false, true]) {
      for (const [vp, vpName] of [[VIEWPORT, "1366"], [{ width: 390, height: 844 }, "390"]]) {
        const { ctx, page } = await newPage({ as, dark, viewport: vp });
        for (const [url, name] of [["/pipeline", "seguimiento"], ["/bookings", "citas"]]) {
          await page.goto(`${BASE}${url}`, { waitUntil: "load", timeout: 90000 });
          await sleep(3500);
          const file = `${who}-${name}-${dark ? "oscuro" : "claro"}-${vpName}.png`;
          await page.screenshot({ path: path.join(REVIEW, file), fullPage: true, animations: "disabled", caret: "hide" });
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          ok(`${file} (desborde horizontal ${overflow}px)`, overflow <= 0);
        }
        await ctx.close();
      }
    }
  }
}

/** Revisión a ojo (no se publica): /ayuda por tramos + tema oscuro. */
async function review() {
  if (!REVIEW) return;
  console.log(`\n== Revisión en ${REVIEW} ==`);
  mkdirSync(REVIEW, { recursive: true });
  {
    const { ctx, page } = await newPage();
    await page.goto(`${BASE}/ayuda`, { waitUntil: "load", timeout: 90000 });
    await page.locator("h1").waitFor();
    await sleep(1500);
    const scroller = page.locator("div.overflow-y-auto").filter({ has: page.locator("h1") }).first();
    const total = await scroller.evaluate((el) => el.scrollHeight);
    let i = 0;
    for (let y = 0; y < total; y += 700, i++) {
      await scroller.evaluate((el, top) => (el.scrollTop = top), y);
      await sleep(250);
      await save(page, `ayuda-${String(i).padStart(2, "0")}.png`, { x: 0, y: 0, ...VIEWPORT }, REVIEW);
    }
    console.log(`  /ayuda: ${total}px en ${i} tramos`);
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage({ dark: true });
    await openChat(page, C.laura);
    await save(page, "oscuro-ventana-abierta.png", { x: 0, y: 0, ...VIEWPORT }, REVIEW);
    await openChat(page, C.carlos);
    await page.getByTestId("template-sender").waitFor();
    await page.getByTestId("template-option").filter({ hasText: "cotización" }).click();
    await sleep(600);
    await save(page, "oscuro-ventana-cerrada.png", { x: 0, y: 0, ...VIEWPORT }, REVIEW);
    await openChat(page, C.ana);
    await page.locator("#composer-input").pressSequentially("C", { delay: 40 });
    await sleep(600);
    await save(page, "oscuro-ia.png", { x: 0, y: 0, ...VIEWPORT }, REVIEW);
    await page.locator("#composer-input").fill("");
    await page.goto(`${BASE}/ayuda`, { waitUntil: "load", timeout: 90000 });
    await page.locator("h1").waitFor();
    await sleep(1000);
    await save(page, "oscuro-ayuda.png", { x: 0, y: 0, ...VIEWPORT }, REVIEW);
    await ctx.close();
  }
}

async function main() {
  browser = await chromium.launch();
  try {
    const seeded = await seed();
    await captures();
    await seedModules(seeded);
    await moduleCaptures(seeded);
    await review();
    await reviewModules();
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
    console.log(failures ? `\n${failures} fallas` : "\nCapturas listas");
    process.exit(failures > 0 ? 1 : 0);
  });
