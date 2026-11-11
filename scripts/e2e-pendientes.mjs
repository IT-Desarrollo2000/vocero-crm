/**
 * Self-test E2E — 035 fase A: Recordatorios y Seguimiento › Pendientes.
 * Contrato: specs/035-recordatorios/spec.md · plan: specs/035-recordatorios/plan.md
 *
 * Contra la app VIVA (mocks) y la BD AISLADA (siembra fechas viejas directo en
 * Postgres, de forma determinista):
 *
 *   1) la vendedora Vera crea un recordatorio desde el chat («Recordarme» del
 *      encabezado) y otro desde Contactos (sin chat); el diálogo enseña los
 *      que ya tiene de ese cliente
 *   2) los ve en Pendientes en su grupo (Vencidos / Hoy / Esta semana /
 *      Después), filtra por motivo y pospone
 *   3) «Hecho» con «¿Qué pasó?»: la nota aparece en el historial del cliente
 *      (cajón del trato) y uno con «cada 6 meses» crea el siguiente
 *   4) «Sin contacto» con atajos de días, «Entre fechas» e «Incluir perdidos»;
 *      la fila con recordatorio lo dice y no ofrece «Recordarme»
 *   5) «Sin respuesta a tu plantilla» (leída / entregada; sin las fallidas ni
 *      las contestadas)
 *   6) «Ver los N» con más de 8 filas: se desplaza dentro del recuadro y el de
 *      abajo sigue debajo
 *   7) el número rojo de vencidos junto a «Seguimiento»
 *   8) el vendedor Bruno no ve lo de Vera (API 404 y UI vacía)
 *   9) el Propietario ve todos con «Vendedor: Todos / …»
 *  10) Pendientes a 390 px sin scroll horizontal
 *
 * Presupuesto del limitador de login: 3 (dueño, Vera, Bruno; por API).
 *
 * Uso (BD aislada, app con .env.e2e):
 *   CATALOG_STORAGE=local node --env-file=.env.e2e scripts/e2e-pendientes.mjs
 * Con `REVISAR_DIR=<dir>` deja capturas. Sale con 1 si algún check falla.
 */
import { chromium } from "playwright";
import postgres from "postgres";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const S = Math.random().toString(36).slice(2, 7);
const PN = "PN-E2E-035";
const WABA = "WABA-E2E-035";
const REVISAR = process.env.REVISAR_DIR ?? null;
const TZ = "America/Mexico_City";
const DAY = 86_400_000;

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

/** Una sesión (cookie) por persona. */
function session() {
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
  return { jar, api };
}

const owner = session();
const vera = session();
const bruno = session();
const api = owner.api;

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
const shot = async (target, file) => {
  if (REVISAR) await target.screenshot({ path: `${REVISAR}/${file}`, animations: "disabled", caret: "hide" }).catch(() => {});
};

