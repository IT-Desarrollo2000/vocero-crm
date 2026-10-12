/**
 * Self-test E2E — recordatorios de cita y métricas de citas (dev-tasks/10).
 * Guion humano: tests/e2e/us-recordatorios.md
 *
 * Conduce la app real con dos cookie jars (Propietario + Vendedor dado de alta
 * por POST /api/settings/team), el wa-mock y el reloj SIMULADO del ticker
 * (`POST /api/dev/reminders/tick { now }`, que llama `runReminderTick` directo):
 *   a) AGENDA apagada → la ruta dev y el reporte responden 404 y el guion
 *      termina limpio (el resto no aplica)
 *   b) owner conecta WhatsApp, da de alta al Vendedor, abre la agenda 24/7
 *   c) plantilla de 2 variables creada y APROBADA en el wa-mock; activar con
 *      una plantilla pendiente → 422; con la aprobada + 24 h → 200
 *   d) cita A (~40 h): tick antes de vencer → nada; DOS ticks en paralelo al
 *      vencer → UNA plantilla (UNIQUE); la cita muestra `sent`; webhook
 *      `delivered` → la cita muestra entregado
 *   e) reprogramar A → tick en la ventana nueva → segundo recordatorio; el
 *      viejo queda de historial
 *   f) cita B cancelada → tick → nada; tick muy pasado de la gracia → nada
 *   g) Laboratorio: cita con la conversación de un caso (is_test) → tick en su
 *      ventana → sin fila ni plantilla (requiere IA → ai-mock)
 *   h) camino infeliz: `fail-sends` "error" → `failed` con motivo y la cita
 *      sigue `agendada`; el Vendedor reintenta con el mock sano → `sent`;
 *      segundo reintento → 409
 *   i) reporte /api/reports/bookings coherente (marcar realizada / no_show
 *      mueve los contadores con y sin recordatorio); Vendedor → 403
 *   j) activar HOY no avisa una cita cuyo momento de envío fue antes de
 *      `reminder_enabled_at` (espera real ≤ 2 min)
 *
 * Las aserciones de envío se hacen por TELÉFONO del contacto en el outbox: la
 * org del self-test puede tener citas de corridas anteriores que también
 * venzan con el reloj simulado.
 *
 * Presupuesto del limitador de login: hasta 3 POST a /sign-in|sign-up (alta
 * del owner que ya existe + su inicio de sesión + el Vendedor).
 *
 * Uso:
 *   1) BD migrada (0018 incluida) y app corriendo con WA_MOCK_ENABLED=true,
 *      META_GRAPH_BASE_URL → wa-mock, OPENROUTER_BASE_URL → ai-mock, AGENDA=on
 *      y AGENDA_REMINDER_TICK_MS=0 (el reloj real no debe adelantarse)
 *   2) node --env-file=.env.e2e scripts/e2e-recordatorios.mjs
 *
 * Sale con código 1 si algún check falla.
 */

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const S = Math.random().toString(36).slice(2, 8);
const PN = "PN-E2E-RECO";
const WABA = "WABA-E2E-RECO";
const LAB_TIMEOUT_MS = 180_000;
const MIN = 60_000;
const H = 60 * MIN;

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
const short = (r) => `${r.res.status} ${JSON.stringify(r.json)?.slice(0, 240)}`;
const iso = (ms) => new Date(ms).toISOString();

const owner = client();
const seller = client();

const OWNER_EMAIL = "e2e@vocero.test";
const OWNER_PASSWORD = "password-e2e-123";
const SELLER_EMAIL = `vend.reco.${S}@vocero.test`;
const SELLER_PASSWORD = "password-vend-123";

function signIn(c, email, password) {
  return c.api("/api/auth/sign-in/email", {
    method: "POST",
    body: body({ email, password }),
  });
}

let phoneSeq = 0;
const phone = () =>
  `52155${String(Date.now()).slice(-5)}${String(++phoneSeq).padStart(2, "0")}${Math.floor(Math.random() * 9)}`;

const tick = (now) =>
  owner.api("/api/dev/reminders/tick", { method: "POST", body: body(now ? { now: iso(now) } : {}) });

/**
 * El CRM normaliza el destinatario (521… → 52…): se compara por los últimos
 * 10 dígitos para no depender de esa regla.
 */
