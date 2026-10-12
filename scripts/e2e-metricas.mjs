/**
 * Self-test E2E — Reportes → Agente (dev-tasks/02-metricas-del-agente.md).
 * Guion humano: tests/e2e/us-metricas.md
 *
 * Siembra datos CONOCIDOS por los flujos reales (wa-mock + ai-mock, la API del
 * operador, /api/bot/handoff y un echo del teléfono) y compara M1–M8 de
 * `GET /api/reports/agent` contra lo esperado:
 *
 *   A  inbound con el agente encendido → responde la IA          → Solo IA
 *   B  inbound + IA responde + /api/bot/handoff «cliente» con nota
 *      + el operador contesta después                             → IA + humano, M3, M5 atendido
 *   C  inbound con el agente apagado + 2 salientes del operador
 *      (la 2ª falla por webhook de estado)                        → Solo humano, M6
 *   D  inbound sin respuesta + evento aproximado «modelo» (SQL,
 *      como la siembra de 0017)                                   → Sin respuesta, M3 aprox.
 *   E  inbound + echo del teléfono (manual_reply)                 → Solo humano, «Pausas por respuesta manual»
 *   Lab  conversación is_test con entrante (SQL)                  → no cuenta en nada
 *   Viejo  entrante de hace 40 días (SQL)                         → fuera de 30d, dentro de 90d
 *
 * Para aislar los números del resto de la BD de E2E, los mensajes y eventos
 * de A–E (y el Lab) se TRASLADAN por SQL a un día del pasado sin datos y se
 * consulta ese día con `range=custom`; además todo se compara como delta
 * contra una línea base tomada antes de sembrar. Así M7 (que ignora los
 * últimos 15 min) y los percentiles de M4 también se pueden verificar.
 *
 * Camino infeliz: 422 (from > to, 400 días, preset raro), 403 del Vendedor
 * (alta por POST /api/settings/team) y 404 de /reports para él.
 *
 * UI (Playwright; selectores de la pantalla de 02-B):
 *   - menú «Reportes»
 *   - `[role=group][aria-label="Rango del reporte"]` con «7 días», «30 días»,
 *     «90 días», «Personalizado»
 *   - KPIs `data-testid`: kpi-active, kpi-ai-only, kpi-escalations, kpi-ai-p50, kpi-failed
 *   - títulos: «Reparto de atención», «Volumen por día y canal»,
 *     «Escalamientos por motivo», «Tiempo a primera respuesta»,
 *     «Salientes fallidas», «Entrega y lectura»
 *   - `svg[data-testid="volume-chart"]` con `data-days`
 *   - `[data-testid="manual-reply-pauses"]` («Pausas por respuesta manual: N»)
 *   - `[data-testid="approximate-notice"]`
 *   - tabla `aria-label="Escalamientos por motivo"`
 *
 * Uso:
 *   1) BD de E2E migrada (0017 incluida) y app corriendo con
 *      WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL → wa-mock,
 *      OPENROUTER_BASE_URL → ai-mock y BOT_API_KEY (p. ej. .env.e2e, :5433)
 *   2) node --env-file=.env.e2e scripts/e2e-metricas.mjs
 *
 * Requiere DATABASE_URL (traslado al pasado, Lab y mensaje viejo).
 * Sale con código 1 si algún check falla.
 */
import { chromium } from "playwright";
import postgres from "postgres";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const BOT_KEY = process.env.BOT_API_KEY;
const S = Math.random().toString(36).slice(2, 8);
const PN = "PN-E2E-METRICAS";

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
        // Better Auth valida Origin (CSRF) en los endpoints de auth.
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

const owner = client();
const seller = client();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const body = (o) => JSON.stringify(o);
const short = (r) => `${r.res.status} ${JSON.stringify(r.json)?.slice(0, 200)}`;
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
    await sleep(300);
  }
};

function bot(path, opts = {}) {
  return owner.api(path, {
    ...opts,
    headers: { "x-api-key": BOT_KEY ?? "", ...(opts.headers ?? {}) },
  });
}

const db = process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: "vocero, extensions" },
    })
  : null;

