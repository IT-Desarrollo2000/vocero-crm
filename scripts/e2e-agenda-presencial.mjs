/**
 * Self-test E2E — 023: agenda presencial (tipos de cita, vendedores y
 * choques). Parte API. Guion humano: tests/e2e/us-agenda-presencial.md
 *
 * Conduce la app real (wa-mock + ai-mock) con tres cookie jars (Propietario +
 * dos Vendedores dados de alta por POST /api/settings/team) y la llave del
 * bot (`X-API-Key`):
 *   a) setup: owner, WhatsApp (wa-mock), dos Vendedores, agenda 24/7 con
 *      rejilla de 30 min y sin margen; catálogo de tipos sembrado
 *   CA-1) dos vendedores, Servicio a la misma hora: el segundo recibe 409
 *        `overlap_warning` con `conflicts`; con `confirmOverlap` → 201
 *   CA-2) otra Prueba de manejo traslapada (exacta y parcial) → 409
 *        `slot_taken`, venga del owner o de un Vendedor, con o sin confirmar
 *   CA-3) el mismo vendedor no se traslapa; reasignar a un vendedor ocupado →
 *        409; un Vendedor que manda `assignedUserId` → 403
 *   CA-4) el bot no ofrece horarios con cita activa; dos reservas simultáneas
 *        al mismo horario desde dos conversaciones → UNA cita activa
 *   CA-5) el Vendedor no ve ni toca (404) la cita de otro; sí ve las sin
 *        asignar, las que él creó (aunque se reasignen) y los bloqueos
 *   CA-6) con AGENDA apagada (modo `--off`) todo lo nuevo → 404 y la
 *        migración 0025 está aplicada igual
 *   CA-7) una cita de una conversación del Laboratorio (is_test) no ocupa la
 *        agenda (requiere IA → ai-mock)
 *   CA-8) el AGENTE in-process agenda en Messenger (conversación asignada →
 *        vendedor = el asignado) e Instagram (sin asignar → sin vendedor),
 *        conducido con los marcadores del ai-mock `[e2e-agenda <tipo>]` y
 *        `[e2e-reserva <ISO>]` (el ISO sale de la oferta registrada en
 *        `offered_slot`); la confirmación por el canal trae "Te agendé tu
 *        servicio" y "Te esperamos en <dirección>"; con recordatorios
 *        encendidos la cita no programa ninguno (vacío o `skipped`) mientras
 *        una cita de control de WhatsApp sí. Camino infeliz con el agente:
 *        tipo inexistente → pregunta con los nombres reales; un horario no
 *        ofrecido → re-oferta sin cita; no ofrece encima de una cita manual
 *        de otro tipo (strict)
 *   camino infeliz) typeId inexistente / sin typeId / `type` desconocido en
 *        el bot / dirección de 301 caracteres → 422
 *
 * Presupuesto del limitador de login: 4 POST a /sign-in|sign-up (alta o
 * login del owner + los dos Vendedores). Reinicia el server entre guiones.
 *
 * Uso (BD AISLADA recién migrada, app con AGENDA=on, CHANNELS con instagram
 * y messenger, AGENDA_REMINDER_TICK_MS=0):
 *   node --env-file=.env.e2e scripts/e2e-agenda-presencial.mjs
 * Con la agenda apagada (server y guion con AGENDA=off):
 *   AGENDA=off node --env-file=.env.e2e scripts/e2e-agenda-presencial.mjs --off
 *
 * Sale con código 1 si algún check falla.
 */
import postgres from "postgres";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const BOT_KEY = process.env.BOT_API_KEY ?? "";
const OFF = process.argv.includes("--off");
const S = Math.random().toString(36).slice(2, 8);
const PN = "PN-E2E-023";
const WABA = "WABA-E2E-023";
const LAB_TIMEOUT_MS = 180_000;
const MIN = 60_000;
const H = 60 * MIN;

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
const notes = [];
function info(msg) {
  notes.push(msg);
  console.log(`  INFO ${msg}`);
}

