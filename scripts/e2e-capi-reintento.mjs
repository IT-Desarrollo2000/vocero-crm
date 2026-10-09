/**
 * Self-test E2E — 016: reintento de conversiones y la venta sin monto.
 *
 * Complementa la sección de atribución de `scripts/e2e-selftest.mjs` (mismo
 * login, mismos mocks) con lo que aquel no cubre:
 *
 *  1. Una conversión FALLIDA (dataset "-fail" del wa-mock: Meta responde 200
 *     con events_received=0) se reintenta con Meta OK y queda ENVIADA, en la
 *     MISMA fila y con el MISMO event_id.
 *  2. Ganar un lead SIN monto deja la venta OMITIDA "sin monto" (no viaja a
 *     Meta); fijar el monto después la envía con `value`, misma fila.
 *  3. Una omitida por "no configurado" sale al reintentar tras conectar.
 *  4. Estados no reintentables (enviada, sin ctwa_clid) → 409; id ajeno → 404.
 *
 * Con ATRIBUCION apagada solo verifica que el endpoint de reintento no existe
 * (404) y sale con 0.
 *
 * Uso:
 *   1) app corriendo con WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL → wa-mock
 *      y BD migrada (NUNCA la de producción: ver memoria e2e-bd-aislada)
 *   2) node --env-file=.env.e2e scripts/e2e-capi-reintento.mjs
 */

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const PN = "PN-E2E-1";

let cookie = "";
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

