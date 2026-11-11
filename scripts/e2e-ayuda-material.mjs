/**
 * Self-test E2E — 034 Ayuda con material de capacitación. Guion humano:
 * tests/e2e/us-ayuda-material.md
 *
 *   a) sin material, /ayuda se ve como siempre (sin recuadro, sin «Con video»)
 *   b) el Propietario, en Ajustes › Material de capacitación, sube dos PDF,
 *      dos videos y la imagen de un tema; cambia el nombre de un botón, el
 *      orden y el tema de un video. La duración la lee el navegador (Edge:
 *      el Chromium de Playwright no trae H.264)
 *   c) la vendedora: GET /api/training sin rastro del almacenamiento; en
 *      /ayuda el recuadro «Capacitación del equipo», descarga del PDF
 *      (`Content-Disposition` correcto), «Con video» en el índice, «Imagen |
 *      Video · 0:01» en el tema (el video carga y avanza), la imagen propia
 *      en «Imagen», y el diálogo con anterior/siguiente y «En la guía»
 *   d) `Range: bytes=0-99` → 206; fuera de límites → 416; sin Range → 200
 *   e) un PNG renombrado a `.mp4` → 415 (la firma manda) y no queda nada
 *   f) la vendedora no sube, ni edita, ni ordena, ni borra (403) y la página
 *      de Ajustes no existe para ella (404)
 *   g) la purga de 30 días (+31 días) no toca el material
 *   h) al quitar todo, /ayuda vuelve a verse como hoy
 *
 * Capturas (`E2E_SHOTS=<carpeta>`): Ayuda con el recuadro, tema con «Video»,
 * diálogo, Ajustes con material y Ayuda a 390 px — antes de quitar todo.
 *
 * Uso (BD aislada; `CATALOG_STORAGE=local` explícito en server y guion):
 *   node --env-file=.env.e2e scripts/e2e-ayuda-material.mjs
 * Sale con código 1 si algún check falla.
 */
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const SHOTS = process.env.E2E_SHOTS || "";
const FIX = path.join(process.cwd(), "tests", "fixtures", "capacitacion");
const PDF = readFileSync(path.join(FIX, "documento.pdf"));
const MP4 = readFileSync(path.join(FIX, "video-1s.mp4"));
const PNG = readFileSync(path.join(FIX, "imagen-tema.png"));
const S = Math.random().toString(36).slice(2, 7);

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

/** Cliente con su cookie jar. JSON solo si el body es texto (multipart va solo). */
function client() {
  const jar = { cookie: "" };
  async function api(p, opts = {}) {
    const isText = typeof opts.body === "string";
    const res = await fetch(`${BASE}${p}`, {
      ...opts,
      headers: {
        ...(isText ? { "content-type": "application/json" } : {}),
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
    } catch {
      /* reintenta */
    }
    if (Date.now() - t0 > ms) return false;
    await sleep(250);
  }
};
const body = (o) => JSON.stringify(o);
const short = (r) => `${r.res.status} ${JSON.stringify(r.json)?.slice(0, 240)}`;

const owner = client();
const seller = client();
const OWNER_EMAIL = "e2e@vocero.test";
const OWNER_PASSWORD = "password-e2e-123";
const SELLER_EMAIL = `vend.material.${S}@vocero.test`;
const SELLER_PASSWORD = "password-vend-123";

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
async function launch() {
  // H.264: el Chromium de Playwright no lo decodifica; Edge sí.
  const channel = process.env.PW_CHANNEL || "msedge";
  try {
    return await chromium.launch({ channel });
  } catch (err) {
    console.log(`  (canal ${channel} no disponible: uso el Chromium de Playwright)`, String(err).slice(0, 80));
    return chromium.launch();
  }
}

async function newPage(actor, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  await ctx.route("**/api/events*", (route) => route.abort());
  await ctx.addCookies(toBrowserCookies(actor.jar));
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  return { ctx, page };
}

async function shot(page, name, opts = {}) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), ...opts });
  console.log(`  (captura ${name}.png)`);
}

async function list(c = owner) {
  return (await c.api("/api/training")).json?.assets ?? [];
}

function upload(c, fields, file) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, String(v));
  form.set("file", new Blob([file.data], { type: file.type }), file.name);
  return c.api("/api/training", { method: "POST", body: form });
}

/** Espera a que el `<input type=file>` y su botón estén hidratados. */
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

