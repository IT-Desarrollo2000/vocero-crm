/**
 * Self-test E2E — 019 Catálogo de productos (fase A: almacenamiento local).
 * Guion humano: tests/e2e/us-catalogo.md
 *
 *   a) owner: categoría + producto + variantes; códigos únicos entre producto
 *      y variante (409); PNG/PDF por firma; `.exe` disfrazado → 415 sin rastro
 *   b) vendedor: GET 200, toda escritura 403
 *   c) atajos: "Crear atajos" (POST /api/quick-replies con productId+attach);
 *      GET /api/quick-replies trae los archivos filtrados
 *   d) envío por API (WhatsApp): texto + 2 fotos en orden, `media_asset_id`
 *      con procedencia; ventana cerrada → 409 sin salir nada; ningún archivo
 *      válido → 404; `is_test` → nada sale ni toca `product_file_upload`
 *   d2) reutilización (AC-4): reenviar → 0 subidas a /media; id invalidado
 *      en el mock → exactamente 1 re-subida; Messenger (si CHANNELS lo
 *      incluye): 1ª vez 1 subida a message_attachments, 2ª vez 0
 *   e) Instagram: el `.txt` → skipped sin tocar Meta, el PDF sale (AC-5)
 *   f) UI (Playwright como vendedor): `/FOT` + Enter escenifica chips, quitar
 *      uno, enviar → outbox; botón Catálogo con variante + "Insertar
 *      detalles" (AC-1…AC-3)
 *   f2) UI como Propietario (15-oct): WebP y PNG > 5 MB generados en el
 *      navegador → JPEG ≤ 5 MB al subir y salen por WhatsApp; `.heic`
 *      ilegible → aviso + 415 sin colgarse (FR-950..953)
 *   g) purga de 30 días: el catálogo sigue sirviendo (AC-8)
 *   h) borrar producto: archivos 404 y fuera del disco; atajo sin producto;
 *      el hilo conserva su copia (AC-10)
 *
 * Uso (BD aislada, ver memoria e2e-bd-aislada):
 *   node --env-file=.env.e2e scripts/e2e-catalogo.mjs
 * Requiere WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL → wa-mock y
 * CHANNELS con instagram para la sección e). DATABASE_URL para d) is_test.
 *
 * Sale con código 1 si algún check falla.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import postgres from "postgres";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const MEDIA_DIR = process.env.MEDIA_DIR ?? "./.dev-media";
const S = Math.random().toString(36).slice(2, 7);
const CODE = `T${S}`.toUpperCase();
const PN = "PN-E2E-CAT";

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
const phone = () => `52155${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;

/* ---------- archivos reales mínimos (la política decide por la firma) ---------- */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);
const png = (n) => Buffer.concat([PNG, Buffer.from(`\n${n}`)]); // bytes distintos por foto
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
);
const TXT = Buffer.from("Ficha resumida\nAutonomía: 400 km\n");
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200, 0x90)]);

const owner = client();
const seller = client();
const OWNER_EMAIL = "e2e@vocero.test";
const OWNER_PASSWORD = "password-e2e-123";
const SELLER_EMAIL = `vend.cat.${S}@vocero.test`;
const SELLER_PASSWORD = "password-vend-123";
const SELLER_NAME = `Vendedora Cat ${S}`;
const COMPOSER = "Escribe una respuesta…";

function upload(c, productId, name, data, mime, variantId) {
  const fd = new FormData();
  fd.set("file", new Blob([data], { type: mime }), name);
  if (variantId) fd.set("variantId", variantId);
  return c.api(`/api/catalog/products/${productId}/files`, { method: "POST", body: fd });
}
/**
 * Outbox desde la última marca. No se borra el del mock: `DELETE` también
 * vacía `uploads` y los ids invalidados que d2) usa (el contador de wamids
 * ya no se reinicia desde 019 fase B).
 */
let outboxBase = 0;
let uploadsBase = 0;
async function rawMock() {
  return (await owner.api("/api/dev/wa-mock/outbox")).json ?? {};
}
async function rawOutbox() {
  return (await rawMock()).outbox ?? [];
}
async function markOutbox() {
  const m = await rawMock();
  outboxBase = (m.outbox ?? []).length;
  uploadsBase = (m.uploads ?? []).length;
}
async function outbox() {
  return (await rawOutbox()).slice(outboxBase);
}
/** Subidas de bytes a Meta (`/media`, `message_attachments`) desde la marca. */
async function uploads(channel) {
  const list = ((await rawMock()).uploads ?? []).slice(uploadsBase);
  return channel ? list.filter((u) => u.channel === channel) : list;
}
async function findByName(c, name) {
  const list = (await c.api("/api/conversations")).json?.conversations ?? [];
  return list.find((cv) => cv.contact?.name === name) ?? null;
}
async function messagesOf(c, convId) {
  return (await c.api(`/api/conversations/${convId}/messages`)).json?.messages ?? [];
}
function catalogFilesOnDisk() {
  const dir = path.join(MEDIA_DIR);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const org of readdirSync(dir)) {
    const cat = path.join(dir, org, "catalog");
    if (existsSync(cat)) out.push(...readdirSync(cat));
  }
  return out;
}
/* ---------- 019 C: proveedor del catálogo (local | azure-blob) ---------- */
const PROVIDER = process.env.CATALOG_STORAGE === "azure-blob" ? "azure-blob" : "local";

/** Cadena de conexión → cuenta, clave y endpoint (formas estándar y Azurite). */
function azureConfig() {
  const parts = Object.fromEntries(
    (process.env.AZURE_STORAGE_CONNECTION_STRING ?? "")
      .split(";")
      .filter(Boolean)
      .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)])
  );
  const endpoint =
    parts.BlobEndpoint ??
    `${parts.DefaultEndpointsProtocol ?? "https"}://${parts.AccountName}.blob.${parts.EndpointSuffix ?? "core.windows.net"}`;
  return {
    account: parts.AccountName,
    key: Buffer.from(parts.AccountKey ?? "", "base64"),
    endpoint: endpoint.replace(/\/+$/, ""),
    container: process.env.AZURE_STORAGE_CONTAINER,
  };
}

/**
 * Petición SharedKey mínima e independiente del adaptador (para observar el
 * contenedor desde fuera): recurso canónico = `/{cuenta}` + path de la URL.
 */