/** Cliente HTTP con su propio cookie jar (una sesión por actor). */
function client(extraHeaders = {}) {
  const jar = { cookie: "" };
  async function api(path, opts = {}) {
    const res = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: {
        "content-type": "application/json",
        origin: BASE,
        ...extraHeaders,
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
const short = (r) => `${r.res.status} ${JSON.stringify(r.json)?.slice(0, 300)}`;
const iso = (ms) => new Date(ms).toISOString();
const ACTIVE = new Set(["agendada", "realizada"]);

/** Lectura directa de `offered_slot` (la oferta que el agente registró). */
const sql = postgres(process.env.DATABASE_URL ?? "postgres://invalid", {
  max: 1,
  onnotice: () => {},
});

const owner = client();
const v1 = client();
const v2 = client();
const bot = client({ "x-api-key": BOT_KEY });

const OWNER_EMAIL = "e2e@vocero.test";
const OWNER_PASSWORD = "password-e2e-123";
const V1_NAME = `Vendedor Uno ${S}`;
const V2_NAME = `Vendedora Dos ${S}`;
const V1_EMAIL = `v1.023.${S}@vocero.test`;
const V2_EMAIL = `v2.023.${S}@vocero.test`;
const SELLER_PASSWORD = "password-vend-123";

function signIn(c, email, password) {
  return c.api("/api/auth/sign-in/email", {
    method: "POST",
    body: body({ email, password }),
  });
}

let seq = 0;
const phone = () =>
  `52155${String(Date.now()).slice(-5)}${String(++seq).padStart(2, "0")}${Math.floor(Math.random() * 9)}`;

/** Un contacto real de WhatsApp (inbound) → { phone, contactId, conversationId }. */
async function newContact(label) {
  const p = phone();
  const name = `Presencial ${label} ${S}`;
  const r = await owner.api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({
      phoneNumberId: PN,
      from: p,
      name,
      text: "hola, informes",
      waMessageId: `wamid.e2e.023.${S}.${label}.${Math.random().toString(36).slice(2, 8)}`,
    }),
  });
  let conv = null;
  await until(async () => {
    const list = (await owner.api("/api/conversations")).json?.conversations ?? [];
    conv = list.find((c) => c.contact?.name === name) ?? null;
    return !!conv;
  });
  ok(`contacto ${label} listo (inbound → conversación)`, r.res.ok && !!conv?.contact?.id, short(r));
  return { phone: p, contactId: conv?.contact?.id, conversationId: conv?.id, name };
}

async function allBookings(c = owner) {
  return (await c.api("/api/bookings")).json?.bookings ?? [];
}

/** POST /api/bookings de una sesión (sin conversación: el vendedor es quien agenda). */
function book(c, { contact, typeId, startMs, assignedUserId, confirmOverlap, conversationId }) {
  return c.api("/api/bookings", {
    method: "POST",
    body: body({
      kind: "session",
      contactId: contact.contactId,
      conversationId: conversationId ?? null,
      startUtc: iso(startMs),
      typeId,
      ...(assignedUserId !== undefined ? { assignedUserId } : {}),
      ...(confirmOverlap !== undefined ? { confirmOverlap } : {}),
    }),
  });
}

/**
 * Primer hueco de la rejilla del tipo SIN choques (ni duros ni de
 * advertencia), a partir de `minMs`. `sellerId=none`: la rejilla no se
 * contamina con las citas del owner.
 */
async function pick(typeId, minMs, around = []) {
  const slots =
    (await owner.api(`/api/calendar/availability?typeId=${typeId}&sellerId=none`)).json?.slots ?? [];
  const free = new Set(
    slots.filter((x) => (x.conflicts ?? []).length === 0).map((x) => Date.parse(x.startUtc))
  );
  // `around`: desplazamientos (min) que también deben ser huecos libres de la
  // rejilla — p. ej. el traslape parcial y la cita contigua no deben caer
  // fuera del horario (cierra 23:30) por la hora a la que corre el guion.
  const t = [...free]
    .sort((a, b) => a - b)
    .find((x) => x >= minMs && around.every((m) => free.has(x + m * MIN)));
  return t ?? null;
}

/** Huecos que el Vendedor ve para un tipo (su rejilla `staff`). */
async function sellerGrid(c, typeId) {
  return (await c.api(`/api/calendar/availability?typeId=${typeId}`)).json?.slots ?? [];
}

const overlaps = (aStart, aMin, bStart, bMin) =>
  aStart < bStart + bMin * MIN && bStart < aStart + aMin * MIN;

/* ============================================================ */

async function offChecks() {
  console.log("\n== CA-6) AGENDA apagada: todo lo nuevo responde 404 ==");
  const rutas = [
    ["GET", "/api/calendar/types"],
    ["GET", "/api/calendar/types?all=1"],
    ["POST", "/api/calendar/types", { name: "Fantasma", durationMinutes: 30 }],
    ["PATCH", "/api/calendar/types/apt_inexistente", { active: false }],
    ["GET", "/api/calendar/availability?typeId=apt_inexistente"],
    ["GET", "/api/calendar/settings"],
    ["PUT", "/api/calendar/settings", { address: "Av. Fantasma 1" }],
    ["GET", "/api/bookings"],
    ["POST", "/api/bookings", { kind: "session", contactId: "ct_x", startUtc: iso(Date.now() + H), typeId: "apt_x" }],
    ["PATCH", "/api/bookings/bk_inexistente", { action: "assign", userId: null }],
  ];
  for (const [method, path, payload] of rutas) {
    const r = await owner.api(path, { method, ...(payload ? { body: body(payload) } : {}) });
    ok(`${method} ${path} → 404`, r.res.status === 404, short(r));
  }
  const botRutas = [
    ["GET", "/api/bot/availability?conversationId=x&type=Servicio"],
    ["POST", "/api/bot/bookings", { conversationId: "x", startUtc: iso(Date.now() + H) }],
    ["PATCH", "/api/bot/bookings", { conversationId: "x", startUtc: iso(Date.now() + H), bookingId: "bk_x" }],
  ];
  for (const [method, path, payload] of botRutas) {
    const r = await bot.api(path, { method, ...(payload ? { body: body(payload) } : {}) });
    ok(`bot ${method} ${path} → 404`, r.res.status === 404, short(r));
  }
  // Revisión 023: la bandera va ANTES que la sesión — sin sesión también 404
  // (un 401 delataría que la ruta existe).
  const anon = client();
  for (const path of ["/api/bookings", "/api/calendar/availability", "/api/calendar/types"]) {
    const r = await anon.api(path);
    ok(`sin sesión: GET ${path} → 404 (no 401)`, r.res.status === 404, short(r));
  }
  const anonPost = await anon.api("/api/bookings", { method: "POST", body: body({ kind: "block" }) });
  ok("sin sesión: POST /api/bookings → 404", anonPost.res.status === 404, short(anonPost));

  const page = await owner.api("/bookings");
  ok("la pantalla /bookings no existe", page.res.status === 404, `status=${page.res.status}`);

  // La migración se aplica igual con la bandera apagada.
  if (process.env.DATABASE_URL) {
    const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
    try {
      const [t] = await sql`select to_regclass('vocero.appointment_type')::text as t`;
      const cols = await sql`
        select table_name, column_name from information_schema.columns
        where table_schema = 'vocero'
          and ((table_name = 'booking' and column_name in ('appointment_type_id','assigned_user_id','exclusive','created_by_user_id'))
            or (table_name = 'calendar_settings' and column_name = 'address')
            or (table_name = 'offered_slot' and column_name = 'appointment_type_id'))`;
      ok("migración 0025 aplicada: existe vocero.appointment_type", t?.t === "vocero.appointment_type", JSON.stringify(t));
      ok("…y las columnas nuevas de booking, offered_slot y calendar_settings", cols.length === 6, JSON.stringify(cols));
      // 025 — Migración 0026 (también con la bandera apagada).
      const cols26 = await sql`
        select table_name, column_name, is_nullable, column_default from information_schema.columns
        where table_schema = 'vocero'
          and ((table_name = 'agent_profile' and column_name = 'formality')
            or (table_name = 'message' and column_name = 'agent_action'))`;
      const formality = cols26.find((c) => c.column_name === "formality");
      ok(
        "migración 0026 aplicada: agent_profile.formality (NOT NULL, default 'tu') y message.agent_action",
        cols26.length === 2 && formality?.is_nullable === "NO" && String(formality?.column_default).includes("'tu'"),
        JSON.stringify(cols26)
      );
    } finally {
      await sql.end();
    }
  } else {
    info("sin DATABASE_URL: no se verifica la migración por SQL");
  }
}

/* ============================================================ */

async function main() {
  if (BOT_KEY.length < 16) {
    console.error("BOT_API_KEY ausente o corta: el guion necesita la llave del bot.");
    process.exit(1);
  }

  console.log("== a) Owner, bandera y equipo ==");
  let su = await owner.api("/api/auth/sign-up/email", {
    method: "POST",
    body: body({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: "Operador E2E" }),
  });
  if (!su.res.ok) su = await signIn(owner, OWNER_EMAIL, OWNER_PASSWORD);
  ok("owner registrado o con sesión", su.res.ok, short(su));

  const cal = await owner.api("/api/calendar/settings");
  if (cal.res.status === 404) {
    if (!OFF) info("la agenda está apagada sin `--off`: se corren los checks del modo apagado");
    await offChecks();
    return;
  }
  if (OFF) {
    ok("modo --off: la agenda debería estar apagada", false, short(cal));
    return;
  }
  ok("GET /api/calendar/settings → 200 (agenda encendida)", cal.res.ok, short(cal));

  const conn = await owner.api("/api/settings/whatsapp", {
    method: "PUT",
    body: body({ wabaId: WABA, phoneNumberId: PN, token: "tok-e2e-023" }),
  });
  ok("owner conecta WhatsApp (wa-mock)", conn.res.ok, short(conn));

  for (const [name, email] of [
    [V1_NAME, V1_EMAIL],
    [V2_NAME, V2_EMAIL],
  ]) {
    const alta = await owner.api("/api/settings/team", {
      method: "POST",
      body: body({ name, email, password: SELLER_PASSWORD }),
    });
    ok(`alta de ${name} → 201`, alta.res.status === 201, short(alta));
  }
  ok("Vendedor Uno inicia sesión", (await signIn(v1, V1_EMAIL, SELLER_PASSWORD)).res.ok);
  ok("Vendedora Dos inicia sesión", (await signIn(v2, V2_EMAIL, SELLER_PASSWORD)).res.ok);
  const members = (await owner.api("/api/settings/team")).json?.members ?? [];
  const V1 = members.find((m) => m.email === V1_EMAIL)?.userId;
  const V2 = members.find((m) => m.email === V2_EMAIL)?.userId;
  const OWNER = members.find((m) => m.email === OWNER_EMAIL)?.userId;
  ok("ids de los tres miembros", Boolean(V1 && V2 && OWNER), JSON.stringify(members.map((m) => m.email)));

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
      meetingLink: null,
      reminderEnabled: false,
    }),
  });
  ok("agenda 24/7, rejilla de 30 min, sin margen", agenda.res.ok, short(agenda));

  const types = (await owner.api("/api/calendar/types")).json?.types ?? [];
  const byName = (n) => types.find((t) => t.name === n);
  const PRUEBA = byName("Prueba de manejo");
  const SERVICIO = byName("Servicio");
  const GARANTIA = byName("Garantía");
  ok(
    "siembra: Prueba de manejo (exclusiva, 60), Servicio (30), Garantía (30), Otro (30)",
    PRUEBA?.exclusive === true &&
      PRUEBA?.durationMinutes === 60 &&
      SERVICIO?.exclusive === false &&
      SERVICIO?.durationMinutes === 30 &&
      GARANTIA?.exclusive === false &&
      !!byName("Otro"),
    JSON.stringify(types.map((t) => [t.name, t.exclusive, t.durationMinutes]))
  );
  const sellerTypes = await v1.api("/api/calendar/types");
  ok("el Vendedor lee el catálogo (GET any)", sellerTypes.res.ok && (sellerTypes.json?.types ?? []).length === types.length, short(sellerTypes));
  const sellerAll = await v1.api("/api/calendar/types?all=1");
  ok("…pero `?all=1` es solo del Propietario (403)", sellerAll.res.status === 403, short(sellerAll));
  const sellerNewType = await v1.api("/api/calendar/types", {
    method: "POST",
    body: body({ name: "Del vendedor", durationMinutes: 30 }),
  });
  ok("el Vendedor no crea tipos (403)", sellerNewType.res.status === 403, short(sellerNewType));
  if (!PRUEBA || !SERVICIO || !GARANTIA || !V1 || !V2 || !OWNER) {
    console.log("  (sin catálogo o sin miembros no se puede seguir)");
    return;
  }

  const c1 = await newContact("c1");
  const c2 = await newContact("c2");
  const c3 = await newContact("c3");
  const t0 = Date.now();

  /* ---------------- CA-1 ---------------- */
  console.log("\n== CA-1) Dos vendedores, Servicio a la misma hora ==");
  const T1 = await pick(SERVICIO.id, t0 + 26 * H);
  ok("hueco libre para CA-1", !!T1);
  const a1 = await book(v1, { contact: c1, typeId: SERVICIO.id, startMs: T1 });
  ok("Vendedor Uno agenda Servicio → 201", a1.res.status === 201, short(a1));
  const ca1Id1 = a1.json?.booking?.id;

  const grid2 = await sellerGrid(v2, SERVICIO.id);
  const enRejilla = grid2.find((s) => Date.parse(s.startUtc) === T1);
  ok(
    "la rejilla de Vendedora Dos muestra el horario como Ocupado (con detalle tipo/vendedor)",
    (enRejilla?.conflicts ?? []).some((c) => c.bookingId === ca1Id1 && c.typeName === "Servicio" && c.sellerName === V1_NAME),
    JSON.stringify(enRejilla)
  );

  const w1 = await book(v2, { contact: c2, typeId: SERVICIO.id, startMs: T1 });
  ok(
    "Vendedora Dos a la misma hora → 409 overlap_warning (código EXACTO)",
    w1.res.status === 409 && w1.json?.error?.code === "overlap_warning",
    short(w1)
  );
  ok(
    "…con `conflicts` como hermano: tipo, vendedor y hora, sin datos del contacto",
    Array.isArray(w1.json?.conflicts) &&
      w1.json.conflicts.some((c) => c.bookingId === ca1Id1 && c.typeName === "Servicio" && c.sellerName === V1_NAME && c.startUtc === iso(T1)) &&
      !JSON.stringify(w1.json).includes(c1.name),
    short(w1)
  );
  const antesConfirmar = (await allBookings()).filter((b) => Date.parse(b.scheduledAtUtc) === T1 && ACTIVE.has(b.status));
  ok("la advertencia NO crea nada", antesConfirmar.length === 1, `activas=${antesConfirmar.length}`);
  const w1ok = await book(v2, { contact: c2, typeId: SERVICIO.id, startMs: T1, confirmOverlap: true });
  ok("con confirmOverlap:true → 201", w1ok.res.status === 201, short(w1ok));
  const ca1Id2 = w1ok.json?.booking?.id;
  const enT1 = (await allBookings()).filter((b) => Date.parse(b.scheduledAtUtc) === T1 && ACTIVE.has(b.status));
  ok(
    "existen las dos citas, cada una con su vendedor y su tipo",
    enT1.length === 2 &&
      enT1.some((b) => b.id === ca1Id1 && b.assignedUser?.id === V1 && b.type?.id === SERVICIO.id) &&
      enT1.some((b) => b.id === ca1Id2 && b.assignedUser?.id === V2 && b.type?.id === SERVICIO.id),
    JSON.stringify(enT1.map((b) => ({ id: b.id, seller: b.assignedUser, type: b.type })))
  );
  ok(
    "la duración se copió del tipo (30 min)",
    enT1.every((b) => b.durationMinutes === SERVICIO.durationMinutes),
    JSON.stringify(enT1.map((b) => b.durationMinutes))
  );

  /* ---------------- CA-2 ---------------- */
  console.log("\n== CA-2) Prueba de manejo: una a la vez en toda la agencia ==");
  const T2 = await pick(PRUEBA.id, t0 + 32 * H, [-30, 30, 60]);
  ok("hueco libre para CA-2", !!T2);
  const p1 = await book(owner, { contact: c1, typeId: PRUEBA.id, startMs: T2, assignedUserId: V1 });
  ok("owner agenda Prueba de manejo para Vendedor Uno → 201", p1.res.status === 201, short(p1));
  const intentos = [
    ["Vendedora Dos, misma hora", v2, { startMs: T2 }],
    ["Vendedora Dos, misma hora con confirmOverlap", v2, { startMs: T2, confirmOverlap: true }],
    ["owner sin vendedor, misma hora", owner, { startMs: T2, assignedUserId: null }],
    ["owner para Vendedora Dos, +30 min (traslape parcial)", owner, { startMs: T2 + 30 * MIN, assignedUserId: V2 }],
    ["Vendedora Dos, +30 min (traslape parcial)", v2, { startMs: T2 + 30 * MIN }],
    ["Vendedora Dos, −30 min (traslape parcial)", v2, { startMs: T2 - 30 * MIN }],
  ];
  const sinAlternativas = [];
  for (const [label, actor, extra] of intentos) {
    const r = await book(actor, { contact: c2, typeId: PRUEBA.id, ...extra });
    ok(`${label} → 409 slot_taken`, r.res.status === 409 && r.json?.error?.code === "slot_taken", short(r));
    if (!(Array.isArray(r.json?.slots) && r.json.slots.length > 0)) sinAlternativas.push(label);
  }
  if (sinAlternativas.length) {
    info(
      `CA-2: el 409 slot_taken del alta manual llega SIN alternativas (slots vacío) en: ${sinAlternativas.join(" · ")}. ` +
        "Por diseño (service.ts: un humano no recibe alternativas REGISTRADAS como oferta); la UI recarga su rejilla (plan §9)."
    );
  }
  const pruebaT2 = (await allBookings()).filter(
    (b) => b.type?.id === PRUEBA.id && ACTIVE.has(b.status) && overlaps(Date.parse(b.scheduledAtUtc), b.durationMinutes, T2, 60)
  );
  ok("una sola Prueba de manejo activa en esa ventana", pruebaT2.length === 1, `n=${pruebaT2.length}`);
  const otroTipo = await book(v2, { contact: c2, typeId: SERVICIO.id, startMs: T2 });
  ok(
    "otro tipo (Servicio) a esa hora → solo advertencia (overlap_warning)",
    otroTipo.res.status === 409 && otroTipo.json?.error?.code === "overlap_warning",
    short(otroTipo)
  );
  const contigua = await book(v2, { contact: c2, typeId: PRUEBA.id, startMs: T2 + 60 * MIN });
  ok("Prueba de manejo contigua (+60, sin traslape) → 201", contigua.res.status === 201, short(contigua));

  /* ---------------- CA-3 ---------------- */
  console.log("\n== CA-3) El mismo vendedor no se traslapa; reasignar ==");
  const T3 = await pick(SERVICIO.id, t0 + 38 * H, [-30]);
  ok("hueco libre para CA-3", !!T3);
  const s1 = await book(v1, { contact: c1, typeId: SERVICIO.id, startMs: T3 });
  ok("Vendedor Uno agenda Servicio → 201", s1.res.status === 201, short(s1));
  const s2 = await book(v1, { contact: c3, typeId: GARANTIA.id, startMs: T3, confirmOverlap: true });
  ok(
    "Vendedor Uno, otra cita suya a la misma hora (aun confirmando) → 409 slot_taken",
    s2.res.status === 409 && s2.json?.error?.code === "slot_taken",
    short(s2)
  );
  const s3 = await book(v1, { contact: c3, typeId: PRUEBA.id, startMs: T3 - 30 * MIN });
  ok(
    "Vendedor Uno, Prueba de manejo que se traslapa a medias con la suya → 409 slot_taken",
    s3.res.status === 409 && s3.json?.error?.code === "slot_taken",
    short(s3)
  );
  const ownerParaV1 = await book(owner, { contact: c3, typeId: GARANTIA.id, startMs: T3, assignedUserId: V1, confirmOverlap: true });
  ok(
    "owner asigna a Vendedor Uno otra cita traslapada → 409 slot_taken",
    ownerParaV1.res.status === 409 && ownerParaV1.json?.error?.code === "slot_taken",
    short(ownerParaV1)
  );

  const x = await book(owner, { contact: c2, typeId: SERVICIO.id, startMs: T3, assignedUserId: V2, confirmOverlap: true });
  ok("owner agenda a Vendedora Dos a esa hora (confirmando la advertencia) → 201", x.res.status === 201, short(x));
  const xId = x.json?.booking?.id;
  const reasignarOcupado = await owner.api(`/api/bookings/${xId}`, {
    method: "PATCH",
    body: body({ action: "assign", userId: V1 }),
  });
  ok(
    "reasignar esa cita a Vendedor Uno (ocupado) → 409 slot_taken con conflicts",
    reasignarOcupado.res.status === 409 &&
      reasignarOcupado.json?.error?.code === "slot_taken" &&
      (reasignarOcupado.json?.conflicts ?? []).some((c) => c.bookingId === s1.json?.booking?.id),
    short(reasignarOcupado)
  );
  const reasignarLibre = await owner.api(`/api/bookings/${xId}`, {
    method: "PATCH",
    body: body({ action: "assign", userId: OWNER }),
  });
  ok(
    "reasignar a un vendedor libre → 200",
    reasignarLibre.res.ok && reasignarLibre.json?.assignedUserId === OWNER,
    short(reasignarLibre)
  );
  const noMiembro = await owner.api(`/api/bookings/${xId}`, {
    method: "PATCH",
    body: body({ action: "assign", userId: "usr_no_existe" }),
  });
  ok("reasignar a alguien que no es miembro → 422", noMiembro.res.status === 422, short(noMiembro));
  const altaAjena = await book(owner, { contact: c3, typeId: SERVICIO.id, startMs: T3 + 2 * H, assignedUserId: "usr_no_existe" });
  ok("alta con un assignedUserId que no es miembro → 422", altaAjena.res.status === 422, short(altaAjena));
  for (const val of [V2, null]) {
    const r = await book(v1, { contact: c3, typeId: SERVICIO.id, startMs: T3 + 3 * H, assignedUserId: val });
    ok(`un Vendedor que manda assignedUserId=${val === null ? "null" : "otro"} → 403`, r.res.status === 403, short(r));
  }
  const vAssign = await v1.api(`/api/bookings/${s1.json?.booking?.id}`, {
    method: "PATCH",
    body: body({ action: "assign", userId: V2 }),
  });
  ok("un Vendedor no reasigna (403)", vAssign.res.status === 403, short(vAssign));

  /* ---------------- CA-5 ---------------- */
  console.log("\n== CA-5) Visibilidad por vendedor ==");
  const T5 = await pick(SERVICIO.id, t0 + 44 * H, [120, 150, 240]);
  const libre = await book(owner, { contact: c3, typeId: SERVICIO.id, startMs: T5, assignedUserId: null });
  ok("owner agenda una cita sin vendedor → 201", libre.res.status === 201, short(libre));
  const bloqueo = await owner.api("/api/bookings", {
    method: "POST",
    body: body({ kind: "block", startUtc: iso(T5 + 2 * H), durationMinutes: 60, notes: `bloqueo ${S}` }),
  });
  ok("owner bloquea una hora → 201", bloqueo.res.status === 201, short(bloqueo));
  // A3: Vendedora Dos agenda y el owner se la reasigna a Vendedor Uno.
  const creadaPorV2 = await book(v2, { contact: c2, typeId: SERVICIO.id, startMs: T5 + 4 * H });
  ok("Vendedora Dos agenda una cita propia → 201", creadaPorV2.res.status === 201, short(creadaPorV2));
  const pasarla = await owner.api(`/api/bookings/${creadaPorV2.json?.booking?.id}`, {
    method: "PATCH",
    body: body({ action: "assign", userId: V1 }),
  });
  ok("owner se la reasigna a Vendedor Uno → 200", pasarla.res.ok, short(pasarla));

  const vista2 = await v2.api("/api/bookings");
  const lista2 = vista2.json?.bookings ?? [];
  const ids2 = new Set(lista2.map((b) => b.id));
  ok(
    "Vendedora Dos NO ve citas de Vendedor Uno que no creó",
    !ids2.has(ca1Id1) && !ids2.has(s1.json?.booking?.id) && !ids2.has(p1.json?.booking?.id),
    JSON.stringify(lista2.map((b) => [b.id, b.assignedUser?.name, b.createdByUserId]))
  );
  ok(
    "…ni ninguna asignada a otro que ella no haya creado",
    lista2.every((b) => b.assignedUser === null || b.assignedUser.id === V2 || b.createdByUserId === V2),
    JSON.stringify(lista2.filter((b) => b.assignedUser && b.assignedUser.id !== V2 && b.createdByUserId !== V2).map((b) => b.id))
  );
  ok("sí ve las suyas", ids2.has(ca1Id2), JSON.stringify([...ids2]));
  ok("sí ve las sin asignar", ids2.has(libre.json?.booking?.id));
  ok("sí ve los bloqueos", ids2.has(bloqueo.json?.booking?.id));
  ok("sí ve la que creó aunque se reasignó (A3)", ids2.has(creadaPorV2.json?.booking?.id));
  ok("la respuesta del Vendedor no trae la lista de vendedores", vista2.json && !("sellers" in vista2.json), Object.keys(vista2.json ?? {}).join(","));
  const vistaOwner = await owner.api("/api/bookings");
  ok(
    "el Propietario ve todo y recibe `sellers` y `types`",
    Array.isArray(vistaOwner.json?.sellers) &&
      vistaOwner.json.sellers.some((s) => s.id === V1) &&
      Array.isArray(vistaOwner.json?.types) &&
      (vistaOwner.json?.bookings ?? []).some((b) => b.id === ca1Id1),
    Object.keys(vistaOwner.json ?? {}).join(",")
  );
  const tocarAjena = await v2.api(`/api/bookings/${ca1Id1}`, { method: "PATCH", body: body({ action: "cancel" }) });
  ok("PATCH (cancelar) la cita de otro vendedor → 404", tocarAjena.res.status === 404, short(tocarAjena));
  const moverAjena = await v2.api(`/api/bookings/${ca1Id1}`, {
    method: "PATCH",
    body: body({ action: "reschedule", startUtc: iso(T1 + 5 * H) }),
  });
  ok("PATCH (reprogramar) la cita de otro vendedor → 404", moverAjena.res.status === 404, short(moverAjena));
  const rejillaAjena = await v2.api(`/api/calendar/availability?excludeBookingId=${ca1Id1}`);
  ok("la rejilla para reprogramar la cita de otro → 404", rejillaAjena.res.status === 404, short(rejillaAjena));
  const ajenaSigue = (await allBookings()).find((b) => b.id === ca1Id1);
  ok("…y la cita de Vendedor Uno sigue intacta", ajenaSigue?.status === "agendada" && Date.parse(ajenaSigue.scheduledAtUtc) === T1);
  const filtroV1 = (await owner.api(`/api/bookings?sellerId=${V1}`)).json?.bookings ?? [];
  ok("filtro del owner por vendedor", filtroV1.length > 0 && filtroV1.every((b) => b.assignedUser?.id === V1), `n=${filtroV1.length}`);
  const filtroNone = (await owner.api("/api/bookings?sellerId=none")).json?.bookings ?? [];
  ok("filtro del owner 'sin asignar'", filtroNone.some((b) => b.id === libre.json?.booking?.id) && filtroNone.every((b) => b.assignedUser === null));
  const filtroTipo = (await owner.api(`/api/bookings?typeId=${PRUEBA.id}`)).json?.bookings ?? [];
  ok("filtro del owner por tipo", filtroTipo.length > 0 && filtroTipo.every((b) => b.type?.id === PRUEBA.id), `n=${filtroTipo.length}`);

  /* ---------------- CA-4 ---------------- */
  console.log("\n== CA-4) El bot no pisa ninguna cita; la carrera deja UNA ==");
  const cP = await newContact("botP");
  const cQ = await newContact("botQ");
  const q = (conv) =>
    `/api/bot/availability?conversationId=${conv}&type=${encodeURIComponent("Servicio")}&limit=48&perDay=8&days=7`;
  const ofertaP0 = await bot.api(q(cP.conversationId));
  const F = ofertaP0.json?.slots?.[0]?.startUtc;
  ok("el bot obtiene huecos con type=Servicio", ofertaP0.res.ok && !!F && ofertaP0.json?.type?.id === SERVICIO.id, short(ofertaP0));
  // Un humano ocupa el primer hueco que el bot acaba de ofrecer.
  const humano = await book(owner, { contact: c3, typeId: SERVICIO.id, startMs: Date.parse(F) });
  ok("un humano agenda ese primer hueco → 201", humano.res.status === 201, short(humano));
  const ofertaP1 = await bot.api(q(cP.conversationId));
  const slotsP = ofertaP1.json?.slots ?? [];
  ok("el bot ya NO ofrece ese horario", slotsP.length > 0 && !slotsP.some((s) => s.startUtc === F), `slots=${slotsP.length}`);
  const activas = (await allBookings()).filter((b) => ACTIVE.has(b.status) && !b.isTest);
  const pisados = slotsP.filter((s) =>
    activas.some((b) => overlaps(Date.parse(s.startUtc), SERVICIO.durationMinutes, Date.parse(b.scheduledAtUtc), b.durationMinutes))
  );
  ok("ningún horario ofrecido al bot traslapa una cita activa (de cualquier tipo o vendedor)", pisados.length === 0, JSON.stringify(pisados));
  const ofertaPrueba = await bot.api(
    `/api/bot/availability?conversationId=${cP.conversationId}&type=${encodeURIComponent("prueba de manejo")}&limit=48&perDay=8&days=7`
  );
  const pisadosPrueba = (ofertaPrueba.json?.slots ?? []).filter((s) =>
    activas.some((b) => overlaps(Date.parse(s.startUtc), PRUEBA.durationMinutes, Date.parse(b.scheduledAtUtc), b.durationMinutes))
  );
  ok(
    "con type por nombre normalizado ('prueba de manejo') resuelve el tipo y tampoco pisa nada",
    ofertaPrueba.res.ok && ofertaPrueba.json?.type?.id === PRUEBA.id && pisadosPrueba.length === 0,
    short(ofertaPrueba)
  );

  // La carrera: las DOS conversaciones con el mismo horario en su oferta.
  const oP = (await bot.api(q(cP.conversationId))).json?.slots ?? [];
  const oQ = (await bot.api(q(cQ.conversationId))).json?.slots ?? [];
  const R = oP.find((s) => oQ.some((o) => o.startUtc === s.startUtc))?.startUtc;
  ok("las dos conversaciones tienen el mismo horario ofrecido", !!R);
  const [rP, rQ] = await Promise.all([
    bot.api("/api/bot/bookings", { method: "POST", body: body({ conversationId: cP.conversationId, startUtc: R }) }),
    bot.api("/api/bot/bookings", { method: "POST", body: body({ conversationId: cQ.conversationId, startUtc: R }) }),
  ]);
  const codes = [rP.res.status, rQ.res.status].sort();
  ok("dos POST /api/bot/bookings simultáneos → un 201 y un 409 (ningún 500)", codes[0] === 201 && codes[1] === 409, `${short(rP)} | ${short(rQ)}`);
  const perdedor = rP.res.status === 409 ? rP : rQ;
  ok(
    "el perdedor recibe slot_taken con alternativas frescas (sobre anidado)",
    perdedor.json?.error?.code === "slot_taken" && (perdedor.json?.slots ?? []).length > 0,
    short(perdedor)
  );
  const enR = (await allBookings()).filter((b) => b.scheduledAtUtc === R && ACTIVE.has(b.status));
  ok("UNA sola cita activa en ese horario", enR.length === 1, `activas=${enR.length}`);
  ok("…marcada como de la IA, sin vendedor (conversación sin asignar)", enR[0]?.source === "ai" && enR[0]?.assignedUser === null, JSON.stringify(enR[0]));

  /* ---------------- Revisión: el humano no pisa la oferta de la IA ---------------- */
  console.log("\n== Un slot_taken del humano NO reemplaza la oferta que el bot hizo ==");
  const cR = await newContact("botR");
  const ofertaR = await bot.api(
    `/api/bot/availability?conversationId=${cR.conversationId}&type=${encodeURIComponent("Servicio")}&limit=48&perDay=8&days=7`
  );
  ok("el bot registra una oferta para la conversación", ofertaR.res.ok && (ofertaR.json?.slots ?? []).length > 0, short(ofertaR));
  const snapOferta = () => sql`
    select id, start_utc, appointment_type_id from vocero.offered_slot
    where conversation_id = ${cR.conversationId} order by start_utc, id`;
  const snapLog = () => sql`
    select count(*)::int as n from vocero.agenda_offer_log where conversation_id = ${cR.conversationId}`;
  const antes = await snapOferta();
  const [logAntes] = await snapLog();
  ok("…y queda en offered_slot", antes.length > 0, `n=${antes.length}`);
  const TR = await pick(PRUEBA.id, t0 + 54 * H);
  const ocupa = await book(owner, { contact: c3, typeId: PRUEBA.id, startMs: TR });
  ok("un humano ocupa una Prueba de manejo (exclusiva) → 201", ocupa.res.status === 201, short(ocupa));
  const choque = await book(owner, {
    contact: cR,
    conversationId: cR.conversationId,
    typeId: PRUEBA.id,
    startMs: TR,
    assignedUserId: V1,
  });
  ok(
    "otro humano choca en ESA conversación → 409 slot_taken sin alternativas registradas",
    choque.res.status === 409 && choque.json?.error?.code === "slot_taken" && (choque.json?.slots ?? []).length === 0,
    short(choque)
  );
  const despues = await snapOferta();
  const [logDespues] = await snapLog();
  ok(
    "offered_slot de la conversación NO cambió (mismas filas, mismos ids)",
    JSON.stringify(despues) === JSON.stringify(antes),
    `antes=${antes.length} después=${despues.length}`
  );
  ok("…ni se sumó una ronda a agenda_offer_log", logDespues?.n === logAntes?.n, `${logAntes?.n} → ${logDespues?.n}`);
  const ajenoContacto = await owner.api("/api/bookings", {
    method: "POST",
    body: body({ kind: "session", contactId: "ct_de_otra_org", startUtc: iso(TR + 2 * H), typeId: SERVICIO.id }),
  });
  ok("un contactId que no es de la organización → 422", ajenoContacto.res.status === 422, short(ajenoContacto));
  const otroContacto = await book(owner, {
    contact: c3,
    conversationId: cR.conversationId,
    typeId: SERVICIO.id,
    startMs: TR + 2 * H,
  });
  ok("un contactId que no es el de la conversación → 422", otroContacto.res.status === 422, short(otroContacto));

  /* ---------------- CA-7 ---------------- */
  console.log("\n== CA-7) Una cita del Laboratorio (is_test) no ocupa la agenda ==");
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
    const T7 = await pick(PRUEBA.id, t0 + 50 * H);
    // El contacto tiene que ser EL de la conversación (revisión 023: un
    // contactId ajeno a la conversación se rechaza con 422).
    const [labConv] = await sql`select contact_id from vocero.conversation where id = ${labConvId}`;
    const labContact = { contactId: labConv?.contact_id };
    const prueba = await book(owner, { contact: labContact, typeId: PRUEBA.id, startMs: T7, conversationId: labConvId, assignedUserId: V1 });
    ok("owner agenda una Prueba de manejo en la conversación de prueba → 201", prueba.res.status === 201, short(prueba));
    const enLista = (await allBookings()).find((b) => b.id === prueba.json?.booking?.id);
    ok("la cita nace is_test", enLista?.isTest === true, JSON.stringify(enLista?.isTest));
    const rejilla = (await owner.api(`/api/calendar/availability?typeId=${PRUEBA.id}&sellerId=none`)).json?.slots ?? [];
    const h7 = rejilla.find((s) => Date.parse(s.startUtc) === T7);
    ok("el horario sigue libre en la rejilla, sin conflicts", !!h7 && (h7.conflicts ?? []).length === 0, JSON.stringify(h7));
    const real = await book(v1, { contact: c1, typeId: PRUEBA.id, startMs: T7 });
    ok(
      "una Prueba de manejo REAL del mismo vendedor a esa hora → 201 directo (ni slot_taken ni advertencia)",
      real.res.status === 201,
      short(real)
    );
  }

  /* ---------------- CA-8 ---------------- */
  console.log("\n== CA-8) El agente agenda en Messenger e Instagram ==");
  const ADDRESS = `Av. Constituyentes 1500, Querétaro ${S}`;
  const dir = await owner.api("/api/calendar/settings", { method: "PUT", body: body({ address: `  ${ADDRESS}  ` }) });
  ok("PUT address → 200, recortada", dir.res.ok && dir.json?.settings?.address === ADDRESS, short(dir));
  const vacia = await owner.api("/api/calendar/settings", { method: "PUT", body: body({ address: "   " }) });
  ok("address vacía → null", vacia.res.ok && vacia.json?.settings?.address === null, short(vacia));
  await owner.api("/api/calendar/settings", { method: "PUT", body: body({ address: ADDRESS }) });
  const vendDir = await v1.api("/api/calendar/settings", { method: "PUT", body: body({ address: "otra" }) });
  ok("el Vendedor no cambia la dirección (403)", vendDir.res.status === 403, short(vendDir));

  // Recordatorios encendidos (plantilla aprobada en el wa-mock).
  const tplName = `recordatorio_023_${S}`;
  await owner.api("/api/templates", {
    method: "POST",
    body: body({ name: tplName, language: "es_MX", category: "UTILITY", body: "Hola {{1}}, te esperamos." }),
  });
  await owner.api("/api/dev/wa-mock/template-status", {
    method: "POST",
    body: body({ wabaId: WABA, name: tplName, language: "es_MX", event: "APPROVED", notify: false }),
  });
  await owner.api("/api/templates/sync", { method: "POST" });
  const tpl = ((await owner.api("/api/templates")).json?.templates ?? []).find((t) => t.name === tplName);
  const rem = await owner.api("/api/calendar/settings", {
    method: "PUT",
    body: body({
      reminderEnabled: true,
      reminderTemplateId: tpl?.id,
      reminderOffsetsMinutes: [1440],
      reminderVariables: ["contact_name"],
    }),
  });
  ok("recordatorios encendidos (24 h antes)", rem.res.ok && rem.json?.reminders?.enabled === true, short(rem));

  // Ids de Página / cuenta de IG: solo dígitos (los valida la conexión).
  const CANAL_SUF = String(Date.now()).slice(-6);
  const canales = [
    {
      channel: "messenger",
      settings: "/api/settings/messenger",
      accountId: `1099${CANAL_SUF}`,
      connect: (accountId) => ({ pageId: accountId, token: "tok-e2e-canal" }),
      pre: "psid",
      minH: 56,
    },
    {
      channel: "instagram",
      settings: "/api/settings/instagram",
      accountId: `1784${CANAL_SUF}`,
      connect: (accountId) => ({ source: "meta", igUserId: accountId, token: "tok-e2e-canal" }),
      pre: "ig",
      minH: 62,
    },
  ];
  // El agente in-process (ai-mock con marcadores `[e2e-agenda …]` /
  // `[e2e-reserva …]`) conduce la conversación: oferta, reserva y la
  // confirmación con la dirección salen por el transporte del canal.
  const prof = await owner.api("/api/agent/profile", { method: "PUT", body: body({ enabled: true }) });
  ok("agente in-process encendido", prof.res.ok, short(prof));
  const outbox = async () => (await owner.api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  // Messenger/Instagram: body.message.text · WhatsApp: body.text.body.
  const textOf = (o) => String(o?.body?.message?.text ?? o?.body?.text?.body ?? "");
  /** Espera un mensaje NUEVO (desde `since`) hacia `to` que cumpla `re`. */
  async function waitOut(to, re, since, ms = 25000) {
    let hit = null;
    await until(async () => {
      hit = (await outbox()).slice(since).find((o) => o.to === to && re.test(textOf(o))) ?? null;
      return !!hit;
    }, ms);
    return hit;
  }
  /** Las ofertas REGISTRADAS de la conversación (lo que `book_slot` acepta). */
  async function offersOf(conversationId) {
    const rows = await sql`
      select (extract(epoch from start_utc) * 1000)::bigint as ms, appointment_type_id as type
      from vocero.offered_slot where conversation_id = ${conversationId} order by start_utc`;
    return rows.map((r) => ({ ms: Number(r.ms), type: r.type }));
  }
  let mseq = 0;
  async function say(c, senderId, text) {
    const since = (await outbox()).length;
    const r = await owner.api("/api/dev/wa-mock/channel-inbound", {
      method: "POST",
      body: body({ channel: c.channel, accountId: c.accountId, senderId, text, mid: `mid.e2e.023.${S}.${++mseq}` }),
    });
    return { r, since };
  }
  async function convOf(c, marker) {
    let conv = null;
    await until(async () => {
      const list = (await owner.api("/api/conversations")).json?.conversations ?? [];
      conv = list.find((x) => x.channel === c.channel && x.preview?.includes(marker)) ?? null;
      return !!conv;
    });
    return conv;
  }

  const conectados = [];
  for (const c of canales) {
    const con = await owner.api(c.settings, { method: "PUT", body: body(c.connect(c.accountId)) });
    if (con.res.status === 404) {
      info(`${c.channel}: canal apagado (CHANNELS), se omite`);
      continue;
    }
    ok(`${c.channel}: conexión guardada`, con.res.ok, short(con));
    conectados.push(c);
    const sender = `${c.pre}${CANAL_SUF}023`;
    const marker = `${c.channel} ${S}`;
    const hola = await say(c, sender, `hola, informes ${marker}`);
    const conv = await convOf(c, marker);
    ok(`${c.channel}: el DM crea la conversación`, hola.r.res.ok && !!conv, short(hola.r));
    if (!conv) continue;
    ok(`${c.channel}: la IA está encendida en la conversación`, conv.aiEnabled !== false, JSON.stringify(conv.aiEnabled));
    // Messenger: conversación asignada a Vendedor Uno; Instagram: sin asignar.
    const asignado = c.channel === "messenger" ? V1 : null;
    if (asignado) {
      const asg = await owner.api(`/api/conversations/${conv.id}/assign`, { method: "POST", body: body({ userId: asignado }) });
      ok(`${c.channel}: conversación asignada a Vendedor Uno`, asg.res.ok, short(asg));
    }

    const pide = await say(c, sender, "[e2e-agenda Servicio]");
    const oferta = await waitOut(sender, /Tengo estos horarios disponibles para tu servicio:\n• /, pide.since);
    ok(`${c.channel}: el agente ofrece horarios de servicio por el canal`, !!oferta, textOf(oferta) || "sin mensaje");
    const ofertas = await offersOf(conv.id);
    ok(
      `${c.channel}: la oferta quedó registrada con el tipo Servicio`,
      ofertas.length > 0 && ofertas.every((o) => o.type === SERVICIO.id),
      JSON.stringify(ofertas.slice(0, 3))
    );
    // El más lejano: > 24 h, así su recordatorio caería después de encenderlos.
    const elegido = ofertas.filter((o) => o.ms >= t0 + 26 * H).at(-1)?.ms;
    ok(`${c.channel}: hay un horario ofrecido a más de 24 h`, !!elegido, JSON.stringify(ofertas.map((o) => iso(o.ms))));
    if (!elegido) continue;

    const reserva = await say(c, sender, `[e2e-reserva ${iso(elegido)}]`);
    const conf = await waitOut(sender, /Te agendé tu servicio/, reserva.since);
    ok(`${c.channel}: confirmación "¡Listo! Te agendé tu servicio para …"`, /^¡Listo! Te agendé tu servicio para /.test(textOf(conf)), textOf(conf) || "sin mensaje");
    ok(`${c.channel}: …con "Te esperamos en <dirección>"`, textOf(conf).includes(`Te esperamos en ${ADDRESS}.`), textOf(conf));
    ok(`${c.channel}: …y sin enlace de reunión (presencial)`, !/Enlace:|enlace/.test(textOf(conf)), textOf(conf));
    const cita = (await allBookings()).find((b) => b.conversationId === conv.id && Date.parse(b.scheduledAtUtc) === elegido);
    ok(`${c.channel}: la cita existe, source=ai, tipo Servicio`, cita?.source === "ai" && cita?.type?.id === SERVICIO.id && cita?.status === "agendada", JSON.stringify(cita && { source: cita.source, type: cita.type, status: cita.status }));
    ok(
      `${c.channel}: vendedor = ${asignado ? "el asignado de la conversación" : "ninguno (conversación sin asignar)"}`,
      asignado ? cita?.assignedUser?.id === asignado : cita?.assignedUser === null,
      JSON.stringify(cita?.assignedUser)
    );
    if (!cita) continue;

    // Control: una cita de WhatsApp poco DESPUÉS (≤ 5 h, dentro de la gracia
    // de 6 h), en la MISMA vuelta del tick, sí recibe su recordatorio — así
    // "sin recordatorio" no pasa en vacío. Sale de la rejilla real (el
    // horario puede terminar justo después de la cita).
    const ctlSlot = (await sellerGrid(owner, SERVICIO.id))
      .map((s) => Date.parse(s.startUtc))
      .find((t) => t > elegido && t <= elegido + 5 * H);
    const control = await book(owner, {
      contact: c1,
      conversationId: c1.conversationId,
      typeId: SERVICIO.id,
      startMs: ctlSlot ?? elegido + 30 * MIN,
      confirmOverlap: true,
    });
    ok(`${c.channel}: cita de control por WhatsApp en la misma ventana → 201`, control.res.status === 201, short(control));
    const outboxAntes = (await outbox()).length;
    const tk = await owner.api("/api/dev/reminders/tick", {
      method: "POST",
      body: body({ now: iso((ctlSlot ?? elegido + 30 * MIN) - 24 * H + MIN) }),
    });
    ok(`${c.channel}: tick forzado en la ventana del recordatorio → 200`, tk.res.ok, short(tk));
    const tras = (await allBookings()).find((b) => b.id === cita.id);
    const rems = tras?.reminders ?? [];
    ok(`${c.channel}: sin recordatorio (lista vacía o skipped)`, Array.isArray(tras?.reminders) && rems.every((r) => r.status === "skipped"), JSON.stringify(rems));
    const ctl = (await allBookings()).find((b) => b.id === control.json?.booking?.id);
    ok(`${c.channel}: …mientras la cita de control (WhatsApp) sí recibió el suyo`, (ctl?.reminders ?? []).some((r) => r.status === "sent"), JSON.stringify(ctl?.reminders));
    const nuevas = (await outbox()).slice(outboxAntes);
    ok(
      `${c.channel}: ninguna plantilla sale hacia el cliente del canal`,
      !nuevas.some((o) => o.type === "template" && o.to === sender),
      JSON.stringify(nuevas.map((o) => [o.type, o.to]))
    );
  }
  await owner.api("/api/calendar/settings", { method: "PUT", body: body({ reminderEnabled: false }) });

  /* ---- CA-8, camino infeliz con el agente real ---- */
  const cx = conectados[0];
  if (cx) {
    console.log(`\n== CA-8) Camino infeliz con el agente real (${cx.channel}) ==`);
    const sender = `${cx.pre}${CANAL_SUF}099`;
    const marker = `infeliz ${S}`;
    await say(cx, sender, `hola ${marker}`);
    const conv = await convOf(cx, marker);
    ok("conversación para el camino infeliz", !!conv);
    if (conv) {
      const nombres = ((await owner.api("/api/calendar/types")).json?.types ?? []).map((t) => t.name);
      const q = await say(cx, sender, "[e2e-agenda Inexistente]");
      const preg = await waitOut(sender, /¿Qué tipo de cita te interesa\?/, q.since);
      ok(
        "tipo inexistente con varios tipos → \"¿Qué tipo de cita te interesa?\" con los nombres reales",
        !!preg && nombres.length > 1 && nombres.every((n) => textOf(preg).includes(n)),
        `${textOf(preg)} | ${nombres.join(", ")}`
      );
      ok("…y no registra oferta", (await offersOf(conv.id)).length === 0);

      // Strict: una cita MANUAL de otro tipo en el primer hueco que la IA
      // ofrecería → la IA ya no lo ofrece.
      const previa = await bot.api(`/api/bot/availability?conversationId=${conv.id}&type=Servicio&limit=48&perDay=8&days=7`);
      const F = Date.parse(previa.json?.slots?.[0]?.startUtc ?? "");
      const manual = await book(owner, { contact: c2, typeId: GARANTIA.id, startMs: F, confirmOverlap: true });
      ok("un humano agenda Garantía en ese primer hueco → 201", manual.res.status === 201, short(manual));
      const q2 = await say(cx, sender, "[e2e-agenda Servicio]");
      const of2 = await waitOut(sender, /Tengo estos horarios disponibles para tu servicio/, q2.since);
      const ofertas2 = await offersOf(conv.id);
      ok("la IA vuelve a ofrecer", !!of2 && ofertas2.length > 0, textOf(of2));
      ok(
        "strict: ninguna oferta de la IA traslapa la cita manual de otro tipo",
        ofertas2.length > 0 && !ofertas2.some((o) => overlaps(o.ms, SERVICIO.durationMinutes, F, GARANTIA.durationMinutes)),
        JSON.stringify({ F: iso(F), ofertas: ofertas2.slice(0, 4).map((o) => iso(o.ms)) })
      );

      // Un instante que NO se ofreció → re-oferta, sin cita.
      const noOfrecido = ofertas2[0].ms + MIN;
      const antes = (await allBookings()).filter((b) => b.conversationId === conv.id).length;
      const q3 = await say(cx, sender, `[e2e-reserva ${iso(noOfrecido)}]`);
      // 025: la re-oferta es del DÍA pedido ("Ese horario no lo tengo
      // disponible." + los horarios reales de ese día).
      const reof = await waitOut(sender, /^Ese horario no lo tengo disponible\.\n(Para el|Ese día)[^\n]*\n• /, q3.since);
      ok("reservar un horario no ofrecido → re-oferta con horarios reales", !!reof, textOf(reof) || "sin mensaje");
      const despues = (await allBookings()).filter((b) => b.conversationId === conv.id);
      ok(
        "…y no se crea ninguna cita",
        despues.length === antes && !despues.some((b) => Date.parse(b.scheduledAtUtc) === noOfrecido),
        `antes=${antes} después=${despues.length}`
      );
    }
  }
  await agendaIaRobusta025({ outbox, textOf, say, convOf, offersOf, conectados, CANAL_SUF, ADDRESS, PRUEBA, SERVICIO, GARANTIA, c2 });
  await owner.api("/api/agent/profile", { method: "PUT", body: body({ enabled: false, formality: "tu" }) });
  const settingsFinal = (await owner.api("/api/calendar/settings")).json?.settings;
  ok("la dirección queda configurada", settingsFinal?.address === ADDRESS, JSON.stringify(settingsFinal?.address));

  /* ---------------- camino infeliz ---------------- */
  console.log("\n== Camino infeliz ==");
  const T9 = await pick(SERVICIO.id, t0 + 70 * H);
  const tipoFalso = await book(owner, { contact: c1, typeId: "apt_no_existe", startMs: T9 });
  ok("typeId inexistente → 422", tipoFalso.res.status === 422, short(tipoFalso));
  const sinTipo = await owner.api("/api/bookings", {
    method: "POST",
    body: body({ kind: "session", contactId: c1.contactId, startUtc: iso(T9) }),
  });
  ok("POST de sesión sin typeId → 422 (A2: obligatorio para humanos)", sinTipo.res.status === 422, short(sinTipo));
  const dispFalsa = await owner.api("/api/calendar/availability?typeId=apt_no_existe");
  ok("rejilla con typeId inexistente → 422", dispFalsa.res.status === 422, short(dispFalsa));
  const botTipo = await bot.api(`/api/bot/availability?conversationId=${cP.conversationId}&type=Lavado%20de%20motor`);
  ok(
    "bot con type desconocido → 422 unknown_type con la lista de tipos como hermano",
    botTipo.res.status === 422 &&
      botTipo.json?.error?.code === "unknown_type" &&
      (botTipo.json?.types ?? []).some((t) => t.name === "Servicio"),
    short(botTipo)
  );
  const larga = await owner.api("/api/calendar/settings", { method: "PUT", body: body({ address: "x".repeat(301) }) });
  ok("address de 301 caracteres → 422", larga.res.status === 422, short(larga));
  const justa = await owner.api("/api/calendar/settings", { method: "PUT", body: body({ address: "y".repeat(300) }) });
  ok("address de 300 caracteres → 200", justa.res.ok, short(justa));
  await owner.api("/api/calendar/settings", { method: "PUT", body: body({ address: ADDRESS }) });
  const desactivado = await owner.api(`/api/calendar/types/${GARANTIA.id}`, { method: "PATCH", body: body({ active: false }) });
  ok("owner desactiva Garantía → 200", desactivado.res.ok && desactivado.json?.type?.active === false, short(desactivado));
  const conInactivo = await book(owner, { contact: c1, typeId: GARANTIA.id, startMs: T9 });
  ok("agendar con un tipo desactivado → 422", conInactivo.res.status === 422, short(conInactivo));
  const activos = (await owner.api("/api/calendar/types")).json?.types ?? [];
  const todos = (await owner.api("/api/calendar/types?all=1")).json?.types ?? [];
  ok(
    "el tipo desactivado deja de listarse, pero sigue en ?all=1",
    !activos.some((t) => t.id === GARANTIA.id) && todos.some((t) => t.id === GARANTIA.id && t.active === false)
  );
  await owner.api(`/api/calendar/types/${GARANTIA.id}`, { method: "PATCH", body: body({ active: true }) });
  const durMala = await owner.api("/api/calendar/types", { method: "POST", body: body({ name: `Corta ${S}`, durationMinutes: 5 }) });
  ok("tipo con duración fuera de 10–480 → 422", durMala.res.status === 422, short(durMala));
}