const last10 = (s) => String(s ?? "").replace(/\D/g, "").slice(-10);

async function outboxTo(to) {
  const ob = (await owner.api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  return ob.filter((o) => last10(o.to) === last10(to) && o.type === "template");
}

async function bookingById(c, id) {
  const list = (await c.api("/api/bookings")).json?.bookings ?? [];
  return list.find((b) => b.id === id) ?? null;
}

/** Un contacto real de WhatsApp (inbound) → { phone, contactId, conversationId }. */
async function newContact(label) {
  const p = phone();
  const name = `Reco ${label} ${S}`;
  const r = await owner.api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({
      phoneNumberId: PN,
      from: p,
      name,
      text: "hola, quiero agendar",
      waMessageId: `wamid.e2e.reco.${S}.${label}.${Math.random().toString(36).slice(2, 8)}`,
    }),
  });
  ok(`inbound de ${label}`, r.res.ok, short(r));
  let conv = null;
  await until(async () => {
    const list = (await owner.api("/api/conversations")).json?.conversations ?? [];
    conv = list.find((c) => c.contact?.name === name) ?? null;
    return !!conv;
  });
  ok(`conversación de ${label}`, !!conv?.contact?.id);
  return { phone: p, contactId: conv?.contact?.id, conversationId: conv?.id, name };
}

/** El hueco libre más cercano (≥) a `targetMs`. */
function slotNear(slots, targetMs, taken) {
  const free = slots
    .map((s) => Date.parse(s.startUtc))
    .filter((t) => t >= targetMs && !taken.has(t))
    .sort((a, b) => a - b);
  const t = free[0];
  if (t !== undefined) taken.add(t);
  return t;
}

function createBooking(contact, startMs, conversationId = contact.conversationId) {
  return owner.api("/api/bookings", {
    method: "POST",
    body: body({
      kind: "session",
      contactId: contact.contactId,
      conversationId,
      startUtc: iso(startMs),
    }),
  });
}

const reminderOf = (b, offset = 1440) =>
  (b?.reminders ?? []).find((r) => r.offsetMinutes === offset) ?? null;

