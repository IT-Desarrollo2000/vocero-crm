/**
 * Self-test E2E — Leads externos (dev-tasks/11-leads-del-formulario-web.md).
 * Guion humano: tests/e2e/us-leads-externos.md
 *
 * Conduce la app real (HTTP + Playwright) como lo haría el ERP del negocio
 * (`POST /api/intake/lead` con `X-API-Key`) y como lo verían el Propietario y
 * un Vendedor.
 *
 * Con LEADS_EXTERNOS encendida (en el server Y en este proceso):
 *   a) owner + WhatsApp (wa-mock) + agente encendido + alta de un vendedor
 *   b) Ajustes: vendedor 403, sin sesión 401; sin clave el endpoint da 401
 *   c) generar clave: completa una sola vez, después solo últimos 4
 *   d) clave mala 401 · cuerpo inválido 422 · teléfono inválido 422
 *   e) alta `website` (10 dígitos con espacios) → 201: contacto 52+10,
 *      conversación sin asignar, tarjeta, lead en Seguimiento, fuente «Sitio
 *      web», correo en la ficha, compositor en modo plantilla
 *   f) mismo lead_id 2× → 200 duplicate, una sola tarjeta y un solo no leído
 *   g) mismo teléfono por `fast_app` (+52 1 …) → misma conversación, 2 tarjetas
 *      (el nombre del lead va a `name`, nunca a `profileName`)
 *   g2) (022) un lead nuevo desarchiva la conversación archivada; un
 *      `lead_id` repetido no
 *   h) el Vendedor la ve (sin asignar) y lee sus mensajes
 *   i) el agente no corre: sin salientes y sin escalamiento (ventana)
 *   j) métricas del agente (M1/M4/M8) sin cambios por las tarjetas
 *   k) Ajustes: último lead por origen · /api/bot/typing ignora `intake:%`
 *   l) Playwright: la Bandeja abierta pinta la conversación nueva EN VIVO, la
 *      pestaña en segundo plano recibe UNA alerta, el hilo muestra la tarjeta
 *      y el compositor ofrece solo plantilla; Ajustes muestra la pestaña y la
 *      clave nueva una sola vez; el Vendedor no ve la pestaña
 *   m) el prospecto escribe por WhatsApp → misma conversación, ventana
 *      abierta, nombre conservado (el nick va a profileName), el agente sí
 *      responde
 *   n) rotar invalida la clave vieja al instante · revocar → 401
 *   o) 429 por el límite global (al final: agota el cupo del minuto)
 *
 * Con LEADS_EXTERNOS apagada: endpoint, API de Ajustes y página en 404, y la
 * pestaña no aparece.
 *
 * Presupuesto del limitador de login: 2 POST (owner sign-up/in, vendedor).
 *
 * Uso (BD aislada, ver memoria e2e-bd-aislada):
 *   CATALOG_STORAGE=local node --env-file=.env.e2e.011 scripts/e2e-leads-externos.mjs
 *   LEADS_EXTERNOS=off CATALOG_STORAGE=local node --env-file=.env.e2e.011 scripts/e2e-leads-externos.mjs
 *
 * Sale con código 1 si algún check falla.
 */

import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const BOT_KEY = process.env.BOT_API_KEY;
const ON = ["on", "1", "true", "si", "sí", "yes"].includes(
  (process.env.LEADS_EXTERNOS ?? "").trim().toLowerCase()
);
const S = Math.random().toString(36).slice(2, 8);
const PN = "PN-E2E-LEADS";

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
      const v = await fn();
      if (v) return v;
    } catch {
      /* reintenta */
    }
    if (Date.now() - t0 > ms) return null;
    await sleep(250);
  }
};
const body = (o) => JSON.stringify(o);
const short = (r) => `${r.res.status} ${JSON.stringify(r.json)?.slice(0, 240)}`;

const owner = client();
const seller = client();
const anon = client();
const OWNER_EMAIL = "e2e@vocero.test";
const OWNER_PASSWORD = "password-e2e-123";
const SELLER_EMAIL = `vend.leads.${S}@vocero.test`;
const SELLER_PASSWORD = "password-vend-leads-123";