async function azureRequest(method, query) {
  const { createHmac } = await import("node:crypto");
  const cfg = azureConfig();
  const url = new URL(`${cfg.endpoint}/${cfg.container}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const date = new Date().toUTCString();
  const canonQuery = Object.keys(query)
    .sort()
    .map((k) => `\n${k.toLowerCase()}:${query[k]}`)
    .join("");
  const toSign = `${method}\n\n\n\n\n\n\n\n\n\n\n\nx-ms-date:${date}\nx-ms-version:2021-08-06\n/${cfg.account}${url.pathname}${canonQuery}`;
  const sig = createHmac("sha256", cfg.key).update(toSign, "utf8").digest("base64");
  return fetch(url, {
    method,
    headers: { "x-ms-date": date, "x-ms-version": "2021-08-06", authorization: `SharedKey ${cfg.account}:${sig}` },
  });
}

async function azureBlobIds() {
  const res = await azureRequest("GET", { comp: "list", restype: "container" });
  const xml = await res.text();
  return [...xml.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1].split("/").pop());
}

/** Ids de archivo guardados en el proveedor activo. */
async function storedIds() {
  return PROVIDER === "azure-blob" ? azureBlobIds() : catalogFilesOnDisk();
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

/** Conversación de WhatsApp nueva con la ventana abierta y sin agente. */
async function openWaConversation(name, extra = {}) {
  const inb = await owner.api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({ phoneNumberId: PN, from: phone(), name, text: "hola, ¿tienen el T03?", waMessageId: `wamid.e2e.cat.${S}.${name.length}.${Date.now()}`, ...extra }),
  });
  ok(`inbound "${name}" entregado`, inb.res.ok, short(inb));
  await until(async () => !!(await findByName(owner, name)));
  const conv = await findByName(owner, name);
  await owner.api(`/api/conversations/${conv?.id}`, { method: "PATCH", body: body({ aiEnabled: false }) });
  return conv;
}

const ctx = {};

async function setup() {
  console.log("== Setup ==");
  let su = await owner.api("/api/auth/sign-up/email", {
    method: "POST",
    body: body({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: "Operador E2E" }),
  });
  if (!su.res.ok) su = await owner.api("/api/auth/sign-in/email", { method: "POST", body: body({ email: OWNER_EMAIL, password: OWNER_PASSWORD }) });
  ok("owner con sesión", su.res.ok, short(su));
  const conn = await owner.api("/api/settings/whatsapp", {
    method: "PUT",
    body: body({ wabaId: "WABA-E2E-CAT", phoneNumberId: PN, token: "tok-e2e-cat" }),
  });
  ok("owner conecta WhatsApp (wa-mock)", conn.res.ok, short(conn));
  const add = await owner.api("/api/settings/team", {
    method: "POST",
    body: body({ name: SELLER_NAME, email: SELLER_EMAIL, password: SELLER_PASSWORD }),
  });
  ok("alta del vendedor → 201", add.res.status === 201, short(add));
  const si = await seller.api("/api/auth/sign-in/email", { method: "POST", body: body({ email: SELLER_EMAIL, password: SELLER_PASSWORD }) });
  ok("el vendedor inicia sesión", si.res.ok, short(si));
}

async function catalogCrud() {
  console.log("\n== a) Catálogo como Propietario ==");
  let r = await owner.api("/api/catalog/categories", { method: "POST", body: body({ name: `SUV ${S}` }) });
  ok("crear categoría → 201", r.res.status === 201 && r.json?.category?.id, short(r));
  ctx.category = r.json?.category;
  r = await owner.api("/api/catalog/products", {
    method: "POST",
    body: body({
      name: `Tiguan ${S}`,
      code: CODE,
      categoryId: ctx.category?.id,
      price: "desde $589,900",
      description: "SUV eléctrica",
      attributes: [{ label: "Motor", value: "eléctrico" }],
    }),
  });
  ok("crear producto → 201", r.res.status === 201 && r.json?.product?.code === CODE, short(r));
  ctx.product = r.json?.product;
  const pid = ctx.product?.id;
  r = await owner.api(`/api/catalog/products/${pid}/variants`, {
    method: "POST",
    body: body({ name: "400 km", code: `${CODE}-400`, price: "$629,900", attributes: [{ label: "Autonomía", value: "400 km" }] }),
  });
  ok("variante 400 km → 201", r.res.status === 201, short(r));
  ctx.v400 = r.json?.variant;
  r = await owner.api(`/api/catalog/products/${pid}/variants`, {
    method: "POST",
    body: body({ name: "300 km", code: `${CODE}-300`, attributes: [{ label: "Autonomía", value: "300 km" }] }),
  });
  ok("variante 300 km → 201", r.res.status === 201, short(r));
  ctx.v300 = r.json?.variant;
  r = await owner.api(`/api/catalog/products/${pid}/variants`, {
    method: "POST",
    body: body({ name: "dup", code: CODE.toLowerCase() }),
  });
  ok("código de variante = código de producto (otra capitalización) → 409 duplicate_code", r.res.status === 409 && r.json?.error?.code === "duplicate_code", short(r));

  r = await upload(owner, pid, "frente.png", png(1), "image/png");
  ok("foto 1 (PNG) → 201 image", r.res.status === 201 && r.json?.file?.kind === "image", short(r));
  ctx.img1 = r.json?.file;
  r = await upload(owner, pid, "lateral.png", png(2), "image/png");
  ok("foto 2 (PNG) → 201", r.res.status === 201, short(r));
  ctx.img2 = r.json?.file;
  r = await upload(owner, pid, "ficha-400.pdf", PDF, "application/pdf", ctx.v400?.id);
  ok("ficha PDF de la variante 400 → 201 document", r.res.status === 201 && r.json?.file?.variantId === ctx.v400?.id, short(r));
  ctx.pdf400 = r.json?.file;
  r = await upload(owner, pid, "ficha-300.pdf", Buffer.concat([PDF, Buffer.from("%300")]), "application/pdf", ctx.v300?.id);
  ok("ficha PDF de la variante 300 → 201", r.res.status === 201, short(r));
  ctx.pdf300 = r.json?.file;
  r = await upload(owner, pid, "resumen.txt", TXT, "text/plain");
  ok("resumen .txt compartido → 201 document", r.res.status === 201 && r.json?.file?.kind === "document", short(r));
  ctx.txt = r.json?.file;

  const before = (await storedIds()).length;
  r = await upload(owner, pid, "virus.pdf", EXE, "application/pdf");
  ok("`.exe` renombrado a .pdf → 415", r.res.status === 415, short(r));
  const cat = (await owner.api("/api/catalog")).json;
  const prod = cat?.products?.find((p) => p.id === pid);
  ok("…y no quedó en BD", prod?.files?.length === 5, `files=${prod?.files?.length}`);
  const afterExe = await storedIds();
  ok(`…ni en el storage (${PROVIDER})`, afterExe.length === before, `${before} → ${afterExe.length}`);
  ok(`GET /api/catalog: provider ${PROVIDER}, 2 variantes, categoría`, cat?.storage?.provider === PROVIDER && prod?.variants?.length === 2 && prod?.categoryId === ctx.category?.id, JSON.stringify(cat?.storage));
  const fileIds = prod?.files?.map((f) => f.id) ?? [];
  ok(`los 5 archivos están en el storage (${PROVIDER})`, fileIds.every((id) => afterExe.includes(id)), JSON.stringify(afterExe.slice(-6)));
  if (PROVIDER === "azure-blob") {
    ok("…y ninguno en el disco local", fileIds.every((id) => !catalogFilesOnDisk().includes(id)));
  }

  const img = await fetch(`${BASE}${ctx.img1?.url}`, { headers: { cookie: seller.jar.cookie } });
  ok("vendedor: GET de la foto → 200 image/png + nosniff", img.status === 200 && img.headers.get("content-type")?.startsWith("image/png") && img.headers.get("x-content-type-options") === "nosniff", `${img.status}`);
}

async function sellerPermissions() {
  console.log("\n== b) Vendedor: lee, no escribe ==");
  let r = await seller.api("/api/catalog");
  ok("GET /api/catalog → 200", r.res.status === 200 && r.json?.products?.some((p) => p.id === ctx.product?.id), short(r));
  const pid = ctx.product?.id;
  for (const [method, p, payload] of [
    ["POST", "/api/catalog/categories", { name: "x" }],
    ["PATCH", `/api/catalog/categories/${ctx.category?.id}`, { name: "x" }],
    ["POST", "/api/catalog/products", { name: "x" }],
    ["PATCH", `/api/catalog/products/${pid}`, { name: "HACK" }],
    ["DELETE", `/api/catalog/products/${pid}`],
    ["POST", `/api/catalog/products/${pid}/variants`, { name: "x" }],
    ["DELETE", `/api/catalog/variants/${ctx.v300?.id}`],
    ["DELETE", `/api/catalog/files/${ctx.img1?.id}`],
  ]) {
    r = await seller.api(p, { method, ...(payload ? { body: body(payload) } : {}) });
    ok(`${method} ${p} → 403`, r.res.status === 403, short(r));
  }
  r = await upload(seller, pid, "x.png", png(9), "image/png");
  ok("subida de archivo → 403", r.res.status === 403, short(r));
  const page = await fetch(`${BASE}/catalog`, { headers: { cookie: seller.jar.cookie }, redirect: "manual" });
  ok("vendedor: /catalog → 200", page.status === 200, `${page.status}`);
}

async function shortcuts() {
  console.log("\n== c) Atajos ligados al producto ==");
  const code = CODE.toLowerCase();
  let r = await owner.api("/api/quick-replies", {
    method: "POST",
    body: body({ shortcut: `fotos_${code}`, title: `Fotos ${ctx.product?.name}`, body: "Te comparto las fotos de {{producto}}", productId: ctx.product?.id, attach: "images" }),
  });
  ok("POST /fotos_<code> (images) → 201", r.res.status === 201, short(r));
  ctx.qrFotos = r.json?.quickReply;
  r = await owner.api("/api/quick-replies", {
    method: "POST",
    body: body({ shortcut: `ficha_${code}`, title: `Ficha ${ctx.product?.name}`, body: "", productId: ctx.product?.id, attach: "documents" }),
  });
  ok("POST /ficha_<code> con body vacío y producto → 201", r.res.status === 201, short(r));
  ctx.qrFicha = r.json?.quickReply;
  r = await owner.api("/api/quick-replies", {
    method: "POST",
    body: body({ shortcut: `solo_${code}`, title: "x", body: "", attach: "images" }),
  });
  ok("attach sin producto → 422", r.res.status === 422, short(r));
  const list = (await seller.api("/api/quick-replies")).json?.quickReplies ?? [];
  const fotos = list.find((q) => q.id === ctx.qrFotos?.id);
  const ficha = list.find((q) => q.id === ctx.qrFicha?.id);
  ok("GET: /fotos trae las 2 imágenes en orden", JSON.stringify(fotos?.product?.files?.map((f) => f.id)) === JSON.stringify([ctx.img1?.id, ctx.img2?.id]), JSON.stringify(fotos?.product?.files?.map((f) => f.fileName)));
  ok("GET: /ficha trae txt + PDF 400 + PDF 300", ficha?.product?.files?.length === 3, JSON.stringify(ficha?.product?.files?.map((f) => f.fileName)));
}

async function apiSend() {
  console.log("\n== d) Envío en lote por API (WhatsApp) ==");
  const conv = await openWaConversation(`Cliente API ${S}`);
  ctx.convApi = conv;
  await sleep(1000);
  await markOutbox();
  const send = (c, id, payload) => c.api(`/api/conversations/${id}/messages/catalog`, { method: "POST", body: body(payload) });

  let r = await send(seller, conv?.id, { text: `Te comparto las fotos ${S}`, fileIds: [ctx.img1?.id, ctx.img2?.id] });
  ok("lote texto + 2 fotos → 200, ambas sent", r.res.status === 200 && r.json?.text?.messageId && r.json?.results?.every((x) => x.status === "sent"), short(r));
  const ob = await outbox();
  const kinds = ob.map((o) => o.body?.type ?? o.type);
  ok("outbox: texto y luego 2 image, en orden", JSON.stringify(kinds.slice(-3)) === JSON.stringify(["text", "image", "image"]), JSON.stringify(kinds));
  ok("las fotos se subieron como media (media-up-)", ob.filter((o) => JSON.stringify(o).includes("media-up-")).length >= 2, JSON.stringify(ob).slice(0, 300));
  ok("1ª vez: exactamente 2 subidas a /media", (await uploads("whatsapp")).length === 2, JSON.stringify(await uploads()));
  ctx.firstMediaIds = ob.filter((o) => o.type === "image").map((o) => o.body?.image?.id);
  const msgs = await messagesOf(owner, conv?.id);
  const outImgs = msgs.filter((m) => m.direction === "out" && m.type === "image");
  ok("hilo: 2 imágenes salientes con adjunto", outImgs.length === 2 && outImgs.every((m) => m.media?.id || m.mediaAssetId || m.media), JSON.stringify(outImgs.map((m) => Object.keys(m))));
  const after = await findByName(owner, conv?.contact?.name);
  ok("responder = tomar: quedó asignada a la vendedora", after?.assignedTo?.name === SELLER_NAME, JSON.stringify(after?.assignedTo));

  r = await send(seller, conv?.id, { text: "huérfano", fileIds: ["pf_noexiste"] });
  ok("ningún archivo válido → 404 sin enviar el texto", r.res.status === 404 && !(await outbox()).some((o) => JSON.stringify(o).includes("huérfano")), short(r));
  r = await send(seller, conv?.id, { fileIds: [] });
  ok("fileIds vacío → 422", r.res.status === 422, short(r));

  // Ventana cerrada (AC-9)
  const old = await openWaConversation(`Cliente Viejo ${S}`, { timestamp: Math.floor(Date.now() / 1000) - 48 * 3600 });
  const n0 = (await outbox()).length;
  r = await send(owner, old?.id, { text: "fotos", fileIds: [ctx.img1?.id] });
  ok("ventana cerrada → 409 window_closed", r.res.status === 409 && r.json?.error?.code === "window_closed", short(r));
  ok("…y no salió nada", (await outbox()).length === n0);

  // is_test (AC-9): el guardrail del sandbox no se toca
  if (process.env.DATABASE_URL) {
    const lab = await openWaConversation(`Cliente Lab ${S}`);
    const sql = postgres(process.env.DATABASE_URL, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: process.env.E2E_DB_SCHEMA ?? "vocero" },
    });
    try {
      await sql`UPDATE conversation SET is_test = true WHERE id = ${lab?.id}`;
      const n1 = (await outbox()).length;
      // FR-944: la caché de ids remotos tampoco se toca (ni lectura que
      // refresque ni escritura): mismas filas y misma fecha antes y después.
      const cacheOf = async () =>
        (await sql`SELECT count(*)::int AS n, max(uploaded_at) AS at FROM product_file_upload WHERE product_file_id = ${ctx.img1?.id}`)[0];
      const c0 = await cacheOf();
      const u0 = (await uploads()).length;
      r = await send(owner, lab?.id, { text: "prueba", fileIds: [ctx.img1?.id] });
      ok("conversación is_test → 403 sandbox_violation", r.res.status === 403 && r.json?.error?.code === "sandbox_violation", short(r));
      ok("…y el outbox no cambió", (await outbox()).length === n1);
      const c1 = await cacheOf();
      ok("…ni product_file_upload (mismas filas y fecha)", c0.n === c1.n && String(c0.at) === String(c1.at), `${JSON.stringify(c0)} → ${JSON.stringify(c1)}`);
      ok("…ni hubo subidas a Meta", (await uploads()).length === u0);
    } finally {
      await sql.end();
    }
  } else {
    ok("(is_test) requiere DATABASE_URL", false, "sin DATABASE_URL");
  }
}

/**
 * d2) Reutilización (AC-4, FR-942/943): lo ya subido a Meta no se vuelve a
 * subir; un id que Meta rechaza se re-sube UNA vez.
 */
async function reuse() {
  console.log("\n== d2) Reutilización de lo ya subido a Meta (AC-4) ==");
  const conv = ctx.convApi;
  const send = (id, payload) => seller.api(`/api/conversations/${id}/messages/catalog`, { method: "POST", body: body(payload) });
  const imagesOut = async () => (await outbox()).filter((o) => o.type === "image");

  await markOutbox();
  let r = await send(conv?.id, { fileIds: [ctx.img1?.id, ctx.img2?.id] });
  ok("reenviar las 2 fotos → 200, ambas sent", r.res.status === 200 && r.json?.results?.every((x) => x.status === "sent"), short(r));
  let imgs = await imagesOut();
  ok("llegaron las 2 imágenes", imgs.length === 2, JSON.stringify(imgs.map((o) => o.body?.image)));
  ok("0 subidas nuevas a /media", (await uploads("whatsapp")).length === 0, JSON.stringify(await uploads()));
  ok("salieron con los MISMOS media id de la 1ª vez", JSON.stringify(imgs.map((o) => o.body?.image?.id)) === JSON.stringify(ctx.firstMediaIds), `${JSON.stringify(imgs.map((o) => o.body?.image?.id))} vs ${JSON.stringify(ctx.firstMediaIds)}`);
  const msgs = await messagesOf(owner, conv?.id);
  ok("el hilo muestra las 4 imágenes salientes (copia igual se reutilice o no)", msgs.filter((m) => m.direction === "out" && m.type === "image").length === 4);

  // Meta deja de reconocer el id cacheado de la foto 1 → 1 re-subida.
  const cachedId = imgs[0]?.body?.image?.id;
  const inv = await owner.api("/api/dev/wa-mock/invalidate-media", { method: "POST", body: body({ id: cachedId }) });
  ok("mock: invalidar el media id cacheado", inv.res.ok, short(inv));
  await markOutbox();
  r = await send(conv?.id, { fileIds: [ctx.img1?.id] });
  ok("id inválido → igual sale (200 sent)", r.res.status === 200 && r.json?.results?.[0]?.status === "sent", short(r));
  imgs = await imagesOut();
  ok("exactamente 1 re-subida a /media", (await uploads("whatsapp")).length === 1, JSON.stringify(await uploads()));
  ok("…y llegó con el id nuevo", imgs.length === 1 && imgs[0]?.body?.image?.id && imgs[0].body.image.id !== cachedId, JSON.stringify(imgs.map((o) => o.body?.image?.id)));
  if (process.env.DATABASE_URL) {
    const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {}, connection: { search_path: process.env.E2E_DB_SCHEMA ?? "vocero" } });
    try {
      const rows = await sql`SELECT remote_id FROM product_file_upload WHERE product_file_id = ${ctx.img1?.id} AND channel = 'whatsapp'`;
      ok("product_file_upload guarda el id nuevo", rows.length === 1 && rows[0].remote_id === imgs[0]?.body?.image?.id, JSON.stringify(rows));
    } finally {
      await sql.end();
    }
  }

  // Messenger: Attachment Upload API (is_reusable) → attachment_id reutilizable.
  if (!(process.env.CHANNELS ?? "").includes("messenger")) {
    console.log("  (CHANNELS sin messenger: se omite Messenger)");
    return;
  }
  const pageId = `1099${String(Date.now()).slice(-6)}`;
  r = await owner.api("/api/settings/messenger", { method: "PUT", body: body({ pageId, token: "tok-e2e-canal" }) });
  ok("conectar Messenger (mock)", r.res.ok, short(r));
  r = await owner.api("/api/dev/wa-mock/channel-inbound", {
    method: "POST",
    body: body({ channel: "messenger", accountId: pageId, senderId: `psid${S}1`, text: `¿me pasas la foto? ${S}`, mid: `mid.e2e.cat.fb.${S}` }),
  });
  ok("DM de Messenger entregado", r.res.ok, short(r));
  let fb = null;
  await until(async () => {
    const list = (await owner.api("/api/conversations")).json?.conversations ?? [];
    fb =
      list
        .filter((c) => c.channel === "messenger")
        .sort((a, b) => String(b.lastInboundAt).localeCompare(String(a.lastInboundAt)))[0] ?? null;
    return !!fb;
  });
  ok("conversación de Messenger creada", !!fb);
  await owner.api(`/api/conversations/${fb?.id}`, { method: "PATCH", body: body({ aiEnabled: false }) });
  await sleep(800);
  const fbAttachments = async () => (await outbox()).filter((o) => o.attachment?.channel === "messenger");

  await markOutbox();
  r = await owner.api(`/api/conversations/${fb?.id}/messages/catalog`, { method: "POST", body: body({ fileIds: [ctx.img1?.id] }) });
  ok("Messenger 1ª vez → 200 sent", r.res.status === 200 && r.json?.results?.[0]?.status === "sent", short(r));
  const up1 = await uploads("messenger");
  let att = await fbAttachments();
  ok("1 subida a message_attachments", up1.length === 1, JSON.stringify(await uploads()));
  ok("…y llegó por attachment_id", att.length === 1 && att[0]?.attachment?.attachmentId === up1[0]?.id, JSON.stringify(att.map((o) => o.attachment)));

  await markOutbox();
  r = await owner.api(`/api/conversations/${fb?.id}/messages/catalog`, { method: "POST", body: body({ fileIds: [ctx.img1?.id] }) });
  ok("Messenger 2ª vez → 200 sent", r.res.status === 200 && r.json?.results?.[0]?.status === "sent", short(r));
  att = await fbAttachments();
  ok("0 subidas nuevas a message_attachments", (await uploads("messenger")).length === 0, JSON.stringify(await uploads()));
  ok("…y llegó con el mismo attachment_id", att.length === 1 && att[0]?.attachment?.attachmentId === up1[0]?.id, JSON.stringify(att.map((o) => o.attachment)));
}

async function instagram() {
  console.log("\n== e) Instagram: incompatible → skipped ==");
  if (!(process.env.CHANNELS ?? "").includes("instagram")) {
    console.log("  (CHANNELS sin instagram: se omite)");
    return;
  }
  const acc = `1784${String(Date.now()).slice(-6)}`;
  let r = await owner.api("/api/settings/instagram", { method: "PUT", body: body({ source: "meta", igUserId: acc, token: "tok-e2e-canal" }) });
  ok("conectar Instagram (mock)", r.res.ok, short(r));
  const name = `ig${S}`;
  r = await owner.api("/api/dev/wa-mock/channel-inbound", {
    method: "POST",
    body: body({ channel: "instagram", accountId: acc, senderId: `ig${S}1`, text: `quiero la ficha ${S}`, mid: `mid.e2e.cat.${S}` }),
  });
  ok("DM de Instagram entregado", r.res.ok, short(r));
  let conv = null;
  await until(async () => {
    const list = (await owner.api("/api/conversations")).json?.conversations ?? [];
    // El DTO no expone el id del remitente: la más reciente de Instagram.
    conv =
      list
        .filter((c) => c.channel === "instagram")
        .sort((a, b) => String(b.lastInboundAt).localeCompare(String(a.lastInboundAt)))[0] ?? null;
    return !!conv;
  });
  ok("conversación de Instagram creada", !!conv, name);
  await owner.api(`/api/conversations/${conv?.id}`, { method: "PATCH", body: body({ aiEnabled: false }) });
  await sleep(800);
  await markOutbox();
  r = await owner.api(`/api/conversations/${conv?.id}/messages/catalog`, { method: "POST", body: body({ fileIds: [ctx.txt?.id, ctx.pdf400?.id] }) });
  const byId = Object.fromEntries((r.json?.results ?? []).map((x) => [x.fileId, x]));
  ok("lote IG → 200", r.res.status === 200, short(r));
  ok("el .txt → skipped con razón", byId[ctx.txt?.id]?.status === "skipped" && !!byId[ctx.txt?.id]?.reason, JSON.stringify(byId[ctx.txt?.id]));
  ok("el PDF → sent", byId[ctx.pdf400?.id]?.status === "sent", JSON.stringify(byId[ctx.pdf400?.id]));
  const ob = await outbox();
  ok("Meta recibió exactamente 1 adjunto (el PDF)", ob.filter((o) => JSON.stringify(o).includes("attachment")).length === 1, JSON.stringify(ob).slice(0, 300));
  // Arreglo IG: el PDF del catálogo se SUBE a message_attachments (bytes) y
  // sale por attachment_id; ya no se manda una URL para que Meta la descargue.
  const upIg = await uploads("instagram");
  const obPdf = ob.find((o) => o.type === "attachment");
  ok(
    "IG: 1 subida binaria del PDF y el envío usa ese attachment_id",
    upIg.length === 1 && upIg[0].mime === "application/pdf" && upIg[0].bytes > 0 &&
      obPdf?.attachment?.channel === "instagram" && obPdf.attachment.attachmentId === upIg[0].id &&
      obPdf.attachment.shape === "attachment" && obPdf.attachment.attachmentType === "file",
    JSON.stringify({ upIg, att: obPdf?.attachment })
  );
}

async function withSellerPage(fn) {
  const browser = await chromium.launch(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {});
  try {
    const bctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await bctx.route("**/api/events*", (route) => route.abort());
    await bctx.addCookies(toBrowserCookies(seller.jar));
    const page = await bctx.newPage();
    page.setDefaultTimeout(60000);
    await fn(page);
    await bctx.close();
  } finally {
    await browser.close();
  }
}

async function composerUi() {
  console.log("\n== f) Compositor (vendedor) ==");
  const conv = await openWaConversation(`María UI ${S}`);
  ctx.otherName = `Pedro Otro ${S}`;
  await openWaConversation(ctx.otherName);
  await sleep(1000);
  await markOutbox();
  await withSellerPage(async (page) => {
    await page.goto(`${BASE}/inbox?contact=${conv?.contact?.id}`, { waitUntil: "load", timeout: 90000 });
    const input = page.getByPlaceholder(COMPOSER);
    await input.waitFor();
    const picker = page.getByRole("listbox", { name: "Respuestas rápidas" });
    const query = `/FOTOS_${CODE}`.slice(0, 12);
    const opened = await until(async () => {
      await input.fill("");
      await input.pressSequentially(query, { delay: 40 });
      await sleep(400);
      return (await picker.count()) > 0 && (await picker.isVisible());
    }, 30000);
    ok(`escribir \`${query}\` (mayúsculas) abre el selector`, opened);
    await input.press("Enter");
    const chips = page.locator('[data-testid="staged-file"]');
    ok("Enter escenifica 2 chips", await until(async () => (await chips.count()) === 2, 8000), `chips=${await chips.count()}`);
    ok("el texto quedó con el nombre del producto", (await input.inputValue()).includes(ctx.product?.name), JSON.stringify(await input.inputValue()));
    await sleep(800);
    ok("nada se envió todavía", (await outbox()).length === 0);

    // AC-2: quitar un chip
    await page.getByRole("button", { name: `Quitar ${ctx.img2?.fileName}` }).click();
    ok("quitar un chip deja 1", await until(async () => (await chips.count()) === 1, 5000));
    await input.press("Enter");
    const sent = await until(async () => {
      const kinds = (await outbox()).map((o) => o.body?.type ?? o.type);
      return kinds.filter((k) => k === "image").length === 1 && kinds.includes("text");
    }, 20000);
    ok("enviar → sale el texto + 1 foto", sent, JSON.stringify((await outbox()).map((o) => o.body?.type ?? o.type)));
    ok("los chips se limpiaron", await until(async () => (await chips.count()) === 0, 5000));
    ok("resumen visible (role=status)", await until(async () => (await page.getByRole("status").filter({ hasText: /enviad/i }).count()) > 0, 5000));

    // AC-3: botón Catálogo con variante + Insertar detalles
    await markOutbox();
    await page.getByRole("button", { name: "Catálogo", exact: true }).click();
    const dlg = page.getByRole("dialog", { name: "Catálogo" });
    await dlg.waitFor();
    await dlg.getByLabel("Buscar en el catálogo").fill(CODE);
    await dlg.getByRole("button", { name: new RegExp(ctx.product?.name ?? "x") }).first().click();
    await dlg.getByLabel("Variante").selectOption({ label: "400 km" });
    const pdf300Box = dlg.getByLabel(ctx.pdf300?.fileName);
    ok("con la variante 400 no se ofrece la ficha de la 300", (await pdf300Box.count()) === 0);
    await dlg.getByLabel(ctx.pdf400?.fileName).check();
    await dlg.getByRole("button", { name: "Insertar detalles" }).click();
    await dlg.getByRole("button", { name: "Agregar" }).click();
    ok("la ficha 400 quedó escenificada", await until(async () => (await page.locator(`[data-testid="staged-file"][data-file-id="${ctx.pdf400?.id}"]`).count()) === 1, 5000));
    const txt = await input.inputValue();
    ok("detalles insertados: variante y precio de la variante", txt.includes("400 km") && txt.includes("629,900"), JSON.stringify(txt));
    await input.press("Enter");
    const sent2 = await until(async () => {
      const kinds = (await outbox()).map((o) => o.body?.type ?? o.type);
      return kinds.includes("document") && kinds.includes("text");
    }, 20000);
    ok("sale el texto con los detalles + el PDF", sent2, JSON.stringify((await outbox()).map((o) => o.body?.type ?? o.type)));

    // Lote en vuelo + cambio de conversación: la respuesta tardía no puede
    // dejar chips, resumen ni borrar el borrador del hilo nuevo.
    await markOutbox();
    await page.route("**/messages/catalog", async (route) => {
      await sleep(4000);
      await route.continue();
    });
    const reopened = await until(async () => {
      await input.fill("");
      await input.pressSequentially(query, { delay: 40 });
      await sleep(400);
      if ((await picker.count()) === 0) return false;
      await input.press("Enter");
      return (await chips.count()) > 0;
    }, 15000);
    ok("(lote en vuelo) chips escenificados otra vez", reopened);
    await input.press("Enter");
    await sleep(300);
    await page.getByText(ctx.otherName, { exact: false }).first().click();
    await until(async () => (await page.getByPlaceholder(COMPOSER).inputValue()) === "", 5000);
    await page.getByPlaceholder(COMPOSER).fill("borrador del otro hilo");
    await until(async () => (await outbox()).some((o) => (o.body?.type ?? o.type) === "image"), 20000);
    await sleep(1500);
    ok("el lote salió igual (al hilo original)", (await outbox()).some((o) => (o.body?.type ?? o.type) === "image"));
    ok("el hilo nuevo no hereda chips", (await chips.count()) === 0, `chips=${await chips.count()}`);
    ok("ni el resumen", (await page.getByRole("status").filter({ hasText: /enviad/i }).count()) === 0);
    ok("y conserva su borrador", (await page.getByPlaceholder(COMPOSER).inputValue()) === "borrador del otro hilo");
    await page.unroute("**/messages/catalog");
  });
}

