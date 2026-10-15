/**
 * Self-test E2E de comportamiento — adjuntos seguros EN EL NAVEGADOR (018).
 * Guion tests/e2e/us-adjuntos.md, sección "Lo que ve el operador".
 *
 * La API ya la cubre scripts/e2e-selftest.mjs (adjuntosChecks). Aquí se mira
 * lo que el operador VE: la foto renderizada (no un icono roto), el PDF como
 * tarjeta descargable, el aviso de bloqueado SIN enlace, el de "no
 * disponible", el aviso de carga fallida, la foto que pasa de "descargando…"
 * a visible sin recargar, el clip con el `accept` del canal, el rechazo en
 * cliente por extensión, el aviso de 30 días al adjuntar y, tras la purga, el
 * aviso de "Archivo eliminado".
 *
 * OJO: al final adelanta el reloj de la purga 31 días → expira TODOS los
 * adjuntos de la BD. Córrelo después del self-test principal.
 *
 * Uso: node --env-file=.env.e2e scripts/e2e-adjuntos-ui.mjs
 * Requiere: app corriendo con WA_MOCK_ENABLED=true y Playwright.
 */
import { chromium } from "playwright";
import { browserWebp, garbageHeic } from "./e2e-test-images.mjs";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const PN = "PN-E2E-1";
const S = Math.random().toString(36).slice(2, 7);
let failures = 0;
let checks = 0;
const ok = (name, cond, extra = "") => {
  checks++;
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PDF mínimo real (la política mira la firma `%PDF-`). */
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "latin1"
);

const browser = await chromium.launch(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {});
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const req = ctx.request;

