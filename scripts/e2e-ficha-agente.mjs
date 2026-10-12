/**
 * Self-test E2E — el agente llena la ficha (tarea 04, guion
 * tests/e2e/us-ficha-agente.md).
 *
 * Contra la app viva con el ai-mock: el mock responde a "me interesa el T03,
 * soy de Villahermosa" con `reply` + `ficha` cuando el prompt trae la sección
 * de campos; "ficha-update" usa el alias `update_ficha` con
 * `presupuesto: "350 mil"`; "ficha-rota" manda una ficha que no es objeto.
 *
 *   1) PUT /api/agent/ficha-fields con la plantilla de autos eléctricos
 *   2) inbound con modelo y ciudad → respuesta entregada, ficha con ambos
 *      valores, meta `ia`, 2 eventos `aplicado`
 *   3) humano edita `presupuesto` → meta `humano` (candado)
 *   4) el agente intenta pisarlo ("ficha-update") → valor intacto + evento
 *      `ignorado_humano`
 *   5) `fichaUnlock` → el agente ya puede: presupuesto = 350000 (número)
 *   6) "ficha-rota" → el cliente recibe "ok" y la conversación NO escala
 *   7) cerebro externo (si hay BOT_API_KEY) intenta pisar un campo con
 *      candado → 200 con `ignored` y valor intacto
 *   8) historial con eventos; Vendedor: 403 en PUT ficha-fields, 200 en el
 *      historial y en el PATCH de ficha
 *   9) sin definición (PUT null) el agente ya no llena nada — y deja la BD
 *      compartida como estaba para los demás guiones
 *
 * Uso:
 *   1) app corriendo con WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL → wa-mock,
 *      OPENROUTER_BASE_URL → ai-mock (con OPENROUTER_API_TOKEN y
 *      OPENROUTER_MODEL de relleno) y BD aislada migrada (0014 incluida)
 *   2) node --env-file=.env.e2e scripts/e2e-ficha-agente.mjs
 *
 * Sale con código 1 si algún check falla.
 */

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const BOT_KEY = process.env.BOT_API_KEY;

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

/** Un "navegador" por usuario: cada uno con su cookie de sesión. */
function session() {
  let cookie = "";
  return async function api(path, opts = {}) {
    const res = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: {
        "content-type": "application/json",
        // Better Auth valida Origin (CSRF) en los endpoints de auth.
        origin: BASE,
        ...(cookie ? { cookie } : {}),
        ...(opts.headers ?? {}),
      },
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    if (setCookie.length) {
      cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    }
    let json = null;
    try {
      json = await res.clone().json();
    } catch {}
    return { res, json };
  };
}

const owner = session();

function bot(path, body) {
  return fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-api-key": BOT_KEY ?? "" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ res: r, json: await r.json().catch(() => null) }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PN = "PN-E2E-FICHA-AGENTE";
const S = Math.random().toString(36).slice(2, 8);
let n = 0;

/** Plantilla "Agencia de autos eléctricos" (src/lib/ficha-fields.ts). */
const PLANTILLA = [
  { key: "modelo_interes", label: "Modelo de interés", type: "texto", hint: "modelo exacto que mencione el cliente", agentFills: true },
  { key: "presupuesto", label: "Presupuesto (MXN)", type: "numero", hint: "monto total que dice poder pagar; no el enganche", agentFills: true },
  { key: "forma_pago", label: "Forma de pago", type: "opcion", options: ["contado", "financiamiento", "arrendamiento", "por definir"], agentFills: true },
  { key: "plazo_compra", label: "Plazo de compra", type: "opcion", options: ["esta semana", "este mes", "1 a 3 meses", "más de 3 meses", "solo explorando"], agentFills: true },
  { key: "ciudad", label: "Ciudad", type: "texto", agentFills: true },
  { key: "uso", label: "Uso principal", type: "opcion", options: ["traslado diario en ciudad", "carretera", "negocio / flotilla", "reparto"], allowOther: true, agentFills: true },
];

async function inbound(from, name, text) {
  n++;
  return owner("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from,
      name,
      text,
      waMessageId: `wamid.e2e.ficha-agente.${S}.${n}`,
    }),
  });
}

async function aiOuts(convId) {
  const msgs = (await owner(`/api/conversations/${convId}/messages`)).json?.messages ?? [];
  return msgs.filter((m) => m.direction === "out" && m.aiGenerated);
}