/** 10 dígitos de un celular de CDMX que nadie más usa en la corrida. */
const ten = () => `55${Math.floor(Math.random() * 9e7 + 1e7)}`;

function postLead(key, payload) {
  return anon.api("/api/intake/lead", {
    method: "POST",
    headers: key === null ? {} : { "x-api-key": key },
    body: typeof payload === "string" ? payload : body(payload),
  });
}

function lead(over = {}) {
  return {
    lead_id: randomUUID(),
    origin: "website",
    first_name: "Prospecto",
    phone: ten(),
    ...over,
  };
}

async function convById(c, id) {
  return (await c.api(`/api/conversations?ids=${encodeURIComponent(id)}`)).json?.conversations?.[0] ?? null;
}
async function messagesOf(c, id) {
  return (await c.api(`/api/conversations/${id}/messages`)).json?.messages ?? [];
}

function toCookies(jar) {
  return jar.cookie
    .split("; ")
    .filter(Boolean)
    .map((kv) => {
      const i = kv.indexOf("=");
      return { name: kv.slice(0, i), value: kv.slice(i + 1), url: BASE };
    });
}

/** Stub de `Notification` (mismo que e2e-alertas): anota cada aviso. */
function notificationStub(cfg) {
  const PERM = "__e2ePerm";
  const NOTES = "__e2eNotes";
  const readPerm = () => localStorage.getItem(PERM) ?? cfg.permission;
  const record = (n) => {
    const all = JSON.parse(sessionStorage.getItem(NOTES) ?? "[]");
    all.push(n);
    sessionStorage.setItem(NOTES, JSON.stringify(all));
  };
  class FakeNotification {
    constructor(title, opts = {}) {
      this.title = title;
      this.onclick = null;
      record({ title, body: opts.body ?? null, tag: opts.tag ?? null });
    }
    close() {}
    static get permission() {
      return readPerm();
    }
    static async requestPermission() {
      if (cfg.grantTo) localStorage.setItem(PERM, cfg.grantTo);
      return readPerm();
    }
  }
  window.Notification = FakeNotification;
}
const notesOf = (page) =>
  page.evaluate(() => JSON.parse(sessionStorage.getItem("__e2eNotes") ?? "[]"));

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch {
    return chromium.launch({ channel: "msedge" });
  }
}

async function login() {
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
  ok("owner con sesión", su.res.ok, short(su));
}

async function agentReport() {
  const r = await owner.api("/api/reports/agent?range=30d");
  const d = (b) => (r.json?.[b]?.ok ? r.json[b].data : null);
  const volIn = (d("volume")?.rows ?? []).reduce((n, row) => n + (row.inbound ?? 0), 0);
  const sessions = JSON.stringify(d("responseTimes"));
  return { ok: r.res.ok, active: d("attention")?.active ?? null, volIn, sessions, raw: r };
}

/* ───────────────────────────── bandera apagada ───────────────────────────── */

async function offChecks() {
  console.log("== Bandera LEADS_EXTERNOS apagada: todo en 404 ==");
  await login();
  const r = await postLead("cualquier-clave", lead());
  ok("POST /api/intake/lead → 404", r.res.status === 404, short(r));
  const r2 = await postLead(null, "{}");
  ok("POST /api/intake/lead sin clave ni cuerpo → 404 (no 401/422)", r2.res.status === 404, short(r2));
  for (const method of ["GET", "PUT", "DELETE"]) {
    const s = await owner.api("/api/settings/intake", { method });
    ok(`${method} /api/settings/intake (owner) → 404`, s.res.status === 404, short(s));
  }
  const page = await owner.api("/settings/leads-externos", { headers: { accept: "text/html" } });
  ok("página /settings/leads-externos → 404", page.res.status === 404, String(page.res.status));
  const acc = await owner.api("/settings/account", { headers: { accept: "text/html" } });
  const html = await acc.res.text();
  ok(
    "la pestaña «Leads externos» no aparece en Ajustes (y las demás sí)",
    acc.res.status === 200 && html.includes("/settings/whatsapp") && !html.includes("/settings/leads-externos"),
    String(acc.res.status)
  );
}