async function api(path, opts = {}) {
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
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Actividad de conversiones (tope del panel: 50). */
async function activity() {
  return (await api("/api/settings/capi/events?limit=50")).json?.events ?? [];
}

/** Lo que el wa-mock recibió en `POST {dataset}/events`. */
async function capiEvents() {
  return (await api("/api/dev/wa-mock/capi-events")).json?.capiEvents ?? [];
}

const eventIdOf = (e) => e?.body?.data?.[0]?.event_id ?? null;

async function main() {
  const encendida = /^(on|1|true|si|sí|yes)$/i.test(
    (process.env.ATRIBUCION ?? "").trim()
  );

  console.log("== Setup: registro/login + conexión WhatsApp ==");
  const email = "e2e@vocero.test";
  const password = "password-e2e-123";
  let su = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password, name: "Operador E2E" }),
  });
  if (!su.res.ok) {
    // Re-corrida: el registro se cierra tras la primera organización.
    su = await api("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }
  ok("registro o login del operador", su.res.ok, JSON.stringify(su.json));

  if (!encendida) {
    console.log("\n== 016: reintento con la atribución apagada ==");
    const uno = await api("/api/settings/capi/events/cve_x/retry", {
      method: "POST",
    });
    ok(
      "POST /api/settings/capi/events/:id/retry → 404 con la atribución apagada",
      uno.res.status === 404,
      `status=${uno.res.status}`
    );
    const todas = await api("/api/settings/capi/events/retry", {
      method: "POST",
    });
    ok(
      "POST /api/settings/capi/events/retry → 404 con la atribución apagada",
      todas.res.status === 404,
      `status=${todas.res.status}`
    );
    console.log(
      "  AVISO: ATRIBUCION apagada — el resto de los checks de reintento no aplican."
    );
    return;
  }

  const conn = await api("/api/settings/whatsapp", {
    method: "PUT",
    body: JSON.stringify({
      wabaId: "WABA-E2E",
      phoneNumberId: PN,
      token: "tok-e2e",
    }),
  });
  ok("conexión WhatsApp guardada (vía wa-mock)", conn.res.ok, JSON.stringify(conn.json));

  // Sufijo por corrida: el dedup de conversiones es permanente, así que cada
  // corrida estrena leads.
  const SUF = String(Date.now()).slice(-6);
  const tel = (n) => `52166${SUF}${n}`;
  const nom = (base) => `${base} ${SUF}`;

  const board0 = (await api("/api/pipeline/board")).json;
  const etapaCalificado = board0.stages.filter((s) => s.kind === "open").at(-1);
  const etapaGanada = board0.stages.find((s) => s.kind === "won");

  async function connect(datasetId) {
    return api("/api/settings/capi", {
      method: "PUT",
      body: JSON.stringify({ datasetId, qualifiedStageId: etapaCalificado.id }),
    });
  }

  async function leadFromAd(n, nombre, clid) {
    await api("/api/dev/wa-mock/inbound", {
      method: "POST",
      body: JSON.stringify({
        phoneNumberId: PN,
        from: tel(n),
        name: nombre,
        text: clid ? "vengo del anuncio" : "hola",
        ...(clid ? { ctwaClid: clid } : {}),
        waMessageId: `wamid.e2e.016r.${SUF}.${n}`,
      }),
    });
    await sleep(1400);
    const board = (await api("/api/pipeline/board")).json;
    return board.leads.find((l) => l.contact.name === nombre);
  }

  await api("/api/dev/wa-mock/capi-events", { method: "DELETE" });

  /* ---------------- 1. failed → retry → sent ---------------- */

  console.log("\n== 016: reintentar una conversión fallida ==");
  const conectadoFail = await connect("ds-e2e-fail");
  ok("dataset que rechaza conectado", conectadoFail.res.ok, `status=${conectadoFail.res.status}`);

  const NOMBRE_FAIL = nom("Reintento fallido");
  const CLID_FAIL = `clid-retry-${SUF}`;
  const leadFail = await leadFromAd("1", NOMBRE_FAIL, CLID_FAIL);
  ok("el lead del anuncio existe", !!leadFail);
  await api(`/api/pipeline/leads/${leadFail?.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  await sleep(800);

  const fallido = (await activity()).find(
    (e) => e.contactName === NOMBRE_FAIL && e.eventName === "QualifiedLead"
  );
  ok(
    "la conversión queda FALLIDA y marcada como reintentable",
    fallido?.status === "failed" && fallido?.retryable === true,
    JSON.stringify(fallido)
  );

  await connect("ds-e2e");
  const retry1 = await api(`/api/settings/capi/events/${fallido?.id}/retry`, {
    method: "POST",
  });
  ok(
    "POST retry → 200 con outcome sent",
    retry1.res.ok && retry1.json?.outcome === "sent",
    `status=${retry1.res.status} ${JSON.stringify(retry1.json)}`
  );
  ok(
    "la respuesta trae la MISMA fila, ya enviada y no reintentable",
    retry1.json?.event?.id === fallido?.id &&
      retry1.json?.event?.status === "sent" &&
      retry1.json?.event?.retryable === false &&
      !!retry1.json?.event?.fbTraceId,
    JSON.stringify(retry1.json?.event)
  );

  const filasFail = (await activity()).filter(
    (e) => e.contactName === NOMBRE_FAIL && e.eventName === "QualifiedLead"
  );
  ok(
    "no se insertó una fila nueva",
    filasFail.length === 1 && filasFail[0]?.status === "sent",
    JSON.stringify(filasFail)
  );

  const viajesFail = (await capiEvents()).filter((e) => e.ctwaClid === CLID_FAIL);
  ok(
    "los dos intentos viajaron con el MISMO event_id (el id de la fila)",
    viajesFail.length === 2 &&
      viajesFail.every((e) => eventIdOf(e) === fallido?.id),
    JSON.stringify(viajesFail.map((e) => [e.datasetId, eventIdOf(e)]))
  );

  /* ---------------- 4. no reintentables ---------------- */

  console.log("\n== 016: lo que no se reintenta ==");
  const otraVez = await api(`/api/settings/capi/events/${fallido?.id}/retry`, {
    method: "POST",
  });
  ok(
    "reintentar una ENVIADA → 409 not_retryable",
    otraVez.res.status === 409 && otraVez.json?.error?.code === "not_retryable",
    `status=${otraVez.res.status} ${JSON.stringify(otraVez.json)}`
  );

  const ajena = await api("/api/settings/capi/events/cve_no_existe/retry", {
    method: "POST",
  });
  ok("un id inexistente → 404", ajena.res.status === 404, `status=${ajena.res.status}`);

  const NOMBRE_ORG = nom("Reintento organico");
  const leadOrg = await leadFromAd("2", NOMBRE_ORG, null);
  await api(`/api/pipeline/leads/${leadOrg?.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  await sleep(800);
  const omitidoOrg = (await activity()).find((e) => e.contactName === NOMBRE_ORG);
  ok(
    "sin ctwa_clid queda omitida y NO se ofrece reintentar",
    omitidoOrg?.status === "skipped" && omitidoOrg?.retryable === false,
    JSON.stringify(omitidoOrg)
  );
  const retryOrg = await api(`/api/settings/capi/events/${omitidoOrg?.id}/retry`, {
    method: "POST",
  });
  ok(
    "reintentar una omitida sin ctwa_clid → 409",
    retryOrg.res.status === 409,
    `status=${retryOrg.res.status}`
  );

  /* ---------------- 2. ganado sin monto → monto después ---------------- */

  console.log("\n== 016: la venta que espera su monto ==");
  const NOMBRE_SM = nom("Venta sin monto");
  const CLID_SM = `clid-sinmonto-${SUF}`;
  const leadSm = await leadFromAd("3", NOMBRE_SM, CLID_SM);
  const ganar = await api(`/api/pipeline/leads/${leadSm?.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaGanada.id }),
  });
  ok("el trato se gana sin monto", ganar.res.ok, `status=${ganar.res.status}`);
  await sleep(800);

  const retenida = (await activity()).find(
    (e) => e.contactName === NOMBRE_SM && e.eventName === "Purchase"
  );
  ok(
    "la venta queda OMITIDA 'sin monto'",
    retenida?.status === "skipped" && /sin monto/.test(retenida?.error ?? ""),
    JSON.stringify(retenida)
  );
  ok(
    "y NO viajó a Meta",
    !(await capiEvents()).some(
      (e) => e.ctwaClid === CLID_SM && e.eventName === "Purchase"
    )
  );

  const monto = await api(`/api/pipeline/leads/${leadSm?.id}`, {
    method: "PATCH",
    body: JSON.stringify({ amountCents: 45050, currency: "MXN" }),
  });
  ok("fijar el monto responde OK", monto.res.ok, `status=${monto.res.status}`);
  await sleep(800);

  const comprasSm = (await activity()).filter(
    (e) => e.contactName === NOMBRE_SM && e.eventName === "Purchase"
  );
  ok(
    "la MISMA fila pasa a enviada (sin fila nueva)",
    comprasSm.length === 1 &&
      comprasSm[0]?.id === retenida?.id &&
      comprasSm[0]?.status === "sent",
    JSON.stringify(comprasSm)
  );
  const viajeSm = (await capiEvents()).find(
    (e) => e.ctwaClid === CLID_SM && e.eventName === "Purchase"
  );
  ok(
    "la venta viajó con value en unidades y el event_id de la fila",
    viajeSm?.customData?.value === 450.5 &&
      viajeSm?.customData?.currency === "MXN" &&
      eventIdOf(viajeSm) === retenida?.id,
    JSON.stringify({ customData: viajeSm?.customData, eventId: eventIdOf(viajeSm) })
  );

  /* ---------------- 3. no configurado → conectar → reintentar ---------------- */

  console.log("\n== 016: omitida por no configurado, luego conectada ==");
  await api("/api/settings/capi", { method: "DELETE" });
  const NOMBRE_NC = nom("Venta sin configurar");
  const CLID_NC = `clid-noconf-${SUF}`;
  const leadNc = await leadFromAd("4", NOMBRE_NC, CLID_NC);
  await api(`/api/pipeline/leads/${leadNc?.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      stageId: etapaGanada.id,
      amountCents: 12300,
      currency: "MXN",
    }),
  });
  await sleep(800);
  const noConf = (await activity()).find(
    (e) => e.contactName === NOMBRE_NC && e.eventName === "Purchase"
  );
  ok(
    "sin dataset la venta queda omitida y reintentable",
    noConf?.status === "skipped" &&
      /no configurada/.test(noConf?.error ?? "") &&
      noConf?.retryable === true,
    JSON.stringify(noConf)
  );

  await connect("ds-e2e");
  const todas = await api("/api/settings/capi/events/retry", { method: "POST" });
  ok(
    "POST retry (todas) responde con el conteo",
    todas.res.ok && typeof todas.json?.attempted === "number" && todas.json.sent >= 1,
    `status=${todas.res.status} ${JSON.stringify(todas.json)}`
  );
  const noConf2 = (await activity()).find((e) => e.id === noConf?.id);
  ok(
    "tras conectar y reintentar, la venta quedó enviada",
    noConf2?.status === "sent",
    JSON.stringify(noConf2)
  );
  const viajeNc = (await capiEvents()).find((e) => e.ctwaClid === CLID_NC);
  ok(
    "con su valor y el event_id de la fila",
    viajeNc?.customData?.value === 123 && eventIdOf(viajeNc) === noConf?.id,
    JSON.stringify({ customData: viajeNc?.customData, eventId: eventIdOf(viajeNc) })
  );

  // Se deja desconectado, como lo deja el arnés principal.
  await api("/api/settings/capi", { method: "DELETE" });
}

main()
  .then(() => {
    console.log(`\n${checks - failures}/${checks} checks OK`);
    process.exit(failures > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error("ERROR FATAL:", err);
    process.exit(1);
  });