/** Espera la siguiente respuesta de la IA (el agente tiene debounce). */
async function nextAiReply(convId, before, timeoutMs = 25_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const outs = await aiOuts(convId);
    if (outs.length > before) return outs[outs.length - 1];
    await sleep(700);
  }
  return null;
}

async function findConvByName(name) {
  for (let i = 0; i < 30; i++) {
    const convs = (await owner("/api/conversations")).json?.conversations ?? [];
    const c = convs.find((x) => x.contact?.name === name);
    if (c) return c;
    await sleep(500);
  }
  return null;
}

async function contactDetail(contactId, api = owner) {
  return (await api(`/api/contacts/${contactId}`)).json;
}

/** La ficha se escribe DESPUÉS de la respuesta: espera a que se cumpla `pred`. */
async function waitContact(contactId, pred, timeoutMs = 8_000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    last = await contactDetail(contactId);
    if (last && pred(last)) return last;
    await sleep(400);
  }
  return last;
}

async function history(contactId, api = owner) {
  return api(`/api/contacts/${contactId}/ficha/history`);
}

async function main() {
  console.log("== Setup: login + conexión WhatsApp + agente encendido ==");
  const email = "e2e@vocero.test";
  const password = "password-e2e-123";
  let su = await owner("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password, name: "Operador E2E" }),
  });
  if (!su.res.ok) {
    su = await owner("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }
  ok("registro o login del Propietario", su.res.ok, JSON.stringify(su.json));

  const conn = await owner("/api/settings/whatsapp", {
    method: "PUT",
    body: JSON.stringify({
      wabaId: "WABA-E2E-FICHA-AGENTE",
      phoneNumberId: PN,
      token: "tok-e2e-ficha-agente",
    }),
  });
  ok("conexión WhatsApp guardada (vía wa-mock)", conn.res.ok, JSON.stringify(conn.json));

  const prof = await owner("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({ name: "Sofi", enabled: true }),
  });
  ok("agente in-process encendido", prof.res.ok, JSON.stringify(prof.json));

  try {
    await flujo();
  } finally {
    console.log("\n== 9) limpieza: sin definición de campos ==");
    const off = await owner("/api/agent/ficha-fields", {
      method: "PUT",
      body: JSON.stringify({ fields: null }),
    });
    ok("PUT ficha-fields null → 200 con fields null", off.res.ok && off.json?.fields === null, JSON.stringify(off.json));
  }
}