/* ───────────────────────────── bandera encendida ─────────────────────────── */

async function onChecks() {
  console.log("== a) Owner, WhatsApp, agente y vendedor ==");
  await login();
  const conn = await owner.api("/api/settings/whatsapp", {
    method: "PUT",
    body: body({ wabaId: "WABA-E2E-LEADS", phoneNumberId: PN, token: "tok-e2e-leads" }),
  });
  ok("owner conecta WhatsApp (wa-mock)", conn.res.ok, short(conn));
  const prof = await owner.api("/api/agent/profile", {
    method: "PUT",
    body: body({ name: "Sofi", enabled: true }),
  });
  ok("agente in-process encendido (para probar que NO corre)", prof.res.ok, short(prof));
  const add = await owner.api("/api/settings/team", {
    method: "POST",
    body: body({ name: `Vendedor Leads ${S}`, email: SELLER_EMAIL, password: SELLER_PASSWORD }),
  });
  ok("alta del vendedor → 201", add.res.status === 201, short(add));
  const sIn = await seller.api("/api/auth/sign-in/email", {
    method: "POST",
    body: body({ email: SELLER_EMAIL, password: SELLER_PASSWORD }),
  });
  ok("el vendedor inicia sesión", sIn.res.ok, short(sIn));

  console.log("\n== b) Permisos de Ajustes y endpoint sin clave ==");
  // Estado limpio: revocar lo que hubiera dejado una corrida anterior.
  await owner.api("/api/settings/intake", { method: "DELETE" });
  for (const method of ["GET", "PUT", "DELETE"]) {
    const s = await seller.api("/api/settings/intake", { method });
    ok(`vendedor ${method} /api/settings/intake → 403`, s.res.status === 403, short(s));
  }
  const noSession = await anon.api("/api/settings/intake");
  ok("sin sesión GET /api/settings/intake → 401", noSession.res.status === 401, short(noSession));
  const g0 = await owner.api("/api/settings/intake");
  ok("owner GET → sin clave todavía", g0.res.ok && g0.json?.intake === null, short(g0));
  ok("trae la URL de entrada", g0.json?.endpoint === `${BASE}/api/intake/lead`, String(g0.json?.endpoint));
  let r = await postLead(null, lead());
  ok("sin X-API-Key → 401", r.res.status === 401 && r.json?.error?.code === "unauthorized", short(r));
  r = await postLead("a".repeat(43), lead());
  ok("con una clave cualquiera y ninguna configurada → 401", r.res.status === 401, short(r));

  console.log("\n== c) Generar la clave ==");
  const gen = await owner.api("/api/settings/intake", { method: "PUT" });
  const KEY = gen.json?.key;
  ok("PUT → clave de 43 caracteres (base64url)", gen.res.ok && /^[A-Za-z0-9_-]{43}$/.test(KEY ?? ""), short(gen));
  ok("la vista dice sus últimos 4", gen.json?.intake?.keyLast4 === KEY?.slice(-4), JSON.stringify(gen.json?.intake));
  ok("la respuesta con la clave no se cachea", (gen.res.headers.get("cache-control") ?? "").includes("no-store"));
  const g1 = await owner.api("/api/settings/intake");
  ok("después, GET ya no trae la clave completa", g1.res.ok && !JSON.stringify(g1.json).includes(KEY), short(g1));

  console.log("\n== d) Clave mala, cuerpo y teléfono inválidos ==");
  r = await postLead(`${KEY.slice(0, -1)}${KEY.endsWith("x") ? "y" : "x"}`, lead());
  ok("clave incorrecta → 401 sin detalle", r.res.status === 401 && r.json?.error?.code === "unauthorized", short(r));
  r = await postLead(KEY, "no es json");
  ok("cuerpo no JSON → 422", r.res.status === 422, short(r));
  r = await postLead(KEY, { origin: "website", first_name: "X", phone: ten() });
  ok("sin lead_id → 422 invalid_body", r.res.status === 422 && r.json?.error?.code === "invalid_body", short(r));
  r = await postLead(KEY, lead({ origin: "walk_in" }));
  ok("origen fuera del contrato → 422", r.res.status === 422, short(r));
  for (const bad of ["12345", "44 1234 5678 90", "5225512345678"]) {
    r = await postLead(KEY, lead({ phone: bad }));
    ok(`teléfono ${JSON.stringify(bad)} → 422 invalid_phone`, r.res.status === 422 && r.json?.error?.code === "invalid_phone", short(r));
  }

  const before = await agentReport();
  ok("reporte del agente (antes) → 200", before.ok, short(before.raw));

  console.log("\n== e) Alta desde el formulario web ==");
  const digits = ten();
  const spaced = `${digits.slice(0, 2)} ${digits.slice(2, 6)} ${digits.slice(6)}`;
  const NAME = `Ana Web ${S}`;
  const L1 = lead({
    first_name: "Ana",
    last_name: `Web ${S}`,
    phone: spaced,
    email: `ana.${S}@example.com`,
    vehicle: "BYD Dolphin",
    branch: "Sucursal Norte",
    notes: "Quiero una prueba de manejo",
    budget_min: 350000,
    budget_max: 450000,
    lead_code: `LEAD-NTE-2026-${S}`,
    utm_source: "google",
    unknown_field: "se ignora",
  });
  const c1 = await postLead(KEY, L1);
  ok("POST website → 201 { contactId, conversationId, created: true }", c1.res.status === 201 && c1.json?.created === true && !!c1.json?.conversationId, short(c1));
  const convId = c1.json?.conversationId;
  const contactId = c1.json?.contactId;
  const conv = await convById(owner, convId);
  ok(`contacto con teléfono 52+10 (52${digits})`, conv?.contact?.phone === `52${digits}`, JSON.stringify(conv?.contact));
  ok("nombre del lead", conv?.contact?.name === NAME, JSON.stringify(conv?.contact?.name));
  ok("sin nombre de perfil (el formulario no es WhatsApp)", conv?.contact?.profileName === null, JSON.stringify(conv?.contact?.profileName));
  ok("conversación SIN asignar", conv?.assignedTo === null, JSON.stringify(conv?.assignedTo));
  ok("un no leído", conv?.unreadCount === 1, String(conv?.unreadCount));
  ok("ventana cerrada: lastInboundAt intacto", conv?.lastInboundAt === null, String(conv?.lastInboundAt));
  ok("compositor en modo plantilla (replyMode template)", conv?.replyMode === "template", String(conv?.replyMode));
  ok("lead en Seguimiento (tiene etapa)", typeof conv?.stageName === "string" && conv.stageName.length > 0, String(conv?.stageName));
  let msgs = await messagesOf(owner, convId);
  ok("una tarjeta lead_intake entrante", msgs.length === 1 && msgs[0]?.type === "lead_intake" && msgs[0]?.direction === "in", JSON.stringify(msgs.map((m) => m.type)));
  const card = msgs[0]?.text ?? "";
  ok("la tarjeta abre con «Lead del sitio web»", card.startsWith("Lead del sitio web\n"), JSON.stringify(card.slice(0, 60)));
  ok("la tarjeta trae correo, vehículo, sucursal, presupuesto y código", ["Correo: ana.", "Vehículo: BYD Dolphin", "Sucursal: Sucursal Norte", "Presupuesto: $350,000 – $450,000", `Código: LEAD-NTE-2026-${S}`].every((s) => card.includes(s)), card);
  ok("el campo desconocido no llega a la tarjeta", !card.includes("se ignora"));
  const det = (await owner.api(`/api/contacts/${contactId}`)).json;
  ok("fuente capturada «web» (Sitio web)", det?.contact?.source?.value === "web" && det?.contact?.source?.source === "capturada", JSON.stringify(det?.contact?.source));
  ok("correo en la ficha, con procedencia externo", det?.contact?.ficha?.email === `ana.${S}@example.com` && det?.contact?.fichaMeta?.email?.by === "externo", JSON.stringify({ f: det?.contact?.ficha, m: det?.contact?.fichaMeta }));
  ok("lead creado (detalle del contacto)", !!det?.lead?.id, JSON.stringify(det?.lead));

  console.log("\n== f) Mismo lead_id dos veces ==");
  const dup = await postLead(KEY, L1);
  ok("→ 200 { duplicate: true }", dup.res.status === 200 && dup.json?.duplicate === true && dup.json?.conversationId === convId, short(dup));
  msgs = await messagesOf(owner, convId);
  ok("sigue habiendo UNA tarjeta", msgs.filter((m) => m.type === "lead_intake").length === 1, String(msgs.length));
  ok("sigue habiendo UN no leído", (await convById(owner, convId))?.unreadCount === 1);

  console.log("\n== g) El mismo teléfono llega por FastApp ==");
  const plus = `+52 1 ${digits.slice(0, 2)} ${digits.slice(2, 6)} ${digits.slice(6)}`;
  const c2 = await postLead(KEY, lead({ origin: "fast_app", first_name: "Ana", last_name: "Promotor", phone: plus, promoter: "Carlos", email: null }));
  ok("POST fast_app (+52 1 …) → 201 created:false", c2.res.status === 201 && c2.json?.created === false, short(c2));
  ok("misma conversación y mismo contacto", c2.json?.conversationId === convId && c2.json?.contactId === contactId, short(c2));
  msgs = await messagesOf(owner, convId);
  const cards = msgs.filter((m) => m.type === "lead_intake");
  ok("dos tarjetas en el hilo", cards.length === 2, String(cards.length));
  ok("la segunda dice «Lead de promotor (FastApp)» y el promotor", (cards[1]?.text ?? "").startsWith("Lead de promotor (FastApp)\n") && cards[1].text.includes("Promotor: Carlos"), cards[1]?.text);
  const det2 = (await owner.api(`/api/contacts/${contactId}`)).json;
  ok("la fuente capturada no cambia (sigue «web»)", det2?.contact?.source?.value === "web", JSON.stringify(det2?.contact?.source));
  ok("el nombre real no se reemplaza", det2?.contact?.name === NAME, String(det2?.contact?.name));
  ok("ni se inventa un nombre de perfil", (await convById(owner, convId))?.contact?.profileName === null);

  console.log("\n== g2) Un lead desarchiva la conversación (022) ==");
  const archive = (id, archived) =>
    owner.api(`/api/conversations/${id}`, { method: "PATCH", body: body({ archived }) });
  const inAll = async (id) =>
    ((await owner.api("/api/conversations")).json?.conversations ?? []).some((c) => c.id === id);
  const aPhone = ten();
  const LA = lead({ first_name: "Archi", last_name: `Vada ${S}`, phone: aPhone });
  const ca = await postLead(KEY, LA);
  ok("lead nuevo → 201", ca.res.status === 201, short(ca));
  const aConv = ca.json?.conversationId;
  const a1 = await archive(aConv, true);
  ok("archivar su conversación → 200", a1.res.ok && !!(await convById(owner, aConv))?.archivedAt, short(a1));
  ok("sale de Todas", !(await inAll(aConv)));
  const ca2 = await postLead(KEY, lead({ origin: "fast_app", first_name: "Archi", phone: aPhone, promoter: "Carlos" }));
  ok("otro lead del mismo teléfono → 201, misma conversación", ca2.res.status === 201 && ca2.json?.conversationId === aConv, short(ca2));
  const aBack = await convById(owner, aConv);
  ok("la desarchiva (archivedAt y motivo en null)", aBack?.archivedAt === null && aBack?.archivedReason === null, JSON.stringify(aBack && { a: aBack.archivedAt, r: aBack.archivedReason }));
  ok("…y vuelve a Todas", await inAll(aConv));
  ok("el nombre del primer lead se conserva", aBack?.contact?.name === `Archi Vada ${S}`, String(aBack?.contact?.name));
  await archive(aConv, true);
  const aDup = await postLead(KEY, LA);
  ok("un lead_id repetido → duplicate", aDup.res.status === 200 && aDup.json?.duplicate === true, short(aDup));
  ok("…y NO desarchiva (sin efectos)", !!(await convById(owner, aConv))?.archivedAt);
  await archive(aConv, false);

  console.log("\n== h) El Vendedor la ve ==");
  const sellerList = (await seller.api("/api/conversations?assigned=unassigned")).json?.conversations ?? [];
  ok("en su lista «sin asignar»", sellerList.some((c) => c.id === convId));
  ok("y lee sus mensajes", (await messagesOf(seller, convId)).length === 2);

  console.log("\n== i) El agente no corre ==");
  await sleep(2500); // > AGENT_COALESCE_MS
  msgs = await messagesOf(owner, convId);
  const conv2 = await convById(owner, convId);
  ok("sin salientes", msgs.every((m) => m.direction === "in"), JSON.stringify(msgs.map((m) => m.direction)));
  ok("sin escalamiento (handoffAt null: no hubo handoff por ventana)", conv2?.handoffAt === null, String(conv2?.handoffAt));

  console.log("\n== j) Métricas del agente ==");
  const after = await agentReport();
  ok("M1/M2: activas sin cambio", after.active === before.active, `${before.active} → ${after.active}`);
  ok("M8: entrantes sin cambio", after.volIn === before.volIn, `${before.volIn} → ${after.volIn}`);
  ok("M4: sesiones sin cambio", after.sessions === before.sessions, `${before.sessions} → ${after.sessions}`);

  console.log("\n== k) Último recibido y /api/bot/typing ==");
  const g2 = (await owner.api("/api/settings/intake")).json?.intake;
  ok("último lead por origen (website y fast_app)", !!g2?.lastReceivedAt?.website && !!g2?.lastReceivedAt?.fast_app, JSON.stringify(g2?.lastReceivedAt));
  if (BOT_KEY) {
    const ty = await anon.api("/api/bot/typing", {
      method: "POST",
      headers: { "x-api-key": BOT_KEY },
      body: body({ conversationId: convId }),
    });
    ok("typing con solo tarjetas → no_inbound (ignora intake:%)", ty.res.ok && ty.json?.reason === "no_inbound", short(ty));
  }

  console.log("\n== l) En la UI ==");
  await uiChecks(KEY, convId, contactId);

  console.log("\n== m) El prospecto escribe por WhatsApp ==");
  const wamid = `wamid.e2e.leads.${S}`;
  const inb = await owner.api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({ phoneNumberId: PN, from: `521${digits}`, name: "Otro Nombre de Perfil", text: "Hola, vi su página", waMessageId: wamid }),
  });
  ok("inbound del wa-mock (from 521…) entregado", inb.res.ok, short(inb));
  const landed = await until(async () => (await messagesOf(owner, convId)).some((m) => m.text === "Hola, vi su página"), 15000);
  ok("cae en la MISMA conversación", !!landed);
  const conv3 = await convById(owner, convId);
  ok("la ventana se abre (replyMode free)", conv3?.replyMode === "free" && conv3?.lastInboundAt !== null, `${conv3?.replyMode} ${conv3?.lastInboundAt}`);
  ok("el nombre del lead se conserva", conv3?.contact?.name === NAME, String(conv3?.contact?.name));
  ok("el nick de WhatsApp va a profileName", conv3?.contact?.profileName === "Otro Nombre de Perfil", String(conv3?.contact?.profileName));
  const contacts = (await owner.api(`/api/contacts?q=${digits}`)).json?.contacts ?? [];
  ok("un solo contacto con ese teléfono", contacts.filter((c) => c.phone === `52${digits}`).length === 1, JSON.stringify(contacts.map((c) => c.phone)));
  const replied = await until(async () => (await messagesOf(owner, convId)).some((m) => m.direction === "out" && m.aiGenerated), 20000);
  ok("ahora el agente sí responde (estaba encendido)", !!replied);
  if (BOT_KEY) {
    // El bot externo con la IA pausada recibiría ai_paused: se mide la
    // selección del entrante con la conversación activa.
    const ty = await anon.api("/api/bot/typing", {
      method: "POST",
      headers: { "x-api-key": BOT_KEY },
      body: body({ conversationId: convId }),
    });
    ok("typing ya encuentra el entrante real (no la tarjeta)", ty.res.ok && ty.json?.reason !== "no_inbound", short(ty));
  }

  console.log("\n== n) Rotar y revocar ==");
  const rot = await owner.api("/api/settings/intake", { method: "PUT" });
  const KEY2 = rot.json?.key;
  ok("rotar → clave nueva distinta", rot.res.ok && !!KEY2 && KEY2 !== KEY, short(rot));
  r = await postLead(KEY, lead());
  ok("la clave vieja → 401 al instante", r.res.status === 401, short(r));
  r = await postLead(KEY2, lead({ first_name: `Rotada ${S}` }));
  ok("la clave nueva → 201", r.res.status === 201, short(r));
  const rev = await owner.api("/api/settings/intake", { method: "DELETE" });
  ok("revocar → 200", rev.res.ok, short(rev));
  r = await postLead(KEY2, lead());
  ok("tras revocar → 401", r.res.status === 401, short(r));
  ok("y Ajustes queda sin clave", (await owner.api("/api/settings/intake")).json?.intake === null);

  console.log("\n== o) Límite de tasa global ==");
  let got429 = null;
  for (let i = 0; i < 140 && !got429; i++) {
    const x = await postLead("clave-que-no-existe", lead());
    if (x.res.status === 429) got429 = x;
  }
  ok("exceso → 429 rate_limited", got429?.json?.error?.code === "rate_limited", got429 ? short(got429) : "nunca 429");
}

