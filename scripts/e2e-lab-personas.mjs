/**
 * Self-test E2E — Laboratorio por cliente (dev-tasks/08).
 * Guion humano: tests/e2e/us-lab-personas.md
 *
 * Conduce la app real con el ai-mock (juez determinista):
 *   a) owner entra; personas sembradas (teléfonos sintéticos); restaurar el
 *      set de autos e idempotencia de "restaurar predeterminadas"
 *   b) crea una persona propia (guion de 2 mensajes, objetivo con el
 *      marcador `[e2e-tono]`): key y teléfono los pone el servidor; guion de
 *      9 mensajes → 422; PATCH no cambia la key
 *   c) corrida SOLO con esa persona (`personaKeys`) → 1 caso con su
 *      `personaSnapshot`; amarillo con `ajuste` de tono + sugerencia P/R
 *   d) caminos infelices de la corrida: clave inexistente → 422
 *      unknown_persona; lista vacía → 422
 *   e) corrida con otro conjunto → historial "conjunto distinto"; aplicar
 *      con texto que excede el tono → 422 too_long y nada aplicado;
 *      índice fuera de rango / destino equivocado → 422
 *   f) aplicar la sugerencia al KB DOS VECES A LA VEZ → una `applied`, otra
 *      `alreadyApplied`, UNA sola entrada nueva en el KB
 *   g) aplicar el ajuste al perfil → el tono termina con el texto; repetir →
 *      `alreadyApplied` sin duplicarlo; el detalle marca `aplicada`
 *   h) re-correr el mismo conjunto → verde, delta +50 contra la primera
 *   i) "qué cambió": tono antes/después y +1 entrada de KB; tendencia
 *   j) archivar la persona → fuera de la lista, corrida vieja legible,
 *      ya no se puede correr; archivar + restaurar una de semilla
 *   k) sandbox: el outbox del wa-mock no creció
 *   l) Vendedor (alta por POST /api/settings/team): 403 en todo /api/lab/*
 *   m) limpieza: tono del perfil y entrada de KB como estaban
 *
 * Presupuesto del limitador de login: ≤ 3 POST a /sign-in|sign-up.
 *
 * Uso:
 *   1) BD migrada (0019 incluida) y app corriendo con WA_MOCK_ENABLED=true,
 *      META_GRAPH_BASE_URL → wa-mock y OPENROUTER_BASE_URL → ai-mock (con
 *      OPENROUTER_API_TOKEN y OPENROUTER_MODEL de relleno)
 *   2) node --env-file=.env.e2e scripts/e2e-lab-personas.mjs
 *
 * Sale con código 1 si algún check falla.
 */

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const S = Math.random().toString(36).slice(2, 8);
const LAB_TIMEOUT_MS = 180_000;
// Deben coincidir con src/server/dev/ai-mock.ts.
const TONE_MARKER = "[e2e-tono]";
const TONE_AJUSTE = "Cierra cada respuesta ofreciendo ayuda adicional.";
const KB_PREGUNTA = "¿Atienden en fin de semana?";

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
    await sleep(500);
  }
};
const body = (o) => JSON.stringify(o);
const short = (r) => `${r.res.status} ${JSON.stringify(r.json)?.slice(0, 300)}`;
const SYNTHETIC = /^52100000\d{5}$/;

const owner = client();
const seller = client();

const OWNER_EMAIL = "e2e@vocero.test";
const OWNER_PASSWORD = "password-e2e-123";
const SELLER_EMAIL = `vend.lab.${S}@vocero.test`;
const SELLER_PASSWORD = "password-vend-123";

function signIn(c, email, password) {
  return c.api("/api/auth/sign-in/email", {
    method: "POST",
    body: body({ email, password }),
  });
}

async function runs() {
  return (await owner.api("/api/lab/runs")).json?.runs ?? [];
}