/** Lo que la Ayuda pinta del material (para comparar "como hoy"). */
async function ayudaBaseline(page) {
  await page.goto(`${BASE}/ayuda`, { waitUntil: "load", timeout: 90000 });
  await page.locator("h1").first().waitFor();
  return {
    box: await page.getByTestId("training-box").count(),
    badges: await page.getByTestId("topic-has-video").count(),
    media: await page.getByTestId("topic-media").count(),
    own: await page.getByTestId("topic-own-image").count(),
    examples: await page.locator('img[src^="/ayuda/"]').count(),
    articles: await page.locator("article").count(),
  };
}

// ── Setup ────────────────────────────────────────────────────────────────

async function setup() {
  console.log("== Setup ==");
  let su = await owner.api("/api/auth/sign-up/email", {
    method: "POST",
    body: body({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: "Operador E2E" }),
  });
  if (!su.res.ok) {
    su = await owner.api("/api/auth/sign-in/email", {
      method: "POST",
      body: body({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
    });
  }
  ok("owner registrado o con sesión", su.res.ok, short(su));
  const add = await owner.api("/api/settings/team", {
    method: "POST",
    body: body({ name: "Vendedora Material", email: SELLER_EMAIL, password: SELLER_PASSWORD }),
  });
  ok("alta de la vendedora", add.res.status === 201 || add.res.status === 409, short(add));
  const si = await seller.api("/api/auth/sign-in/email", {
    method: "POST",
    body: body({ email: SELLER_EMAIL, password: SELLER_PASSWORD }),
  });
  ok("la vendedora inicia sesión", si.res.ok, short(si));
  // Corridas previas: empezar sin material.
  for (const a of await list()) await owner.api(`/api/training/${a.id}`, { method: "DELETE" });
  ok("sin material al empezar", (await list()).length === 0);
}

// ── a) y h) La Ayuda como hoy ────────────────────────────────────────────

async function baselineChecks(label) {
  const { ctx, page } = await newPage(seller);
  const b = await ayudaBaseline(page);
  ok(`${label}: sin recuadro «Capacitación del equipo»`, b.box === 0, JSON.stringify(b));
  ok(`${label}: sin «Con video», sin «Imagen | Video», sin imagen propia`, b.badges === 0 && b.media === 0 && b.own === 0, JSON.stringify(b));
  ok(`${label}: las capturas de ejemplo de siempre`, b.examples > 0, JSON.stringify(b));
  ok(`${label}: sin el encabezado «¿Qué te está pasando?»`, (await page.getByRole("heading", { name: "¿Qué te está pasando?" }).count()) === 0);
  await ctx.close();
  return b;
}

// ── b) El Propietario sube en Ajustes ────────────────────────────────────

async function ownerUploads() {
  console.log("\n== b) Propietario: Ajustes › Material de capacitación ==");
  const { ctx, page } = await newPage(owner);
  await page.goto(`${BASE}/settings/capacitacion`, { waitUntil: "load", timeout: 90000 });
  await page.getByRole("heading", { name: "Material de capacitación", level: 1 }).waitFor();
  ok("la pestaña «Material de capacitación» está en Ajustes", (await page.getByRole("link", { name: "Material de capacitación" }).count()) === 1);
  ok("las tres secciones", (await page.getByRole("heading", { name: "Documentos para descargar" }).count()) === 1 && (await page.getByRole("heading", { name: "Videos", exact: true }).count()) === 1 && (await page.getByRole("heading", { name: "Imágenes de la Ayuda" }).count()) === 1);
  ok("estado vacío: «Todavía no hay documentos.» / «Todavía no hay videos.»", (await page.getByText("Todavía no hay documentos.").count()) === 1 && (await page.getByText("Todavía no hay videos.").count()) === 1);
  await waitHydrated(page, '[data-testid="upload-document"]');

  const pick = async (testId, file) => {
    await page.getByTestId(testId).setInputFiles({ name: file.name, mimeType: file.type, buffer: file.data });
  };
  const count = async (kind) => (await list()).filter((a) => a.kind === kind).length;

  await pick("upload-document", { name: `Presentacion-${S}.pdf`, type: "application/pdf", data: PDF });
  ok("sube el primer PDF", await until(async () => (await count("document")) === 1, 30000));
  await pick("upload-document", { name: `Hoja-de-bolsillo-${S}.pdf`, type: "application/pdf", data: PDF });
  ok("sube el segundo PDF", await until(async () => (await count("document")) === 2, 30000));
  await pick("upload-video", { name: `La-Bandeja-${S}.mp4`, type: "video/mp4", data: MP4 });
  ok("sube el primer video", await until(async () => (await count("video")) === 1, 30000));
  await pick("upload-video", { name: `Las-24-horas-${S}.mp4`, type: "video/mp4", data: MP4 });
  ok("sube el segundo video", await until(async () => (await count("video")) === 2, 30000));
  const imgInput = page.locator('[data-topic="plantillas"] input[type="file"]');
  await imgInput.setInputFiles({ name: `captura-${S}.png`, mimeType: "image/png", buffer: PNG });
  ok("sube la imagen del tema «plantillas»", await until(async () => (await count("help_image")) === 1, 30000));
  ok("y la tarjeta dice «Imagen de tu negocio» con «Cambiar» y «Usar la de ejemplo»", await until(async () => {
    const t = (await page.locator('[data-topic="plantillas"]').textContent()) ?? "";
    return t.includes("Imagen de tu negocio") && t.includes("Cambiar") && t.includes("Usar la de ejemplo");
  }, 15000));

  let assets = await list();
  const vids = assets.filter((a) => a.kind === "video");
  ok("la duración la leyó el navegador (1 s)", vids.every((v) => v.durationSeconds === 1), JSON.stringify(vids.map((v) => v.durationSeconds)));
  const img = assets.find((a) => a.kind === "help_image");
  ok("la imagen trae ancho y alto leídos al subir (64×40)", img?.width === 64 && img?.height === 40, JSON.stringify(img));
  ok("títulos por defecto: el nombre del archivo sin extensión", assets.some((a) => a.title === `Presentacion-${S}`), JSON.stringify(assets.map((a) => a.title)));

  // Cambiar el nombre del primer botón.
  const firstDoc = page.locator('[data-testid="training-documents"] li').first();
  const nameInput = firstDoc.getByLabel("Nombre del botón");
  await nameInput.fill("Presentación de prueba");
  await nameInput.press("Enter");
  ok("cambia el nombre del botón (PATCH)", await until(async () => (await list()).some((a) => a.kind === "document" && a.title === "Presentación de prueba"), 15000));

  // «Reemplazar»: archivo nuevo, mismo nombre de botón y mismo lugar.
  const oldFirst = (await list()).find((a) => a.kind === "document");
  await firstDoc.locator('input[type="file"]').setInputFiles({ name: `otra-version-${S}.pdf`, mimeType: "application/pdf", buffer: PDF });
  ok("«Reemplazar» cambia el archivo y conserva nombre y lugar", await until(async () => {
    const docs = (await list()).filter((a) => a.kind === "document");
    return docs.length === 2 && docs[0].id !== oldFirst.id && docs[0].title === "Presentación de prueba";
  }, 30000), JSON.stringify((await list()).filter((a) => a.kind === "document").map((a) => [a.id, a.title])));
  const oldGone = await owner.api(`/api/training/${oldFirst.id}/file`);
  ok("y el archivo reemplazado ya no se sirve (404)", oldGone.res.status === 404, String(oldGone.res.status));

  // Orden: el segundo PDF sube al primer lugar.
  const docsBefore = (await list()).filter((a) => a.kind === "document").map((a) => a.id);
  await page.getByRole("button", { name: `Subir de lugar: Hoja-de-bolsillo-${S}` }).click();
  ok("«Subir de lugar» cambia el orden de los PDF", await until(async () => {
    const now = (await list()).filter((a) => a.kind === "document").map((a) => a.id);
    return now[0] === docsBefore[1] && now[1] === docsBefore[0];
  }, 15000));
  // …y regresa (el primero es «Presentación de prueba»: el botón principal).
  await page.getByRole("button", { name: `Bajar de lugar: Hoja-de-bolsillo-${S}` }).click();
  ok("«Bajar de lugar» lo regresa", await until(async () => (await list()).filter((a) => a.kind === "document")[0]?.title === "Presentación de prueba", 15000));

  // Tema de los videos: el primero en «plantillas», el segundo sin tema.
  const firstVideo = page.locator('[data-testid="training-videos"] li').first();
  await firstVideo.locator("select").selectOption("plantillas");
  ok("asigna el tema del primer video", await until(async () => (await list()).find((a) => a.kind === "video")?.topicId === "plantillas", 15000));
  await firstVideo.getByLabel("Título").fill("Las 24 horas y las plantillas");
  await firstVideo.getByLabel("Título").press("Enter");
  ok("cambia el título del video", await until(async () => (await list()).find((a) => a.kind === "video")?.title === "Las 24 horas y las plantillas", 15000));
  await page.getByText("Guardado.").first().waitFor({ timeout: 15000 }).catch(() => {});
  assets = await list();
  await ctx.close();
  return assets;
}

// ── c) La vendedora en la Ayuda ──────────────────────────────────────────

async function sellerChecks(assets) {
  console.log("\n== c) Vendedora: la Ayuda con el material ==");
  const sl = await seller.api("/api/training");
  ok("GET /api/training (vendedora) → 200", sl.res.status === 200, short(sl));
  const raw = JSON.stringify(sl.json);
  ok("el DTO no trae storage_key, proveedor ni ruta", !/storage|azure|local|capacitacion\//i.test(raw), raw.slice(0, 200));
  ok("trae id, kind, title, topicId, position, sizeBytes, durationSeconds, mimeType", (sl.json?.assets ?? []).every((a) => ["id", "kind", "title", "topicId", "position", "sizeBytes", "durationSeconds", "mimeType"].every((k) => k in a)));

  const docs = assets.filter((a) => a.kind === "document");
  const vids = assets.filter((a) => a.kind === "video");
  const { ctx, page } = await newPage(seller);
  await page.goto(`${BASE}/ayuda`, { waitUntil: "load", timeout: 90000 });
  const box = page.getByTestId("training-box");
  await box.waitFor();
  const boxText = (await box.textContent()) ?? "";
  ok("recuadro «Capacitación del equipo»", boxText.includes("Capacitación del equipo"), boxText.slice(0, 120));
  ok("con «Los documentos para descargar y los 2 videos completos, en orden.»", boxText.includes("Los documentos para descargar y los 2 videos completos, en orden."), boxText.slice(0, 200));
  const docLinks = page.getByTestId("training-doc");
  ok("dos botones de PDF, en orden, con «(PDF · 0.1 MB)»", (await docLinks.count()) === 2 && ((await docLinks.first().textContent()) ?? "").includes("Presentación de prueba (PDF · 0.1 MB)"), await docLinks.first().textContent().catch(() => ""));
  const chips = page.getByTestId("training-video-chip");
  ok("los videos en orden: «1 · Las 24 horas y las plantillas 0:01»", (await chips.count()) === 2 && /1 · Las 24 horas y las plantillas\s*0:01/.test((await chips.first().textContent()) ?? ""), await chips.first().textContent().catch(() => ""));
  await shot(page, "ayuda-recuadro", { fullPage: false });

  // Descarga del PDF.
  const dlP = page.waitForEvent("download", { timeout: 30000 }).catch(() => null);
  await docLinks.first().click();
  const dl = await dlP;
  ok("clic en el PDF → descarga «Presentación de prueba.pdf»", dl?.suggestedFilename() === "Presentación de prueba.pdf", dl?.suggestedFilename());
  const pdfRes = await seller.api(`/api/training/${docs[0].id}/file`);
  const cd = pdfRes.res.headers.get("content-disposition") ?? "";
  ok("Content-Disposition: attachment con nombre ASCII y UTF-8", /^attachment; filename="Presentacion de prueba\.pdf"; filename\*=UTF-8''Presentaci%C3%B3n%20de%20prueba\.pdf$/.test(cd), cd);
  ok("PDF con Cache-Control private y nosniff", (pdfRes.res.headers.get("cache-control") ?? "").startsWith("private") && pdfRes.res.headers.get("x-content-type-options") === "nosniff");
  ok("los bytes son el PDF subido", Buffer.from(await pdfRes.res.arrayBuffer()).equals(PDF));

  // Índice: «Con video» solo en el tema con video.
  const badges = page.getByTestId("topic-has-video");
  ok("«Con video» en el índice, solo en «plantillas»", (await badges.count()) === 1 && (await page.locator('a[href="#plantillas"]').getByTestId("topic-has-video").count()) === 1);

  // Tema con video: «Imagen | Video · 0:01».
  const media = page.locator('[data-testid="topic-media"][data-topic="plantillas"]');
  await media.scrollIntoViewIfNeeded();
  const tabs = media.getByRole("tab");
  ok("el tema trae «Imagen | Video · 0:01»", (await tabs.count()) === 2 && (await tabs.nth(0).textContent()) === "Imagen" && ((await tabs.nth(1).textContent()) ?? "").includes("Video · 0:01"), JSON.stringify(await tabs.allTextContents()));
  ok("«Video» activo de entrada", (await tabs.nth(1).getAttribute("aria-selected")) === "true");
  const topicVideo = media.getByTestId("topic-video");
  ok("el <video> apunta a /api/training/<id>/file", ((await topicVideo.getAttribute("src")) ?? "") === `/api/training/${vids[0].id}/file`);
  const played = await until(async () =>
    topicVideo.evaluate(async (v) => {
      v.muted = true;
      if (v.paused && !v.ended) await v.play().catch(() => {});
      return v.readyState >= 1 && v.duration > 0 && (v.currentTime > 0 || v.ended);
    }), 30000);
  ok("el video se reproduce ahí mismo (avanza)", played, await topicVideo.evaluate((v) => JSON.stringify({ rs: v.readyState, d: v.duration, t: v.currentTime, err: v.error?.code ?? null })).catch(() => ""));
  await topicVideo.evaluate((v) => {
    v.pause();
    v.currentTime = 0;
  }).catch(() => {});
  await media.scrollIntoViewIfNeeded();
  await shot(page, "tema-video-activo", { fullPage: false });
  await tabs.nth(0).click();
  ok("«Imagen» muestra la imagen del negocio (reemplaza las de ejemplo)", await until(async () => {
    const own = media.getByTestId("topic-own-image");
    return (await own.isVisible()) && (await own.evaluate((i) => i.complete && i.naturalWidth === 64));
  }, 15000));
  ok("…y no las capturas de ejemplo del tema", (await page.locator("#plantillas img[src^='/ayuda/']").count()) === 0);
  ok("un tema sin video se queda igual (sin pestañas, su captura de ejemplo)", (await page.locator("#respuestas-rapidas [role='tablist']").count()) === 0 && (await page.locator("#respuestas-rapidas img[src^='/ayuda/']").count()) >= 1);

  // Diálogo.
  await page.evaluate(() => window.scrollTo(0, 0));
  await chips.first().click();
  const dialog = page.getByTestId("training-video-dialog");
  await dialog.waitFor();
  let dText = (await dialog.textContent()) ?? "";
  ok("el diálogo: «Video 1 de 2 · 0:01» y el título", dText.includes("Video 1 de 2 · 0:01") && dText.includes("Las 24 horas y las plantillas"), dText.slice(0, 160));
  ok("con «En la guía: «Ya no puedo escribirle al cliente»»", (await dialog.getByRole("link", { name: /En la guía: «Ya no puedo escribirle al cliente»/ }).count()) === 1);
  ok("sin «anterior» en el primero; «2 · … ›» como siguiente", (await dialog.getByRole("button", { name: /^‹/ }).count()) === 0 && (await dialog.getByRole("button", { name: /^2 · .+ ›$/ }).count()) === 1);
  const dVideo = dialog.locator("video");
  ok("el video del diálogo carga (metadata)", await until(async () => dVideo.evaluate((v) => v.readyState >= 1 && v.duration > 0), 30000));
  await dVideo.evaluate((v) => v.pause()).catch(() => {});
  const ov = await page.getByTestId("training-video-overlay").evaluate((el) => {
    const r = el.getBoundingClientRect();
    let p = el.parentElement;
    const cb = [];
    while (p) {
      const cs = getComputedStyle(p);
      if (cs.transform !== "none" || cs.filter !== "none" || cs.contain !== "none" || cs.containerType !== "normal") cb.push(p.tagName + "." + p.className.slice(0, 40));
      p = p.parentElement;
    }
    return { top: r.top, left: r.left, h: r.height, w: r.width, vh: window.innerHeight, vw: window.innerWidth, sy: window.scrollY, html: document.documentElement.scrollTop, body: document.body.scrollTop, vv: window.visualViewport?.offsetTop ?? null, cb };
  });
  ok("el velo del diálogo cubre toda la ventana", ov.top === 0 && ov.left === 0 && ov.h === ov.vh && ov.w === ov.vw, JSON.stringify(ov));
  // Diagnóstico (no es check): un `fixed inset-0` DENTRO del recuadro, como
  // estaba antes del portal; qué ancestro le cambia el bloque contenedor.
  const probe = await page.getByTestId("training-box").evaluate((box) => {
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;inset:0;pointer-events:none";
    box.appendChild(d);
    const r = d.getBoundingClientRect();
    const cb = [];
    for (let p = d.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      const why = [
        cs.transform !== "none" && `transform:${cs.transform}`,
        cs.filter !== "none" && `filter:${cs.filter}`,
        cs.backdropFilter && cs.backdropFilter !== "none" && `backdrop:${cs.backdropFilter}`,
        cs.contain !== "none" && `contain:${cs.contain}`,
        cs.containerType && cs.containerType !== "normal" && `container:${cs.containerType}`,
        cs.willChange !== "auto" && `will-change:${cs.willChange}`,
        cs.perspective !== "none" && `perspective:${cs.perspective}`,
      ].filter(Boolean);
      if (why.length) cb.push(`${p.tagName}.${String(p.className).slice(0, 60)} [${why.join(", ")}]`);
    }
    d.remove();
    return { top: r.top, h: r.height, cb };
  });
  console.log(`  (info) fixed dentro del recuadro: ${JSON.stringify(probe)}`);
  await shot(page, "dialogo-video", { fullPage: false });
  await dialog.getByRole("button", { name: /^2 · .+ ›$/ }).click();
  dText = (await dialog.textContent()) ?? "";
  ok("«siguiente» → «Video 2 de 2»; sin tema no hay «En la guía»", dText.includes("Video 2 de 2") && (await dialog.getByRole("link", { name: /En la guía/ }).count()) === 0, dText.slice(0, 160));
  ok("y el «anterior» «‹ 1 · Las 24 horas y las plantillas»", (await dialog.getByRole("button", { name: "‹ 1 · Las 24 horas y las plantillas" }).count()) === 1);
  await dialog.getByRole("button", { name: "‹ 1 · Las 24 horas y las plantillas" }).click();
  await dialog.getByRole("link", { name: /En la guía/ }).click();
  ok("«En la guía» cierra el diálogo y lleva al tema", await until(async () => (await dialog.count()) === 0 && (await page.evaluate(() => location.hash)) === "#plantillas", 10000));
  await chips.nth(1).click();
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  ok("Esc cierra el diálogo", await until(async () => (await dialog.count()) === 0, 5000));
  ok("y el foco vuelve al botón del video", await until(async () => chips.nth(1).evaluate((el) => el === document.activeElement), 3000));
  await ctx.close();

  // 390 px.
  const m = await newPage(seller, { width: 390, height: 844 });
  await m.page.goto(`${BASE}/ayuda`, { waitUntil: "load", timeout: 90000 });
  await m.page.getByTestId("training-box").waitFor();
  const w = await m.page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth }));
  ok("/ayuda a 390 px sin scroll horizontal", w.doc <= w.vw, JSON.stringify(w));
  await shot(m.page, "ayuda-390", { fullPage: false });
  await m.ctx.close();
}