async function withOwnerPage(fn) {
  const browser = await chromium.launch(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {});
  try {
    const bctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await bctx.route("**/api/events*", (route) => route.abort());
    await bctx.addCookies(toBrowserCookies(owner.jar));
    const page = await bctx.newPage();
    page.setDefaultTimeout(60000);
    await fn(page);
    await bctx.close();
  } finally {
    await browser.close();
  }
}

/**
 * f2) Ampliación 15-oct (FR-950..953): el navegador convierte WebP/GIF/HEIC a
 * JPG y reduce lo que pase de 5 MB antes de subir; el servidor sigue con su
 * lista blanca JPG/PNG por firma.
 */
async function browserImagesUi() {
  console.log("\n== f2) Subida desde el navegador: WebP → JPG, PNG grande → ≤ 5 MB ==");
  const { browserWebp, browserNoisePng, garbageHeic, jpegSize } = await import("./e2e-test-images.mjs");
  const pid = ctx.product?.id;
  const MAX = 5 * 1024 * 1024;
  await withOwnerPage(async (page) => {
    await page.goto(`${BASE}/catalog`, { waitUntil: "load", timeout: 90000 });
    const card = page.locator(`[data-testid="catalog-product"][data-product-id="${pid}"]`);
    await card.waitFor();
    const detail = page.locator(`[data-testid="catalog-detail"][data-product-id="${pid}"]`);
    ok("(UI) abrir el producto como Propietario", await until(async () => {
      if ((await detail.count()) > 0) return true;
      await card.click();
      await sleep(500);
      return (await detail.count()) > 0;
    }, 20000));
    const input = page.getByTestId("catalog-upload-input");
    const accept = (await input.getAttribute("accept")) ?? "";
    ok("el input acepta webp/gif/heic/heif", [".webp", ".gif", ".heic", ".heif", "image/heic"].every((x) => accept.includes(x)), accept);

    const webp = await browserWebp(page, `foto-${S}.webp`);
    const big = await browserNoisePng(page, `grande-${S}.png`);
    ok(`archivos de prueba generados en el navegador (webp ${webp.buffer.length} B, png ${(big.buffer.length / 1048576).toFixed(1)} MB)`, webp.buffer.length > 0 && big.buffer.length > MAX);

    const rows = page.getByTestId("catalog-upload");
    await input.setInputFiles([webp, big]);
    const settled = await until(async () => {
      const st = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-status")));
      return st.length === 2 && st.every((s) => s === "done" || s === "error");
    }, 120000);
    const statuses = await rows.evaluateAll((els) => els.map((e) => [e.getAttribute("data-status"), e.textContent]));
    ok("las 2 subidas terminan en done", settled && statuses.every(([s]) => s === "done"), JSON.stringify(statuses));
    ok("la fila del WebP dice 'convertida a JPG'", /convertida a JPG/.test(statuses[0]?.[1] ?? ""), statuses[0]?.[1]);
    ok("la fila del PNG grande dice 'reducida a … MB'", /reducida a \d+(\.\d)? MB/.test(statuses[1]?.[1] ?? ""), statuses[1]?.[1]);

    // Camino infeliz: un .heic que el navegador no decodifica → aviso + 415.
    const heicRes = page.waitForResponse((r) => r.url().includes(`/api/catalog/products/${pid}/files`) && r.request().method() === "POST", { timeout: 60000 });
    await input.setInputFiles([garbageHeic(`IMG_${S}.heic`)]);
    const res = await heicRes.catch(() => null);
    ok("HEIC no decodificable: el servidor responde 415", res?.status() === 415, `${res?.status()}`);
    const heicRow = rows.first();
    ok("…la fila queda en error (sin colgarse)", await until(async () => (await heicRow.getAttribute("data-status")) === "error", 15000), await heicRow.textContent());
    ok("…con el aviso del navegador", /no puede convertir este formato/.test((await page.getByTestId("catalog-upload-note").first().textContent().catch(() => "")) ?? ""));
  });

  const prod = (await owner.api("/api/catalog")).json?.products?.find((p) => p.id === pid);
  const webpFile = prod?.files?.find((f) => f.fileName.startsWith(`foto-${S}`));
  const bigFile = prod?.files?.find((f) => f.fileName.startsWith(`grande-${S}`));
  ok("foto.webp quedó kind=image, image/jpeg, .jpg", webpFile?.kind === "image" && webpFile?.mimeType === "image/jpeg" && webpFile?.fileName === `foto-${S}.jpg`, JSON.stringify(webpFile));
  ok("el PNG grande quedó JPEG ≤ 5 MB", bigFile?.kind === "image" && bigFile?.mimeType === "image/jpeg" && bigFile?.fileName.endsWith(".jpg") && bigFile?.size <= MAX, JSON.stringify(bigFile));
  ok("el .heic no quedó en el catálogo", !prod?.files?.some((f) => f.fileName.toLowerCase().includes(`img_${S}`)), JSON.stringify(prod?.files?.map((f) => f.fileName)));
  ctx.webpJpg = webpFile;
  ctx.bigJpg = bigFile;
  if (bigFile) {
    const bytes = Buffer.from(await (await fetch(`${BASE}${bigFile.url}`, { headers: { cookie: owner.jar.cookie } })).arrayBuffer());
    const dims = jpegSize(bytes);
    ok("los bytes servidos son JPEG con lado mayor ≤ 2560 px", !!dims && Math.max(dims.width, dims.height) <= 2560 && bytes.length <= MAX, JSON.stringify({ dims, size: bytes.length }));
  }

  await markOutbox();
  const r = await owner.api(`/api/conversations/${ctx.convApi?.id}/messages/catalog`, {
    method: "POST",
    body: body({ fileIds: [webpFile?.id, bigFile?.id] }),
  });
  ok("se envían por WhatsApp (lote) → ambas sent", r.res.status === 200 && r.json?.results?.length === 2 && r.json.results.every((x) => x.status === "sent"), short(r));
  const imgs = (await outbox()).filter((o) => (o.body?.type ?? o.type) === "image");
  ok("…Meta recibió 2 imágenes subidas a /media", imgs.length === 2 && (await uploads("whatsapp")).length === 2, JSON.stringify({ imgs: imgs.length, up: (await uploads()).length }));
}

