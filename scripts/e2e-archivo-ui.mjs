/**
 * Self-test E2E de UI — 022: renombrar desde la Bandeja y archivar
 * conversaciones. Guiones: tests/e2e/us-nombre-contacto.md · us-archivo.md.
 * El contrato por API lo cubre scripts/e2e-archivo.mjs.
 *
 * Recorre como usuario (Playwright):
 *   a) panel Detalles: renombrar en línea (Enter guarda, Esc cancela, vacío
 *      → error sin perder lo escrito), línea gris con el nick, persiste al
 *      recargar
 *   b) archivar desde la cabecera: sale de Todas, aviso en el hilo, aparece en
 *      «Archivadas» con etiqueta; desarchivar desde el aviso; archivar desde
 *      la fila; un entrante la regresa sola (SSE, sin recargar)
 *   c) Ajustes → Bandeja: interruptor apagado por defecto, Calcular → conteo,
 *      confirmar → archivadas; guardar el interruptor persiste
 *   d) Seguimiento → Gestionar etapas: casilla «No archivar» persiste
 *   e) Vendedor: sin pestaña «Bandeja» en Ajustes ni acceso a la página
 *   f) móvil 375 px: botón Archivar en la cabecera y Ajustes sin scroll lateral
 *
 * Uso: node --env-file=.env.e2e scripts/e2e-archivo-ui.mjs (app viva + mocks)
 */
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const PN = "PN-E2E-ARCH-UI";
const S = Math.random().toString(36).slice(2, 6).toUpperCase();
const DAY = 24 * 60 * 60 * 1000;
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
// Tope amplio: en `next dev` una petición puede esperar en cola tras GETs
// lentos; cuando la app responde, la espera termina en el acto.
const soft = async (p, ms = 20000) => {
  try {
    await p(ms);
    return true;
  } catch {
    return false;
  }
};

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const req = ctx.request;

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
ok("login owner", r.ok());
await req.put(`${BASE}/api/settings/whatsapp`, {
  headers: { origin: BASE },
  data: { wabaId: "WABA-ARCH-UI", phoneNumberId: PN, token: "tok-arch-ui" },
});

let n = 0;
const SUF = String(Math.floor(Math.random() * 9e4) + 1e4);
const phone = () => `521558${SUF}${String(n++).padStart(2, "0")}`;
const inbound = (from, name, daysAgo = 0, text = "hola, informes") =>
  req.post(`${BASE}/api/dev/wa-mock/inbound`, {
    headers: { origin: BASE },
    data: {
      phoneNumberId: PN,
      from,
      name,
      text,
      waMessageId: `wamid.archui.${S}.${Math.random().toString(36).slice(2, 10)}`,
      timestamp: Math.floor((Date.now() - daysAgo * DAY) / 1000),
    },
  });

const NICK = `Dios es amor ${S}`;
const REAL = `María del Carmen ${S}`;
const ARCH = `Archivable ${S}`;
const OLD = `Vieja UI ${S}`;
const pNick = phone();
const pArch = phone();
const pOld = phone();
await inbound(pNick, NICK);
await inbound(pArch, ARCH);
await inbound(pOld, OLD, 20);
await sleep(2000);
const convs = (await (await req.get(`${BASE}/api/conversations`)).json()).conversations;
const byName = (name) => convs.find((c) => c.contact.name === name);
ok("las 3 conversaciones de prueba existen", !!(byName(NICK) && byName(ARCH) && byName(OLD)));
const archId = byName(ARCH)?.id;

// `next dev` compila cada ruta en su primera petición (hasta ~10 s): se
// precalientan las que el guion ejerce para que las esperas midan la app.
for (const [method, path] of [
  ["PATCH", `/api/contacts/${byName(NICK)?.contact.id}`],
  ["PATCH", `/api/conversations/${archId}`],
  ["POST", "/api/conversations/archive-inactive"],
  ["PUT", "/api/settings/inbox"],
  ["PATCH", "/api/pipeline/stages/stg_inexistente"],
  ["GET", "/api/pipeline/board"],
]) {
  await req.fetch(`${BASE}${path}`, { method, headers: { origin: BASE }, data: { invalid: true } }).catch(() => {});
}