/** Lanza una corrida y espera a que termine; devuelve `{ runId, detail }`. */
async function correr(label, payload) {
  const post = await owner.api("/api/lab/runs", {
    method: "POST",
    body: payload ? body(payload) : undefined,
  });
  ok(`${label}: POST /api/lab/runs → 202`, post.res.status === 202 && !!post.json?.runId, short(post));
  const runId = post.json?.runId;
  if (!runId) return { runId: null, detail: null };
  const t0 = Date.now();
  let detail = null;
  await until(async () => {
    detail = (await owner.api(`/api/lab/runs/${runId}`)).json;
    return detail?.run?.status && detail.run.status !== "running";
  }, LAB_TIMEOUT_MS);
  console.log(`  ..  ${label}: terminó en ${((Date.now() - t0) / 1000).toFixed(1)}s (status=${detail?.run?.status})`);
  ok(`${label}: la corrida termina done`, detail?.run?.status === "done", JSON.stringify(detail?.run));
  return { runId, detail };
}

function apply(payload) {
  return owner.api("/api/lab/suggestions/apply", { method: "POST", body: body(payload) });
}

async function kbEntries() {
  return (await owner.api("/api/kb")).json?.entries ?? [];
}

async function outboxCount() {
  const r = await owner.api("/api/dev/wa-mock/outbox");
  return Array.isArray(r.json?.outbox) ? r.json.outbox.length : null;
}