async function purgeKeepsCatalog() {
  console.log("\n== g) La purga de 30 días no toca el catálogo ==");
  const r = await owner.api("/api/dev/media/purge", { method: "POST", body: body({ advanceDays: 31 }) });
  ok("purga forzada (+31 días) → 200", r.res.status === 200, short(r));
  const img = await fetch(`${BASE}${ctx.img1?.url}`, { headers: { cookie: owner.jar.cookie } });
  ok("la foto del catálogo sigue → 200", img.status === 200, `${img.status}`);
  const msgs = await messagesOf(owner, ctx.convApi?.id);
  const outImg = msgs.find((m) => m.direction === "out" && m.type === "image");
  ok("la copia del hilo quedó expirada", JSON.stringify(outImg ?? {}).includes("expired"), JSON.stringify(outImg?.media ?? outImg).slice(0, 200));
}

async function deleteProduct() {
  console.log("\n== h) Borrar el producto ==");
  const before = await storedIds();
  const ids = [ctx.img1, ctx.img2, ctx.pdf400, ctx.pdf300, ctx.txt].map((f) => f?.id);
  let r = await owner.api(`/api/catalog/products/${ctx.product?.id}`, { method: "DELETE" });
  ok("DELETE producto → 200", r.res.status === 200, short(r));
  const gone = await fetch(`${BASE}${ctx.img1?.url}`, { headers: { cookie: owner.jar.cookie } });
  ok("su foto → 404", gone.status === 404, `${gone.status}`);
  const after = await storedIds();
  ok(`sus bytes salieron del storage (${PROVIDER})`, ids.every((id) => !after.includes(id)) && after.length <= before.length - 5, `${before.length} → ${after.length}`);
  const list = (await owner.api("/api/quick-replies")).json?.quickReplies ?? [];
  const fotos = list.find((q) => q.id === ctx.qrFotos?.id);
  ok("el atajo quedó sin producto", fotos && fotos.productId === null && fotos.product === null, JSON.stringify(fotos));
  const msgs = await messagesOf(owner, ctx.convApi?.id);
  ok("el hilo conserva sus mensajes", msgs.filter((m) => m.direction === "out").length >= 3);
}

