/**
 * Self-test E2E — nota libre del handoff (`conversation.handoff_note`).
 *
 * Antes, el porqué concreto de un escalamiento se perdía: el agente explicaba
 * su `reason` y quedaba solo "modelo". Este guion comprueba, por la API real:
 *   1) /api/bot/handoff con `note` → GET /api/conversations trae `handoffNote`
 *   2) la nota se recorta (no se rechaza) si es larga
 *   3) un `reason` fuera del catálogo y sin `note` se conserva como nota
 *   4) reactivar desde el CRM (PATCH reactivate) y /api/bot/reset la limpian
 *
 * Uso:
 *   1) app corriendo con WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL → wa-mock,
 *      BOT_API_KEY configurada y BD migrada (0012 incluida)
 *   2) node --env-file=.env.e2e scripts/e2e-handoff-nota.mjs
 *
 * Sale con código 1 si algún check falla.
 */

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const BOT_KEY = process.env.BOT_API_KEY;

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

function bot(path, opts = {}) {
  return api(path, {
    ...opts,
    headers: { "x-api-key": BOT_KEY ?? "", ...(opts.headers ?? {}) },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PN = "PN-E2E-NOTA";
const S = Math.random().toString(36).slice(2, 8);

async function findConv(id) {
  const convs = (await api("/api/conversations")).json?.conversations ?? [];
  return convs.find((c) => c.id === id);
}

async function reset(convId) {
  const r = await bot("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  await sleep(300);
  return r;
}

async function handoff(body) {
  const r = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify(body),
  });
  await sleep(300);
  return r;
}

async function main() {
  if (!BOT_KEY || BOT_KEY.length < 16) {
    console.error(
      "BOT_API_KEY ausente o corta (<16): los checks de /api/bot/* no pueden correr."
    );
    process.exit(1);
  }

  console.log("== Setup: login + conexión WhatsApp + conversación ==");
  const email = "e2e@vocero.test";
  const password = "password-e2e-123";
  let su = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password, name: "Operador E2E" }),
  });
  if (!su.res.ok) {
    su = await api("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }
  ok("registro o login del operador", su.res.ok, JSON.stringify(su.json));

  const conn = await api("/api/settings/whatsapp", {
    method: "PUT",
    body: JSON.stringify({
      wabaId: "WABA-E2E-NOTA",
      phoneNumberId: PN,
      token: "tok-e2e-nota",
    }),
  });
  ok("conexión WhatsApp guardada (vía wa-mock)", conn.res.ok, JSON.stringify(conn.json));

  const name = `Nota${S} Handoff`;
  const inb = await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      fromUserId: `bsu_nota_${S}`,
      name,
      text: "hola, quiero informes",
      waMessageId: `wamid.e2e.nota.${S}`,
    }),
  });
  ok("inbound entregado", inb.res.ok, JSON.stringify(inb.json));
  await sleep(1200);

  const convs = (await api("/api/conversations")).json?.conversations ?? [];
  const convId = convs.find((c) => c.contact.name === name)?.id;
  ok("conversación creada", !!convId);
  if (!convId) return;

  // El handoff solo escribe en la transición: partir de un estado limpio
  // (el agente in-process pudo haber escalado ya al recibir el inbound).
  await reset(convId);

  console.log("\n== handoff con nota ==");
  const NOTA = `Pide factura a nombre de otra empresa (${S})`;
  const ho = await handoff({ conversationId: convId, reason: "cliente", note: NOTA });
  let conv = await findConv(convId);
  ok(
    "POST /api/bot/handoff con note → 200 y el DTO trae handoffNote",
    ho.res.ok &&
      conv?.handoffReason === "cliente" &&
      conv?.handoffNote === NOTA &&
      conv?.aiEnabled === false,
    JSON.stringify({ status: ho.res.status, reason: conv?.handoffReason, note: conv?.handoffNote })
  );

  console.log("\n== reactivar desde el CRM limpia la nota ==");
  const react = await api(`/api/conversations/${convId}`, {
    method: "PATCH",
    body: JSON.stringify({ reactivate: true }),
  });
  await sleep(300);
  conv = await findConv(convId);
  ok(
    "PATCH reactivate → handoffAt/handoffReason/handoffNote en null",
    react.res.ok &&
      conv?.aiEnabled === true &&
      conv?.handoffAt === null &&
      conv?.handoffReason === null &&
      conv?.handoffNote === null,
    JSON.stringify({ handoffAt: conv?.handoffAt, reason: conv?.handoffReason, note: conv?.handoffNote })
  );

  console.log("\n== nota larga: se recorta, no se rechaza ==");
  await reset(convId);
  const larga = await handoff({ conversationId: convId, reason: "hostilidad", note: "x".repeat(2000) });
  conv = await findConv(convId);
  ok(
    "nota de 2000 chars → 200 y queda en 500",
    larga.res.ok &&
      conv?.handoffReason === "hostilidad" &&
      typeof conv?.handoffNote === "string" &&
      conv.handoffNote.length === 500,
    JSON.stringify({ status: larga.res.status, len: conv?.handoffNote?.length })
  );

  console.log("\n== motivo fuera del catálogo sin nota → se conserva como nota ==");
  await reset(convId);
  const raro = await handoff({ conversationId: convId, reason: "porque se enojó" });
  conv = await findConv(convId);
  ok(
    "reason libre → handoffReason 'modelo' + handoffNote con el texto crudo",
    raro.res.ok && conv?.handoffReason === "modelo" && conv?.handoffNote === "porque se enojó",
    JSON.stringify({ reason: conv?.handoffReason, note: conv?.handoffNote })
  );

  console.log("\n== motivo del catálogo sin nota → sin nota ==");
  await reset(convId);
  const sinNota = await handoff({ conversationId: convId, reason: "hostilidad" });
  conv = await findConv(convId);
  ok(
    "reason del catálogo sin note → handoffNote null",
    sinNota.res.ok && conv?.handoffReason === "hostilidad" && conv?.handoffNote === null,
    JSON.stringify({ reason: conv?.handoffReason, note: conv?.handoffNote })
  );

  console.log("\n== /api/bot/reset también limpia la nota ==");
  await handoff({ conversationId: convId }); // ya hay handoff: no-op idempotente
  await reset(convId);
  await handoff({ conversationId: convId, note: "nota para el reset" });
  await reset(convId);
  conv = await findConv(convId);
  ok(
    "tras /api/bot/reset → handoffNote null",
    conv?.handoffNote === null && conv?.handoffReason === null,
    JSON.stringify({ reason: conv?.handoffReason, note: conv?.handoffNote })
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
