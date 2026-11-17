/**
 * Self-test E2E — 036 fase 2: importar contactos desde Excel DENTRO del CRM
 * (Contactos → Importar desde Excel, solo Propietario).
 * Spec: specs/036-importar-leads-evento/spec.md · Guion: tests/e2e/us-importar-leads.md
 * Diseño aprobado: specs/036-importar-leads-evento/diseno/*.dc.html
 *
 * Contra la app VIVA (mocks) y la BD AISLADA. Con cualquier valor de
 * LEADS_EXTERNOS (la importación desde la app NO depende de esa bandera;
 * correrlo con ella encendida y apagada):
 *
 *   a) setup: owner, equipo (Mariana, Jorge, dos «Ana…» para el ambiguo),
 *      un contacto que ya existe
 *   b) Entrada: el botón «Importar desde Excel» en Contactos → /contacts/importar
 *   c) la plantilla: hojas, encabezados, WhatsApp como texto + validación de
 *      10, Vendedor = lista de la hoja «Equipo» con los nombres del equipo
 *   d) errores de la vista previa (sin columnas, tipo no soportado) en línea
 *   e) subir el fixture (texto / número / HYPERLINK wa.me, inválido,
 *      repetido, vendedor desconocido, ambiguo, uno que ya es contacto):
 *      números exactos y CERO escrituras en la BD (contactos, mensajes,
 *      conversaciones, leads)
 *   f) importar → «Listo» con números exactos; tarjetas «Lead de evento»
 *      con el `lead_id` determinista del script; asignados a su vendedor;
 *      resultado .xlsx por renglón
 *   g) segunda importación igual: un lote que falla → «Reintentar lo que
 *      falta» → 0 nuevos, sin tarjetas nuevas
 *   h) Vendedor: sin botón, /contacts/importar 404 y las 4 rutas → 403
 *
 * Capturas de las 4 pantallas en specs/036-importar-leads-evento/capturas/
 * (o en `CAPTURAS_DIR`).
 *
 * Presupuesto del limitador de login: 2 (owner, vendedora; por API).
 *
 * Uso (BD aislada, app con .env.e2e):
 *   CATALOG_STORAGE=local node --env-file=.env.e2e scripts/e2e-importar-contactos.mjs
 *   (con la app levantada con LEADS_EXTERNOS=on y también sin ella)
 * Sale con 1 si algún check falla.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import postgres from "postgres";
import { chromium } from "playwright";
import { leadIdFor } from "../src/lib/contact-import/core.mjs";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const S = Math.random().toString(36).slice(2, 7);
const SUF = String(Date.now()).slice(-6);
const PN = "PN-E2E-036B";
const CAPTURAS = process.env.CAPTURAS_DIR ?? "specs/036-importar-leads-evento/capturas";
const FLAG = ["on", "1", "true", "si", "sí", "yes"].includes((process.env.LEADS_EXTERNOS ?? "").trim().toLowerCase());

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

function session() {
  const jar = { cookie: "" };
  async function api(p, opts = {}) {
    const res = await fetch(`${BASE}${p}`, {
      ...opts,
      headers: {
        ...(opts.rawBody ? {} : { "content-type": "application/json" }),
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
  return { jar, api };
}
const owner = session();
const mariana = session();
const body = (o) => JSON.stringify(o);
const short = (r) => `${r.res.status} ${JSON.stringify(r.json)?.slice(0, 260)}`;
const toCookies = (jar) =>
  jar.cookie
    .split("; ")
    .filter(Boolean)
    .map((kv) => {
      const i = kv.indexOf("=");
      return { name: kv.slice(0, i), value: kv.slice(i + 1), url: BASE };
    });

const OWNER = { email: "e2e@vocero.test", password: "password-e2e-123", name: "Operador E2E" };
const TEAM = {
  mariana: { name: `Mariana${S} López`, email: `mariana.${S}@vocero.test`, password: "password-mariana-036" },
  jorge: { name: `Jorge${S} Ruiz`, email: `jorge.${S}@vocero.test`, password: "password-jorge-036" },
  anaT: { name: `Ana${S} Torres`, email: `anat.${S}@vocero.test`, password: "password-anat-036" },
  anaP: { name: `Ana${S} Pérez`, email: `anap.${S}@vocero.test`, password: "password-anap-036" },
};
const EVENT = `Expo E2E ${S}`;
/** 10 dígitos únicos por corrida. */
const ten = (n) => `57${SUF}${String(n).padStart(2, "0")}`;
const P = {
  ana: ten(1),
  beto: ten(2),
  caro: ten(3),
  fede: ten(5),
  gina: ten(6),
  existente: ten(7),
  hugo: ten(8),
};
const NAME = (k) => `${k} ${S}`;