// ── d) Range ─────────────────────────────────────────────────────────────

async function rangeChecks(video) {
  console.log("\n== d) Range ==");
  const url = `/api/training/${video.id}/file`;
  const r206 = await seller.api(url, { headers: { range: "bytes=0-99" } });
  const b206 = Buffer.from(await r206.res.arrayBuffer());
  ok("Range bytes=0-99 → 206", r206.res.status === 206, String(r206.res.status));
  ok("Content-Range bytes 0-99/<tamaño> y Accept-Ranges", r206.res.headers.get("content-range") === `bytes 0-99/${MP4.length}` && r206.res.headers.get("accept-ranges") === "bytes", `${r206.res.headers.get("content-range")} ${r206.res.headers.get("accept-ranges")}`);
  ok("100 bytes, los primeros del MP4, tipo video/mp4 inline", b206.length === 100 && b206.equals(MP4.subarray(0, 100)) && r206.res.headers.get("content-type") === "video/mp4" && r206.res.headers.get("content-disposition") === "inline");
  const rMid = await seller.api(url, { headers: { range: `bytes=1000-` } });
  const bMid = Buffer.from(await rMid.res.arrayBuffer());
  ok("bytes=1000- → 206 hasta el final", rMid.res.status === 206 && bMid.equals(MP4.subarray(1000)), `${rMid.res.status} ${rMid.res.headers.get("content-range")}`);
  const r416 = await seller.api(url, { headers: { range: `bytes=${MP4.length + 10}-` } });
  ok("rango fuera de límites → 416 con bytes */<tamaño>", r416.res.status === 416 && r416.res.headers.get("content-range") === `bytes */${MP4.length}`, `${r416.res.status} ${r416.res.headers.get("content-range")}`);
  const r200 = await seller.api(url);
  const b200 = Buffer.from(await r200.res.arrayBuffer());
  ok("sin Range → 200 completo con Accept-Ranges", r200.res.status === 200 && r200.res.headers.get("accept-ranges") === "bytes" && b200.equals(MP4), `${r200.res.status} ${b200.length}`);
  ok("Cache-Control private", (r200.res.headers.get("cache-control") ?? "").startsWith("private"));
  const anon = await fetch(`${BASE}${url}`, { redirect: "manual" });
  ok("sin sesión → 401 (no hay enlaces públicos)", anon.status === 401, String(anon.status));

  // Un video de 12 MB por el handler real (más que los 10 MB que el
  // middleware de Next clona) y un rango a media pista leído del disco.
  const BIG = 12 * 1024 * 1024;
  const big = Buffer.alloc(BIG);
  Buffer.from([0, 0, 0, 0x20, ...Buffer.from("ftypisom")]).copy(big, 0);
  for (let i = 12; i < BIG; i += 4096) big[i] = (i / 4096) % 251;
  const up = await upload(owner, { kind: "video", title: `Grande ${S}` }, { name: "grande.mp4", type: "video/mp4", data: big });
  ok("un MP4 de 12 MB sube por POST /api/training (201, tamaño exacto)", up.res.status === 201 && up.json?.asset?.sizeBytes === BIG, short(up));
  if (up.json?.asset?.id) {
    const start = 11_000_000;
    const rb = await seller.api(`/api/training/${up.json.asset.id}/file`, { headers: { range: `bytes=${start}-` } });
    const bb = Buffer.from(await rb.res.arrayBuffer());
    ok(
      "Range a media pista del de 12 MB → 206 con los bytes exactos",
      rb.res.status === 206 && rb.res.headers.get("content-range") === `bytes ${start}-${BIG - 1}/${BIG}` && bb.equals(big.subarray(start)),
      `${rb.res.status} ${rb.res.headers.get("content-range")} ${bb.length}`
    );
    const r0 = await seller.api(`/api/training/${up.json.asset.id}/file`, { headers: { range: "bytes=0-" } });
    ok("bytes=0- del de 12 MB → 206 topado a 8 MiB", r0.res.status === 206 && r0.res.headers.get("content-range") === `bytes 0-${8 * 1024 * 1024 - 1}/${BIG}`, `${r0.res.status} ${r0.res.headers.get("content-range")}`);
    await r0.res.arrayBuffer().catch(() => null);
    const del = await owner.api(`/api/training/${up.json.asset.id}`, { method: "DELETE" });
    ok("y se quita", del.res.ok, short(del));
  }
}