/** Teléfono MX normalizado (52 + 10 dígitos), único por corrida. */
function phone() {
  return `52477${Math.floor(Math.random() * 9e6 + 1e6)}`;
}

async function inbound(from, name, text) {
  const r = await owner.api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({ phoneNumberId: PN, from, name, text, waMessageId: `wamid.met.${S}.${from}.${Date.now()}` }),
  });
  ok(`inbound de ${name} entregado`, r.res.ok, short(r));
}

async function convByName(name) {
  return until(async () => {
    const convs = (await owner.api("/api/conversations")).json?.conversations ?? [];
    return convs.find((c) => c.contact?.name === name) ?? null;
  });
}

async function messages(convId) {
  return (await owner.api(`/api/conversations/${convId}/messages`)).json?.messages ?? [];
}

/** wa_message_id de un saliente (el DTO no lo trae): del outbox del mock. */
async function waIdFor(to, text) {
  const outbox = (await owner.api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  const hit = [...outbox].reverse().find((e) => e.to === to && JSON.stringify(e.body).includes(text));
  return hit?.waMessageId ?? null;
}

async function setStatus(waMessageId, status, extra = {}) {
  const r = await owner.api("/api/dev/wa-mock/status", {
    method: "POST",
    body: body({ waMessageId, status, ...extra }),
  });
  return r.res.ok;
}

async function report(qs) {
  return owner.api(`/api/reports/agent?${qs}`);
}

/** Fecha local YYYY-MM-DD de un instante en una zona. */
function dayIn(tz, d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}`;
}
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const data = (r, block) => (r.json?.[block]?.ok ? r.json[block].data : null);
const volTotals = (r) =>
  (data(r, "volume")?.rows ?? []).reduce(
    (acc, x) => ({ in: acc.in + x.inbound, out: acc.out + x.outbound }),
    { in: 0, out: 0 }
  );
const reasonCount = (r, reason) => data(r, "escalations")?.byReason?.find((x) => x.reason === reason)?.count ?? 0;

async function main() {
  if (!BOT_KEY || BOT_KEY.length < 16) {
    console.error("BOT_API_KEY ausente o corta (<16): /api/bot/handoff no puede correr.");
    process.exit(1);
  }
  if (!db) {
    console.error("DATABASE_URL ausente: el guion necesita la BD de E2E (traslado al pasado, Lab, mensaje viejo).");
    process.exit(1);
  }

  console.log("== Setup: Propietario + WhatsApp (wa-mock) ==");
  const email = "e2e@vocero.test";
  const password = "password-e2e-123";
  let su = await owner.api("/api/auth/sign-up/email", {
    method: "POST",
    body: body({ email, password, name: "Operador E2E" }),
  });
  if (!su.res.ok) {
    su = await owner.api("/api/auth/sign-in/email", { method: "POST", body: body({ email, password }) });
  }
  ok("registro o login del Propietario", su.res.ok, short(su));
  const conn = await owner.api("/api/settings/whatsapp", {
    method: "PUT",
    body: body({ wabaId: "WABA-E2E-MET", phoneNumberId: PN, token: "tok-e2e-met" }),
  });
  ok("conexión WhatsApp guardada", conn.res.ok, short(conn));
  const prof0 = (await owner.api("/api/agent/profile")).json?.profile;
  const agentWasEnabled = prof0?.enabled === true;

  const [org] = await db`SELECT id FROM organization LIMIT 1`;
  const orgId = org?.id;
  ok("organización encontrada en la BD", !!orgId);
  if (!orgId) return;

  console.log("\n== Camino infeliz: 422 invalid_range ==");
  for (const [qs, why] of [
    ["range=custom&from=2026-10-10&to=2026-10-01", "from > to"],
    ["from=2025-01-01&to=2026-02-04", "400 días"],
    ["range=15d", "preset raro"],
    ["range=custom&from=2026-02-30&to=2026-03-01", "fecha inexistente"],
  ]) {
    const r = await report(qs);
    ok(`${why} → 422 invalid_range`, r.res.status === 422 && r.json?.error?.code === "invalid_range", short(r));
  }

  // ── Línea base ──────────────────────────────────────────────────────────
  const base30 = await report("range=30d");
  ok("GET range=30d → 200 con range.days (30) y tz", base30.res.ok && base30.json?.range?.days?.length === 30 && !!base30.json?.range?.tz, short(base30));
  ok("Cache-Control privado", /private/.test(base30.res.headers.get("cache-control") ?? ""));
  const base90 = await report("range=90d");
  ok("GET range=90d → 90 días", base90.json?.range?.days?.length === 90, short(base90));
  const tz = base30.json?.range?.tz ?? "America/Mexico_City";
  const today = dayIn(tz);
  // Día del pasado (entre 120 y 359 días atrás) al que se trasladan los datos.
  const K = 120 + Math.floor(Math.random() * 240);
  const D = addDays(today, -K);
  // Ventana de 3 días alrededor de D: tolera la medianoche durante la corrida.
  const WIN = `range=custom&from=${addDays(D, -1)}&to=${addDays(D, 1)}`;
  const baseW = await report(WIN);
  ok("línea base del día del pasado → 200", baseW.res.ok, short(baseW));
  const cleanDay = (data(baseW, "attention")?.active ?? 1) === 0;

  // ── Siembra ─────────────────────────────────────────────────────────────
  const P = { A: phone(), B: phone(), C: phone(), D: phone(), E: phone() };
  const N = Object.fromEntries(Object.keys(P).map((k) => [k, `Met${k}${S}`]));
  const NOTE_B = `Pide factura con otro RFC (${S})`;

  console.log("\n== Fase 1: agente APAGADO — C (operador), D (sin respuesta), E (teléfono) ==");
  await owner.api("/api/agent/profile", { method: "PUT", body: body({ enabled: false }) });
  await inbound(P.C, N.C, "hola, soy C");
  await inbound(P.D, N.D, "hola, soy D");
  await inbound(P.E, N.E, "hola, soy E");
  const cC = await convByName(N.C);
  const cD = await convByName(N.D);
  const cE = await convByName(N.E);
  ok("conversaciones C, D y E creadas", !!(cC && cD && cE));
  if (!cC || !cD || !cE) return;

  const TXT_C1 = `te atiendo yo (${S})`;
  const TXT_C2 = `mensaje que va a fallar (${S})`;
  const c1 = await owner.api(`/api/conversations/${cC.id}/messages`, { method: "POST", body: body({ text: TXT_C1 }) });
  const c2 = await owner.api(`/api/conversations/${cC.id}/messages`, { method: "POST", body: body({ text: TXT_C2 }) });
  ok("C: dos salientes del operador", c1.res.ok && c2.res.ok, `${short(c1)} | ${short(c2)}`);
  await sleep(800);
  const waC2 = await until(() => waIdFor(P.C, TXT_C2));
  ok("C: la 2ª salida falla por webhook de estado", !!waC2 && (await setStatus(waC2, "failed", { errorCode: 131026, errorMessage: "Message undeliverable" })));

  const echo = await owner.api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: body({ phoneNumberId: PN, to: P.E, text: `te contesto desde el cel (${S})`, waMessageId: `wamid.met.echo.${S}` }),
  });
  ok("E: echo del teléfono entregado", echo.res.ok, short(echo));
  const pausedE = await until(async () => {
    const convs = (await owner.api("/api/conversations")).json?.conversations ?? [];
    const c = convs.find((x) => x.id === cE.id);
    return c?.handoffReason === "manual_reply" ? c : null;
  });
  ok("E: IA en pausa con manual_reply", !!pausedE);

  console.log("\n== Fase 2: agente ENCENDIDO — A (solo IA), B (IA + escalamiento con nota) ==");
  await owner.api("/api/agent/profile", { method: "PUT", body: body({ enabled: true }) });
  await inbound(P.A, N.A, "hola, quiero informes A");
  await inbound(P.B, N.B, "hola, quiero informes B");
  const cA = await convByName(N.A);
  const cB = await convByName(N.B);
  ok("conversaciones A y B creadas", !!(cA && cB));
  if (!cA || !cB) return;
  const aiReply = async (convId) =>
    until(async () => (await messages(convId)).find((m) => m.direction === "out" && m.origin === "ai") ?? null, 30000);
  const rA = await aiReply(cA.id);
  const rB = await aiReply(cB.id);
  ok("A y B: la IA respondió (ai-mock)", !!(rA && rB));

  const ho = await bot("/api/bot/handoff", {
    method: "POST",
    body: body({ conversationId: cB.id, reason: "cliente", note: NOTE_B }),
  });
  ok("B: /api/bot/handoff «cliente» con nota → 200", ho.res.ok, short(ho));
  await sleep(500);
  const opB = await owner.api(`/api/conversations/${cB.id}/messages`, {
    method: "POST",
    body: body({ text: `ya te atiende una persona (${S})` }),
  });
  ok("B: el operador contesta tras el escalamiento", opB.res.ok, short(opB));
  await owner.api("/api/agent/profile", { method: "PUT", body: body({ enabled: agentWasEnabled }) });

  // Estados de entrega: A leído, B (IA) entregado.
  const waA = rA ? await until(() => waIdFor(P.A, rA.text ?? "")) : null;
  const waB = rB ? await until(() => waIdFor(P.B, rB.text ?? "")) : null;
  ok("A → read, B (IA) → delivered", !!waA && !!waB && (await setStatus(waA, "read")) && (await setStatus(waB, "delivered")));
  await sleep(1200);

  // ── Lo esperado, a partir de lo que de verdad quedó en la BD ───────────
  const all = { A: cA, B: cB, C: cC, D: cD, E: cE };
  const msgs = {};
  for (const [k, c] of Object.entries(all)) msgs[k] = await messages(c.id);
  const flat = Object.values(msgs).flat();
  const outs = flat.filter((m) => m.direction === "out");
  const exp = {
    in: flat.filter((m) => m.direction === "in").length,
    out: outs.length,
    failed: outs.filter((m) => m.status === "failed").length,
    // M7: WhatsApp, sin `manual`.
    m7base: outs.filter((m) => m.origin !== "manual" && ["sent", "delivered", "read", "failed"].includes(m.status)).length,
    m7delivered: outs.filter((m) => m.origin !== "manual" && ["delivered", "read"].includes(m.status)).length,
    m7read: outs.filter((m) => m.origin !== "manual" && m.status === "read").length,
  };
  ok("C quedó con 1 saliente fallida", msgs.C.filter((m) => m.status === "failed").length === 1, JSON.stringify(msgs.C.map((m) => m.status)));

  console.log("\n== SQL: Lab, aproximado, viejo y traslado al pasado ==");
  const ids = Object.values(all).map((c) => c.id);
  const ctLab = `ct_met_lab_${S}`;
  const cvLab = `cv_met_lab_${S}`;
  await db`INSERT INTO contact (id, organization_id, wa_identity, name) VALUES (${ctLab}, ${orgId}, ${`lab-met-${S}`}, ${`MetLab${S}`})`;
  await db`INSERT INTO conversation (id, organization_id, contact_id, is_test) VALUES (${cvLab}, ${orgId}, ${ctLab}, true)`;
  await db`INSERT INTO message (id, organization_id, conversation_id, direction, text, status, origin)
           VALUES (${`msg_met_lab_in_${S}`}, ${orgId}, ${cvLab}, 'in', 'soy del laboratorio', 'sent', 'operator'),
                  (${`msg_met_lab_out_${S}`}, ${orgId}, ${cvLab}, 'out', 'respuesta del lab', 'failed', 'ai')`;
  // Evento sembrado como la migración 0017 (aproximado), sobre D.
  await db`INSERT INTO conversation_handoff_event (id, organization_id, conversation_id, kind, reason, note, source, approximate, created_at)
           VALUES (${`hoe_met_seed_${S}`}, ${orgId}, ${cD.id}, 'opened', 'modelo', NULL, 'migracion', true, now() at time zone 'UTC')`;
  // Traslado: K días atrás, conservando la hora (y los tiempos de respuesta).
  const shiftIds = [...ids, cvLab];
  const movedMsgs = await db`UPDATE message SET created_at = created_at - make_interval(days => ${K})
                             WHERE organization_id = ${orgId} AND conversation_id IN ${db(shiftIds)} RETURNING id`;
  const movedEv = await db`UPDATE conversation_handoff_event SET created_at = created_at - make_interval(days => ${K})
                           WHERE organization_id = ${orgId} AND conversation_id IN ${db(shiftIds)} RETURNING id`;
  ok(`traslado al ${D}: mensajes y eventos`, movedMsgs.length === exp.in + exp.out + 2 && movedEv.length >= 3, `${movedMsgs.length} msgs, ${movedEv.length} eventos`);
  // Entrante de hace 40 días en una conversación real nueva.
  const ctOld = `ct_met_old_${S}`;
  const cvOld = `cv_met_old_${S}`;
  await db`INSERT INTO contact (id, organization_id, wa_identity, name) VALUES (${ctOld}, ${orgId}, ${`old-met-${S}`}, ${`MetViejo${S}`})`;
  await db`INSERT INTO conversation (id, organization_id, contact_id) VALUES (${cvOld}, ${orgId}, ${ctOld})`;
  await db`INSERT INTO message (id, organization_id, conversation_id, direction, text, status, created_at)
           VALUES (${`msg_met_old_${S}`}, ${orgId}, ${cvOld}, 'in', 'mensaje viejo', 'sent', (now() at time zone 'UTC') - interval '40 days')`;

  console.log("\n== M1–M8 por la API (deltas contra la línea base) ==");
  const after = await report(WIN);
  ok("GET del día del pasado → 200 y todos los bloques ok", after.res.ok && ["attention", "escalations", "responseTimes", "afterHandoff", "failures", "delivery", "volume"].every((b) => after.json?.[b]?.ok), short(after));
  const d = (block, field, r = after, b = baseW) => (data(r, block)?.[field] ?? 0) - (data(b, block)?.[field] ?? 0);

  ok("M1: +5 activas (el Lab no cuenta)", d("attention", "active") === 5, JSON.stringify(data(after, "attention")));
  ok("M2: Solo IA +1 (A)", d("attention", "aiOnly") === 1);
  ok("M2: IA + humano +1 (B)", d("attention", "aiAndHuman") === 1);
  ok("M2: Solo humano +2 (C operador, E teléfono)", d("attention", "humanOnly") === 2);
  ok("M2: Sin respuesta +1 (D, aunque tenga un evento aproximado)", d("attention", "noReply") === 1);
  if (cleanDay) ok("M2: % Solo IA = 1/5", data(after, "attention")?.aiOnlyRate === 0.2, String(data(after, "attention")?.aiOnlyRate));

  const esc = data(after, "escalations");
  ok("M3: +2 escalamientos (cliente + modelo aproximado); manual_reply fuera", d("escalations", "total") === 2, JSON.stringify(esc));
  ok("M3: «cliente» +1", reasonCount(after, "cliente") - reasonCount(baseW, "cliente") === 1);
  ok("M3: «modelo» +1 (aproximado cuenta para totales)", reasonCount(after, "modelo") - reasonCount(baseW, "modelo") === 1);
  ok("M3: nunca aparece manual_reply en byReason", !(esc?.byReason ?? []).some((x) => x.reason === "manual_reply"));
  const sample = esc?.byReason?.find((x) => x.reason === "cliente")?.samples?.find((s) => s.note === NOTE_B);
  ok("M3: muestra con la nota de B, su contacto y su conversación", sample?.contactName === N.B && sample?.conversationId === cB.id && !!sample?.contactId, JSON.stringify(sample));
  ok("M3: etiqueta en español", esc?.byReason?.find((x) => x.reason === "cliente")?.label === "El cliente pidió un humano");
  ok("M3: aviso de datos aproximados", esc?.approximate === true);
  ok("«Pausas por respuesta manual» +1 (E)", d("escalations", "manualReplyPauses") === 1);

  const rt = data(after, "responseTimes");
  const rt0 = data(baseW, "responseTimes");
  ok("M4: sesiones IA +2 (A, B)", (rt?.ai?.sessions ?? 0) - (rt0?.ai?.sessions ?? 0) === 2, JSON.stringify(rt));
  ok("M4: sesiones humanas +2 (C, E)", (rt?.human?.sessions ?? 0) - (rt0?.human?.sessions ?? 0) === 2);
  ok("M4: sin respuesta +1 (D)", (rt?.unanswered ?? 0) - (rt0?.unanswered ?? 0) === 1);
  if (cleanDay) {
    ok("M4: mediana IA numérica y < 60 s", typeof rt?.ai?.p50Seconds === "number" && rt.ai.p50Seconds < 60, String(rt?.ai?.p50Seconds));
    ok("M4: mediana humana numérica", typeof rt?.human?.p50Seconds === "number");
  }

  const ah = data(after, "afterHandoff");
  const ah0 = data(baseW, "afterHandoff");
  ok("M5: +1 atendido (B); el aproximado y manual_reply no entran", (ah?.attended ?? 0) - (ah0?.attended ?? 0) === 1 && (ah?.unattended ?? 0) - (ah0?.unattended ?? 0) === 0, JSON.stringify(ah));
  if (cleanDay) ok("M5: p50 numérico", typeof ah?.p50Seconds === "number");

  ok(`M6: salientes +${exp.out}, fallidas +${exp.failed} (el Lab no cuenta)`, d("failures", "total") === exp.out && d("failures", "failed") === exp.failed, JSON.stringify(data(after, "failures")));
  ok("M6: corte por canal y por origen presentes", (data(after, "failures")?.byChannel ?? []).some((x) => x.channel === "whatsapp") && (data(after, "failures")?.byOrigin ?? []).some((x) => x.origin === "operator"));
  ok("M6: top de errores con el motivo", (data(after, "failures")?.topErrors ?? []).length >= 1);

  ok(`M7: base +${exp.m7base}, entregados +${exp.m7delivered}, leídos +${exp.m7read} (sin manual)`, d("delivery", "base") === exp.m7base && d("delivery", "delivered") === exp.m7delivered && d("delivery", "read") === exp.m7read, JSON.stringify(data(after, "delivery")));
  ok("M7: solo canales con acuses (whatsapp)", JSON.stringify(data(after, "delivery")?.channels) === JSON.stringify(["whatsapp"]));

  const v1 = volTotals(after);
  const v0 = volTotals(baseW);
  ok(`M8: volumen +${exp.in} entrantes / +${exp.out} salientes`, v1.in - v0.in === exp.in && v1.out - v0.out === exp.out, JSON.stringify({ v0, v1 }));
  ok("M8: 3 días × canal, días en cero incluidos", (data(after, "volume")?.rows ?? []).filter((r) => r.channel === "whatsapp").length === 3);

  console.log("\n== CA-02-04: el mensaje de hace 40 días ==");
  const a30 = await report("range=30d");
  const a90 = await report("range=90d");
  ok("fuera de 30 días", d("attention", "active", a30, base30) === 0, `${data(base30, "attention")?.active} → ${data(a30, "attention")?.active}`);
  ok("dentro de 90 días", d("attention", "active", a90, base90) === 1, `${data(base90, "attention")?.active} → ${data(a90, "attention")?.active}`);

  console.log("\n== Vendedor: 403 en la API ==");
  const SELLER_EMAIL = `vend.met.${S}@vocero.test`;
  const SELLER_PASSWORD = "password-vend-met-123";
  const add = await owner.api("/api/settings/team", {
    method: "POST",
    body: body({ name: "Vendedor Métricas", email: SELLER_EMAIL, password: SELLER_PASSWORD }),
  });
  ok("alta del vendedor (POST /api/settings/team)", add.res.status === 201 || add.res.ok, short(add));
  const sIn = await seller.api("/api/auth/sign-in/email", { method: "POST", body: body({ email: SELLER_EMAIL, password: SELLER_PASSWORD }) });
  ok("el vendedor inicia sesión", sIn.res.ok, short(sIn));
  const forb = await seller.api("/api/reports/agent?range=30d");
  ok("GET /api/reports/agent como vendedor → 403 forbidden", forb.res.status === 403 && forb.json?.error?.code === "forbidden", short(forb));

  console.log("\n== UI (Playwright) ==");
  const browser = await chromium.launch();
  try {
    const toCookies = (jar) =>
      jar.cookie
        .split("; ")
        .filter(Boolean)
        .map((kv) => {
          const i = kv.indexOf("=");
          return { name: kv.slice(0, i), value: kv.slice(i + 1), url: BASE };
        });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies(toCookies(owner.jar));
    const page = await ctx.newPage();
    await page.goto(`${BASE}/inbox`, { waitUntil: "load" });
    ok("menú con «Reportes» para el Propietario", (await page.getByRole("link", { name: "Reportes" }).count()) > 0);

    await page.goto(`${BASE}/reports?${WIN}`, { waitUntil: "load" });
    await page.getByText("Reparto de atención").first().waitFor({ timeout: 20000 });
    // Los títulos se pintan desde la carga («…»): esperar a que llegue el
    // reporte (en dev, la primera compilación de la ruta tarda varios s).
    await until(async () => {
      const t = await page.locator('[data-testid="kpi-active"]').first().innerText();
      return !t.includes("…");
    }, 60000);
    for (const title of [
      "Reparto de atención",
      "Volumen por día y canal",
      "Escalamientos por motivo",
      "Tiempo a primera respuesta",
      "Salientes fallidas",
      "Entrega y lectura",
    ]) {
      ok(`bloque «${title}» visible`, (await page.getByText(title).count()) > 0);
    }
    for (const id of ["kpi-active", "kpi-ai-only", "kpi-escalations", "kpi-ai-p50", "kpi-failed"]) {
      ok(`KPI ${id} presente`, (await page.locator(`[data-testid="${id}"]`).count()) > 0);
    }
    const activeTxt = (await page.locator('[data-testid="kpi-active"]').first().innerText()).replace(/\s+/g, " ");
    ok("KPI de activas muestra el número de la API", activeTxt.includes(String(data(after, "attention")?.active)), activeTxt);
    const pauses = page.locator('[data-testid="manual-reply-pauses"]');
    const pausesTxt = (await pauses.count()) ? await pauses.first().innerText() : "";
    ok("línea «Pausas por respuesta manual» con el conteo", pausesTxt.includes("Pausas por respuesta manual") && pausesTxt.includes(String(esc?.manualReplyPauses)), pausesTxt);
    ok("aviso de datos aproximados visible", (await page.locator('[data-testid="approximate-notice"]').count()) > 0);
    ok("tabla de escalamientos con la nota de B", (await page.locator('[aria-label="Escalamientos por motivo"]').count()) > 0 && (await page.getByText(NOTE_B).count()) > 0);

    const group = page.locator('[role="group"][aria-label="Rango del reporte"]');
    ok("selector de rango presente", (await group.count()) > 0);
    await group.getByRole("button", { name: "90 días" }).click();
    await page.waitForURL(/range=90d/, { timeout: 15000 }).catch(() => {});
    ok("cambiar a 90 días actualiza la URL", /range=90d/.test(page.url()), page.url());
    const chart = page.locator('svg[data-testid="volume-chart"]');
    await chart.first().waitFor({ timeout: 20000 }).catch(() => {});
    await until(async () => (await chart.first().getAttribute("data-days")) === "90", 15000);
    ok("el gráfico diario de 90 días tiene 90 días", (await chart.first().getAttribute("data-days")) === "90");
    await ctx.close();

    const sctx = await browser.newContext();
    await sctx.addCookies(toCookies(seller.jar));
    const spage = await sctx.newPage();
    const nav = await spage.goto(`${BASE}/reports`, { waitUntil: "load" });
    ok("/reports para el vendedor → 404", nav?.status() === 404, String(nav?.status()));
    await spage.goto(`${BASE}/inbox`, { waitUntil: "load" });
    ok("menú del vendedor sin «Reportes»", (await spage.getByRole("link", { name: "Reportes" }).count()) === 0);
    await sctx.close();
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (err) {
  failures++;
  console.error("  FAIL excepción no controlada:", err);
} finally {
  await db?.end();
}
console.log(`\n${checks} checks — ${failures === 0 ? "TODO VERDE" : `${failures} FALLO(S)`}`);
process.exit(failures ? 1 : 0);