/** FR-913 / AC-12: el estado del almacenamiento solo existe con el conector encendido. */
async function storageSettings() {
  console.log(`\n== i) Ajustes → Almacenamiento (${PROVIDER}) ==`);
  const get = await owner.api("/api/settings/catalog-storage");
  const page = await fetch(`${BASE}/settings/storage`, { headers: { cookie: owner.jar.cookie }, redirect: "manual" });
  const settingsHtml = await (await fetch(`${BASE}/settings`, { headers: { cookie: owner.jar.cookie } })).text();
  if (PROVIDER === "local") {
    ok("apagado: GET /api/settings/catalog-storage → 404", get.res.status === 404, short(get));
    ok("apagado: /settings/storage → 404", page.status === 404, `${page.status}`);
    ok("apagado: Ajustes no menciona Azure", !/azure/i.test(settingsHtml));
    return;
  }
  const cfg = azureConfig();
  ok("encendido: GET → 200 con cuenta y contenedor", get.res.status === 200 && get.json?.provider === "azure-blob" && get.json?.accountName === cfg.account && get.json?.container === cfg.container, short(get));
  const raw = JSON.stringify(get.json ?? {});
  ok("…sin la clave ni la cadena", !raw.includes(cfg.key.toString("base64").slice(0, 16)) && !/AccountKey/i.test(raw));
  ok("encendido: /settings/storage → 200", page.status === 200, `${page.status}`);
  const test = await owner.api("/api/settings/catalog-storage/test", { method: "POST", body: "{}" });
  ok("Probar conexión → ok", test.res.status === 200 && test.json?.ok === true, short(test));
  const sellerGet = await seller.api("/api/settings/catalog-storage");
  ok("vendedor → 403", sellerGet.res.status === 403, short(sellerGet));
}