const page = await ctx.newPage();
const row = (id) => page.locator(`li[data-conversation-id="${id}"]`);
const rowByText = (t) => page.locator("li[data-conversation-id]", { hasText: t });
const header = () => page.locator("header").filter({ has: page.getByRole("button", { name: "Mostrar detalles" }) }).first();

async function openConversation(name) {
  await rowByText(name).first().locator("button").first().click();
  await sleep(500);
}
async function ensurePanel() {
  const edit = page.getByRole("button", { name: "Editar nombre" });
  if (!(await edit.isVisible().catch(() => false))) {
    const show = page.getByRole("button", { name: "Mostrar detalles" });
    if (await show.isVisible().catch(() => false)) await show.click();
  }
  await edit.waitFor({ timeout: 8000 });
}

// ------------------------------------------------------------------ a
console.log("\n== a) Renombrar desde el panel Detalles ==");
await page.goto(`${BASE}/inbox`, { waitUntil: "load" });
await rowByText(NICK).first().waitFor({ timeout: 20000 });
await openConversation(NICK);
await ensurePanel();
await page.getByRole("button", { name: "Editar nombre" }).click();
const input = page.getByLabel("Nombre del contacto");
ok("el lápiz abre el campo con el nombre actual", (await input.inputValue()) === NICK);
await input.fill("Borrador que se descarta");
await input.press("Escape");
ok("Esc cancela sin guardar", await soft((ms) => page.getByLabel("Nombre del contacto").waitFor({ state: "detached", timeout: ms })));
ok("…y el nombre sigue igual", (await rowByText(NICK).count()) > 0);
await page.getByRole("button", { name: "Editar nombre" }).click();
await page.getByLabel("Nombre del contacto").fill("   ");
await page.getByLabel("Nombre del contacto").press("Enter");
ok("vacío → error visible", await soft((ms) => page.getByRole("alert").filter({ hasText: "vacío" }).first().waitFor({ timeout: ms })));
ok("…sin cerrar el campo", await page.getByLabel("Nombre del contacto").isVisible());
await page.getByLabel("Nombre del contacto").fill(REAL);
// En `next dev` el PATCH puede esperar en cola tras GETs lentos (compilación
// en frío + límite de conexiones por host): se mide desde su respuesta.
const saved = page
  .waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes("/api/contacts/"), { timeout: 45000 })
  .catch(() => null);
await page.getByLabel("Nombre del contacto").press("Enter");
const savedRes = await saved;
ok("Enter guarda (PATCH 200)", savedRes?.status() === 200, String(savedRes?.status()));
ok("la fila muestra el nombre nuevo sin recargar", await soft((ms) => rowByText(REAL).first().waitFor({ timeout: ms })));
const caption = page.getByTestId("profile-name");
ok(
  "línea gris con el nick original",
  await soft((ms) => caption.filter({ hasText: NICK }).first().waitFor({ timeout: ms })),
  await caption.first().innerText().catch(() => "(sin línea)")
);
ok("la línea nombra el canal", /WhatsApp/.test(await caption.first().innerText().catch(() => "")));
await page.reload({ waitUntil: "load" });
await rowByText(REAL).first().waitFor({ timeout: 20000 }).catch(() => {});
ok("el nombre persiste al recargar", (await rowByText(REAL).count()) > 0);
const box = page.getByLabel("Buscar conversación");
await box.fill(NICK);
ok("buscar por el nick encuentra al renombrado", await soft((ms) => rowByText(REAL).first().waitFor({ timeout: ms })));
await box.fill("");
await sleep(800);