try {
  console.log("== Setup ==");
  let r = await req.post(`${BASE}/api/auth/sign-up/email`, {
    headers: { origin: BASE },
    data: { email: "e2e@vocero.test", password: "password-e2e-123", name: "Operador E2E" },
  });
  if (!r.ok())
    r = await req.post(`${BASE}/api/auth/sign-in/email`, {
      headers: { origin: BASE },
      data: { email: "e2e@vocero.test", password: "password-e2e-123" },
    });
  ok("login", r.ok());
  await req.put(`${BASE}/api/settings/whatsapp`, {
    data: { wabaId: "WABA-E2E", phoneNumberId: PN, token: "tok-e2e" },
  });

  const NAME = `Adjuntos UI ${S}`;
  const FROM = `521477${Math.floor(Math.random() * 9e6) + 1e6}`;
  const inbound = (data) =>
    req.post(`${BASE}/api/dev/wa-mock/inbound`, { data: { phoneNumberId: PN, from: FROM, ...data } });
  await inbound({ name: NAME, text: "hola, les mando unos archivos", waMessageId: `wamid.ui.${S}.0` });
  await inbound({ type: "image", mediaId: `media-ui-img-${S}`, caption: `foto ${S}`, waMessageId: `wamid.ui.${S}.1` });
  await inbound({
    type: "document",
    mediaId: `media-ui-cot-pdf-${S}`,
    filename: `cotizacion-${S}.pdf`,
    caption: `cot ${S}`,
    waMessageId: `wamid.ui.${S}.2`,
  });
  await inbound({
    type: "document",
    mediaId: `media-ui-html-pdf-${S}`,
    filename: "factura.pdf",
    caption: `bloq ${S}`,
    waMessageId: `wamid.ui.${S}.3`,
  });
  await inbound({ type: "image", mediaId: "broken-no-url", caption: `rota ${S}`, waMessageId: `wamid.ui.${S}.4` });
  await inbound({ type: "image", mediaId: `media-ui-img-err-${S}`, caption: `noload ${S}`, waMessageId: `wamid.ui.${S}.5` });

  // Espera a que las descargas en segundo plano terminen.
  let conv = null;
  let msgs = [];
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const convs = (await (await req.get(`${BASE}/api/conversations`)).json()).conversations ?? [];
    conv = convs.find((c) => c.contact.name === NAME) ?? null;
    if (!conv) continue;
    msgs = (await (await req.get(`${BASE}/api/conversations/${conv.id}/messages`)).json()).messages ?? [];
    const media = msgs.filter((m) => m.media);
    if (media.length >= 5 && media.every((m) => m.media.fetchStatus !== "pending")) break;
  }
  ok("conversación con 5 adjuntos entrantes ya procesados", !!conv && msgs.filter((m) => m.media).length >= 5);
  const byCaption = (c) => msgs.find((m) => m.media?.caption === c)?.media;
  ok(
    "estados en la API: imagen y PDF disponibles, HTML bloqueado, roto failed",
    byCaption(`foto ${S}`)?.fetchStatus === "available" &&
      byCaption(`cot ${S}`)?.fetchStatus === "available" &&
      byCaption(`bloq ${S}`)?.fetchStatus === "blocked" &&
      byCaption(`rota ${S}`)?.fetchStatus === "failed",
    JSON.stringify(msgs.filter((m) => m.media).map((m) => [m.media.caption, m.media.fetchStatus]))
  );
  const errAsset = byCaption(`noload ${S}`)?.assetId;

  console.log("\n== Lo que ve el operador en el hilo ==");
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  // La imagen `noload` responde 500 en el navegador: debe verse el aviso, no
  // un icono roto.
  if (errAsset) {
    await page.route(`**/api/media/${errAsset}`, (route) => route.fulfill({ status: 500, body: "" }));
  }
  const openThread = async () => {
    await page.goto(`${BASE}/inbox?contact=${conv.contact.id}`, { waitUntil: "load", timeout: 90000 });
    await page.getByPlaceholder("Escribe una respuesta").waitFor();
    await page.getByText(`cot ${S}`).first().waitFor();
  };
  await openThread();

  const img = page.locator(`img[data-testid="media-image"][alt="foto ${S}"]`);
  await img.waitFor();
  const rendered = await img
    .evaluate(
      (el) =>
        new Promise((res) => {
          const done = () => res(el.naturalWidth);
          if (el.complete) done();
          else {
            el.addEventListener("load", done, { once: true });
            el.addEventListener("error", () => res(0), { once: true });
          }
        })
    )
    .catch(() => 0);
  ok("la foto del cliente se ve dentro del chat (renderizada)", rendered > 0, `naturalWidth=${rendered}`);

  const card = page.locator('[data-testid="media-document"]').filter({ hasText: `cotizacion-${S}.pdf` });
  ok("el PDF aparece como tarjeta con su nombre", (await card.count()) === 1);
  const cardText = (await card.first().innerText().catch(() => "")) ?? "";
  ok("la tarjeta dice el tipo (PDF) y el tamaño", /PDF/.test(cardText) && /B/.test(cardText), cardText);
  ok(
    "la tarjeta descarga (href a /api/media + atributo download)",
    /\/api\/media\//.test((await card.first().getAttribute("href")) ?? "") &&
      (await card.first().getAttribute("download")) !== null
  );

  const bloq = page.locator('[data-testid="media-blocked"]');
  const bloqText = (await bloq.first().innerText().catch(() => "")) ?? "";
  ok("el HTML disfrazado se ve como 'Archivo bloqueado por seguridad'", /Archivo bloqueado por seguridad/.test(bloqText), bloqText);
  ok("con la razón del bloqueo", /HTML/.test(bloqText), bloqText);
  ok("y SIN ningún enlace para abrirlo", (await bloq.first().locator("a").count()) === 0);
  ok(
    "ningún enlace del hilo apunta al archivo bloqueado",
    (await page.locator(`a[href$="/api/media/${byCaption(`bloq ${S}`)?.assetId}"]`).count()) === 0
  );

  const failed = page.locator('[data-testid="media-failed"]');
  ok(
    "la descarga fallida dice 'No disponible (expiró en la plataforma)'",
    /No disponible \(expiró en la plataforma\)/.test((await failed.first().innerText().catch(() => "")) ?? "")
  );
  const loadErr = page.locator('[data-testid="media-load-error"]');
  await loadErr.first().waitFor({ timeout: 15000 }).catch(() => {});
  ok(
    "una imagen que no carga muestra 'No se pudo cargar la imagen' (no un icono roto)",
    /No se pudo cargar la imagen/.test((await loadErr.first().innerText().catch(() => "")) ?? "")
  );

  console.log("\n== Una foto nueva pasa de 'descargando…' a visible sin recargar ==");
  await inbound({ type: "image", mediaId: `media-ui-img-live-${S}`, caption: `en vivo ${S}`, waMessageId: `wamid.ui.${S}.6` });
  const live = page.locator(`img[data-testid="media-image"][alt="en vivo ${S}"]`);
  const llego = await live.waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
  ok("la foto entrante aparece renderizada sin recargar la página", llego);

  console.log("\n== El compositor ==");
  const accept = await page.locator('input[type="file"]').getAttribute("accept");
  ok(
    "el clip usa el accept del canal (WhatsApp)",
    !!conv.outboundFiles?.accept &&
      (accept ?? "").startsWith(conv.outboundFiles.accept) &&
      /\.pdf/.test(accept ?? "") &&
      !/\.exe/.test(accept ?? ""),
    String(accept)
  );
  ok(
    "…más webp/gif/heic/heif (el navegador los convierte a JPG)",
    [".webp", ".gif", ".heic", ".heif"].every((x) => (accept ?? "").includes(x)),
    String(accept)
  );
  const clip = page.getByRole("button", { name: "Adjuntar archivo" });
  ok("el clip explica qué acepta el canal", /WhatsApp acepta/.test((await clip.getAttribute("title")) ?? ""));
  ok("hay botones de ubicación y contacto (WhatsApp)", (await page.getByRole("button", { name: "Enviar ubicación" }).count()) === 1);

  // Validación ligera en cliente: un .exe se rechaza con la frase del canal.
  await page.locator('input[type="file"]').setInputFiles({
    name: "virus.exe",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("MZ\x90\x00", "latin1"),
  });
  const rechazo = await page
    .getByText(/WhatsApp acepta imágenes/)
    .filter({ hasNot: page.locator("button") })
    .first()
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  ok("elegir un .exe muestra el error del canal y no lo adjunta", rechazo && (await page.getByText("virus.exe").count()) === 0);

  await page.locator('input[type="file"]').setInputFiles({
    name: `propuesta-${S}.pdf`,
    mimeType: "application/pdf",
    buffer: PDF_BYTES,
  });
  await page.getByText(`propuesta-${S}.pdf`).first().waitFor({ timeout: 10000 });
  ok(
    "al adjuntar avisa: 'Los archivos se eliminan del CRM a los 30 días.'",
    (await page.getByText("Los archivos se eliminan del CRM a los 30 días.").count()) === 1
  );
  // Un clic antes de hidratar puede no hacer nada: el envío es idempotente
  // mientras el archivo siga en la tarjeta.
  const enviado = page.locator('[data-testid="media-document"]').filter({ hasText: `propuesta-${S}.pdf` });
  for (let i = 0; i < 3 && (await enviado.count()) === 0; i++) {
    if ((await page.getByText("Los archivos se eliminan del CRM a los 30 días.").count()) === 0) break;
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await enviado.first().waitFor({ timeout: 15000 }).catch(() => {});
  }
  ok("el PDF enviado aparece en el hilo como tarjeta", (await enviado.count()) === 1);

  console.log("\n== Clip: WebP → JPG en el navegador (019, 15-oct) ==");
  const mock = async () => (await (await req.get(`${BASE}/api/dev/wa-mock/outbox`)).json()) ?? {};
  const m0 = await mock();
  const outBase = (m0.outbox ?? []).length;
  const upBase = (m0.uploads ?? []).length;
  const webp = await browserWebp(page, `foto-${S}.webp`);
  await page.locator('input[type="file"]').setInputFiles(webp);
  const note = page.getByTestId("attach-note");
  await note.waitFor({ timeout: 30000 }).catch(() => {});
  ok("al adjuntar foto.webp avisa 'convertida a JPG'", /convertida a JPG/.test((await note.textContent().catch(() => "")) ?? ""), await note.textContent().catch(() => ""));
  ok("la tarjeta ya muestra foto.jpg", (await page.getByText(`foto-${S}.jpg`).count()) > 0);
  const caption = `webp ${S}`;
  await page.getByPlaceholder("Pie del adjunto (opcional)…").fill(caption);
  const sentImg = page.locator(`img[data-testid="media-image"][alt="${caption}"]`);
  for (let i = 0; i < 3 && (await sentImg.count()) === 0; i++) {
    if ((await note.count()) === 0) break;
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await sentImg.first().waitFor({ timeout: 15000 }).catch(() => {});
  }
  const m1 = await mock();
  const newOut = (m1.outbox ?? []).slice(outBase);
  const newUp = (m1.uploads ?? []).slice(upBase);
  ok("el wa-mock recibió type=image", newOut.some((o) => (o.body?.type ?? o.type) === "image"), JSON.stringify(newOut.map((o) => o.body?.type ?? o.type)));
  ok(
    "…subida a /media como JPEG (foto.jpg)",
    newUp.some((u) => u.channel === "whatsapp" && u.mime === "image/jpeg" && u.fileName === `foto-${S}.jpg`),
    JSON.stringify(newUp).slice(0, 300)
  );
  const after = (await (await req.get(`${BASE}/api/conversations/${conv.id}/messages`)).json()).messages ?? [];
  const lastOut = after.filter((m) => m.direction === "out").at(-1);
  ok("el mensaje del hilo es imagen", lastOut?.type === "image" && lastOut?.media?.caption === caption, JSON.stringify({ type: lastOut?.type, media: lastOut?.media }).slice(0, 300));
  ok("y se ve en el hilo", (await sentImg.count()) === 1);

  console.log("\n== Clip: HEIC ilegible → aviso + 415 sin colgarse ==");
  await page.locator('input[type="file"]').setInputFiles(garbageHeic(`IMG_${S}.heic`));
  await note.waitFor({ timeout: 30000 }).catch(() => {});
  ok("avisa que el navegador no puede convertirla", /no puede convertir este formato/.test((await note.textContent().catch(() => "")) ?? ""), await note.textContent().catch(() => ""));
  const heicRes = page.waitForResponse((r) => r.url().includes("/messages/media") && r.request().method() === "POST", { timeout: 30000 });
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  const hr = await heicRes.catch(() => null);
  ok("el servidor responde 415", hr?.status() === 415, `${hr?.status()}`);
  const errShown = await page.locator("p.text-destructive").first().waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
  ok("la UI muestra el error y el botón vuelve a estar disponible", errShown && (await page.getByRole("button", { name: "Enviar", exact: true }).isEnabled()));
  await page.getByRole("button", { name: "Quitar adjunto" }).click();

  console.log("\n== A los 30 días: 'Archivo eliminado' ==");
  const purga = await req.post(`${BASE}/api/dev/media/purge`, { data: { advanceDays: 31 } });
  ok("purga con el reloj adelantado 31 días", purga.ok(), await purga.text());
  await openThread();
  const expirados = page.locator('[data-testid="media-expired"]');
  await expirados.first().waitFor({ timeout: 15000 }).catch(() => {});
  const nExp = await expirados.count();
  ok("los adjuntos purgados muestran el aviso (≥ 4: foto, PDF, en vivo, enviado)", nExp >= 4, `n=${nExp}`);
  ok(
    "con el texto 'Archivo eliminado — los archivos se guardan 30 días'",
    /Archivo eliminado — los archivos se guardan 30 días/.test((await expirados.first().innerText().catch(() => "")) ?? "")
  );
  ok("ya no hay imágenes ni tarjetas descargables del hilo", (await page.locator('[data-testid="media-image"], [data-testid="media-document"]').count()) === 0);
  ok("y los expirados no llevan enlace", (await expirados.locator("a").count()) === 0);
  ok(
    "el bloqueado conserva 'Archivo bloqueado por seguridad' tras la purga",
    /Archivo bloqueado por seguridad/.test(
      (await page.locator('[data-testid="media-blocked"]').first().innerText().catch(() => "")) ?? ""
    )
  );
} finally {
  await browser.close();
}

console.log(`\n=====${checks - failures}/${checks} checks OK, ${failures} fallos =====`);
process.exit(failures > 0 ? 1 : 0);