// ── e) firma ─────────────────────────────────────────────────────────────

async function signatureChecks() {
  console.log("\n== e) Extensión engañosa ==");
  const before = (await list()).length;
  const fake = await upload(owner, { kind: "video" }, { name: "falso.mp4", type: "video/mp4", data: PNG });
  ok("un PNG renombrado a .mp4 → 415 unsupported_type «no es un video MP4»", fake.res.status === 415 && fake.json?.error?.code === "unsupported_type" && /no es un video MP4/.test(fake.json?.error?.message ?? ""), short(fake));
  const fakePdf = await upload(owner, { kind: "document" }, { name: "falso.pdf", type: "application/pdf", data: MP4 });
  ok("un MP4 renombrado a .pdf → 415", fakePdf.res.status === 415, short(fakePdf));
  const badTopic = await upload(owner, { kind: "help_image", topicId: "inventado" }, { name: "x.png", type: "image/png", data: PNG });
  ok("tema que no existe en la Ayuda → 422", badTopic.res.status === 422, short(badTopic));
  ok("no quedó nada nuevo", (await list()).length === before);
}

// ── f) la vendedora no administra ────────────────────────────────────────

async function sellerForbiddenChecks(assets) {
  console.log("\n== f) La vendedora no administra ==");
  const id = assets[0].id;
  const up = await upload(seller, { kind: "document" }, { name: "x.pdf", type: "application/pdf", data: PDF });
  ok("POST /api/training (vendedora) → 403", up.res.status === 403, short(up));
  const pa = await seller.api(`/api/training/${id}`, { method: "PATCH", body: body({ title: "hackeo" }) });
  ok("PATCH (vendedora) → 403", pa.res.status === 403, short(pa));
  const de = await seller.api(`/api/training/${id}`, { method: "DELETE" });
  ok("DELETE (vendedora) → 403", de.res.status === 403, short(de));
  const re = await seller.api("/api/training/reorder", { method: "POST", body: body({ kind: "video", ids: assets.filter((a) => a.kind === "video").map((a) => a.id) }) });
  ok("reorder (vendedora) → 403", re.res.status === 403, short(re));
  const page = await seller.api("/settings/capacitacion");
  ok("/settings/capacitacion (vendedora) → 404", page.res.status === 404, String(page.res.status));
  ok("y nada cambió", (await list()).length === assets.length);
}