async function flujo() {
  console.log("\n== 1) plantilla de autos eléctricos ==");
  const put = await owner("/api/agent/ficha-fields", {
    method: "PUT",
    body: JSON.stringify({ fields: PLANTILLA }),
  });
  ok(
    "PUT /api/agent/ficha-fields → 200 con los 6 campos canónicos",
    put.res.ok && put.json?.fields?.length === 6 && put.json.fields[0].key === "modelo_interes",
    JSON.stringify(put.json).slice(0, 300)
  );
  const get = await owner("/api/agent/ficha-fields");
  ok("GET /api/agent/ficha-fields devuelve la definición", get.json?.fields?.length === 6);
  const bad = await owner("/api/agent/ficha-fields", {
    method: "PUT",
    body: JSON.stringify({ fields: [PLANTILLA[0], PLANTILLA[0]] }),
  });
  ok(
    "clave repetida → 422 invalid_body",
    bad.res.status === 422 && bad.json?.error?.code === "invalid_body",
    `${bad.res.status} ${JSON.stringify(bad.json)}`
  );

  console.log("\n== 2) el agente llena la ficha sin gastar el turno ==");
  const from = `52155${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const name = `FichaIA${S} Cliente`;
  const first = await inbound(from, name, "me interesa el T03, soy de Villahermosa");
  ok("inbound entregado", first.res.ok, JSON.stringify(first.json));
  const conv = await findConvByName(name);
  ok("conversación creada", !!conv);
  if (!conv) return;
  const convId = conv.id;
  const contactId = conv.contact.id;

  const r2 = await nextAiReply(convId, 0);
  ok("el cliente recibe la respuesta", !!r2?.text && r2.text.includes("T03"), JSON.stringify(r2?.text));
  const d2 = await waitContact(contactId, (d) => d.contact?.ficha?.ciudad === "Villahermosa");
  ok(
    "ficha con modelo_interes y ciudad",
    d2?.contact?.ficha?.modelo_interes === "T03" && d2?.contact?.ficha?.ciudad === "Villahermosa",
    JSON.stringify(d2?.contact?.ficha)
  );
  ok(
    "fichaMeta los marca `ia`",
    d2?.contact?.fichaMeta?.modelo_interes?.by === "ia" && d2?.contact?.fichaMeta?.ciudad?.by === "ia",
    JSON.stringify(d2?.contact?.fichaMeta)
  );
  ok("GET /api/contacts/[id] trae fichaFields", d2?.fichaFields?.length === 6);
  const h2 = (await history(contactId)).json?.events ?? [];
  ok(
    "historial con 2 eventos `aplicado` de la IA",
    h2.filter((e) => e.outcome === "aplicado" && e.source === "ia").length === 2,
    JSON.stringify(h2).slice(0, 300)
  );

  console.log("\n== 3) el humano edita `presupuesto` ==");
  const p3 = await owner(`/api/contacts/${contactId}`, {
    method: "PATCH",
    body: JSON.stringify({ ficha: { presupuesto: 500000 } }),
  });
  ok(
    "PATCH → 200 con meta `humano` (candado)",
    p3.res.ok &&
      p3.json?.contact?.ficha?.presupuesto === 500000 &&
      p3.json?.contact?.fichaMeta?.presupuesto?.by === "humano",
    JSON.stringify(p3.json?.contact?.fichaMeta)
  );

  console.log("\n== 4) el agente intenta pisarlo ==");
  const before4 = (await aiOuts(convId)).length;
  await inbound(from, name, "ficha-update");
  const r4 = await nextAiReply(convId, before4);
  ok("el cliente recibe 'Anotado' (alias update_ficha)", r4?.text === "Anotado", JSON.stringify(r4?.text));
  let h4 = [];
  for (let i = 0; i < 15; i++) {
    h4 = (await history(contactId)).json?.events ?? [];
    if (h4.some((e) => e.outcome === "ignorado_humano")) break;
    await sleep(400);
  }
  const d4 = await contactDetail(contactId);
  ok("presupuesto sigue en 500000", d4?.contact?.ficha?.presupuesto === 500000, JSON.stringify(d4?.contact?.ficha));
  ok(
    "evento `ignorado_humano` (candado_humano) para presupuesto",
    h4.some((e) => e.key === "presupuesto" && e.outcome === "ignorado_humano" && e.reason === "candado_humano"),
    JSON.stringify(h4.slice(0, 3))
  );

  console.log("\n== 5) \"Dejar que el agente lo actualice\" ==");
  const p5 = await owner(`/api/contacts/${contactId}`, {
    method: "PATCH",
    body: JSON.stringify({ fichaUnlock: ["presupuesto"] }),
  });
  ok(
    "fichaUnlock → valor intacto y meta `ia`",
    p5.res.ok &&
      p5.json?.contact?.ficha?.presupuesto === 500000 &&
      p5.json?.contact?.fichaMeta?.presupuesto?.by === "ia",
    JSON.stringify(p5.json?.contact)
  );
  const before5 = (await aiOuts(convId)).length;
  await inbound(from, name, "ficha-update");
  await nextAiReply(convId, before5);
  const d5 = await waitContact(contactId, (d) => d.contact?.ficha?.presupuesto === 350000);
  ok(
    "ahora sí: '350 mil' se guarda como 350000 (número)",
    d5?.contact?.ficha?.presupuesto === 350000,
    JSON.stringify(d5?.contact?.ficha)
  );

  console.log("\n== 6) ficha rota: la respuesta sale igual ==");
  const before6 = (await aiOuts(convId)).length;
  await inbound(from, name, "ficha-rota");
  const r6 = await nextAiReply(convId, before6);
  ok("el cliente recibe 'ok'", r6?.text === "ok", JSON.stringify(r6?.text));
  const c6 = ((await owner("/api/conversations")).json?.conversations ?? []).find((c) => c.id === convId);
  ok("sin handoff", !c6?.handoffReason, JSON.stringify({ reason: c6?.handoffReason }));

  console.log("\n== 7) cerebro externo y el candado humano (D-04-4) ==");
  if (!BOT_KEY || BOT_KEY.length < 16) {
    console.log("  (omitido: sin BOT_API_KEY de 16+ caracteres)");
  } else {
    await owner(`/api/contacts/${contactId}`, {
      method: "PATCH",
      body: JSON.stringify({ ficha: { ciudad: "Mérida" } }),
    });
    const b7 = await bot("/api/bot/ficha", {
      conversationId: convId,
      ficha: { ciudad: "Cancún", urgencia: "alta" },
    });
    ok(
      "PUT /api/bot/ficha → 200 con ignored [ciudad: candado_humano]",
      b7.res.ok &&
        Array.isArray(b7.json?.ignored) &&
        b7.json.ignored.some((i) => i.key === "ciudad" && i.reason === "candado_humano"),
      JSON.stringify(b7.json)
    );
    ok(
      "ciudad intacta y lo libre sí entra (meta `bot`)",
      b7.json?.ficha?.ciudad === "Mérida" && b7.json?.ficha?.urgencia === "alta",
      JSON.stringify(b7.json?.ficha)
    );
    const ctx = await fetch(`${BASE}/api/bot/context?conversationId=${convId}`, {
      headers: { "x-api-key": BOT_KEY },
    }).then((r) => r.json().catch(() => null));
    ok(
      "/api/bot/context trae contact.fichaMeta y fichaFields",
      ctx?.contact?.fichaMeta?.ciudad?.by === "humano" &&
        ctx?.contact?.fichaMeta?.urgencia?.by === "bot" &&
        ctx?.fichaFields?.length === 6,
      JSON.stringify({ meta: ctx?.contact?.fichaMeta, n: ctx?.fichaFields?.length })
    );
  }

  console.log("\n== 8) historial y permisos del Vendedor ==");
  const h8 = await history(contactId);
  const ev = h8.json?.events ?? [];
  ok(
    "historial: más reciente primero, con actor humano",
    h8.res.ok &&
      ev.length >= 4 &&
      ev[0].createdAt >= ev[ev.length - 1].createdAt &&
      ev.some((e) => e.source === "humano" && e.actor?.name),
    JSON.stringify(ev.slice(0, 2))
  );

  const vend = session();
  const vEmail = `vendedor.${S}@vocero.test`;
  const vPass = `password-vend-${S}`;
  const alta = await owner("/api/settings/team", {
    method: "POST",
    body: JSON.stringify({ name: `Vendedor ${S}`, email: vEmail, password: vPass }),
  });
  ok("alta del Vendedor (POST /api/settings/team)", alta.res.status === 201, `${alta.res.status} ${JSON.stringify(alta.json)}`);
  const li = await vend("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: vEmail, password: vPass }),
  });
  ok("login del Vendedor", li.res.ok, JSON.stringify(li.json));
  const v403 = await vend("/api/agent/ficha-fields", {
    method: "PUT",
    body: JSON.stringify({ fields: null }),
  });
  ok("Vendedor: PUT ficha-fields → 403", v403.res.status === 403, String(v403.res.status));
  const vGet = await vend("/api/agent/ficha-fields");
  ok("Vendedor: GET ficha-fields → 403", vGet.res.status === 403, String(vGet.res.status));
  const vh = await history(contactId, vend);
  ok("Vendedor: historial → 200", vh.res.ok, String(vh.res.status));
  const vd = await contactDetail(contactId, vend);
  ok("Vendedor: ve la definición en el detalle del contacto", vd?.fichaFields?.length === 6);
  const vp = await vend(`/api/contacts/${contactId}`, {
    method: "PATCH",
    body: JSON.stringify({ ficha: { forma_pago: "contado" } }),
  });
  ok(
    "Vendedor: PATCH de ficha → 200 con candado",
    vp.res.ok && vp.json?.contact?.fichaMeta?.forma_pago?.by === "humano",
    `${vp.res.status} ${JSON.stringify(vp.json?.contact?.fichaMeta)}`
  );

  console.log("\n== 9a) sin definición el agente ya no llena nada ==");
  await owner("/api/agent/ficha-fields", { method: "PUT", body: JSON.stringify({ fields: [] }) });
  const before9 = (await aiOuts(convId)).length;
  await inbound(from, name, "me interesa el Bingo, vivo en Cancún");
  const r9 = await nextAiReply(convId, before9);
  ok("el cliente recibe respuesta", !!r9?.text, JSON.stringify(r9?.text));
  await sleep(1500);
  const d9 = await contactDetail(contactId);
  ok(
    "fichaFields null y la ficha no cambió",
    d9?.fichaFields === null && d9?.contact?.ficha?.modelo_interes === "T03",
    JSON.stringify({ f: d9?.fichaFields, ficha: d9?.contact?.ficha })
  );
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