// ------------------------------------------------------------------ b
console.log("\n== b) Archivar y desarchivar ==");
await openConversation(ARCH);
const hdrArchive = page.getByRole("button", { name: "Archivar", exact: true });
await hdrArchive.waitFor({ timeout: 8000 });
await hdrArchive.click();
ok("archivar desde la cabecera la saca de Todas", await soft((ms) => row(archId).waitFor({ state: "detached", timeout: ms })));
const note = page.getByRole("note", { name: "Conversación archivada" });
ok("el hilo sigue abierto con el aviso de archivada", await soft((ms) => note.waitFor({ timeout: ms })));
ok("la cabecera ofrece Desarchivar", await page.getByRole("button", { name: "Desarchivar", exact: true }).first().isVisible());
const pill = page.getByRole("button", { name: /^Archivadas/ });
ok("pastilla Archivadas con contador ≥ 1", /\d/.test(await pill.innerText()), await pill.innerText());
await pill.click();
ok("en Archivadas aparece la fila", await soft((ms) => row(archId).waitFor({ timeout: ms })));
ok("…con la etiqueta «Archivada»", (await row(archId).getByText("Archivada", { exact: true }).count()) > 0);
await note.getByRole("button", { name: "Desarchivar" }).click();
ok("desarchivar desde el aviso quita el aviso", await soft((ms) => note.waitFor({ state: "detached", timeout: ms })));
ok("…y la saca de Archivadas", await soft((ms) => row(archId).waitFor({ state: "detached", timeout: ms })));
await page.getByRole("button", { name: /^Todas/ }).click();
ok("vuelve a Todas", await soft((ms) => row(archId).waitFor({ timeout: ms })));
await row(archId).hover();
await row(archId).getByRole("button", { name: "Archivar conversación" }).click();
ok("archivar desde la fila (hover) la saca de Todas", await soft((ms) => row(archId).waitFor({ state: "detached", timeout: ms })));
await inbound(pArch, ARCH, 0, "¿siguen ahí?");
ok("un entrante la regresa a Todas sin recargar (SSE)", await soft((ms) => row(archId).waitFor({ timeout: ms }), 15000));
ok("…ya sin etiqueta «Archivada»", (await row(archId).getByText("Archivada", { exact: true }).count()) === 0);

// ------------------------------------------------------------------ c
console.log("\n== c) Ajustes → Bandeja ==");
await page.goto(`${BASE}/settings/inbox`, { waitUntil: "load" });
ok("pestaña Ajustes → Bandeja", (await page.locator('a[href="/settings/inbox"]').count()) > 0);
const sw = page.getByRole("switch", { name: "Archivar automáticamente conversaciones inactivas" });
await sw.waitFor({ timeout: 15000 });
await sleep(800);
ok("auto-archivo apagado por defecto", (await sw.getAttribute("aria-checked")) === "false");
ok("días por defecto 14", (await page.getByLabel("Días sin actividad").inputValue()) === "14");
ok("días de limpieza por defecto 14", (await page.getByLabel("Días de inactividad para limpiar").inputValue()) === "14");
await page.getByRole("button", { name: "Calcular" }).click();
const preview = page.getByRole("status").filter({ hasText: /Se archivar|No hay conversaciones/ });
ok("Calcular muestra el conteo", await soft((ms) => preview.first().waitFor({ timeout: ms })));
const pText = await preview.first().innerText().catch(() => "");
const nPrev = /Se archivará 1 /.test(pText) ? 1 : Number(/Se archivarán (\d+)/.exec(pText)?.[1] ?? 0);
ok("el conteo incluye la vieja (≥ 1)", nPrev >= 1, pText);
await page.getByRole("button", { name: /^Archivar \d+ conversaci/ }).click();
const done = page.getByRole("status").filter({ hasText: /Se archiv(ó|aron)/ });
ok("confirmar archiva y lo informa", await soft((ms) => done.first().waitFor({ timeout: ms })), pText);
const oldNow = (await (await req.get(`${BASE}/api/conversations?ids=${byName(OLD)?.id}`)).json()).conversations?.[0];
ok("la vieja quedó archivada (motivo bulk)", !!oldNow?.archivedAt && oldNow?.archivedReason === "bulk");
await page.getByLabel("Días de inactividad para limpiar").fill("0");
const calc = page.getByRole("button", { name: "Calcular" });
ok("días inválidos no calculan (botón deshabilitado o error)",
   (await calc.isDisabled()) || (await (async () => { await calc.click(); return soft((ms) => page.getByRole("alert").first().waitFor({ timeout: ms }), 4000); })()));
await sw.click();
await page.getByRole("button", { name: "Guardar" }).click();
ok("guardar muestra confirmación", await soft((ms) => page.getByText("Ajustes guardados").first().waitFor({ timeout: ms })));
await page.reload({ waitUntil: "load" });
await sw.waitFor({ timeout: 15000 });
await sleep(800);
ok("el interruptor encendido persiste", (await sw.getAttribute("aria-checked")) === "true");
await sw.click();
await page.getByRole("button", { name: "Guardar" }).click();
await soft((ms) => page.getByText("Ajustes guardados").first().waitFor({ timeout: ms }));