/* ============================================================
 * 025 — Agenda por IA robusta (specs/025-agenda-ia-robusta). Reproduce el
 * incidente del 21-oct con el agente REAL por WhatsApp y Messenger, trato
 * usted. El modelo simulado NO recibe ningún ISO: los marcadores del ai-mock
 * (`[e2e-dia …]`, `[e2e-elige …]`) lo obligan a leer el calendario "Próximos
 * días" y el bloque HORARIOS OFRECIDOS del prompt, como uno real. El guion
 * tampoco lee `offered_slot` para ELEGIR: solo para verificar.
 * ============================================================ */

/** Pronombres/verbos de tuteo que el motor NO debe usar con trato usted. */
const TUTEO = /\b(te|tu|tus|ti|tienes|déjame|puedes|quieres|prefieres|dime)\b/i;
const AI_INVENTED_SNIPPET = "24 de octubre a las 10:30";
const AI_ATTENTION_TEXT =
  "Abrimos de lunes a sábado de 9:00 a 18:00 y domingo de 10:00 a 15:00.";

async function agendaIaRobusta025(ctx) {
  const { outbox, textOf, say, convOf, offersOf, conectados, CANAL_SUF, ADDRESS, PRUEBA, GARANTIA, c2 } = ctx;
  console.log("\n== 025) Agenda por IA robusta (agente real, trato usted) ==");
  const prof = await owner.api("/api/agent/profile", {
    method: "PUT",
    body: body({ enabled: true, formality: "usted" }),
  });
  const perfil = (await owner.api("/api/agent/profile")).json?.profile;
  ok("perfil del agente: trato usted (PUT formality → GET lo devuelve)", prof.res.ok && perfil?.formality === "usted", JSON.stringify(perfil?.formality));
  const vend = await v1.api("/api/agent/profile", { method: "PUT", body: body({ formality: "tu" }) });
  ok("el Vendedor no cambia el trato (403)", vend.res.status === 403, short(vend));

  const TZ = (await owner.api("/api/calendar/settings")).json?.settings?.timezone ?? "America/Mexico_City";
  const dayIsoOf = (d) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const wdOf = (d) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(d);
  // El PRÓXIMO viernes según la zona del negocio (como "Próximos días": desde mañana).
  let FRI = null;
  for (let i = 1; i <= 7 && !FRI; i++) {
    const d = new Date(Date.now() + i * 24 * H);
    if (wdOf(d) === "Fri") FRI = dayIsoOf(d);
  }
  const friNum = Number(FRI.slice(8, 10));

  const last10 = (s) => String(s ?? "").replace(/\D/g, "").slice(-10);
  const engineUsted = [];
  const fragments = {};
  const keep = (label, o) => {
    const t = textOf(o);
    if (t) {
      engineUsted.push({ label, text: t });
    }
    return t;
  };
  /** Espera un mensaje NUEVO (desde `since`) hacia `match(to)` que cumpla `re`. */
  async function waitTo(match, re, since, ms = 25000) {
    let hit = null;
    await until(async () => {
      hit = (await outbox()).slice(since).find((o) => match(o.to) && re.test(textOf(o))) ?? null;
      return !!hit;
    }, ms);
    return hit;
  }
  /** Saliente más reciente con `agent_action` de la conversación (historial). */
  async function lastAction(conversationId) {
    const [row] = await sql`
      select agent_action as a, text from vocero.message
      where conversation_id = ${conversationId} and direction = 'out' and agent_action is not null
      order by created_at desc limit 1`;
    return row ?? null;
  }
  const timesOf = (text) => [...text.matchAll(/^• (?:.* a las )?(\d{2}:\d{2})$/gm)].map((m) => m[1]);

  /** Un "canal" de prueba: WhatsApp (teléfono) o Messenger (PSID). */
  async function openChannel(kind, label) {
    if (kind === "whatsapp") {
      const p = phone();
      const name = `IA025 ${label} ${S}`;
      let wseq = 0;
      const sayIt = async (text) => {
        const since = (await outbox()).length;
        const r = await owner.api("/api/dev/wa-mock/inbound", {
          method: "POST",
          body: body({ phoneNumberId: PN, from: p, name, text, waMessageId: `wamid.e2e.025.${S}.${label}.${++wseq}` }),
        });
        return { r, since };
      };
      await sayIt("hola, buenas tardes");
      let conv = null;
      await until(async () => {
        const list = (await owner.api("/api/conversations")).json?.conversations ?? [];
        conv = list.find((c) => c.contact?.name === name) ?? null;
        return !!conv;
      });
      await sleep(1500); // deja pasar la respuesta de eco al saludo
      return { conv, say: sayIt, to: (to) => last10(to) === last10(p), label: `WhatsApp ${label}` };
    }
    const cx = conectados.find((c) => c.channel === "messenger");
    if (!cx) return null;
    const sender = `${cx.pre}${CANAL_SUF}25${label.length}${Math.floor(Math.random() * 9)}`;
    const marker = `ia025 ${label} ${S}`;
    await say(cx, sender, `hola ${marker}`);
    const conv = await convOf(cx, marker);
    await sleep(1500);
    return { conv, say: (text) => say(cx, sender, text), to: (to) => to === sender, label: `Messenger ${label}` };
  }

  const friSlots =
    (await owner.api(`/api/calendar/availability?typeId=${PRUEBA.id}&sellerId=none&from=${FRI}&to=${FRI}`)).json?.slots ?? [];

  /* ---- a, b, c, i — WhatsApp y Messenger ---- */
  for (const kind of ["whatsapp", "messenger"]) {
    const ch = await openChannel(kind, kind === "whatsapp" ? "wa" : "fb");
    if (!ch?.conv) {
      ok(`${kind}: conversación lista`, false);
      continue;
    }
    const L = ch.label;
    console.log(`  -- ${L} --`);

    // a) Oferta inicial.
    const qa = await ch.say("[e2e-agenda Prueba de manejo]");
    const oa = await waitTo(ch.to, /Tengo estos horarios disponibles para su prueba de manejo:/, qa.since);
    const ta = keep(`${L} oferta inicial`, oa);
    ok(`${L} a) oferta inicial con horarios`, timesOf(ta).length > 0, ta || "sin mensaje");
    ok(`${L} a) …e invita a pedir otro día: "Si prefiere otro día, dígame cuál."`, ta.includes("Si prefiere otro día, dígame cuál."), ta);
    if (kind === "whatsapp") fragments.a = ta;
    // i) El historial: el saliente de la oferta guarda la ACCIÓN.
    const ia = await lastAction(ch.conv.id);
    ok(
      `${L} i) el saliente de la oferta tiene agent_action offer_slots con lo mostrado`,
      ia?.a?.action === "offer_slots" && Array.isArray(ia?.a?.shown) && ia.a.shown.length === timesOf(ta).length && ia.text === ta,
      JSON.stringify(ia?.a)
    );

    // b) CA-1: "¿qué tal el viernes?".
    const qb = await ch.say("[e2e-dia viernes Prueba de manejo]");
    const ob = await waitTo(ch.to, /^(Para el|Ese día ya no tengo)/, qb.since);
    const tb = keep(`${L} oferta del viernes`, ob);
    if (kind === "whatsapp") fragments.b = tb;
    const tFri = timesOf(tb);
    ok(`${L} b) CA-1: "Para el viernes ${friNum} de …" (el viernes REAL, ${FRI})`, tb.startsWith(`Para el viernes ${friNum} de `), tb || "sin mensaje");
    ok(`${L} b) …nunca el ${friNum + 1} (el día que inventó el modelo del incidente)`, !new RegExp(`\\b${friNum + 1}\\b`).test(tb), tb);
    const freeFri = new Set(friSlots.map((s) => s.time));
    ok(
      `${L} b) …con horarios REALES de ese viernes (contra /api/calendar/availability)`,
      tFri.length > 0 && tFri.every((t) => freeFri.has(t)),
      JSON.stringify({ mostrados: tFri, libres: friSlots.length })
    );
    const ib = await lastAction(ch.conv.id);
    ok(`${L} b) agent_action con date=${FRI}`, ib?.a?.action === "offer_slots" && ib?.a?.date === FRI, JSON.stringify(ib?.a));

    // c) CA-2: una hora suelta que se vio ese viernes → cita a esa hora local.
    const pickT = tFri.includes("11:00") ? "11:00" : (tFri[1] ?? tFri[0]);
    const hourArg = pickT?.endsWith(":00") ? String(Number(pickT.slice(0, 2))) : pickT;
    const qc = await ch.say(`[e2e-elige ${hourArg}]`);
    const oc = await waitTo(ch.to, /Le agendé|agend/, qc.since);
    const tc = keep(`${L} confirmación`, oc);
    if (kind === "whatsapp") fragments.c = tc;
    ok(`${L} c) CA-2: "¡Listo! Le agendé su prueba de manejo para …"`, tc.startsWith("¡Listo! Le agendé su prueba de manejo para "), tc || "sin mensaje");
    ok(`${L} c) …"Le esperamos en <dirección>"`, tc.includes(`Le esperamos en ${ADDRESS}.`), tc);
    const expected = friSlots.find((s) => s.time === pickT)?.startUtc;
    const cita = (await allBookings()).find((b) => b.conversationId === ch.conv.id && b.status === "agendada");
    ok(
      `${L} c) …cita creada el viernes ${FRI} a las ${pickT} (hora local), source=ai, Prueba de manejo`,
      !!expected && cita?.scheduledAtUtc === expected && cita?.source === "ai" && cita?.type?.id === PRUEBA.id,
      JSON.stringify({ esperado: expected, cita: cita && { at: cita.scheduledAtUtc, source: cita.source, type: cita.type?.name } })
    );
    const ic = await lastAction(ch.conv.id);
    ok(`${L} c) agent_action book_slot con lo agendado`, ic?.a?.action === "book_slot" && typeof ic?.a?.booked === "string", JSON.stringify(ic?.a));
  }

  /* ---- d) CA-3: hora no ofrecida → re-oferta del MISMO día, sin repetir, sin cita ---- */
  {
    const ch = await openChannel("whatsapp", "d");
    const q1 = await ch.say("[e2e-agenda Servicio]");
    const o1 = await waitTo(ch.to, /Tengo estos horarios disponibles para su servicio:/, q1.since);
    keep("CA-3 oferta", o1);
    const first = (await lastAction(ch.conv.id))?.a;
    const q2 = await ch.say("[e2e-elige 23:45]");
    const o2 = await waitTo(ch.to, /^Ese horario no lo tengo disponible\./, q2.since);
    const t2 = keep("CA-3 re-oferta", o2);
    fragments.d = t2;
    const re = (await lastAction(ch.conv.id))?.a;
    ok("d) CA-3: [e2e-elige 23:45] (no ofrecida) → \"Ese horario no lo tengo disponible.\" + horarios", !!o2 && timesOf(t2).length > 0, t2 || "sin mensaje");
    const firstDayNum = Number(String(first?.shown?.[0] ?? "").split(" ")[1]);
    ok(
      "d) …del MISMO día de la oferta que vio",
      re?.action === "offer_slots" && Number(String(re?.date).slice(8, 10)) === firstDayNum,
      JSON.stringify({ vio: first?.shown, reoferta: { date: re?.date, shown: re?.shown } })
    );
    const repetidos = (re?.shown ?? []).filter((s) => (first?.shown ?? []).includes(s));
    ok("d) …sin repetir los horarios ya mostrados", (re?.shown ?? []).length > 0 && repetidos.length === 0, JSON.stringify(repetidos));
    const citas = (await allBookings()).filter((b) => b.conversationId === ch.conv.id);
    ok("d) …y sin cita", citas.length === 0, `citas=${citas.length}`);

    // slot_taken (para CA-5): un humano ocupa el horario que el cliente vio.
    const ch3 = await openChannel("whatsapp", "st");
    const q3 = await ch3.say("[e2e-agenda Servicio]");
    const o3 = await waitTo(ch3.to, /Tengo estos horarios disponibles para su servicio:/, q3.since);
    keep("slot_taken oferta", o3);
    const t3 = timesOf(textOf(o3))[0];
    const target = (await offersOf(ch3.conv.id))[0]?.ms; // solo para preparar el choque
    const manual = await book(owner, { contact: c2, typeId: GARANTIA.id, startMs: target, confirmOverlap: true });
    ok("slot_taken: un humano ocupa el horario mostrado → 201", manual.res.status === 201, short(manual));
    const q4 = await ch3.say(`[e2e-elige ${t3}]`);
    const o4 = await waitTo(ch3.to, /^Se me acaba de ocupar ese horario/, q4.since);
    const t4 = keep("slot_taken re-oferta", o4);
    ok("slot_taken: \"Se me acaba de ocupar ese horario, ¡disculpe!\" + re-oferta", t4.startsWith("Se me acaba de ocupar ese horario, ¡disculpe!") && timesOf(t4).length > 0, t4 || "sin mensaje");
    // Pregunta de tipo (usted).
    const q5 = await ch3.say("[e2e-agenda Inexistente]");
    const o5 = await waitTo(ch3.to, /^¿Qué tipo de cita le interesa\? Tengo: /, q5.since);
    const t5 = keep("pregunta de tipo", o5);
    ok("pregunta de tipo en usted: \"¿Qué tipo de cita le interesa? Tengo: …\"", !!o5, t5 || "sin mensaje");
  }

  /* ---- e) CA-4: barrera de horarios inventados ---- */
  {
    const ch = await openChannel("whatsapp", "e");
    const q1 = await ch.say("[e2e-agenda Servicio]");
    await waitTo(ch.to, /Tengo estos horarios disponibles para su servicio:/, q1.since);
    const q2 = await ch.say("[e2e-inventa]");
    const o2 = await waitTo(ch.to, /^(Para el|Ese día ya no tengo)/, q2.since);
    await sleep(1500);
    const nuevos = (await outbox()).slice(q2.since).filter((o) => ch.to(o.to)).map(textOf);
    const t2 = keep("barrera → oferta real", o2);
    fragments.e = t2;
    ok(`e) CA-4: el texto inventado NO sale ("${AI_INVENTED_SNIPPET}")`, nuevos.length > 0 && !nuevos.some((t) => t.includes(AI_INVENTED_SNIPPET)), JSON.stringify(nuevos));
    // La barrera resuelve el nombre del día HOY INCLUIDO (slot-barrier.ts,
    // deduceDay): dicho un viernes con huecos aún libres, es hoy; si no, el
    // próximo viernes.
    const todayIso = dayIsoOf(new Date());
    const friE =
      wdOf(new Date()) === "Fri" && t2.startsWith(`Para el viernes ${Number(todayIso.slice(8, 10))} de `)
        ? todayIso
        : FRI;
    const friENum = Number(friE.slice(8, 10));
    ok(`e) …sale una oferta REAL del motor para el viernes ${friENum}`, t2.startsWith(`Para el viernes ${friENum} de `) && timesOf(t2).length > 0, t2 || "sin mensaje");
    const ofs = await offersOf(ch.conv.id);
    ok(
      "e) …y offered_slot quedó con las filas de esa oferta (todas del viernes)",
      ofs.length > 0 && ofs.every((o) => dayIsoOf(new Date(o.ms)) === friE),
      JSON.stringify(ofs.slice(0, 3).map((o) => iso(o.ms)))
    );
    const logFile = process.env.E2E_SERVER_LOG;
    if (logFile) {
      const { readFileSync } = await import("node:fs");
      const log = readFileSync(logFile, "utf8");
      ok("e) …el log del server registra \"[agente] barrera de horarios\"", log.includes("[agente] barrera de horarios") && log.includes(AI_INVENTED_SNIPPET));
    } else {
      info("sin E2E_SERVER_LOG: no se verifica el log de la barrera");
    }
    const q3 = await ch.say("[e2e-horario-atencion]");
    const o3 = await waitTo(ch.to, /^Abrimos de lunes a sábado/, q3.since);
    ok("e) un horario de atención NO dispara la barrera: sale tal cual", textOf(o3) === AI_ATTENTION_TEXT, textOf(o3) || "sin mensaje");
  }

  /* ---- g) coalescido: "15" + otro texto en la ventana de coalescing ---- */
  {
    const ch = await openChannel("whatsapp", "g");
    const q1 = await ch.say("[e2e-agenda Servicio]");
    const o1 = await waitTo(ch.to, /Tengo estos horarios disponibles para su servicio:/, q1.since);
    keep("coalescido oferta", o1);
    const shownTimes = timesOf(textOf(o1));
    const pickT = shownTimes.includes("15:00") ? "15:00" : shownTimes[0];
    const arg = pickT?.endsWith(":00") ? String(Number(pickT.slice(0, 2))) : pickT;
    const since = (await outbox()).length;
    const t0g = Date.now();
    await ch.say(`[e2e-elige ${arg}]`);
    await ch.say("¿y cuánto cuesta?");
    const gap = Date.now() - t0g;
    const conf = await waitTo(ch.to, /^¡Listo! Le agendé su servicio para /, since);
    keep("coalescido confirmación", conf);
    await sleep(2500);
    const replies = (await outbox()).slice(since).filter((o) => ch.to(o.to)).map(textOf);
    const citas = (await allBookings()).filter((b) => b.conversationId === ch.conv.id && b.status === "agendada");
    ok(`g) coalescido: "[e2e-elige ${arg}]" + "¿y cuánto cuesta?" → UNA cita a las ${pickT}`, !!conf && citas.length === 1, JSON.stringify({ replies, citas: citas.length }));
    info(
      `g) coalescido (AGENT_COALESCE_MS=${process.env.AGENT_COALESCE_MS ?? "?"}; los dos entrantes salieron con ${gap} ms de diferencia): ` +
        `${replies.length} respuesta(s) del agente — ${replies.length === 1 ? "un solo turno con los dos mensajes (el mock lee todos los mensajes nuevos del cliente)" : "dos turnos: el primero reserva y el segundo responde la pregunta"}.`
    );
  }

  /* ---- B1/R3: el reply de book_slot (el precio) llega junto a la confirmación ---- */
  {
    const ch = await openChannel("whatsapp", "precio");
    const q1 = await ch.say("[e2e-agenda Servicio]");
    const o1 = await waitTo(ch.to, /Tengo estos horarios disponibles para su servicio:/, q1.since);
    keep("precio oferta", o1);
    const t = timesOf(textOf(o1))[0];
    const q2 = await ch.say(`[e2e-elige-con-precio ${t}]`);
    const o2 = await waitTo(ch.to, /Le agendé su servicio/, q2.since);
    const t2 = textOf(o2);
    fragments.precio = t2;
    ok(
      "B1: book_slot con reply → el outbox trae el precio Y \"Le agendé\" (precio primero)",
      t2.startsWith("El Macaron 2P cuesta $285,990.\n¡Listo! Le agendé su servicio para "),
      t2 || "sin mensaje"
    );
    const r3 = (await lastAction(ch.conv.id))?.a;
    ok("R3: agent_action del book_slot guarda el reply del modelo", r3?.action === "book_slot" && r3?.reply === "El Macaron 2P cuesta $285,990.", JSON.stringify(r3));
    const citas = (await allBookings()).filter((b) => b.conversationId === ch.conv.id && b.status === "agendada");
    ok("B1: …y la cita existe", citas.length === 1, `citas=${citas.length}`);
  }

  /* ---- f) CA-5: ningún texto del motor tutea con trato usted ---- */
  const tuteo = engineUsted.filter((e) => TUTEO.test(e.text));
  ok(
    `f) CA-5: ninguno de los ${engineUsted.length} textos del motor (oferta, re-oferta, confirmación, pregunta de tipo, slot_taken) tutea`,
    engineUsted.length >= 10 && tuteo.length === 0,
    JSON.stringify(tuteo)
  );
  // Con trato tú, la confirmación sí tutea.
  await owner.api("/api/agent/profile", { method: "PUT", body: body({ formality: "tu" }) });
  {
    const ch = await openChannel("whatsapp", "tu");
    const q1 = await ch.say("[e2e-agenda Servicio]");
    const o1 = await waitTo(ch.to, /Tengo estos horarios disponibles para tu servicio:/, q1.since);
    ok("f) trato tú: la oferta dice \"para tu servicio\" y \"Si prefieres otro día, dime cuál.\"", textOf(o1).includes("Si prefieres otro día, dime cuál."), textOf(o1) || "sin mensaje");
    const t = timesOf(textOf(o1))[0];
    const q2 = await ch.say(`[e2e-elige ${t}]`);
    const o2 = await waitTo(ch.to, /^¡Listo! Te agendé tu servicio para /, q2.since);
    ok("f) trato tú: la confirmación dice \"Te agendé\" y \"Te esperamos en\"", !!o2 && textOf(o2).includes(`Te esperamos en ${ADDRESS}.`), textOf(o2) || "sin mensaje");
  }
  await owner.api("/api/agent/profile", { method: "PUT", body: body({ formality: "usted" }) });

  /* ---- j) Laboratorio: el saliente de agenda en is_test guarda agent_action ---- */
  {
    const per = await owner.api("/api/lab/personas", {
      method: "POST",
      body: body({ name: `Agenda 025 ${S}`, objetivo: "Agendar un servicio", guion: ["[e2e-agenda Servicio]"] }),
    });
    const key = per.json?.persona?.key;
    ok("j) Laboratorio: persona con guion \"[e2e-agenda Servicio]\" → 201", per.res.status === 201 && !!key, short(per));
    if (key) {
      await until(async () => !((await owner.api("/api/lab/runs")).json?.runs ?? []).some((r) => r.status === "running"), 180_000);
      const run = await owner.api("/api/lab/runs", { method: "POST", body: body({ personaKeys: [key] }) });
      ok("j) corrida corta del Laboratorio con esa persona → 202", run.res.status === 202, short(run));
      let row = null;
      await until(async () => {
        const d = await owner.api(`/api/lab/runs/${run.json?.runId}`);
        const convId = (d.json?.cases ?? []).find((c) => c.conversationId)?.conversationId;
        if (!convId) return false;
        [row] = await sql`
          select m.agent_action as a, c.is_test from vocero.message m
          join vocero.conversation c on c.id = m.conversation_id
          where m.conversation_id = ${convId} and m.direction = 'out' and m.agent_action is not null
          limit 1`;
        return !!row;
      }, 120_000);
      ok(
        "j) …el saliente de agenda en la conversación is_test guarda agent_action (persistTestOutbound)",
        row?.is_test === true && row?.a?.action === "offer_slots" && Array.isArray(row?.a?.shown),
        JSON.stringify(row)
      );
    }
  }

  console.log("\n  Fragmentos del outbox (textos reales del motor):");
  for (const [k, v] of Object.entries(fragments)) console.log(`  [${k}] ${JSON.stringify(v)}`);
}

main()
  .catch((err) => {
    failures++;
    console.error("ERROR FATAL:", err);
  })
  .finally(async () => {
    await sql.end({ timeout: 2 }).catch(() => {});
    if (notes.length) {
      console.log("\nNotas:");
      for (const n of notes) console.log(`  - ${n}`);
    }
    console.log(`\n===== ${checks - failures} OK / ${failures} FAIL =====`);
    process.exit(failures > 0 ? 1 : 0);
  });