let ids = {};
let tmp;
let browser;

/* ───────────────────────── setup ───────────────────────── */

async function setup() {
  console.log(`== a) Setup (LEADS_EXTERNOS ${FLAG ? "on" : "off"}) ==`);
  let su = await owner.api("/api/auth/sign-up/email", { method: "POST", body: body(OWNER) });
  if (!su.res.ok) su = await owner.api("/api/auth/sign-in/email", { method: "POST", body: body({ email: OWNER.email, password: OWNER.password }) });
  ok("owner con sesión", su.res.ok, short(su));
  await owner.api("/api/settings/whatsapp", { method: "PUT", body: body({ wabaId: "WABA-E2E-036B", phoneNumberId: PN, token: "tok-e2e-036b" }) });
  for (const p of Object.values(TEAM)) {
    const alta = await owner.api("/api/settings/team", { method: "POST", body: body(p) });
    ok(`alta de ${p.name}`, alta.res.status === 201, short(alta));
  }
  const lm = await mariana.api("/api/auth/sign-in/email", { method: "POST", body: body({ email: TEAM.mariana.email, password: TEAM.mariana.password }) });
  ok("Mariana inicia sesión", lm.res.ok, short(lm));
  const team = (await owner.api("/api/settings/team")).json?.members ?? [];
  ids.team = team;
  ids.mariana = team.find((m) => m.email === TEAM.mariana.email)?.userId;
  ids.jorge = team.find((m) => m.email === TEAM.jorge.email)?.userId;
  ok("ids del equipo", !!ids.mariana && !!ids.jorge);
  const ct = await owner.api("/api/contacts", { method: "POST", body: body({ name: NAME("Existente"), phone: `52${P.existente}` }) });
  ids.existente = ct.json?.contact?.id ?? ct.json?.id;
  ok("un contacto que ya existe (alta manual, 52 + 10)", ct.res.ok && !!ids.existente, short(ct));
  if (!FLAG) {
    const off = await fetch(`${BASE}/api/intake/lead`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "x".repeat(43) }, body: "{}" });
    ok("con LEADS_EXTERNOS apagada la entrada del ERP es 404 (y la app importa igual)", off.status === 404, String(off.status));
  }
}

/** Fixture: texto / número / HYPERLINK, inválido, repetido, desconocido, ambiguo, existente, sin vendedor. */
async function fixture(file) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Hoja1");
  ws.addRow(["Nombre", "WhatsApp", "Vendedor", "Modelo de interés", "Comentarios", "Correo", "¿Aceptó que le escribamos por WhatsApp?"]);
  const sp = (d) => `${d.slice(0, 2)} ${d.slice(2, 6)} ${d.slice(6)}`;
  ws.addRow([NAME("Ana"), sp(P.ana), `Mariana${S}`, "Dolphin", "Vino el sábado", `ana.${S}@example.com`, "Sí"]); // 2 texto
  ws.addRow([NAME("Beto"), Number(P.beto), `Jorge${S} Ruiz`, "", "", "", "No"]); // 3 número, nombre completo
  ws.addRow([NAME("Caro"), { formula: `HYPERLINK("https://wa.me/521${P.caro}","Enviar WhatsApp")`, result: "Enviar WhatsApp" }, `mariana${S}`, "", "", "", ""]); // 4 enlace
  ws.addRow([NAME("Dani"), "55 1234 567", `Mariana${S}`, "", "", "", ""]); // 5 le falta un dígito
  ws.addRow([NAME("Eva"), `+52 ${sp(P.ana)}`, `Mariana${S}`, "", "", "", ""]); // 6 repetido del 2
  ws.addRow([NAME("Fede"), P.fede, `Lupita${S}`, "", "", "", ""]); // 7 nadie se llama así
  ws.addRow([NAME("Gina"), P.gina, `Ana${S}`, "", "", "", ""]); // 8 ambiguo
  ws.addRow([NAME("Existente Excel"), P.existente, "", "", "", "", ""]); // 9 ya es contacto
  ws.addRow([NAME("Hugo"), P.hugo, "", "", "", "", ""]); // 10 sin vendedor
  await wb.xlsx.writeFile(file);
}