async function main() {
  console.log("== a) Owner y bandera AGENDA ==");
  let su = await owner.api("/api/auth/sign-up/email", {
    method: "POST",
    body: body({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: "Operador E2E" }),
  });
  if (!su.res.ok) su = await signIn(owner, OWNER_EMAIL, OWNER_PASSWORD);
  ok("owner registrado o con sesión", su.res.ok, short(su));

  const cal = await owner.api("/api/calendar/settings");
  if (cal.res.status === 404) {
    const t = await tick();
    ok("AGENDA apagada: POST /api/dev/reminders/tick → 404", t.res.status === 404, short(t));
    const rep = await owner.api("/api/reports/bookings");
    ok("AGENDA apagada: GET /api/reports/bookings → 404", rep.res.status === 404, short(rep));
    console.log("  (agenda apagada: el resto del guion no aplica)");
    return;
  }
  ok("GET /api/calendar/settings trae `reminders`", cal.res.ok && !!cal.json?.reminders, short(cal));

  console.log("\n== b) WhatsApp, Vendedor y agenda 24/7 ==");
  // Una corrida anterior abortada puede haber dejado el mock fallando.
  const sano = await owner.api("/api/dev/wa-mock/fail-sends", { method: "POST", body: body({ mode: "off" }) });
  ok("wa-mock: envíos sanos al empezar", sano.json?.failSends === "off", short(sano));
  const conn = await owner.api("/api/settings/whatsapp", {
    method: "PUT",
    body: body({ wabaId: WABA, phoneNumberId: PN, token: "tok-e2e-reco" }),
  });
  ok("owner conecta WhatsApp (wa-mock)", conn.res.ok, short(conn));
  const alta = await owner.api("/api/settings/team", {
    method: "POST",
    body: body({ name: `Vendedor Reco ${S}`, email: SELLER_EMAIL, password: SELLER_PASSWORD }),
  });
  ok("alta del Vendedor → 201", alta.res.status === 201, short(alta));
  ok("el Vendedor inicia sesión", (await signIn(seller, SELLER_EMAIL, SELLER_PASSWORD)).res.ok);

  const allDay = [{ start: "00:00", end: "23:30" }];
  const agenda = await owner.api("/api/calendar/settings", {
    method: "PUT",
    body: body({
      weeklyHours: { mon: allDay, tue: allDay, wed: allDay, thu: allDay, fri: allDay, sat: allDay, sun: allDay },
      slotMinutes: 30,
      bufferMinutes: 0,
      minNoticeHours: 0,
      maxDaysAhead: 7,
      connector: "enlace-fijo",
    }),
  });
  ok("agenda abierta 24/7, 7 días", agenda.res.ok, short(agenda));

  console.log("\n== c) Plantilla aprobada y ajustes de recordatorio ==");
  const tplName = `recordatorio_cita_${S}`;
  const created = await owner.api("/api/templates", {
    method: "POST",
    body: body({
      name: tplName,
      language: "es_MX",
      category: "UTILITY",
      body: "Hola {{1}}, te recordamos tu cita el {{2}}.",
    }),
  });
  ok("plantilla de 2 variables creada", created.res.ok, short(created));
  const pendName = `recordatorio_pend_${S}`;
  await owner.api("/api/templates", {
    method: "POST",
    body: body({ name: pendName, language: "es_MX", category: "UTILITY", body: "Hola {{1}}" }),
  });
  const appr = await owner.api("/api/dev/wa-mock/template-status", {
    method: "POST",
    body: body({ wabaId: WABA, name: tplName, language: "es_MX", event: "APPROVED", notify: false }),
  });
  ok("Meta (mock) la aprueba", appr.res.ok, short(appr));
  ok("sync 200", (await owner.api("/api/templates/sync", { method: "POST" })).res.ok);
  const tpls = (await owner.api("/api/templates")).json?.templates ?? [];
  const tpl = tpls.find((t) => t.name === tplName);
  const pend = tpls.find((t) => t.name === pendName);
  ok("plantilla local aprobada", tpl?.status === "approved", JSON.stringify(tpl));

  const bad = await owner.api("/api/calendar/settings", {
    method: "PUT",
    body: body({ reminderEnabled: true, reminderTemplateId: pend?.id, reminderVariables: ["contact_name"] }),
  });
  ok("activar con plantilla no aprobada → 422", bad.res.status === 422 && !!bad.json?.error?.message, short(bad));
  const incompleta = await owner.api("/api/calendar/settings", {
    method: "PUT",
    body: body({ reminderEnabled: true, reminderTemplateId: tpl?.id, reminderVariables: ["contact_name"] }),
  });
  ok("mapeo incompleto → 422", incompleta.res.status === 422, short(incompleta));

  // Apagar primero: así esta corrida siempre pasa por apagado → encendido.
  await owner.api("/api/calendar/settings", { method: "PUT", body: body({ reminderEnabled: false }) });
  const on = await owner.api("/api/calendar/settings", {
    method: "PUT",
    body: body({
      reminderEnabled: true,
      reminderTemplateId: tpl?.id,
      reminderOffsetsMinutes: [1440],
      reminderVariables: ["contact_name", "booking_datetime"],
    }),
  });
  ok(
    "activar con la aprobada + 24 h → 200 con enabledAt",
    on.res.ok && on.json?.reminders?.enabled === true && !!on.json?.reminders?.enabledAt && on.json?.reminders?.warning === null,
    short(on)
  );
  const vendSettings = await seller.api("/api/calendar/settings", {
    method: "PUT",
    body: body({ reminderEnabled: false }),
  });
  ok("Vendedor no toca los recordatorios → 403", vendSettings.res.status === 403, short(vendSettings));

  console.log("\n== d) Cita A: un solo envío aunque corran dos ticks ==");
  const ctA = await newContact("A");
  const ctB = await newContact("B");
  const ctD = await newContact("D");
  const ctE = await newContact("E");
  const slots = (await owner.api("/api/calendar/availability")).json?.slots ?? [];
  ok("hay huecos para los próximos días", slots.length > 50, `n=${slots.length}`);
  const taken = new Set();
  const t0 = Date.now();
  // Separadas ≥ 10 h: la gracia de 24 h es 6 h, así cada tick solo toca la suya.
  const sE = slotNear(slots, t0 + 30 * H, taken);
  const sA = slotNear(slots, t0 + 40 * H, taken);
  const sB = slotNear(slots, t0 + 50 * H, taken);
  const sD = slotNear(slots, t0 + 60 * H, taken);
  const sD2 = slotNear(slots, (sD ?? 0) + 1, taken);
  const sC = slotNear(slots, t0 + 70 * H, taken);
  const sR = slotNear(slots, t0 + 100 * H, taken);
  ok("huecos elegidos", [sE, sA, sB, sD, sD2, sC, sR].every(Boolean));

  const bA = await createBooking(ctA, sA);
  ok("cita A creada (201)", bA.res.status === 201, short(bA));
  const idA = bA.json?.booking?.id;
  const dueA = sA - 24 * H;

  let t = await tick(dueA - 5 * MIN);
  ok("tick antes de vencer → 200", t.res.ok, short(t));
  ok("antes de vencer: ninguna plantilla para A", (await outboxTo(ctA.phone)).length === 0);
  const pendA = reminderOf(await bookingById(owner, idA));
  ok("la cita muestra el recordatorio `pending` con su dueAt", pendA?.status === "pending" && pendA?.dueAt === iso(dueA), JSON.stringify(pendA));

  const [t1, t2] = await Promise.all([tick(dueA + MIN), tick(dueA + MIN)]);
  ok("dos ticks en paralelo → 200 y 200", t1.res.ok && t2.res.ok, `${short(t1)} | ${short(t2)}`);
  const sentA = await outboxTo(ctA.phone);
  ok("UNA sola plantilla para A (claim atómico)", sentA.length === 1, `n=${sentA.length}`);
  const params = sentA[0]?.body?.template?.components?.[0]?.parameters?.map((p) => p.text) ?? [];
  ok("parámetros: nombre y fecha", params[0] === ctA.name && /\d{2}:\d{2}$/.test(params[1] ?? ""), JSON.stringify(params));
  let remA = reminderOf(await bookingById(owner, idA));
  ok("la cita muestra `sent`", remA?.status === "sent" && !!remA?.sentAt, JSON.stringify(remA));
  ok("el Vendedor también lo ve", reminderOf(await bookingById(seller, idA))?.status === "sent");

  const st = await owner.api("/api/dev/wa-mock/status", {
    method: "POST",
    body: body({ waMessageId: sentA[0]?.waMessageId, status: "delivered" }),
  });
  ok("webhook de estado delivered", st.res.ok, short(st));
  ok(
    "la cita muestra entregado",
    await until(async () => reminderOf(await bookingById(owner, idA))?.delivery === "delivered", 8000)
  );

  console.log("\n== e) Reprogramar → recordatorio nuevo ==");
  const re = await owner.api(`/api/bookings/${idA}`, {
    method: "PATCH",
    body: body({ action: "reschedule", startUtc: iso(sR) }),
  });
  ok("reprogramar A → 200", re.res.ok, short(re));
  remA = reminderOf(await bookingById(owner, idA));
  ok("tras reprogramar: pendiente para la hora nueva", remA?.status === "pending" && remA?.scheduledFor === iso(sR), JSON.stringify(remA));
  t = await tick(sR - 24 * H + MIN);
  ok("tick en la ventana nueva → 200", t.res.ok, short(t));
  ok("segunda plantilla para A", (await outboxTo(ctA.phone)).length === 2);
  remA = reminderOf(await bookingById(owner, idA));
  ok("la cita muestra `sent` para la hora vigente", remA?.status === "sent" && remA?.scheduledFor === iso(sR), JSON.stringify(remA));

  console.log("\n== f) Cancelar → nada; fuera de la gracia → nada ==");
  const bB = await createBooking(ctB, sB);
  ok("cita B creada", bB.res.status === 201, short(bB));
  const idB = bB.json?.booking?.id;
  const cancel = await owner.api(`/api/bookings/${idB}`, { method: "PATCH", body: body({ action: "cancel" }) });
  ok("cancelar B → 200", cancel.res.ok, short(cancel));
  await tick(sB - 24 * H + MIN);
  ok("cancelada: ninguna plantilla para B", (await outboxTo(ctB.phone)).length === 0);
  ok("cancelada: sin recordatorios en la cita", (await bookingById(owner, idB))?.reminders?.length === 0);

  const bD = await createBooking(ctD, sD);
  ok("cita D creada", bD.res.status === 201, short(bD));
  const idD = bD.json?.booking?.id;
  const dueD = sD - 24 * H;
  await tick(dueD + 6 * H + 5 * MIN);
  ok("tick muy pasado de la gracia: nada para D", (await outboxTo(ctD.phone)).length === 0);
  ok("…y sin fila (sigue sin intento)", reminderOf(await bookingById(owner, idD))?.id == null);

  console.log("\n== g) Laboratorio: una cita de prueba nunca envía ==");
  let labConvId = null;
  await until(
    async () => !((await owner.api("/api/lab/runs")).json?.runs ?? []).some((c) => c.status === "running"),
    LAB_TIMEOUT_MS
  );
  const run = await owner.api("/api/lab/runs", { method: "POST" });
  ok("POST /api/lab/runs → 202", run.res.status === 202 && !!run.json?.runId, short(run));
  await until(async () => {
    const d = await owner.api(`/api/lab/runs/${run.json?.runId}`);
    labConvId = (d.json?.cases ?? []).find((c) => c.conversationId)?.conversationId ?? null;
    return !!labConvId;
  }, LAB_TIMEOUT_MS);
  ok("un caso del Laboratorio trae conversationId", !!labConvId);
  if (labConvId) {
    // El contacto lo pone la conversación de prueba: la cita nace is_test.
    const bC = await createBooking(ctB, sC, labConvId);
    ok("cita de prueba creada", bC.res.status === 201, short(bC));
    const idC = bC.json?.booking?.id;
    const before = (await owner.api("/api/dev/wa-mock/outbox")).json?.outbox?.length ?? 0;
    await tick(sC - 24 * H + MIN);
    const after = (await owner.api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
    const c = await bookingById(owner, idC);
    ok("la cita es de prueba", c?.isTest === true, JSON.stringify(c?.isTest));
    ok("cita de prueba: sin recordatorios", (c?.reminders ?? []).length === 0, JSON.stringify(c?.reminders));
    ok(
      "outbox sin plantillas nuevas por la cita de prueba",
      after.slice(before).every((o) => o.type !== "template" || last10(o.to) !== last10(ctB.phone)),
      `nuevas=${after.length - before}`
    );
  }

  console.log("\n== h) Camino infeliz: Meta rechaza → reintento manual ==");
  const bD2 = await owner.api(`/api/bookings/${idD}`, {
    method: "PATCH",
    body: body({ action: "reschedule", startUtc: iso(sD2) }),
  });
  ok("D se reprograma al hueco siguiente (clave nueva)", bD2.res.ok, short(bD2));
  const fs = await owner.api("/api/dev/wa-mock/fail-sends", { method: "POST", body: body({ mode: "error" }) });
  ok("wa-mock: envíos fallan (error)", fs.json?.failSends === "error", short(fs));
  await tick(sD2 - 24 * H + MIN);
  await owner.api("/api/dev/wa-mock/fail-sends", { method: "POST", body: body({ mode: "off" }) });
  let dNow = await bookingById(owner, idD);
  let remD = reminderOf(dNow);
  ok("recordatorio `failed` con motivo", remD?.status === "failed" && !!remD?.error && remD?.canRetry === true, JSON.stringify(remD));
  ok("la cita sigue `agendada`", dNow?.status === "agendada");

  const retry1 = await seller.api(`/api/bookings/${idD}/reminders/${remD?.id}/retry`, { method: "POST" });
  ok(
    "el Vendedor reintenta → 200 `sent`",
    retry1.res.ok && retry1.json?.reminder?.status === "sent" && retry1.json?.reminder?.attempts === 2,
    short(retry1)
  );
  ok("plantilla para D tras el reintento", (await outboxTo(ctD.phone)).length === 1);
  const retry2 = await seller.api(`/api/bookings/${idD}/reminders/${remD?.id}/retry`, { method: "POST" });
  ok("segundo reintento → 409", retry2.res.status === 409, short(retry2));
  const retry404 = await seller.api(`/api/bookings/${idA}/reminders/${remD?.id}/retry`, { method: "POST" });
  ok("recordatorio de otra cita → 404", retry404.res.status === 404, short(retry404));

  console.log("\n== i) Reporte de citas ==");
  const today = new Date().toISOString().slice(0, 10);
  const in7 = new Date(Date.now() + 7 * 24 * H).toISOString().slice(0, 10);
  const q = `/api/reports/bookings?range=custom&from=${today}&to=${in7}`;
  const rep0 = await owner.api(q);
  ok("owner: GET /api/reports/bookings → 200", rep0.res.ok && rep0.json?.attendance?.ok && rep0.json?.byReminder?.ok && rep0.json?.offers?.ok, short(rep0));
  await owner.api(`/api/bookings/${idA}`, { method: "PATCH", body: body({ action: "status", status: "realizada" }) });
  await owner.api(`/api/bookings/${idD}`, { method: "PATCH", body: body({ action: "status", status: "no_show" }) });
  const rep1 = await owner.api(q);
  const a0 = rep0.json?.attendance?.data;
  const a1 = rep1.json?.attendance?.data;
  const w0 = rep0.json?.byReminder?.data?.withReminder;
  const w1 = rep1.json?.byReminder?.data?.withReminder;
  ok("realizada +1 y no_show +1", a1?.realizada === (a0?.realizada ?? 0) + 1 && a1?.noShow === (a0?.noShow ?? 0) + 1, `${JSON.stringify(a0)} → ${JSON.stringify(a1)}`);
  ok("tasa = realizada / (realizada + no_show)", Math.abs((a1?.rate ?? -1) - a1?.realizada / (a1?.realizada + a1?.noShow)) < 1e-9, JSON.stringify(a1));
  ok("ambas cuentan «con recordatorio»", w1?.realizada === (w0?.realizada ?? 0) + 1 && w1?.noShow === (w0?.noShow ?? 0) + 1, `${JSON.stringify(w0)} → ${JSON.stringify(w1)}`);
  const off = rep1.json?.offers?.data;
  ok("oferta→cita: proporción 0..1 o null", off && (off.rate === null || (off.rate >= 0 && off.rate <= 1)), JSON.stringify(off));
  const repV = await seller.api(q);
  ok("Vendedor: reporte → 403", repV.res.status === 403, short(repV));

  console.log("\n== j) Encender hoy no avisa lo que venció antes ==");
  // Anticipación a la medida para que el vencimiento caiga en ~1-2 min reales.
  const k = Math.floor((sE - Date.now()) / MIN) - 1;
  ok("anticipación a la medida en rango (60..4320)", k >= 60 && k <= 4320, `k=${k}`);
  const setK = await owner.api("/api/calendar/settings", {
    method: "PUT",
    body: body({ reminderOffsetsMinutes: [1440, k] }),
  });
  ok("anticipaciones [24 h, k] → 200", setK.res.ok, short(setK));
  const bE = await createBooking(ctE, sE);
  ok("cita E creada antes de su vencimiento", bE.res.status === 201, short(bE));
  const idE = bE.json?.booking?.id;
  const dueE = sE - k * MIN;
  while (Date.now() < dueE + 2_000) await sleep(1_000);
  await owner.api("/api/calendar/settings", { method: "PUT", body: body({ reminderEnabled: false }) });
  const reOn = await owner.api("/api/calendar/settings", { method: "PUT", body: body({ reminderEnabled: true }) });
  ok("apagar → encender reescribe enabledAt", reOn.res.ok && Date.parse(reOn.json?.reminders?.enabledAt) > dueE, short(reOn));
  await tick(dueE + MIN);
  ok("nada para E (venció antes de enabledAt)", (await outboxTo(ctE.phone)).length === 0);
  ok("E no muestra pendiente para k", !reminderOf(await bookingById(owner, idE), k));
  await owner.api("/api/calendar/settings", { method: "PUT", body: body({ reminderOffsetsMinutes: [1440] }) });
}

main()
  .catch((err) => {
    failures++;
    console.error("Error inesperado:", err);
  })
  .finally(() => {
    console.log(`\n=====${checks - failures}/${checks} checks OK, ${failures} fallos =====`);
    process.exit(failures > 0 ? 1 : 0);
  });