/** AC-11: con Azure caído el CRM degrada sin colgarse y se recupera solo. */
async function azureDown() {
  const container = process.env.E2E_AZURITE_CONTAINER;
  if (PROVIDER !== "azure-blob" || !container) return;
  console.log("\n== j) Azure no responde ==");
  const { execFileSync } = await import("node:child_process");
  execFileSync("docker", ["stop", container], { stdio: "ignore" });
  try {
    let r = await upload(owner, ctx.product?.id, "caido.png", png(77), "image/png");
    ok("subir → 503 storage_unavailable con mensaje claro", r.res.status === 503 && r.json?.error?.code === "storage_unavailable" && !!r.json?.error?.message, short(r));
    r = await owner.api("/api/catalog");
    ok("el catálogo se sigue listando (200)", r.res.status === 200 && r.json?.products?.length > 0, short(r));
    const img = await fetch(`${BASE}${ctx.img1?.url}`, { headers: { cookie: owner.jar.cookie } });
    ok("servir una foto → 503 (miniatura rota, no 500)", img.status === 503, `${img.status}`);
    await markOutbox();
    r = await owner.api(`/api/conversations/${ctx.convApi?.id}/messages/catalog`, {
      method: "POST",
      body: body({ text: `con azure caído ${S}`, fileIds: [ctx.img1?.id] }),
    });
    const item = r.json?.results?.[0];
    ok("lote → 200: el texto sale y la foto queda failed", r.res.status === 200 && !!r.json?.text?.messageId && item?.status === "failed" && /storage/.test(item?.reason ?? ""), short(r));
    ok("…Meta solo recibió el texto", (await outbox()).every((o) => (o.body?.type ?? o.type) === "text"));
    r = await owner.api("/api/settings/catalog-storage/test", { method: "POST", body: "{}" });
    ok("Probar conexión → 503", r.res.status === 503, short(r));
  } finally {
    execFileSync("docker", ["start", container], { stdio: "ignore" });
  }
  const back = await until(async () => (await owner.api("/api/settings/catalog-storage/test", { method: "POST", body: "{}" })).res.status === 200, 30000);
  ok("Azure vuelve → Probar conexión ok sin reiniciar el CRM", back);
  const img = await fetch(`${BASE}${ctx.img1?.url}`, { headers: { cookie: owner.jar.cookie } });
  ok("…y la foto se sirve otra vez", img.status === 200, `${img.status}`);
}

async function main() {
  if (PROVIDER === "azure-blob") {
    // El CRM no crea contenedores (en Azure real lo crea el dueño en el portal).
    const res = await azureRequest("PUT", { restype: "container" });
    ok("(setup) contenedor de Azurite listo", res.status === 201 || res.status === 409, `${res.status}`);
  }
  await setup();
  await storageSettings();
  await catalogCrud();
  await sellerPermissions();
  await shortcuts();
  await apiSend();
  await reuse();
  await instagram();
  if (process.env.E2E_SKIP_UI !== "1") {
    await composerUi();
    await browserImagesUi();
  }
  await azureDown();
  await purgeKeepsCatalog();
  await deleteProduct();
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