async function counts(db) {
  const [r] = await db`select
    (select count(*)::int from vocero.contact) as contacts,
    (select count(*)::int from vocero.message) as messages,
    (select count(*)::int from vocero.conversation) as conversations,
    (select count(*)::int from vocero.lead) as leads`;
  return r;
}

/** Captura de la pantalla completa: el contenido tiene su propio scroll, así que se agranda la ventana. */
async function shot(page, file, { full = true } = {}) {
  mkdirSync(CAPTURAS, { recursive: true });
  const h = !full ? 860 : await page.evaluate(() => Math.max(...[...document.querySelectorAll("div")].map((d) => d.scrollHeight))).catch(() => 900);
  await page.setViewportSize({ width: 1366, height: Math.min(Math.max(900, h + 40), 2400) });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(CAPTURAS, file), animations: "disabled", caret: "hide" }).catch(() => {});
  await page.setViewportSize({ width: 1366, height: 900 });
}

async function launch() {
  try {
    return await chromium.launch();
  } catch {
    return chromium.launch({ channel: "msedge" });
  }
}

async function pageAs(sess) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true, locale: "es-MX" });
  await ctx.addCookies(toCookies(sess.jar));
  const page = await ctx.newPage();
  return { ctx, page };
}

/* ───────────────────────── propietario ───────────────────────── */