async function main() {
  console.log("== a) Owner, personas sembradas y restaurar ==");
  let su = await owner.api("/api/auth/sign-up/email", {
    method: "POST",
    body: body({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: "Operador E2E" }),
  });
  if (!su.res.ok) su = await signIn(owner, OWNER_EMAIL, OWNER_PASSWORD);
  ok("owner registrado o con sesión", su.res.ok, short(su));
  if (!su.res.ok) return;

  ok(
    "no hay corridas del Laboratorio en curso",
    await until(async () => !(await runs()).some((r) => r.status === "running"), LAB_TIMEOUT_MS)
  );

  const outboxBefore = await outboxCount();
  ok("el wa-mock expone su outbox", outboxBefore !== null);

  let r = await owner.api("/api/lab/personas");
  const sembradas = r.json?.personas ?? [];
  ok("GET /api/lab/personas → 200 con ≥ 7 personas", r.res.status === 200 && sembradas.length >= 7, short(r));
  ok("runInProgress es booleano (aviso D-08-06)", typeof r.json?.runInProgress === "boolean");
  ok(
    "todas con teléfono sintético (52100000 + 5 dígitos)",
    sembradas.every((p) => SYNTHETIC.test(p.phone)),
    JSON.stringify(sembradas.map((p) => p.phone))
  );

  r = await owner.api("/api/lab/personas/restore-defaults", { method: "POST", body: body({ set: "autos" }) });
  ok("restore-defaults {set:autos} → 200", r.res.status === 200 && r.json?.set === "autos", short(r));
  r = await owner.api("/api/lab/personas/restore-defaults", { method: "POST", body: body({ set: "autos" }) });
  ok("restaurar otra vez es idempotente (restored = [])", r.res.status === 200 && r.json?.restored?.length === 0, short(r));
  const seeds = r.json?.personas ?? [];
  ok(
    "las 7 de semilla del set autos, activas",
    ["comprador_decidido", "fuera_de_kb", "pide_humano"].every((k) =>
      seeds.some((p) => p.key === k && p.seedSet === "autos" && p.active)
    ),
    JSON.stringify(seeds.map((p) => [p.key, p.seedSet, p.active]))
  );

  console.log("\n== b) Persona propia ==");
  const NAME = `Tono E2E ${S}`;
  r = await owner.api("/api/lab/personas", {
    method: "POST",
    body: body({
      name: NAME,
      objetivo: `Cliente que valora la calidez ${TONE_MARKER}`,
      guion: ["Hola, buenas tardes", "¿Abren en fin de semana?"],
      criteriosExito: "Cierra ofreciendo ayuda; no inventa horarios",
      key: "comprador_decidido",
      phone: "5215555555555",
    }),
  });
  const persona = r.json?.persona;
  ok("POST /api/lab/personas → 201", r.res.status === 201 && !!persona?.id, short(r));
  if (!persona?.id) return;
  ok("key = slug del nombre (la del body se ignora)", persona.key === `tono_e2e_${S}`, persona.key);
  ok(
    "teléfono sintético generado por el servidor (el del body se ignora)",
    SYNTHETIC.test(persona.phone) && persona.phone !== "5215555555555",
    persona.phone
  );
  ok("personalizada: seedSet null y activa", persona.seedSet === null && persona.active === true);
  const KEY = persona.key;

  r = await owner.api("/api/lab/personas", {
    method: "POST",
    body: body({ name: "Demasiado larga", guion: Array.from({ length: 9 }, (_, i) => `m${i}`) }),
  });
  ok("guion de 9 mensajes → 422 invalid_body", r.res.status === 422, short(r));

  r = await owner.api(`/api/lab/personas/${persona.id}`, {
    method: "PATCH",
    body: body({ rasgos: "Escribe corto", key: "otra_clave" }),
  });
  ok("PATCH → 200 y la key no cambia", r.res.status === 200 && r.json?.persona?.key === KEY && r.json?.persona?.rasgos === "Escribe corto", short(r));
  r = await owner.api("/api/lab/personas/lpe_no_existe_e2e", { method: "PATCH", body: body({ name: "x" }) });
  ok("PATCH de una persona inexistente → 404", r.res.status === 404, short(r));

  const prof0 = await owner.api("/api/agent/profile");
  const toneBefore = prof0.json?.profile?.tone ?? null;
  ok("GET /api/agent/profile → 200", prof0.res.status === 200, short(prof0));

  console.log("\n== c) Corrida solo con la persona propia ==");
  const run1 = await correr("corrida 1", { personaKeys: [KEY] });
  if (!run1.runId) return;
  const caso1 = run1.detail?.cases?.[0];
  ok("la corrida guarda su conjunto (personaKeys)", JSON.stringify(run1.detail?.run?.personaKeys) === JSON.stringify([KEY]));
  ok("1 caso, de esa persona", run1.detail?.cases?.length === 1 && caso1?.persona === KEY, JSON.stringify(run1.detail?.cases?.map((c) => c.persona)));
  ok(
    "el caso trae su personaSnapshot (nombre, guion de 2, teléfono)",
    caso1?.personaSnapshot?.name === NAME &&
      caso1?.personaSnapshot?.guion?.length === 2 &&
      caso1?.personaSnapshot?.phone === persona.phone &&
      caso1?.personaLabel === NAME,
    JSON.stringify(caso1?.personaSnapshot)
  );
  ok("el transcript conversó el guion (2 mensajes del cliente)", (caso1?.transcript ?? []).filter((t) => t.role === "cliente").length === 2);
  ok("veredicto amarillo (juez simulado)", caso1?.veredicto === "amarillo", caso1?.veredicto);
  ok(
    "hallazgo 0: tono con ajuste al tono; hallazgo 1: sugerencia P/R",
    caso1?.hallazgos?.[0]?.ajuste?.campo === "tone" &&
      caso1?.hallazgos?.[0]?.ajuste?.texto === TONE_AJUSTE &&
      caso1?.hallazgos?.[1]?.sugerencia?.pregunta === KB_PREGUNTA,
    JSON.stringify(caso1?.hallazgos)
  );
  ok("ningún hallazgo aplicado todavía", (caso1?.hallazgos ?? []).every((h) => h.aplicada === null));

  console.log("\n== d) Caminos infelices de la corrida ==");
  r = await owner.api("/api/lab/runs", { method: "POST", body: body({ personaKeys: ["no_existe_e2e"] }) });
  ok("clave inexistente → 422 unknown_persona", r.res.status === 422 && r.json?.error?.code === "unknown_persona", short(r));
  r = await owner.api("/api/lab/runs", { method: "POST", body: body({ personaKeys: [] }) });
  ok("lista vacía → 422", r.res.status === 422, short(r));
  r = await owner.api("/api/lab/runs", {
    method: "POST",
    body: body({ personaKeys: Array.from({ length: 11 }, (_, i) => `k${i}`) }),
  });
  ok("más de 10 personas → 422", r.res.status === 422, short(r));

  console.log("\n== e) Otro conjunto → \"conjunto distinto\" ==");
  const run2 = await correr("corrida 2", { personaKeys: [KEY, "pide_humano"] });
  const fila2 = (await runs()).find((x) => x.id === run2.runId);
  ok(
    "historial: delta null con nota \"conjunto distinto\"",
    fila2?.delta === null && fila2?.deltaNote === "conjunto distinto",
    JSON.stringify(fila2)
  );
  const caso2 = run2.detail?.cases?.find((c) => c.persona === KEY);
  if (caso2) {
    r = await apply({ testCaseId: caso2.id, hallazgoIndex: 0, target: "profile", text: "x".repeat(600) });
    ok("aplicar un texto que excede el tono → 422 too_long", r.res.status === 422 && r.json?.error?.code === "too_long", short(r));
    const d2 = (await owner.api(`/api/lab/runs/${run2.runId}`)).json;
    ok(
      "…y no quedó registrada (rollback)",
      d2?.cases?.find((c) => c.id === caso2.id)?.hallazgos?.[0]?.aplicada === null
    );
    r = await apply({ testCaseId: caso2.id, hallazgoIndex: 99, target: "kb" });
    ok("hallazgo fuera de rango → 422 hallazgo_not_found", r.res.status === 422 && r.json?.error?.code === "hallazgo_not_found", short(r));
    r = await apply({ testCaseId: caso2.id, hallazgoIndex: 0, target: "kb" });
    ok("destino que el hallazgo no trae → 422 target_mismatch", r.res.status === 422 && r.json?.error?.code === "target_mismatch", short(r));
  } else {
    ok("la corrida 2 trae el caso de la persona propia", false);
  }
  r = await apply({ testCaseId: "case_no_existe_e2e", hallazgoIndex: 0, target: "kb" });
  ok("caso inexistente → 404", r.res.status === 404, short(r));

  console.log("\n== f) Sugerencia al KB, dos veces a la vez ==");
  const kbAntes = (await kbEntries()).filter((e) => e.question === KB_PREGUNTA).length;
  const [k1, k2] = await Promise.all([
    apply({ testCaseId: caso1.id, hallazgoIndex: 1, target: "kb" }),
    apply({ testCaseId: caso1.id, hallazgoIndex: 1, target: "kb" }),
  ]);
  const results = [k1.json?.result, k2.json?.result].sort();
  ok(
    "dos POST simultáneos → 200 y 200: uno applied, otro alreadyApplied",
    k1.res.status === 200 && k2.res.status === 200 && results[0] === "alreadyApplied" && results[1] === "applied",
    `${short(k1)} | ${short(k2)}`
  );
  const kbNuevas = (await kbEntries()).filter((e) => e.question === KB_PREGUNTA);
  ok("UNA sola entrada nueva en el KB", kbNuevas.length === kbAntes + 1, `antes=${kbAntes} después=${kbNuevas.length}`);
  const kbEntryId = (k1.json?.result === "applied" ? k1 : k2).json?.application?.kbEntryId;
  r = await apply({ testCaseId: caso1.id, hallazgoIndex: 1, target: "kb" });
  ok(
    "tercer POST → alreadyApplied con la misma entrada",
    r.res.status === 200 && r.json?.result === "alreadyApplied" && r.json?.application?.kbEntryId === kbEntryId,
    short(r)
  );

  console.log("\n== g) Ajuste al perfil ==");
  r = await apply({ testCaseId: caso1.id, hallazgoIndex: 0, target: "profile" });
  ok("aplicar el ajuste de tono → applied", r.res.status === 200 && r.json?.result === "applied" && r.json?.application?.field === "tone", short(r));
  let tone = (await owner.api("/api/agent/profile")).json?.profile?.tone ?? "";
  ok("el tono del perfil termina con el texto agregado", tone.endsWith(TONE_AJUSTE), JSON.stringify(tone));
  r = await apply({ testCaseId: caso1.id, hallazgoIndex: 0, target: "profile" });
  ok("repetir → alreadyApplied", r.res.status === 200 && r.json?.result === "alreadyApplied", short(r));
  tone = (await owner.api("/api/agent/profile")).json?.profile?.tone ?? "";
  ok("…sin duplicar el texto", tone.split(TONE_AJUSTE).length === 2, JSON.stringify(tone));
  const d1 = (await owner.api(`/api/lab/runs/${run1.runId}`)).json;
  const h1 = d1?.cases?.[0]?.hallazgos ?? [];
  ok(
    "el detalle marca ambos hallazgos como aplicados (persistente)",
    h1[0]?.aplicada?.target === "profile" && h1[0]?.aplicada?.field === "tone" && h1[1]?.aplicada?.target === "kb" && h1[1]?.aplicada?.kbEntryId === kbEntryId,
    JSON.stringify(h1.map((h) => h.aplicada))
  );

  console.log("\n== h) Re-correr el mismo conjunto ==");
  const run3 = await correr("corrida 3", { personaKeys: [KEY] });
  ok("con el ajuste aplicado → verde", run3.detail?.cases?.[0]?.veredicto === "verde", run3.detail?.cases?.[0]?.veredicto);
  const fila3 = (await runs()).find((x) => x.id === run3.runId);
  ok(
    "delta +50 contra la corrida 1 (mismo conjunto, mismo guion)",
    fila3?.delta === 50 && fila3?.deltaAgainst === run1.runId && fila3?.deltaNote === null,
    JSON.stringify(fila3)
  );

  console.log("\n== i) Qué cambió y tendencia ==");
  r = await owner.api(`/api/lab/runs/${run3.runId}/diff?against=${run1.runId}`);
  ok("diff contra la corrida 1 → disponible", r.res.status === 200 && r.json?.available === true && r.json?.againstId === run1.runId, short(r));
  ok(
    "tono antes/después",
    r.json?.profile?.tone?.before === toneBefore && (r.json?.profile?.tone?.after ?? "").endsWith(TONE_AJUSTE),
    JSON.stringify(r.json?.profile)
  );
  ok(
    "+1 entrada de conocimiento con su pregunta",
    (r.json?.kb?.added ?? []).some((e) => e.id === kbEntryId && e.question === KB_PREGUNTA),
    JSON.stringify(r.json?.kb?.added)
  );
  ok("mismas personas", JSON.stringify(r.json?.personas) === JSON.stringify({ added: [], removed: [], edited: [] }), JSON.stringify(r.json?.personas));
  r = await owner.api(`/api/lab/runs/${run3.runId}/diff`);
  ok(
    "diff por defecto → la corrida done anterior (la 2): quitó pide_humano",
    r.json?.available === true && r.json?.againstId === run2.runId && (r.json?.personas?.removed ?? []).includes("pide_humano"),
    short(r)
  );
  r = await owner.api(`/api/lab/runs/${run3.runId}/diff?against=run_no_existe_e2e`);
  ok("diff contra una corrida inexistente → 404", r.res.status === 404, short(r));

  r = await owner.api("/api/lab/trends?limit=5");
  const trend = r.json?.runs ?? [];
  ok("GET /api/lab/trends → 200, la más reciente primero", r.res.status === 200 && trend[0]?.id === run3.runId, short(r));
  const t1 = trend.find((x) => x.id === run1.runId);
  ok(
    "corrida 1: 1 hallazgo de tono, 1 fuera_de_kb y la persona en amarillo",
    t1?.hallazgosPorTipo?.tono === 1 && t1?.hallazgosPorTipo?.fuera_de_kb === 1 && t1?.veredictos?.[KEY] === "amarillo",
    JSON.stringify(t1)
  );
  ok("corrida 3: sin hallazgos de tono y la persona en verde", trend[0]?.hallazgosPorTipo?.tono === 0 && trend[0]?.veredictos?.[KEY] === "verde", JSON.stringify(trend[0]));

  console.log("\n== j) Archivar ==");
  r = await owner.api(`/api/lab/personas/${persona.id}`, { method: "DELETE" });
  const archivedAt = r.json?.persona?.archivedAt;
  ok("DELETE → 200 con archivedAt (archivada, no borrada)", r.res.status === 200 && !!archivedAt && r.json?.persona?.active === false, short(r));
  r = await owner.api(`/api/lab/personas/${persona.id}`, { method: "DELETE" });
  ok("archivar otra vez es idempotente (misma fecha)", r.res.status === 200 && r.json?.persona?.archivedAt === archivedAt, short(r));
  ok("ya no sale en la lista", !((await owner.api("/api/lab/personas")).json?.personas ?? []).some((p) => p.id === persona.id));
  ok("sí sale con ?archived=1", ((await owner.api("/api/lab/personas?archived=1")).json?.personas ?? []).some((p) => p.id === persona.id));
  r = await owner.api(`/api/lab/runs/${run1.runId}`);
  ok(
    "la corrida vieja sigue legible con su nombre y guion de entonces",
    r.res.status === 200 && r.json?.cases?.[0]?.personaLabel === NAME && r.json?.cases?.[0]?.personaSnapshot?.guion?.length === 2,
    short(r)
  );
  r = await owner.api("/api/lab/runs", { method: "POST", body: body({ personaKeys: [KEY] }) });
  ok("correr la archivada → 422 unknown_persona", r.res.status === 422 && r.json?.error?.code === "unknown_persona", short(r));

  const modismos = seeds.find((p) => p.key === "errores_modismos");
  r = await owner.api(`/api/lab/personas/${modismos?.id}`, { method: "DELETE" });
  ok("archivar una de semilla → 200", r.res.status === 200, short(r));
  r = await owner.api("/api/lab/personas/restore-defaults", { method: "POST" });
  ok(
    "restaurar (sin cuerpo: el set de la org) la reactiva",
    r.res.status === 200 && r.json?.set === "autos" && r.json?.restored?.includes("errores_modismos") &&
      (r.json?.personas ?? []).some((p) => p.key === "errores_modismos" && p.active && !p.archivedAt),
    short(r)
  );
  ok("…sin revivir la personalizada archivada", !(r.json?.personas ?? []).some((p) => p.id === persona.id));

  console.log("\n== k) Sandbox ==");
  const outboxAfter = await outboxCount();
  ok("el outbox del wa-mock no creció (nada salió a WhatsApp)", outboxAfter === outboxBefore, `antes=${outboxBefore} después=${outboxAfter}`);

  console.log("\n== l) Vendedor: 403 en todo el Laboratorio ==");
  r = await owner.api("/api/settings/team", {
    method: "POST",
    body: body({ name: `Vendedor Lab ${S}`, email: SELLER_EMAIL, password: SELLER_PASSWORD }),
  });
  ok("alta del vendedor → 201", r.res.status === 201, short(r));
  ok("el vendedor inicia sesión", (await signIn(seller, SELLER_EMAIL, SELLER_PASSWORD)).res.ok);
  const FORBIDDEN = [
    ["GET", "/api/lab/personas"],
    ["POST", "/api/lab/personas", { name: "Hack", guion: ["hola"] }],
    ["PATCH", `/api/lab/personas/${persona.id}`, { name: "Hack" }],
    ["DELETE", `/api/lab/personas/${modismos?.id}`],
    ["POST", "/api/lab/personas/restore-defaults", { set: "neutro" }],
    ["GET", "/api/lab/runs"],
    ["POST", "/api/lab/runs", { personaKeys: ["pide_humano"] }],
    ["GET", `/api/lab/runs/${run1.runId}`],
    ["DELETE", `/api/lab/runs/${run2.runId}`],
    ["GET", `/api/lab/runs/${run3.runId}/diff`],
    ["GET", "/api/lab/trends"],
    ["POST", "/api/lab/suggestions/apply", { testCaseId: caso1.id, hallazgoIndex: 0, target: "profile" }],
  ];
  for (const [method, path, payload] of FORBIDDEN) {
    const x = await seller.api(path, { method, body: payload ? body(payload) : undefined });
    ok(`vendedor: ${method} ${path} → 403`, x.res.status === 403 && x.json?.error?.code === "forbidden", short(x));
  }
  ok("…y no cambió nada: la corrida 2 sigue", (await owner.api(`/api/lab/runs/${run2.runId}`)).res.status === 200);
  ok(
    "…ni la persona de semilla",
    ((await owner.api("/api/lab/personas")).json?.personas ?? []).some((p) => p.id === modismos?.id && p.active)
  );

  console.log("\n== m) Limpieza ==");
  r = await owner.api("/api/agent/profile", { method: "PUT", body: body({ tone: toneBefore }) });
  ok("tono del perfil restaurado", r.res.ok, short(r));
  if (kbEntryId) {
    r = await owner.api(`/api/kb/${kbEntryId}`, { method: "DELETE" });
    ok("entrada de KB del guion borrada", r.res.ok, short(r));
  }
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