// ------------------------------------------------------------------ d
console.log("\n== d) Etapa «No archivar» ==");
await page.goto(`${BASE}/pipeline`, { waitUntil: "load" });
await page.getByRole("button", { name: /Gestionar etapas/ }).click();
const keep = page.getByLabel('No archivar automáticamente "Nuevo"', { exact: true });
ok("casilla «No archivar» por etapa", await soft((ms) => keep.waitFor({ timeout: ms })));
const was = await keep.isChecked();
await keep.click();
const stageKeep = async () =>
  ((await (await req.get(`${BASE}/api/pipeline/stages`)).json()).stages ?? []).find((s) => s.name === "Nuevo")?.keepActive;
let reached = false;
for (let i = 0; i < 40 && !reached; i++) {
  reached = (await stageKeep()) === !was;
  if (!reached) await sleep(250);
}
ok("el cambio llega al servidor", reached, String(await stageKeep()));
await page.reload({ waitUntil: "load" });
await page.getByRole("button", { name: /Gestionar etapas/ }).click();
await keep.waitFor({ timeout: 8000 });
ok("al reabrir, la casilla refleja lo guardado", (await keep.isChecked()) === !was);
await keep.click();
await sleep(1500);

// ------------------------------------------------------------------ e
console.log("\n== e) Vendedor ==");
const SELLER = `vend.archui.${S.toLowerCase()}@vocero.test`;
const alta = await req.post(`${BASE}/api/settings/team`, {
  headers: { origin: BASE },
  data: { name: `Vendedor UI ${S}`, email: SELLER, password: "password-vend-123" },
});
ok("alta del Vendedor", alta.status() === 201, String(alta.status()));
const sctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const sl = await sctx.request.post(`${BASE}/api/auth/sign-in/email`, {
  headers: { origin: BASE },
  data: { email: SELLER, password: "password-vend-123" },
});
ok("Vendedor con sesión", sl.ok());
const sp = await sctx.newPage();
await sp.goto(`${BASE}/settings/inbox`, { waitUntil: "load" });
await sleep(1000);
ok("el Vendedor no ve el interruptor de auto-archivo",
   (await sp.getByRole("switch", { name: "Archivar automáticamente conversaciones inactivas" }).count()) === 0, sp.url());
await sp.goto(`${BASE}/settings`, { waitUntil: "load" });
await sleep(1000);
ok("…ni la pestaña Ajustes → Bandeja", (await sp.locator('a[href="/settings/inbox"]').count()) === 0, sp.url());
await sp.goto(`${BASE}/inbox`, { waitUntil: "load" });
await sp.locator(`li[data-conversation-id="${archId}"]`).waitFor({ timeout: 20000 }).catch(() => {});
ok("el Vendedor ve el botón Archivar en la fila", (await sp.locator(`li[data-conversation-id="${archId}"]`).getByRole("button", { name: "Archivar conversación" }).count()) > 0);
await sctx.close();

// ------------------------------------------------------------------ f
console.log("\n== f) Móvil 375 px ==");
const mctx = await browser.newContext({ viewport: { width: 375, height: 800 }, storageState: await ctx.storageState() });
const mp = await mctx.newPage();
await mp.goto(`${BASE}/inbox?contact=${byName(ARCH)?.contact.id}`, { waitUntil: "load" });
await sleep(2500);
await mp.locator(`li[data-conversation-id="${archId}"] button`).first().click().catch(() => {});
const mArch = mp.getByRole("button", { name: "Archivar", exact: true });
ok("en móvil la cabecera tiene Archivar", await soft((ms) => mArch.first().waitFor({ timeout: ms })));
await mp.goto(`${BASE}/settings/inbox`, { waitUntil: "load" });
await sleep(1500);
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok("Ajustes → Bandeja sin scroll horizontal en 375 px", overflow <= 1, `overflow=${overflow}`);
await mctx.close();

await browser.close();
console.log(`\n${checks - failures}/${checks} checks OK`);
process.exit(failures ? 1 : 0);