async function ownerFlow(db) {
  const { ctx, page } = await pageAs(owner);
  const fixtureFile = path.join(tmp, `lista-expo-${S}.xlsx`);
  await fixture(fixtureFile);

  console.log("\n== b) Entrada ==");
  await page.goto(`${BASE}/contacts`, { waitUntil: "load" });
  const link = page.getByRole("link", { name: "Importar desde Excel" });
  await link.waitFor({ timeout: 20000 }).catch(() => {});
  ok("Contactos: botón «Importar desde Excel» junto a «Nuevo contacto»", await link.isVisible().catch(() => false));
  await page.getByText(NAME("Existente")).first().waitFor({ timeout: 20000 }).catch(() => {});
  await shot(page, "0-entrada.png", { full: false });
  await link.click();
  await page.waitForURL(/\/contacts\/importar$/, { timeout: 20000 }).catch(() => {});
  ok("lleva a /contacts/importar", page.url().endsWith("/contacts/importar"), page.url());
  await page.waitForLoadState("load");
  await page.getByRole("heading", { name: "Importar contactos desde Excel" }).waitFor({ timeout: 20000 }).catch(() => {});
  ok("paso 1 «Subir la lista» marcado", (await page.locator('[aria-current="step"]').innerText().catch(() => "")).includes("Subir la lista"));
  ok("sin `title` (tooltips) en la pantalla", (await page.locator("main [title], [data-testid^=import] [title]").count()) === 0);

  console.log("\n== c) Plantilla ==");
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), page.getByTestId("import-template").click()]);
  ok("nombre del archivo de la plantilla", dl.suggestedFilename() === "plantilla-importar-contactos.xlsx", dl.suggestedFilename());
  const tplPath = path.join(tmp, "plantilla.xlsx");
  await dl.saveAs(tplPath);
  const tpl = new ExcelJS.Workbook();
  await tpl.xlsx.readFile(tplPath);
  ok("hojas Leads, Instrucciones, Equipo", tpl.worksheets.map((w) => w.name).join(",") === "Leads,Instrucciones,Equipo", tpl.worksheets.map((w) => w.name).join(","));
  const leads = tpl.getWorksheet("Leads");
  ok(
    "encabezados en orden",
    JSON.stringify(leads.getRow(1).values.slice(1)) ===
      JSON.stringify(["Nombre", "WhatsApp", "Vendedor", "Modelo de interés", "Comentarios", "Correo", "¿Aceptó que le escribamos por WhatsApp?"]),
    JSON.stringify(leads.getRow(1).values)
  );
  ok("WhatsApp en formato texto", leads.getCell("B2").numFmt === "@" && leads.getCell("B2001").numFmt === "@");
  const dv = leads.dataValidations.model;
  ok("WhatsApp: validación de 10 caracteres con mensaje", dv.B2?.type === "textLength" && dv.B2?.formulae?.[0] === 10 && /10 dígitos/.test(dv.B2?.error ?? ""), JSON.stringify(dv.B2));
  const equipo = tpl.getWorksheet("Equipo");
  const names = [];
  for (let r = 2; r <= equipo.rowCount; r++) names.push(String(equipo.getCell(r, 1).value ?? ""));
  const expected = [...new Set(ids.team.map((m) => m.name))].sort((a, b) => a.localeCompare(b, "es"));
  ok("hoja Equipo = los nombres del equipo de hoy", JSON.stringify(names) === JSON.stringify(expected), `${names.length} vs ${expected.length}`);
  ok("Vendedor: lista que apunta a la hoja Equipo", dv.C2?.type === "list" && dv.C2?.formulae?.[0] === `Equipo!$A$2:$A$${names.length + 1}`, JSON.stringify(dv.C2));
  ok("¿Aceptó…?: lista Sí/No", dv.G2?.type === "list" && dv.G2?.formulae?.[0] === '"Sí,No"');

  console.log("\n== d) Errores de la vista previa ==");
  const sinCols = path.join(tmp, "sin-columnas.csv");
  writeFileSync(sinCols, "Cliente,Tel\nAna,5512345678\n");
  const review = page.getByTestId("import-review");
  await page.getByTestId("import-event").fill(EVENT);
  await page.getByTestId("import-file").setInputFiles(sinCols);
  const state = page.getByTestId("import-file-state");
  await state.getByText("No encontré las columnas").waitFor({ timeout: 20000 }).catch(() => {});
  ok("sin columnas: dice cuáles necesita", /«Nombre» y «WhatsApp»/.test(await state.innerText().catch(() => "")), await state.innerText().catch(() => ""));
  ok("«Revisar la lista» deshabilitado con error", await review.isDisabled());
  const txt = path.join(tmp, "lista.txt");
  writeFileSync(txt, "hola");
  await page.getByTestId("import-file").setInputFiles(txt);
  await state.getByText("Solo se leen archivos").waitFor({ timeout: 10000 }).catch(() => {});
  ok("tipo no soportado: mensaje en línea", (await state.innerText().catch(() => "")).includes("Solo se leen archivos de Excel"));
  const pdfApi = await owner.api("/api/contacts/import/preview", {
    method: "POST",
    rawBody: true,
    body: (() => {
      const f = new FormData();
      f.set("file", new Blob([Buffer.from("%PDF-1.4")]), "lista.xlsx");
      return f;
    })(),
  });
  ok("API: un PDF disfrazado de .xlsx → 415 por la firma", pdfApi.res.status === 415, short(pdfApi));

  console.log("\n== e) Vista previa: números exactos y cero escrituras ==");
  const before = await counts(db);
  await page.getByTestId("import-file").setInputFiles(fixtureFile);
  await state.getByText("9 renglones").waitFor({ timeout: 30000 }).catch(() => {});
  const stateText = await state.innerText().catch(() => "");
  ok("archivo elegido: nombre, 9 renglones y columnas reconocidas", stateText.includes(`lista-expo-${S}.xlsx`) && stateText.includes("9 renglones") && stateText.includes("columnas: Nombre, WhatsApp, Vendedor, Modelo de interés, Comentarios, Correo"), stateText);
  ok("«Revisar la lista» habilitado con evento y archivo", await review.isEnabled());
  await page.getByTestId("import-event").fill("");
  ok("sin nombre de evento, deshabilitado", await review.isDisabled());
  await page.getByTestId("import-event").fill(EVENT);
  await shot(page, "1-subir.png");
  await review.click();
  await page.getByRole("heading", { name: "Revisa la lista antes de importar" }).waitFor({ timeout: 20000 }).catch(() => {});
  const n = async (id) => Number((await page.getByTestId(`${id}-n`).innerText().catch(() => "-1")).replace(/\D/g, ""));
  ok("7 listos para importar", (await n("stat-ready")) === 7);
  ok("«1 de ellos ya está en tus contactos…»", (await page.getByTestId("stat-ready").innerText()).includes("1 de ellos ya está en tus contactos"));
  ok("1 con problema", (await n("stat-invalid")) === 1);
  ok("1 repetido", (await n("stat-repeated")) === 1);
  const sellers = await page.getByTestId("import-sellers").innerText().catch(() => "");
  ok("vendedores: «Mariana…» y «mariana…» (primer nombre) → una línea, Mariana López, 2 chats", new RegExp(`«Mariana${S}» → ${TEAM.mariana.name}\\s+2 chats`).test(sellers), sellers);
  ok("vendedores: nombre completo → Jorge Ruiz", sellers.includes(`«Jorge${S} Ruiz» → ${TEAM.jorge.name}`), sellers);
  ok("vendedores: desconocido → «nadie del equipo se llama así» al Buzón", new RegExp(`«Lupita${S}» → nadie del equipo se llama así\\s+1 chat al Buzón, sin asignar`).test(sellers), sellers);
  ok("vendedores: ambiguo → «coincide con más de una persona»", sellers.includes(`«Ana${S}» → coincide con más de una persona del equipo`), sellers);
  ok("vendedores: «Sin vendedor anotado · 2 chats al Buzón»", /Sin vendedor anotado\s+2 chats al Buzón, sin asignar/.test(sellers), sellers);
  const table = page.getByTestId("import-rows");
  const tableText = await table.innerText().catch(() => "");
  ok("filtro inicial «Con problema»: renglón 5 «Le falta un dígito»", tableText.includes("Le falta un dígito (deben ser 10)") && !tableText.includes(NAME("Ana")), tableText);
  await page.getByRole("button", { name: /^Repetidos · 1$/ }).click();
  ok("«Repetidos»: «Repetido del renglón 2»", (await table.innerText()).includes("Repetido del renglón 2"));
  await page.getByRole("button", { name: /^Todos · 9$/ }).click();
  const all = await table.innerText();
  ok("«Todos · 9»: el existente dice que ya está", all.includes("Ya está en tus contactos") && all.includes("Contacto nuevo"));
  await page.getByRole("button", { name: /^Con problema · 1$/ }).click();
  ok("botón «Importar 7 contactos»", (await page.getByTestId("import-run").innerText()).includes("Importar 7 contactos"));
  ok("«Todavía no se ha guardado nada»", await page.getByText("Todavía no se ha guardado nada").isVisible());
  await shot(page, "2-revisar.png");
  const afterPreview = await counts(db);
  ok("la vista previa NO escribió nada (contactos, mensajes, conversaciones, leads)", JSON.stringify(before) === JSON.stringify(afterPreview), `${JSON.stringify(before)} → ${JSON.stringify(afterPreview)}`);

  console.log("\n== f) Importar ==");
  await page.getByTestId("import-run").click();
  await page.getByTestId("import-done").waitFor({ timeout: 60000 }).catch(() => {});
  const num = async (id) => Number((await page.getByTestId(`done-${id}`).locator("dd").innerText().catch(() => "-1")).replace(/\D/g, ""));
  ok("«Listo: 7 contactos de «evento»»", (await page.getByRole("heading", { level: 1 }).innerText()).includes(`Listo: 7 contactos de «${EVENT}»`));
  ok("Contactos nuevos: 6", (await num("created")) === 6, String(await num("created")));
  ok("Ya estaban (con tarjeta nueva): 1", (await num("existing")) === 1, String(await num("existing")));
  ok("Asignados a su vendedor: 3", (await num("assigned")) === 3, String(await num("assigned")));
  ok("En el Buzón, sin asignar: 4", (await num("buzon")) === 4, String(await num("buzon")));
  const next = await page.getByTestId("import-next").innerText().catch(() => "");
  ok("Lo que sigue: Mis chats, los 4 del Buzón, los 2 renglones que no entraron", next.includes("Mis chats") && next.includes("Los 4 del Buzón") && next.includes("Los 2 renglones que no entraron (1 con problema, 1 repetido)"), next);
  ok("botón «Ver en la Bandeja» → /inbox", (await page.getByTestId("import-inbox").getAttribute("href")) === "/inbox");
  await shot(page, "3-listo.png");
  const afterImport = await counts(db);
  ok("6 contactos nuevos y 7 tarjetas en la BD", afterImport.contacts - before.contacts === 6 && afterImport.messages - before.messages === 7, `${JSON.stringify(before)} → ${JSON.stringify(afterImport)}`);

  // Bandeja: tarjeta, evento, lead_id del script y asignación.
  const conv = async (digits) => {
    const list = (await owner.api(`/api/conversations?q=${digits}`)).json?.conversations ?? [];
    return list.find((c) => c.contact?.phone === `52${digits}`) ?? null;
  };
  const cAna = await conv(P.ana);
  const msgs = (await owner.api(`/api/conversations/${cAna?.id}/messages`)).json?.messages ?? [];
  const card = msgs.find((m) => m.type === "lead_intake")?.text ?? "";
  ok("la Bandeja trae la conversación con la tarjeta «Lead de evento»", card.startsWith("Lead de evento\n") && card.includes(`Evento: ${EVENT}`) && card.includes(`Vendedor: Mariana${S}`) && card.includes("Autorizó WhatsApp: Sí"), card);
  const [wamid] = await db`select wa_message_id from vocero.message where conversation_id = ${cAna?.id ?? ""} and type = 'lead_intake'`;
  ok("mismo lead_id que el script (evento + WhatsApp)", wamid?.wa_message_id === `intake:${leadIdFor(EVENT, `52${P.ana}`)}`, wamid?.wa_message_id);
  ok("Ana → Mariana", cAna?.assignedTo?.userId === ids.mariana, JSON.stringify(cAna?.assignedTo));
  ok("Beto (número) → Jorge", (await conv(P.beto))?.assignedTo?.userId === ids.jorge);
  ok("Caro (HYPERLINK wa.me/521…) → Mariana", (await conv(P.caro))?.assignedTo?.userId === ids.mariana);
  ok("Fede (desconocido), Gina (ambiguo) y Hugo: sin asignar", [(await conv(P.fede))?.assignedTo, (await conv(P.gina))?.assignedTo, (await conv(P.hugo))?.assignedTo].every((a) => a === null));
  const cEx = await conv(P.existente);
  ok("el existente: misma persona, su nombre no cambia", cEx?.contact?.id === ids.existente && cEx?.contact?.name === NAME("Existente"), JSON.stringify(cEx?.contact));
  const marianaList = (await mariana.api("/api/conversations?assigned=me")).json?.conversations ?? [];
  ok("Mariana ve a Ana y Caro en sus chats", [P.ana, P.caro].every((d) => marianaList.some((c) => c.contact?.phone === `52${d}`)), String(marianaList.length));

  const [rdl] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), page.getByTestId("import-result").click()]);
  const resPath = path.join(tmp, "resultado.xlsx");
  await rdl.saveAs(resPath);
  const rwb = new ExcelJS.Workbook();
  await rwb.xlsx.readFile(resPath);
  const rws = rwb.worksheets[0];
  const rrows = [];
  rws.eachRow((row, i) => i > 1 && rrows.push(row.values.slice(1).map((v) => String(v ?? ""))));
  ok("resultado .xlsx: 9 renglones con encabezados", rrows.length === 9 && JSON.stringify(rws.getRow(1).values.slice(1)) === JSON.stringify(["Renglón", "Nombre", "WhatsApp", "Vendedor", "Resultado", "Asignación"]), `${rrows.length}`);
  const byRow = Object.fromEntries(rrows.map((r) => [r[0], r]));
  ok("renglón 2: Contacto nuevo · Asignado a Mariana", byRow["2"]?.[4] === "Contacto nuevo" && byRow["2"]?.[5] === `Asignado a ${TEAM.mariana.name}`, JSON.stringify(byRow["2"]));
  ok("renglón 5: no se importó (le falta un dígito)", (byRow["5"]?.[4] ?? "").startsWith("No se importó: Le falta un dígito"), JSON.stringify(byRow["5"]));
  ok("renglón 9: ya estaba · Buzón", byRow["9"]?.[4] === "Ya estaba: tarjeta nueva" && byRow["9"]?.[5] === "Buzón, sin asignar", JSON.stringify(byRow["9"]));

  console.log("\n== g) Segunda importación igual (con un lote que falla) ==");
  await page.getByRole("button", { name: "Importar otra lista" }).click();
  await page.getByTestId("import-event").fill(EVENT);
  await page.getByTestId("import-file").setInputFiles(fixtureFile);
  await state.getByText("9 renglones").waitFor({ timeout: 30000 }).catch(() => {});
  await review.click();
  await page.getByTestId("stat-ready").waitFor({ timeout: 20000 }).catch(() => {});
  ok("ahora los 7 ya están en tus contactos", (await page.getByTestId("stat-ready").innerText()).includes("7 de ellos ya están en tus contactos"));
  let failed = false;
  await page.route("**/api/contacts/import", (route) => {
    if (!failed && route.request().method() === "POST") {
      failed = true;
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Error interno" } }) });
    }
    return route.continue();
  });
  await page.getByTestId("import-run").click();
  await page.getByTestId("import-error").waitFor({ timeout: 20000 }).catch(() => {});
  ok("un lote que falla: error en línea", (await page.getByTestId("import-error").innerText().catch(() => "")).includes("Se detuvo en 0 de 7"));
  ok("el botón pasa a «Reintentar lo que falta»", (await page.getByTestId("import-run").innerText()).includes("Reintentar lo que falta"));
  await page.unroute("**/api/contacts/import");
  await page.getByTestId("import-run").click();
  await page.getByTestId("import-done").waitFor({ timeout: 60000 }).catch(() => {});
  ok("reintento → Listo: 0 nuevos, 0 con tarjeta nueva", (await num("created")) === 0 && (await num("existing")) === 0);
  ok("y dice que ya se habían importado", (await page.getByTestId("import-next").innerText()).includes("7 ya se habían importado con este evento"));
  const afterSecond = await counts(db);
  ok("la segunda importación no escribió tarjetas ni contactos", JSON.stringify(afterSecond) === JSON.stringify(afterImport), `${JSON.stringify(afterImport)} → ${JSON.stringify(afterSecond)}`);

  await ctx.close();
}