/** Día de pared (YYYY-MM-DD) en la zona del negocio, con desplazamiento en días. */
function dayIn(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(
    new Date(Date.now() + offsetDays * DAY)
  );
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${m.year}-${m.month}-${m.day}`;
}
function wallOf(iso) {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return { day, time };
}
/** Domingo de la semana de calendario (lun–dom) que contiene `day`. */
function endOfWeekDay(day) {
  const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
  const t = new Date(`${day}T12:00:00Z`).getTime() + ((7 - wd) % 7) * DAY;
  return new Date(t).toISOString().slice(0, 10);
}
/** Grupo esperado de un recordatorio FUTURO según su día (zona del negocio). */
function groupOfDay(day) {
  if (day === dayIn(0)) return "today";
  return day <= endOfWeekDay(dayIn(0)) ? "week" : "later";
}
function weekdayName(day) {
  return ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"][new Date(`${day}T12:00:00Z`).getUTCDay()];
}
function addMonthsClamped(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const idx = y * 12 + (m - 1) + n;
  const ty = Math.floor(idx / 12);
  const tm = (idx % 12) + 1;
  const dim = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return `${ty}-${String(tm).padStart(2, "0")}-${String(Math.min(d, dim)).padStart(2, "0")}`;
}

const OWNER = { email: "e2e@vocero.test", password: "password-e2e-123", name: "Operador E2E" };
const VERA = { name: `Vera ${S}`, email: `vera.${S}@vocero.test`, password: "password-vera-035" };
const BRUNO = { name: `Bruno ${S}`, email: `bruno.${S}@vocero.test`, password: "password-bruno-035" };

let seq = 0;
const phoneOf = new Map();
function phone(name) {
  if (!phoneOf.has(name)) phoneOf.set(name, `52155${String(Date.now()).slice(-5)}${String(seq++).padStart(3, "0")}`);
  return phoneOf.get(name);
}
async function convOf(name) {
  const r = await api(`/api/conversations?${new URLSearchParams({ q: name })}`);
  return (r.json?.conversations ?? []).find((c) => c.contact?.name === name) ?? null;
}
async function inbound(name, text) {
  const r = await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({ phoneNumberId: PN, from: phone(name), name, text, waMessageId: `wamid.e2e.035.${S}.${seq++}` }),
  });
  if (!r.res.ok) ok(`inbound de ${name}`, false, short(r));
  await until(async () => !!(await convOf(name)));
  return convOf(name);
}

const N = {
  laura: `Laura Chat ${S}`,
  ana: `Ana Contactos ${S}`,
  k30: `Kiko Cuarenta ${S}`,
  k60: `Kari Setenta ${S}`,
  k90: `Koke Cien ${S}`,
  lost: `Lalo Perdido ${S}`,
  k15: `Kim Veinte ${S}`,
  bruno: `Beto DeBruno ${S}`,
  t1: `Tere Leida ${S}`,
  t2: `Toño Entregada ${S}`,
  t3: `Tina Fallida ${S}`,
  t4: `Tavo Contesto ${S}`,
};
const many = Array.from({ length: 10 }, (_, i) => `Nico ${String(i + 1).padStart(2, "0")} ${S}`);
const TPL = `seguimiento_cotizacion_${S}`;

/* ───────────────────────── setup ───────────────────────── */

let ids = {};
/** ¿El segundo recordatorio de Laura cayó hoy? (no, después de las 23:30 en la zona). */
let hoyLaura = true;
const conv = {};

async function setup(db) {
  console.log("== Setup ==");
  let su = await api("/api/auth/sign-up/email", { method: "POST", body: body(OWNER) });
  if (!su.res.ok) su = await api("/api/auth/sign-in/email", { method: "POST", body: body({ email: OWNER.email, password: OWNER.password }) });
  ok("owner con sesión", su.res.ok, short(su));
  const conn = await api("/api/settings/whatsapp", { method: "PUT", body: body({ wabaId: WABA, phoneNumberId: PN, token: "tok-e2e-035" }) });
  ok("WhatsApp (wa-mock)", conn.res.ok, short(conn));
  // IA apagada ANTES del primer entrante: una respuesta suya movería «Sin contacto».
  await api("/api/agent/profile", { method: "PUT", body: body({ name: "Lumi", tone: "breve", instructions: "Tienda.", enabled: false }) });

  for (const p of [VERA, BRUNO]) {
    const alta = await api("/api/settings/team", { method: "POST", body: body(p) });
    ok(`alta de ${p.name}`, alta.res.status === 201, short(alta));
  }
  const lv = await vera.api("/api/auth/sign-in/email", { method: "POST", body: body({ email: VERA.email, password: VERA.password }) });
  const lb = await bruno.api("/api/auth/sign-in/email", { method: "POST", body: body({ email: BRUNO.email, password: BRUNO.password }) });
  ok("Vera y Bruno inician sesión", lv.res.ok && lb.res.ok, `${short(lv)} | ${short(lb)}`);
  const team = (await api("/api/settings/team")).json?.members ?? [];
  const me = (await api("/api/auth/get-session")).json?.user?.id;
  ids = {
    owner: me,
    vera: team.find((m) => m.email === VERA.email)?.userId,
    bruno: team.find((m) => m.email === BRUNO.email)?.userId,
  };
  ok("ids del equipo", !!ids.owner && !!ids.vera && !!ids.bruno, JSON.stringify(ids));

  await api("/api/templates", { method: "POST", body: body({ name: TPL, body: "Hola {{1}}, ¿seguimos con tu cotización?", language: "es_MX", category: "UTILITY" }) });
  await api("/api/dev/wa-mock/template-status", { method: "POST", body: body({ wabaId: WABA, name: TPL, language: "es_MX", event: "APPROVED", notify: false }) });
  await api("/api/templates/sync", { method: "POST" });
  const tpl = ((await api("/api/templates")).json?.templates ?? []).find((t) => t.name === TPL);
  ok("plantilla aprobada", tpl?.status === "approved", JSON.stringify(tpl));

  // Conversaciones: todas de Vera salvo la de Bruno.
  const all = [N.laura, N.k30, N.k60, N.k90, N.lost, N.k15, N.bruno, N.t1, N.t2, N.t3, N.t4, ...many];
  for (const name of all) {
    conv[name] = await inbound(name, "Hola, quiero informes");
    const who = name === N.bruno ? ids.bruno : ids.vera;
    const a = await api(`/api/conversations/${conv[name]?.id}/assign`, { method: "POST", body: body({ userId: who }) });
    if (!a.res.ok) ok(`asignar ${name}`, false, short(a));
  }
  ok("conversaciones creadas y asignadas", all.every((n) => !!conv[n]?.id));

  // Plantillas (antes de envejecer): t1 leída, t2 entregada, t3 fallida, t4 contestada.
  const sendTpl = async (name) =>
    api(`/api/conversations/${conv[name].id}/messages/template`, {
      method: "POST",
      body: body({ templateId: tpl?.id, variables: [name.split(" ")[0]] }),
    });
  for (const n of [N.t1, N.t2, N.t3, N.t4]) {
    const r = await sendTpl(n);
    if (!r.res.ok) ok(`plantilla a ${n}`, false, short(r));
  }
  const outbox = (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  const wamidTo = (n) => outbox.filter((o) => o.body?.type === "template" && String(o.body?.to ?? "").endsWith(phone(n).slice(-10))).at(-1)?.waMessageId;
  const st = (n, s, extra = {}) => api("/api/dev/wa-mock/status", { method: "POST", body: body({ waMessageId: wamidTo(n), status: s, ...extra }) });
  await st(N.t1, "delivered");
  await st(N.t1, "read");
  await st(N.t2, "delivered");
  await st(N.t3, "failed", { errorCode: 131026, errorMessage: "Message undeliverable" });
  await sleep(800);
  await inbound(N.t4, "Gracias, lo pienso");

  // Envejecer (determinista): todo el hilo y `last_message_at` N días atrás.
  const age = async (name, days) => {
    const id = conv[name].id;
    await db`update vocero.message set created_at = created_at - make_interval(days => ${days}),
               wa_timestamp = coalesce(wa_timestamp, created_at) - make_interval(days => ${days})
             where conversation_id = ${id}`;
    await db`update vocero.conversation set
               last_message_at = (select max(created_at) from vocero.message where conversation_id = ${id}),
               created_at = created_at - make_interval(days => ${days}),
               last_inbound_at = last_inbound_at - make_interval(days => ${days})
             where id = ${id}`;
  };
  await age(N.k30, 40);
  await age(N.k60, 70);
  await age(N.k90, 100);
  await age(N.lost, 50);
  await age(N.k15, 20);
  await age(N.bruno, 50);
  await age(N.t1, 5);
  await age(N.t2, 8);
  await age(N.t3, 9);
  await age(N.t4, 9);
  for (let i = 0; i < many.length; i++) await age(many[i], 35 + i);
  // Perdido: directo en la BD (el tablero no es el objeto de esta prueba).
  const [lostStage] = await db`select s.id from vocero.pipeline_stage s join vocero.conversation c on c.organization_id = s.organization_id where c.id = ${conv[N.lost].id} and s.kind = 'lost' limit 1`;
  await db`update vocero.lead set stage_id = ${lostStage.id} where contact_id = ${conv[N.lost].contact.id}`;
  ok("fechas sembradas en la BD aislada", true);
  // `next dev` compila cada ruta en su primera petición: se precalientan.
  for (const p of ["/api/follow-ups", "/api/follow-ups/count", "/api/follow-ups/pending?days=30", "/pipeline?vista=pendientes", "/contacts"]) {
    await api(p).catch(() => {});
  }
  return tpl;
}

/* ───────────────────────── navegador ───────────────────────── */

let browser;
async function pageAs(sess, viewport = { width: 1366, height: 1000 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.route("**/api/events*", (route) => route.abort());
  const host = new URL(BASE);
  await ctx.addCookies(
    sess.jar.cookie.split("; ").filter(Boolean).map((kv) => {
      const i = kv.indexOf("=");
      return { name: kv.slice(0, i), value: kv.slice(i + 1), domain: host.hostname, path: "/" };
    })
  );
  const page = await ctx.newPage();
  return { ctx, page };
}
async function gotoPendientes(page) {
  await page.goto(`${BASE}/pipeline?vista=pendientes`, { waitUntil: "load" });
  await page.waitForSelector('[data-testid="my-follow-ups"]', { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="my-follow-ups"] [aria-busy="true"]'), null, { timeout: 30000 });
  await page.waitForFunction(() => !/·\s*…/.test(document.querySelector('[data-testid="no-contact"] h2')?.textContent ?? "…"), null, { timeout: 30000 });
}
const listOf = async (sess, qs = "") => (await sess.api(`/api/follow-ups${qs}`)).json?.followUps ?? [];
const pending = async (sess, qs) => (await sess.api(`/api/follow-ups/pending?${qs}`)).json;
const names = (rows) => (rows ?? []).map((r) => r.contact.name);

/* ───────────────────────── 1) crear ───────────────────────── */

async function crear() {
  console.log("\n== 1) Crear desde el chat y desde Contactos ==");
  const anaCt = await vera.api("/api/contacts", { method: "POST", body: body({ name: N.ana, phone: phone(N.ana) }) });
  ok("Vera da de alta a Ana (sin chat)", anaCt.res.ok, short(anaCt));
  ids.ana = anaCt.json?.contact?.id ?? anaCt.json?.id;

  const { ctx, page } = await pageAs(vera);
  // Chat: «Recordarme» del encabezado.
  await page.goto(`${BASE}/inbox?contact=${conv[N.laura].contact.id}`, { waitUntil: "load" });
  await page.getByTestId("inbox-remind").click({ timeout: 60000 });
  const dlg = page.getByTestId("remind-dialog");
  await dlg.waitFor();
  ok("diálogo «Recordarme de Laura…»", (await dlg.getByRole("heading").innerText()).startsWith(`Recordarme de ${N.laura}`));
  ok(
    "el diálogo conoce la zona del negocio",
    await until(async () => /hora de Ciudad de México/.test(await dlg.getByTestId("remind-preview").innerText()), 60000)
  );
  await dlg.getByRole("button", { name: "En 3 días" }).click();
  ok(
    "«En 3 días» pone el día y la vista previa a las 10:00 a. m.",
    (await dlg.locator('input[type="date"]').inputValue()) === dayIn(3) &&
      /10:00 a\. m\. \(hora de Ciudad de México\)$/.test(await dlg.getByTestId("remind-preview").innerText()),
    await dlg.getByTestId("remind-preview").innerText()
  );
  await dlg.getByLabel("Servicio").check();
  await dlg.getByLabel("Repetir").selectOption("6");
  await dlg.locator("textarea").fill("Revisar cómo le fue con la garantía del sofá.");
  await dlg.getByRole("button", { name: "Guardar recordatorio" }).click();
  await dlg.waitFor({ state: "detached", timeout: 10000 });
  let mine = await listOf(vera);
  const laura = mine.find((f) => f.contact.name === N.laura);
  ok(
    "API: el de Laura (chat) con motivo, repetir, nota y 10:00 hora del negocio",
    laura?.reason === "servicio" && laura?.repeatMonths === 6 && laura?.conversationId === conv[N.laura].id &&
      wallOf(laura.dueAt).day === dayIn(3) && wallOf(laura.dueAt).time === "10:00",
    JSON.stringify(laura)
  );

  // Otro de Laura por API (hoy, más tarde) → el diálogo los enseña abajo.
  // «Hoy» relativo al reloj: ahora + 30 min en la zona del negocio. Cerca de
  // medianoche eso ya es mañana: el recordatorio cae en «Esta semana» y el
  // check de «Hoy» se omite (los conteos no cambian).
  const hoyAt = wallOf(new Date(Date.now() + 30 * 60_000).toISOString());
  hoyLaura = hoyAt.day === dayIn(0);
  await vera.api("/api/follow-ups", { method: "POST", body: body({ contactId: conv[N.laura].contact.id, day: hoyAt.day, time: hoyAt.time, reason: "informacion", note: "Avisarle del comedor en nogal." }) });
  await page.getByTestId("inbox-remind").click();
  await dlg.waitFor();
  await dlg.getByTestId("remind-existing").waitFor({ timeout: 10000 });
  const pie = await dlg.getByTestId("remind-existing").innerText();
  ok("el diálogo enseña «Ya tienes 2 recordatorios de Laura» con «Ver en Pendientes»", /Ya tienes 2 recordatorios de Laura/.test(pie) && /Ver en Pendientes/.test(pie), pie);
  await dlg.getByRole("button", { name: "En 1 semana" }).click();
  await dlg.getByLabel("Información solicitada").check();
  await shot(page, "recordarme-con-previo.png");
  await dlg.getByRole("button", { name: "Cancelar" }).click();

  // Contactos: fila de Ana (sin chat), con `?q=`.
  await page.goto(`${BASE}/contacts?q=${encodeURIComponent(N.ana)}`, { waitUntil: "load" });
  await page.getByRole("button", { name: `Recordarme de ${N.ana}` }).click({ timeout: 60000 });
  await dlg.waitFor();
  await until(async () => /hora de/.test(await dlg.getByTestId("remind-preview").innerText()), 10000);
  await dlg.getByRole("button", { name: "Mañana" }).click();
  await dlg.locator('input[type="time"]').fill("09:30");
  await dlg.getByRole("button", { name: "Guardar recordatorio" }).click();
  await dlg.waitFor({ state: "detached", timeout: 10000 });
  mine = await listOf(vera);
  const ana = mine.find((f) => f.contact.name === N.ana);
  ok(
    "API: el de Ana (Contactos) sin chat, mañana 09:30",
    ana && ana.conversationId === null && wallOf(ana.dueAt).day === dayIn(1) && wallOf(ana.dueAt).time === "09:30" && ana.reason === "volver_a_contactar",
    JSON.stringify(ana)
  );
  await ctx.close();

  // Más para los grupos: dos vencidos y uno «después».
  const mk = (contactId, day, time, reason, note, extra = {}) =>
    vera.api("/api/follow-ups", { method: "POST", body: body({ contactId, day, time, reason, note, ...extra }) });
  const v1 = await mk(conv[N.k30].contact.id, dayIn(-1), "10:00", "volver_a_contactar", "Quedó de decidir después de la quincena.");
  const v2 = await mk(conv[N.k60].contact.id, dayIn(-2), "11:00", "cita", "No llegó a su cita.");
  const d1 = await mk(conv[N.t2].contact.id, dayIn(20), "12:00", "otro", null);
  ok("API: vencidos y «después» creados (201)", [v1, v2, d1].every((r) => r.res.status === 201), [v1, v2, d1].map(short).join(" | "));
  const bad = await vera.api("/api/follow-ups", { method: "POST", body: body({ contactId: conv[N.k30].contact.id, day: "2026-02-30", time: "10:00", reason: "cita" }) });
  ok("API: día inexistente → 422", bad.res.status === 422, short(bad));
  const badReason = await vera.api("/api/follow-ups", { method: "POST", body: body({ contactId: conv[N.k30].contact.id, day: dayIn(1), time: "10:00", reason: "llamar" }) });
  ok("API: motivo fuera del catálogo → 422", badReason.res.status === 422, short(badReason));
  return { v1: v1.json?.followUp, v2: v2.json?.followUp };
}

/* ───────────────────────── 2) y 3) Pendientes ───────────────────────── */

async function pendientes({ v1 }) {
  console.log("\n== 2) Pendientes: grupos, motivo, posponer · 3) Hecho ==");
  const { ctx, page } = await pageAs(vera);
  await gotoPendientes(page);
  const groupNames = async (g) => page.getByTestId(`group-${g}`).locator('[data-testid="follow-up-name"]').allInnerTexts().catch(() => []);
  const vencidos = (await groupNames("overdue")).join("|");
  const hoy = (await groupNames("today")).join("|");
  ok("Vencidos: Kiko (ayer) y Kari (antier)", vencidos.includes(N.k30) && vencidos.includes(N.k60), vencidos);
  if (hoyLaura) ok("Hoy: Laura (ahora + 30 min)", hoy.includes(N.laura), hoy);
  else console.log("  SKIP «Hoy: Laura» — se omite: muy cerca de medianoche (ahora + 30 min ya es mañana)");
  ok("«Esta semana» y «Después» empiezan plegados", (await page.getByTestId("group-week").count()) === 0 && (await page.getByTestId("group-later").count()) === 0);
  // El grupo esperado depende del día en que se corra (semana lun–dom).
  const esperado = [
    { name: N.laura, day: dayIn(3), what: "Laura (en 3 días)" },
    { name: N.ana, day: dayIn(1), what: "Ana (mañana)" },
    { name: N.t2, day: dayIn(20), what: "Toño (en 20 días)" },
  ].map((e) => ({ ...e, group: groupOfDay(e.day) }));
  for (const g of ["week", "later"]) {
    const t = page.getByTestId(`group-toggle-${g}`);
    const deben = esperado.filter((e) => e.group === g).length;
    ok(
      `«${g === "week" ? "Esta semana" : "Después"}» ${deben ? "aparece" : "no aparece (vacía)"} — hoy es ${weekdayName(dayIn(0))}`,
      deben ? (await t.count()) === 1 : (await t.count()) === 0 || !esperado.some((e) => e.group === g)
    );
    if (await t.count()) await t.click();
  }
  const semana = await groupNames("week");
  const despues = await groupNames("later");
  for (const e of esperado) {
    ok(
      `${e.what} en «${e.group === "week" ? "Esta semana" : "Después"}» (domingo de esta semana: ${endOfWeekDay(dayIn(0))})`,
      (e.group === "week" ? semana : despues).includes(e.name),
      `${semana.join("|")} // ${despues.join("|")}`
    );
  }
  if (!esperado.some((e) => e.group === "week")) {
    ok("domingo: sin encabezado «Esta semana»", (await page.getByTestId("group-toggle-week").count()) === 0);
  }
  ok(
    "fila con día y hora de 12 h («Ayer» · «10:00 a. m.») y chip «cada 6 meses»",
    /Ayer/.test(await page.locator(`[data-follow-up="${v1?.id}"]`).innerText()) &&
      /10:00 a\. m\./.test(await page.locator(`[data-follow-up="${v1?.id}"]`).innerText()) &&
      (await page.getByText("cada 6 meses").count()) >= 1
  );
  const tab = await page.getByTestId("view-pendientes").innerText();
  ok("pestaña «Pendientes · 2 vencidos»", /Pendientes · 2 vencidos/.test(tab), tab);

  // 7) número rojo del menú
  const nav = await page.getByTestId("nav-overdue").innerText().catch(() => "");
  const count = (await vera.api("/api/follow-ups/count")).json?.overdue;
  ok("menú: número rojo junto a «Seguimiento» = vencidos (2)", nav.trim() === "2" && count === 2, `${nav} / ${count}`);

  // Filtro por motivo
  await page.getByRole("button", { name: /^Servicio · 1$/ }).click();
  const filtrado = await page.locator('[data-testid="follow-up-name"]').allInnerTexts();
  ok("filtro «Servicio · 1» deja solo a Laura", filtrado.length === 1 && filtrado[0] === N.laura, filtrado.join("|"));
  ok("contadores por motivo («Todos · 6»)", (await page.getByRole("button", { name: /^Todos · 6$/ }).count()) === 1);
  await page.getByRole("button", { name: /^Todos · 6$/ }).click();
  await shot(page, "pendientes-tres-secciones.png");

  // Posponer el vencido de Kiko 1 semana → sale de Vencidos.
  const kikoRow = page.locator(`[data-follow-up="${v1?.id}"]`);
  await kikoRow.getByRole("button", { name: "Posponer ▾" }).click();
  await kikoRow.getByRole("menuitem", { name: "1 semana" }).click();
  ok("posponer «1 semana» lo saca de Vencidos", await until(async () => !(await groupNames("overdue")).includes(N.k30), 10000));
  const kiko = (await listOf(vera)).find((f) => f.id === v1?.id);
  ok("API: due_at = hoy + 7 a la misma hora (10:00)", wallOf(kiko?.dueAt).day === dayIn(7) && wallOf(kiko?.dueAt).time === "10:00", JSON.stringify(kiko && wallOf(kiko.dueAt)));
  ok("el número rojo baja a 1", await until(async () => (await page.getByTestId("nav-overdue").innerText().catch(() => "")).trim() === "1", 10000));

  // 3) Hecho con nota y repetición (Laura, cada 6 meses).
  const lauraFu = (await listOf(vera)).find((f) => f.contact.name === N.laura && f.repeatMonths === 6);
  const lauraRow = page.locator(`[data-follow-up="${lauraFu?.id}"]`);
  await lauraRow.getByRole("button", { name: "Hecho" }).click();
  await lauraRow.getByRole("textbox").fill("Ya le cambiaron la funda, quedó contenta.");
  const aviso = await lauraRow.getByTestId("repeat-notice").innerText();
  const nextDay = addMonthsClamped(wallOf(lauraFu.dueAt).day, 6);
  ok("aviso «Se repite cada 6 meses: el siguiente queda para el …»", /^Se repite cada 6 meses: el siguiente queda para el \d+ de \w+ de \d{4}\.$/.test(aviso), aviso);
  await shot(lauraRow, "hecho-con-nota-y-repeticion.png");
  await lauraRow.getByRole("button", { name: "Marcar como hecho" }).click();
  await page.getByText(/Listo\. El siguiente recordatorio de/).waitFor({ timeout: 10000 });
  const done = (await listOf(vera, `?status=done&contactId=${conv[N.laura].contact.id}`))[0];
  const nextOne = (await listOf(vera, `?contactId=${conv[N.laura].contact.id}`)).find((f) => f.repeatMonths === 6);
  ok("API: hecho con su «¿Qué pasó?»", done?.status === "done" && done?.doneNote === "Ya le cambiaron la funda, quedó contenta." && !!done?.doneAt, JSON.stringify(done));
  ok(
    "API: el siguiente = original + 6 meses, misma hora, motivo y nota",
    nextOne && nextOne.id !== lauraFu.id && wallOf(nextOne.dueAt).day === nextDay && wallOf(nextOne.dueAt).time === "10:00" && nextOne.reason === "servicio" && nextOne.note === lauraFu.note,
    JSON.stringify(nextOne)
  );
  const again = await vera.api(`/api/follow-ups/${lauraFu.id}`, { method: "PATCH", body: body({ action: "done" }) });
  ok("API: marcarlo hecho otra vez → 409 already_done (no crea otro siguiente)", again.res.status === 409 && again.json?.error?.code === "already_done", short(again));

  // Historial en el cajón del trato (Tablero).
  await page.getByTestId("view-tablero").click();
  await page.waitForURL(/\/pipeline$/, { timeout: 15000 });
  await page.getByRole("button", { name: `Abrir el trato de ${N.laura}` }).click({ timeout: 60000 });
  const hist = page.getByTestId("lead-follow-ups");
  ok(
    "cajón del trato: «Recordatorios» con el hecho y su nota",
    await until(async () => /Ya le cambiaron la funda, quedó contenta\./.test(await hist.innerText()), 15000),
    await hist.innerText().catch(() => "")
  );
  await ctx.close();
}