async function uiChecks(KEY, convId, contactId) {
  const browser = await launchBrowser();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies(toCookies(owner.jar));
    await ctx.addInitScript(notificationStub, { permission: "default", grantTo: "granted" });
    const pageErrors = [];

    // Alertas encendidas desde el aviso de la Bandeja (como en e2e-alertas).
    const inbox = await ctx.newPage();
    inbox.on("pageerror", (e) => pageErrors.push(String(e)));
    await inbox.goto(`${BASE}/inbox`, { waitUntil: "load" });
    const btn = inbox.getByRole("button", { name: "Activar avisos" });
    await btn.waitFor({ timeout: 20000 }).catch(() => {});
    await btn.click().catch(() => {});
    const granted = await until(
      async () => (await inbox.getByRole("button", { name: "Activar avisos" }).count()) === 0,
      10000
    );
    ok("alertas activadas desde la Bandeja", !!granted);
    const bg = await ctx.newPage();
    bg.on("pageerror", (e) => pageErrors.push(String(e)));
    await bg.goto(`${BASE}/pipeline`, { waitUntil: "load" });
    await inbox.bringToFront();
    await sleep(3000); // SSE conectado en ambas + líder elegido

    const before = (await notesOf(inbox)).length + (await notesOf(bg)).length;
    const LIVE = `Luis Vivo ${S}`;
    const live = await postLead(KEY, lead({ first_name: "Luis", last_name: `Vivo ${S}`, origin: "fast_app", promoter: "Carlos" }));
    ok("lead nuevo con la Bandeja abierta → 201", live.res.status === 201, short(live));
    const row = await until(async () => (await inbox.getByText(LIVE).count()) > 0, 15000);
    ok("la Bandeja abierta lo pinta en vivo (sin recargar)", !!row);
    await until(async () => (await notesOf(inbox)).length + (await notesOf(bg)).length > before, 15000);
    await sleep(2000);
    const all = [...(await notesOf(inbox)), ...(await notesOf(bg))];
    const fresh = all.slice(before);
    ok("UNA alerta entre las pestañas, con el nombre del lead", fresh.length === 1 && fresh[0]?.title === LIVE, JSON.stringify(fresh));

    await inbox.goto(`${BASE}/inbox?contact=${encodeURIComponent(contactId)}`, { waitUntil: "load" });
    const cardEl = inbox.getByTestId("lead-intake-card").first();
    await cardEl.waitFor({ timeout: 20000 }).catch(() => {});
    const cardText = (await cardEl.textContent().catch(() => "")) ?? "";
    ok("el hilo muestra la tarjeta «Lead del sitio web»", cardText.includes("Lead del sitio web") && cardText.includes("BYD Dolphin"), cardText.slice(0, 120));
    ok("y la de promotor", (await inbox.getByTestId("lead-intake-card").count()) === 2);
    const closed = await until(async () => (await inbox.getByText("La ventana de 24 horas está cerrada.").count()) > 0, 10000);
    ok("el compositor ofrece solo plantilla", !!closed);

    await inbox.goto(`${BASE}/settings/leads-externos`, { waitUntil: "load" });
    ok("Ajustes: la pestaña «Leads externos» está en la navegación", (await inbox.getByRole("link", { name: "Leads externos" }).count()) > 0);
    const endpoint = await until(async () => {
      const t = (await inbox.getByTestId("intake-endpoint").textContent()) ?? "";
      return t.includes("/api/intake/lead") ? t : null;
    }, 10000);
    ok("Ajustes muestra la URL de entrada", !!endpoint, String(endpoint));
    ok("Ajustes no muestra la clave completa", !(await inbox.content()).includes(KEY));
    const status = (await inbox.getByTestId("intake-key-status").textContent()) ?? "";
    ok("Ajustes muestra los últimos 4", status.includes(`····${KEY.slice(-4)}`), status);
    ok("Ajustes: último lead de FastApp con fecha", !/Aún no/.test((await inbox.getByTestId("intake-last-fast_app").textContent()) ?? ""));
    // Rotar desde la UI: la clave completa aparece UNA vez y se va al recargar.
    await inbox.getByRole("button", { name: "Rotar clave" }).click();
    const freshKey = await until(async () => {
      const t = ((await inbox.getByTestId("intake-fresh-key").textContent().catch(() => "")) ?? "").trim();
      return /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
    }, 10000);
    ok("Ajustes: «Rotar clave» muestra la clave completa nueva", !!freshKey && freshKey !== KEY, String(freshKey));
    ok("…con el SQL para el Vault del ERP", (await inbox.getByText("crm_intake_key").count()) > 0);
    await inbox.reload({ waitUntil: "load" });
    await inbox.getByTestId("intake-key-status").waitFor({ timeout: 10000 }).catch(() => {});
    ok("al recargar ya no se muestra (una sola vez)", (await inbox.getByTestId("intake-fresh-key").count()) === 0 && !(await inbox.content()).includes(freshKey ?? "∅"));
    ok("y la vieja deja de valer", (await postLead(KEY, lead())).res.status === 401);
    ok("sin errores de página", pageErrors.length === 0, pageErrors.join(" | "));
    await ctx.close();

    // El Vendedor: sin pestaña y sin página.
    const sctx = await browser.newContext();
    await sctx.addCookies(toCookies(seller.jar));
    const sp = await sctx.newPage();
    await sp.goto(`${BASE}/settings/account`, { waitUntil: "load" });
    ok("Vendedor: la pestaña no aparece", (await sp.getByRole("link", { name: "Leads externos" }).count()) === 0);
    const sres = await sp.goto(`${BASE}/settings/leads-externos`, { waitUntil: "load" });
    ok("Vendedor: la página no se le sirve", !sp.url().includes("/settings/leads-externos") || sres?.status() === 404 || (await sp.getByTestId("intake-endpoint").count()) === 0, `${sres?.status()} ${sp.url()}`);
    await sctx.close();
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log(`LEADS_EXTERNOS ${ON ? "ENCENDIDA" : "APAGADA"} · ${BASE}\n`);
  if (ON) await onChecks();
  else await offChecks();
  console.log(`\n${checks - failures}/${checks} checks OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