/* ───────────────────────── vendedora ───────────────────────── */

async function sellerFlow() {
  console.log("\n== h) Vendedora ==");
  const { ctx, page } = await pageAs(mariana);
  await page.goto(`${BASE}/contacts`, { waitUntil: "load" });
  await page.getByRole("button", { name: "Nuevo contacto" }).waitFor({ timeout: 20000 }).catch(() => {});
  ok("Contactos de la vendedora: sin «Importar desde Excel»", (await page.getByRole("link", { name: "Importar desde Excel" }).count()) === 0);
  const res = await page.goto(`${BASE}/contacts/importar`, { waitUntil: "load" });
  ok("/contacts/importar → 404 para la vendedora", res?.status() === 404, String(res?.status()));
  await ctx.close();
  const form = new FormData();
  form.set("file", new Blob(["Nombre,WhatsApp\nA,5512345678\n"]), "l.csv");
  const calls = [
    ["GET /api/contacts/import/template", mariana.api("/api/contacts/import/template")],
    ["POST /api/contacts/import/preview", mariana.api("/api/contacts/import/preview", { method: "POST", rawBody: true, body: form })],
    ["POST /api/contacts/import", mariana.api("/api/contacts/import", { method: "POST", body: body({ event: "X", rows: [{ rowNumber: 2, name: "A", phone: "5512345678" }] }) })],
    ["POST /api/contacts/import/result", mariana.api("/api/contacts/import/result", { method: "POST", body: body({ event: "X", rows: [] }) })],
  ];
  for (const [label, p] of calls) {
    const r = await p;
    ok(`${label} → 403 para la vendedora`, r.res.status === 403 && r.json?.error?.code === "forbidden", short(r));
  }
  const anon = await fetch(`${BASE}/api/contacts/import/template`);
  ok("sin sesión → 401", anon.status === 401, String(anon.status));
}

/* ───────────────────────── main ───────────────────────── */

async function main() {
  const db = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  tmp = mkdtempSync(path.join(tmpdir(), "e2e-036b-"));
  try {
    await setup();
    browser = await launch();
    await ownerFlow(db);
    await sellerFlow();
  } catch (err) {
    ok("el guion terminó sin excepción", false, String(err?.stack ?? err));
  } finally {
    await browser?.close().catch(() => {});
    await db.end().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n=====${checks - failures}/${checks} checks OK, ${failures} fallos =====`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