/* ───────────────────────── 4) 5) 6) recuadros ───────────────────────── */

async function recuadros() {
  console.log("\n== 4) Sin contacto · 5) Sin respuesta a tu plantilla · 6) Ver los N ==");
  // API primero (determinista).
  const p30 = await pending(vera, "days=30");
  const n30 = names(p30?.noContact?.rows);
  ok(
    "+30 días: Kiko, Kari, Koke y los 10 Nico; sin el perdido, sin Kim (20 d), sin el de Bruno ni Laura",
    [N.k30, N.k60, N.k90, ...many].every((n) => n30.includes(n)) && ![N.lost, N.k15, N.bruno, N.laura].some((n) => n30.includes(n)),
    n30.join("|")
  );
  ok("orden: el más antiguo primero (Koke, 100 d)", n30[0] === N.k90, n30.slice(0, 3).join("|"));
  ok("total = filas (13 propias)", p30?.noContact?.total === n30.length && n30.filter((n) => n.endsWith(S)).length === 13, String(p30?.noContact?.total));
  const n90 = names((await pending(vera, "days=90"))?.noContact?.rows);
  ok("+90 días: solo Koke", n90.filter((n) => n.endsWith(S)).join("|") === N.k90, n90.join("|"));
  const n15 = names((await pending(vera, "days=15"))?.noContact?.rows);
  ok("+15 días: ya entra Kim (20 d)", n15.includes(N.k15));
  const lost = names((await pending(vera, "days=30&includeLost=1"))?.noContact?.rows);
  ok("«Incluir perdidos»: entra Lalo", lost.includes(N.lost) && !n30.includes(N.lost));
  const between = names((await pending(vera, `from=${dayIn(-75)}&to=${dayIn(-65)}`))?.noContact?.rows);
  ok("«Entre fechas» (hace 75 a 65 días): solo Kari", between.filter((n) => n.endsWith(S)).join("|") === N.k60, between.join("|"));
  const k30row = p30?.noContact?.rows?.find((r) => r.contact.name === N.k30);
  ok("la fila de Kiko dice que ya tiene recordatorio", !!k30row?.openFollowUpAt, JSON.stringify(k30row));
  const malo = await vera.api("/api/follow-ups/pending?days=45");
  ok("API: días fuera del catálogo → 422", malo.res.status === 422, short(malo));

  const r3 = names((await pending(vera, "days=30&replyDays=3"))?.noReply?.rows);
  ok("Sin respuesta +3: Tere (5 d) y Toño (8 d); sin la fallida ni la contestada", r3.includes(N.t1) && r3.includes(N.t2) && !r3.includes(N.t3) && !r3.includes(N.t4), r3.join("|"));
  const r7 = names((await pending(vera, "days=30&replyDays=7"))?.noReply?.rows);
  ok("Sin respuesta +7: solo Toño", r7.filter((n) => n.endsWith(S)).join("|") === N.t2, r7.join("|"));
  const tere = (await pending(vera, "days=30&replyDays=3"))?.noReply?.rows?.find((r) => r.contact.name === N.t1);
  ok("Tere: nombre de la plantilla y «read»", tere?.templateName === TPL && tere?.templateStatus === "read", JSON.stringify(tere));

  // UI
  const { ctx, page } = await pageAs(vera);
  await gotoPendientes(page);
  const box = page.getByTestId("no-contact");
  await box.getByRole("button", { name: "+30 días" }).click();
  await until(async () => /· 13/.test(await box.locator("h2").innerText()), 15000);
  ok("UI: «Sin contacto · 13» y 3 filas a la vista", (await box.getByTestId("pending-row").count()) === 3, await box.locator("h2").innerText());
  const first = await box.getByTestId("pending-row").first().innerText();
  ok("UI: primero Koke «hace 100 días»", first.includes(N.k90) && /último mensaje hace 100 días/.test(first), first);
  const below = page.getByTestId("no-reply");
  const top0 = (await below.boundingBox())?.y ?? 0;
  const more = box.getByTestId("no-contact-list-more");
  ok("UI: «Ver los 13 (del más antiguo al más reciente)»", /^Ver los 13 \(del más antiguo al más reciente\)/.test(await more.innerText()), await more.innerText());
  await more.click();
  const list = box.getByTestId("no-contact-list");
  const dims = await list.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, rows: el.children.length }));
  const top1 = (await below.boundingBox())?.y ?? 0;
  const rowH = (await box.getByTestId("pending-row").first().boundingBox())?.height ?? 60;
  ok("UI: abierta, se desplaza DENTRO del recuadro (13 filas, ≤ ~8 a la vista)", dims.rows === 13 && dims.sh > dims.ch && dims.ch <= rowH * 8.6, JSON.stringify({ ...dims, rowH }));
  ok("UI: «Sin respuesta a tu plantilla» sigue debajo (baja como mucho ~5 filas)", top1 - top0 <= rowH * 5.6 + 8, JSON.stringify({ top0, top1, rowH }));
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const top2 = (await below.boundingBox())?.y ?? 0;
  ok("UI: desplazar la lista no mueve el recuadro de abajo", Math.abs(top2 - top1) < 1, JSON.stringify({ top1, top2 }));
  await list.evaluate((el) => (el.scrollTop = 0));
  await shot(box, "sin-contacto-expandido.png");
  const kRow = box.getByTestId("pending-row").filter({ hasText: N.k30 });
  ok(
    "UI: la fila de Kiko dice «recordatorio el …» y no ofrece «Recordarme»",
    /recordatorio el \d+ \w+/.test(await kRow.innerText()) && (await kRow.getByRole("button", { name: "Recordarme" }).count()) === 0,
    await kRow.innerText()
  );
  // «Recordarme» desde una fila de Sin contacto.
  const nicoRow = box.getByTestId("pending-row").filter({ hasText: many[9] });
  await nicoRow.getByRole("button", { name: "Recordarme" }).click();
  const dlg = page.getByTestId("remind-dialog");
  await dlg.waitFor();
  await until(async () => /hora de/.test(await dlg.getByTestId("remind-preview").innerText()), 10000);
  await dlg.getByRole("button", { name: "En 1 mes" }).click();
  await dlg.getByRole("button", { name: "Guardar recordatorio" }).click();
  await dlg.waitFor({ state: "detached", timeout: 10000 });
  ok(
    "UI: tras «Recordarme», la fila de Nico 10 ya dice «recordatorio el …»",
    await until(async () => /recordatorio el/.test(await box.getByTestId("pending-row").filter({ hasText: many[9] }).innerText()), 10000)
  );
  // Contactar abre el chat.
  const href = await box.getByTestId("pending-row").first().getByRole("link", { name: "Contactar" }).getAttribute("href");
  ok("UI: «Contactar» abre su chat en la Bandeja", href === `/inbox?contact=${conv[N.k90].contact.id}`, href);

  // Entre fechas e Incluir perdidos.
  await box.getByRole("button", { name: "Entre fechas" }).click();
  await box.getByTestId("between-from").fill(dayIn(-75));
  await box.getByTestId("between-to").fill(dayIn(-65));
  ok(
    "UI: «Entre fechas» → «Clientes cuyo último mensaje fue entre … · 1» y solo Kari",
    await until(async () => /· 1$/.test((await box.getByTestId("between-summary").innerText()).trim()), 15000) &&
      (await box.getByTestId("pending-row").count()) === 1 &&
      (await box.getByTestId("pending-row").first().innerText()).includes(N.k60),
    await box.getByTestId("between-summary").innerText()
  );
  await box.getByRole("button", { name: "+30 días" }).click();
  await box.getByLabel("Incluir perdidos").check();
  ok("UI: «Incluir perdidos» → 14", await until(async () => /· 14/.test(await box.locator("h2").innerText()), 15000), await box.locator("h2").innerText());

  // Sin respuesta.
  const nr = page.getByTestId("no-reply");
  await until(async () => (await nr.getByTestId("pending-row").count()) >= 2, 10000);
  const tereRow = await nr.getByTestId("pending-row").filter({ hasText: N.t1 }).innerText();
  ok("UI: Tere «nombre de plantilla» · leída · hace 5 días", tereRow.includes(`«${TPL}»`) && /leída · hace 5 días/.test(tereRow), tereRow);
  ok("UI: Toño · entregada · hace 8 días", /entregada · hace 8 días/.test(await nr.getByTestId("pending-row").filter({ hasText: N.t2 }).innerText()));
  await nr.getByRole("button", { name: "+7 días" }).click();
  ok("UI: +7 días deja solo a Toño", await until(async () => (await nr.getByTestId("pending-row").count()) === 1, 10000));
  await nr.getByRole("button", { name: "+3 días" }).click();
  await ctx.close();
}