// ── g) purga ─────────────────────────────────────────────────────────────

async function purgeChecks(assets) {
  console.log("\n== g) La purga de 30 días no toca el material ==");
  const p = await owner.api("/api/dev/media/purge", { method: "POST", body: body({ advanceDays: 400 }) });
  ok("purga forzada (+400 días)", p.res.ok, short(p));
  let all = true;
  for (const a of assets) {
    const r = await seller.api(`/api/training/${a.id}/file`, { headers: { range: "bytes=0-0" } });
    if (r.res.status !== 206) all = false;
  }
  ok("todo el material se sigue sirviendo", all);
}

// ── h) quitar todo ───────────────────────────────────────────────────────

async function removeAll(assets) {
  console.log("\n== h) Quitar todo (desde Ajustes) ==");
  const { ctx, page } = await newPage(owner);
  await page.goto(`${BASE}/settings/capacitacion`, { waitUntil: "load", timeout: 90000 });
  await page.getByRole("heading", { name: "Material de capacitación", level: 1 }).waitFor();
  await waitHydrated(page, '[data-testid="upload-document"]');
  // Las miniaturas cargadas antes de la captura (el scroll de Ajustes es interno:
  // la ventana alta muestra las tres secciones).
  await until(async () => page.locator('[data-testid="training-images"] img').evaluateAll((imgs) => imgs.every((i) => i.complete && i.naturalWidth > 0)), 15000);
  await page.setViewportSize({ width: 1366, height: 1500 });
  await sleep(300);
  await shot(page, "ajustes-material", { fullPage: false });
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.locator('[data-topic="plantillas"]').getByRole("button", { name: "Usar la de ejemplo" }).click();
  ok("«Usar la de ejemplo» quita la imagen propia", await until(async () => (await list()).every((a) => a.kind !== "help_image"), 15000));
  for (let i = 0; i < 4; i++) {
    const btn = page.getByRole("button", { name: "Quitar", exact: true }).first();
    if ((await btn.count()) === 0) break;
    const n = (await list()).length;
    await btn.click();
    await until(async () => (await list()).length === n - 1, 15000);
  }
  ok("«Quitar» deja Ajustes sin material", (await list()).length === 0);
  ok("y vuelven los estados vacíos", await until(async () => (await page.getByText("Todavía no hay documentos.").count()) === 1 && (await page.getByText("Todavía no hay videos.").count()) === 1, 10000));
  await ctx.close();
  const gone = await seller.api(`/api/training/${assets[0].id}/file`);
  ok("un archivo quitado ya no se sirve (404)", gone.res.status === 404, String(gone.res.status));
}

async function main() {
  browser = await launch();
  try {
    await setup();
    console.log("\n== a) Sin material: la Ayuda como hoy ==");
    const before = await baselineChecks("antes");
    const assets = await ownerUploads();
    await sellerChecks(assets);
    await rangeChecks(assets.find((a) => a.kind === "video"));
    await signatureChecks();
    await sellerForbiddenChecks(assets);
    await purgeChecks(assets);
    await removeAll(assets);
    console.log("\n== h) Sin material otra vez ==");
    const after = await baselineChecks("después");
    ok("idéntica a como estaba (mismos artículos y capturas)", JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
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