/* ───────────────────────── 8) 9) 10) ───────────────────────── */

async function permisos() {
  console.log("\n== 8) Bruno no ve lo de Vera · 9) Propietario · 10) 390 px ==");
  const deVera = await listOf(vera);
  const ajeno = deVera[0];
  const lb = await listOf(bruno);
  ok("API: Bruno no recibe ninguno de Vera", lb.every((f) => f.user.id === ids.bruno) && !lb.some((f) => deVera.some((v) => v.id === f.id)), JSON.stringify(lb.map((f) => f.id)));
  const lbFiltro = await listOf(bruno, `?userId=${ids.vera}`);
  ok("API: Bruno pidiendo `userId` de Vera sigue sin verlos", lbFiltro.length === lb.length);
  const p404 = await bruno.api(`/api/follow-ups/${ajeno.id}`, { method: "PATCH", body: body({ action: "postpone", preset: "1h" }) });
  ok("API: Bruno tocando uno de Vera → 404", p404.res.status === 404 && p404.json?.error?.code === "not_found", short(p404));
  const pb = await pending(bruno, "days=30");
  ok("API: «Sin contacto» de Bruno = solo su cliente", names(pb?.noContact?.rows).filter((n) => n.endsWith(S)).join("|") === N.bruno, names(pb?.noContact?.rows).join("|"));
  ok("API: el contador de Bruno es 0", (await bruno.api("/api/follow-ups/count")).json?.overdue === 0);
  const brunoFu = await bruno.api("/api/follow-ups", { method: "POST", body: body({ contactId: conv[N.bruno].contact.id, day: dayIn(2), time: "12:00", reason: "volver_a_contactar" }) });
  ok("API: Bruno crea el suyo", brunoFu.res.status === 201, short(brunoFu));

  const b = await pageAs(bruno);
  await gotoPendientes(b.page);
  const rowsB = await b.page.locator('[data-testid="follow-up-name"]').allInnerTexts();
  ok("UI (Bruno): ninguno de Vera en su lista", !rowsB.some((n) => deVera.some((v) => v.contact.name === n)), rowsB.join("|"));
  ok("UI (Bruno): sin número rojo", (await b.page.getByTestId("nav-overdue").count()) === 0);
  await b.ctx.close();

  // Propietario: Todos / Vera / Bruno.
  const o = await pageAs(owner);
  await gotoPendientes(o.page);
  const sel = o.page.getByTestId("pending-seller");
  // «Esta semana» y «Después» empiezan plegados: se abren para ver todo
  // (cualquiera puede estar vacía según el día de la semana).
  if (await o.page.getByTestId("group-toggle-week").count()) await o.page.getByTestId("group-toggle-week").click();
  if (await o.page.getByTestId("group-toggle-later").count()) await o.page.getByTestId("group-toggle-later").click();
  ok("UI (Propietario): «Vendedor: Todos» por omisión", (await sel.inputValue()) === "all");
  const todos = await o.page.locator('[data-testid="follow-up-row"]').allInnerTexts();
  ok(
    "UI (Propietario, Todos): ve los de Vera y el de Bruno, cada uno «De …»",
    todos.some((t) => t.includes(N.k60) && t.includes(`De ${VERA.name}`)) && todos.some((t) => t.includes(N.bruno) && t.includes(`De ${BRUNO.name}`)),
    todos.length
  );
  await sel.selectOption(ids.bruno);
  ok(
    "UI (Propietario, Bruno): solo el de Bruno",
    await until(async () => {
      const t = await o.page.locator('[data-testid="follow-up-name"]').allInnerTexts();
      return t.length === 1 && t[0] === N.bruno;
    }, 10000)
  );
  await sel.selectOption(ids.vera);
  ok(
    "UI (Propietario, Vera): los de Vera y su «Sin contacto»",
    await until(async () => {
      const t = await o.page.locator('[data-testid="follow-up-name"]').allInnerTexts();
      return t.includes(N.k60) && !t.includes(N.bruno) && /Sin contacto · 13/.test(await o.page.getByTestId("no-contact").locator("h2").innerText());
    }, 15000)
  );
  const pOwner = await pending(owner, `days=30&userId=${ids.bruno}`);
  ok("API (Propietario, `userId` = Bruno): su cliente", names(pOwner?.noContact?.rows).filter((n) => n.endsWith(S)).join("|") === N.bruno);
  const own404 = await api(`/api/follow-ups/${ajeno.id}`, { method: "PATCH", body: body({ action: "postpone", preset: "tomorrow" }) });
  ok("API: el Propietario sí puede posponer uno de Vera", own404.res.ok, short(own404));
  await o.ctx.close();

  // 390 px
  const m = await pageAs(vera, { width: 390, height: 844 });
  await gotoPendientes(m.page);
  const w = await m.page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth }));
  ok("390 px: Pendientes sin scroll horizontal", w.doc <= w.vw, JSON.stringify(w));
  await shot(m.page, "pendientes-390.png");
  if (REVISAR) await m.page.screenshot({ path: `${REVISAR}/pendientes-390-completa.png`, fullPage: true }).catch(() => {});
  await m.page.goto(`${BASE}/inbox?contact=${conv[N.laura].contact.id}`, { waitUntil: "load" });
  await m.page.getByTestId("inbox-remind").waitFor({ timeout: 60000 });
  const wi = await m.page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth }));
  ok("390 px: el chat con «Recordarme» sin scroll horizontal", wi.doc <= wi.vw, JSON.stringify(wi));
  await m.page.getByTestId("inbox-remind").click();
  await m.page.getByTestId("remind-dialog").waitFor();
  const wd = await m.page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth }));
  ok("390 px: el diálogo cabe", wd.doc <= wd.vw, JSON.stringify(wd));
  await m.ctx.close();

  // Sin tooltips: ningún `title` en Pendientes.
  const t = await pageAs(vera);
  await gotoPendientes(t.page);
  const titles = await t.page.locator('main [title], [data-testid="my-follow-ups"] [title], [data-testid="no-contact"] [title], [data-testid="no-reply"] [title]').count();
  ok("sin `title` (tooltips) en Pendientes", titles === 0, String(titles));
  await t.ctx.close();
}

/* ───────────────────────── main ───────────────────────── */

async function main() {
  const db = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await setup(db);
    browser = await chromium.launch();
    const made = await crear();
    await pendientes(made);
    await recuadros();
    await permisos();
  } catch (err) {
    ok("el guion terminó sin excepción", false, String(err?.stack ?? err));
  } finally {
    await browser?.close().catch(() => {});
    await db.end().catch(() => {});
  }
  console.log(`\n=====${checks - failures}/${checks} checks OK, ${failures} fallos =====`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
