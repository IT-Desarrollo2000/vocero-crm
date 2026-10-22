/**
 * Self-test E2E — paginación de la Bandeja (dev-tasks/06, servidor 06-A).
 * Guion humano: tests/e2e/us-bandeja-paginacion.md
 *
 * Conduce la API real con dos cookie jars (Propietario + un Vendedor dado de
 * alta por POST /api/settings/team) y el wa-mock:
 *   a) owner entra, conecta WhatsApp (wa-mock) y da de alta al vendedor
 *   b) siembra 130 conversaciones (entrantes con waMessageId únicos; 5 con
 *      acentos "José Ñandú") y espera a que la lista se quede quieta
 *   c) recorre `limit=50` siguiendo `nextCursor` hasta null → sin duplicados
 *      ni huecos, orden (sortAt, id) DESC y total = counts.all
 *   d) entre la página 1 y la 2 entra un mensaje en una conversación de la
 *      página 3 → no aparece duplicada; solo ella puede faltar (subió al tope)
 *   e) filtros: unread / human / stage / channel / q (acentos y teléfono con
 *      formato) — cada recorrido coincide con su contador y cada fila cumple
 *   f) vendedor: `?ids=` con una del owner → ausente; GET /:id → 404; no
 *      aparece en su recorrido ni en sus contadores; `filter=mine`
 *   g) `?contact=` (deep link), GET /:id ajeno/inexistente → 404,
 *      `assigned=todas` → 422 (lista y counts), cursor basura → 1.ª página,
 *      `limit=0` → 1 fila, sin `limit` → lista completa (compat, D-06-1)
 *   h) UI (Playwright, cookie del owner): `/inbox?contact=` de una
 *      conversación fuera de la 1.ª página → seleccionada, a la vista y con
 *      su hilo abierto (CA-06-05)
 *   i) UI en vivo (Playwright): un entrante pide solo `?ids=` + `/counts`
 *      (nunca la lista completa); scroll infinito hasta «No hay más
 *      conversaciones» sin ids repetidos en el DOM; alt-tab simulado
 *      (`visibilitychange`) y corte de red (`setOffline`) + reconexión NO
 *      pierden lo cargado ni la posición; la página 2 que falla
 *      (`page.route`) se recupera con «Reintentar»
 *
 * Presupuesto del limitador de login: 2 POST a /sign-in|sign-up (owner, vendedor).
 * La BD de E2E NO se limpia entre guiones: todo se compara contra los
 * contadores del mismo actor o contra el conjunto sembrado (sufijo `S`).
 *
 * Uso:
 *   1) BD migrada (0016 incluida) y app corriendo con WA_MOCK_ENABLED=true y
 *      META_GRAPH_BASE_URL → wa-mock (p. ej. .env.e2e, BD aislada en :5433)
 *   2) node --env-file=.env.e2e scripts/e2e-bandeja-paginacion.mjs
 *
 * Sale con código 1 si algún check falla.
 */

import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
// Solo letras: con ≥ 3 dígitos, `q=S` también buscaría por teléfono y
// arrastraría contactos de otras corridas (la BD de E2E no se limpia).
const S = Array.from({ length: 6 }, () =>
  String.fromCharCode(97 + Math.floor(Math.random() * 26))
).join("");
const RUN = String(Math.floor(10000 + Math.random() * 89999));
const PN = "PN-E2E-PAG";
const SEED = 130;
const ACCENTED = 5;
const PAGE = 50;

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
const short = (r) => `${r.res.status} ${JSON.stringify(r.json)?.slice(0, 200)}`;

const owner = client();
const seller = client();

const OWNER_EMAIL = "e2e@vocero.test";
const OWNER_PASSWORD = "password-e2e-123";
const SELLER_EMAIL = `vend.pag.${S}@vocero.test`;
const SELLER_PASSWORD = "password-vend-123";

function signIn(c, email, password) {
  return c.api("/api/auth/sign-in/email", {
    method: "POST",
    body: body({ email, password }),
  });
}

/** 13 dígitos únicos por corrida: 52155 + RUN (5) + índice (3). */
const phoneOf = (i) => `52155${RUN}${String(i).padStart(3, "0")}`;
const nameOf = (i) => (i < ACCENTED ? `José Ñandú ${S} ${i}` : `Pag ${S} ${i}`);

function inbound(i, text = "hola, quiero informes") {
  return owner.api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({
      phoneNumberId: PN,
      from: phoneOf(i),
      name: nameOf(i),
      text,
      waMessageId: `wamid.e2e.pag.${S}.${i}.${Math.random().toString(36).slice(2, 10)}`,
    }),
  });
}

const qs = (params) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
};

async function counts(c, params = {}) {
  const r = await c.api(`/api/conversations/counts${qs(params)}`);
  return r.res.ok ? r.json : null;
}

/**
 * Recorre la lista con `limit` siguiendo `nextCursor` hasta null.
 * `between(pageNo)` corre tras cada página (para perturbar el orden).
 */
async function traverse(c, params = {}, { limit = PAGE, between } = {}) {
  const rows = [];
  const pages = [];
  let cursor;
  for (let n = 1; n <= 200; n++) {
    const r = await c.api(`/api/conversations${qs({ ...params, limit, cursor })}`);
    if (!r.res.ok) return { rows, pages, error: short(r) };
    const page = r.json?.conversations ?? [];
    pages.push(page.length);
    rows.push(...page);
    cursor = r.json?.nextCursor ?? undefined;
    if (!cursor) return { rows, pages, error: null };
    if (between) await between(n);
  }
  return { rows, pages, error: "más de 200 páginas" };
}

const ids = (rows) => rows.map((r) => r.id);
const dupes = (list) => list.filter((id, i) => list.indexOf(id) !== i);

/** ¿Orden (sortAt, id) DESC? (sortAt es ISO en ms: empates por id desc). */
function sortedDesc(rows) {
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (a.sortAt < b.sortAt) return false;
    if (a.sortAt === b.sortAt && a.id < b.id) return false;
  }
  return true;
}

/**
 * El agente puede responder (ai-mock) y mover sort_at de las sembradas: un
 * recorrido en marcha vería saltar filas. Espera a que la lista de `q=S`
 * se quede quieta 3 s.
 */
async function waitQuiet() {
  let lastSig = "";
  let stableSince = Date.now();
  await until(async () => {
    const all = (await owner.api(`/api/conversations${qs({ q: S })}`)).json?.conversations ?? [];
    const sig = all.map((c) => `${c.id}:${c.sortAt}`).join("|");
    if (sig !== lastSig) {
      lastSig = sig;
      stableSince = Date.now();
    }
    return Date.now() - stableSince > 3000;
  }, 90000);
}

async function main() {
  console.log("== a) Owner, WhatsApp y alta del vendedor ==");
  let su = await owner.api("/api/auth/sign-up/email", {
    method: "POST",
    body: body({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: "Operador E2E" }),
  });
  if (!su.res.ok) su = await signIn(owner, OWNER_EMAIL, OWNER_PASSWORD);
  ok("owner registrado o con sesión", su.res.ok, short(su));
  const conn = await owner.api("/api/settings/whatsapp", {
    method: "PUT",
    body: body({ wabaId: "WABA-E2E-PAG", phoneNumberId: PN, token: "tok-e2e-pag" }),
  });
  ok("owner conecta WhatsApp (wa-mock)", conn.res.ok, short(conn));
  const alta = await owner.api("/api/settings/team", {
    method: "POST",
    body: body({ name: `Vendedor Pag ${S}`, email: SELLER_EMAIL, password: SELLER_PASSWORD }),
  });
  ok("alta del vendedor → 201", alta.res.status === 201, short(alta));
  const team = (await owner.api("/api/settings/team")).json?.members ?? [];
  const sellerUserId = team.find((m) => m.email === SELLER_EMAIL)?.userId;
  const ownerUserId = team.find((m) => m.email === OWNER_EMAIL)?.userId;
  ok("userId del vendedor y del owner", !!sellerUserId && !!ownerUserId);
  ok("el vendedor inicia sesión", (await signIn(seller, SELLER_EMAIL, SELLER_PASSWORD)).res.ok);

  const c0 = await counts(owner);
  ok("GET /api/conversations/counts → 200 con la forma del contrato",
    !!c0 && typeof c0.all === "number" && typeof c0.byChannel?.whatsapp === "number" &&
      typeof c0.unreadConversations === "number" && typeof c0.teamMode === "boolean",
    JSON.stringify(c0));
  const baseline = c0?.all ?? 0;

  console.log(`\n== b) Siembra ${SEED} conversaciones (sufijo ${S}) ==`);
  let delivered = 0;
  for (let i = 0; i < SEED; i += 10) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(10, SEED - i) }, (_, k) => inbound(i + k))
    );
    delivered += batch.filter((r) => r.res.ok).length;
  }
  ok(`${SEED} entrantes entregados`, delivered === SEED, `${delivered}`);
  const mineQ = { q: S };
  ok("counts(q=S).all llega a 130", await until(async () => (await counts(owner, mineQ))?.all === SEED, 60000),
    JSON.stringify(await counts(owner, mineQ)));
  ok("counts.all creció en ≥ 130", ((await counts(owner))?.all ?? 0) >= baseline + SEED);

  await waitQuiet();

  const seededAll = (await owner.api(`/api/conversations${qs({ q: S })}`)).json?.conversations ?? [];
  const seededIds = new Set(ids(seededAll));
  ok("la lista completa (sin limit) trae las 130 sembradas", seededIds.size === SEED, `${seededIds.size}`);
  const byIndex = (i) => seededAll.find((c) => c.contact?.name === nameOf(i));

  console.log("\n== c) Recorrido completo con limit=50 ==");
  const t1 = await traverse(owner);
  const cAll = await counts(owner);
  ok("recorrido sin error", !t1.error, t1.error ?? "");
  ok("ningún id duplicado entre páginas", dupes(ids(t1.rows)).length === 0, dupes(ids(t1.rows)).join());
  ok("total recorrido = counts.all", t1.rows.length === cAll?.all, `${t1.rows.length} vs ${cAll?.all}`);
  ok("páginas de 50 salvo la última", t1.pages.slice(0, -1).every((n) => n === PAGE) && (t1.pages.at(-1) ?? 0) <= PAGE,
    t1.pages.join(","));
  ok("orden (sortAt, id) DESC", sortedDesc(t1.rows));
  ok("las 130 sembradas están en el recorrido", [...seededIds].every((id) => t1.rows.some((r) => r.id === id)));
  ok("cada fila trae sortAt y stageId (clave presente)", t1.rows.every((r) => typeof r.sortAt === "string" && "stageId" in r));
  ok("badge: unreadConversations = counts.unread sin filtros", cAll?.unreadConversations === cAll?.unread,
    `${cAll?.unreadConversations} vs ${cAll?.unread}`);

  console.log("\n== d) Un mensaje en la página 3 entre la página 1 y la 2 ==");
  const order = ids(t1.rows);
  const page3Seeded = order.slice(2 * PAGE, 3 * PAGE).filter((id) => seededIds.has(id));
  const target = page3Seeded[0];
  ok("hay una sembrada en la página 3", !!target, order.length.toString());
  if (target) {
    const targetRow = seededAll.find((c) => c.id === target);
    const targetIndex = Number(targetRow?.contact?.name?.split(" ").at(-1));
    const t2 = await traverse(owner, {}, {
      between: async (n) => {
        if (n !== 1) return;
        await inbound(targetIndex, `mensaje nuevo ${S}`);
        await until(async () => {
          const r = (await owner.api(`/api/conversations?ids=${target}`)).json?.conversations ?? [];
          return r[0]?.sortAt && r[0].sortAt !== targetRow?.sortAt;
        });
      },
    });
    const seen = ids(t2.rows);
    ok("recorrido perturbado sin error", !t2.error, t2.error ?? "");
    ok("ninguna duplicada (tampoco la que subió)", dupes(seen).length === 0, dupes(seen).join());
    const missing = order.filter((id) => !seen.includes(id));
    ok("solo puede faltar la que subió al tope", missing.every((id) => id === target), missing.join());
    const first = (await owner.api(`/api/conversations?limit=1`)).json?.conversations ?? [];
    ok("la conversación del mensaje nuevo queda al tope", first[0]?.id === target, first[0]?.id);
  }

  await waitQuiet(); // la respuesta del agente al mensaje nuevo de d)

  console.log("\n== e) Filtros con contadores coherentes ==");
  // unread: marca 3 como leídas.
  const readIds = [byIndex(10)?.id, byIndex(11)?.id, byIndex(12)?.id].filter(Boolean);
  for (const id of readIds) {
    await owner.api(`/api/conversations/${id}`, { method: "PATCH", body: body({ markRead: true }) });
  }
  const tu = await traverse(owner, { filter: "unread", q: S });
  const cu = await counts(owner, { q: S });
  ok("filter=unread: recorrido = counts.unread", tu.rows.length === cu?.unread, `${tu.rows.length} vs ${cu?.unread}`);
  ok("filter=unread: toda fila con unreadCount > 0", tu.rows.every((r) => r.unreadCount > 0));
  ok("filter=unread: las marcadas leídas no vienen", readIds.every((id) => !tu.rows.some((r) => r.id === id)));
  ok("filter=unread: sin duplicados", dupes(ids(tu.rows)).length === 0);

  // human: IA pausada a mano en 3 y (026) el cliente vuelve a escribir: "Por
  // atender" = en manos de una persona Y esperando respuesta.
  const humanIdx = [20, 21, 22];
  const humanIds = humanIdx.map((i) => byIndex(i)?.id).filter(Boolean);
  for (const id of humanIds) {
    await owner.api(`/api/conversations/${id}`, { method: "PATCH", body: body({ aiEnabled: false }) });
  }
  for (const i of humanIdx) await inbound(i, `sigo esperando ${S}`);
  await waitQuiet();
  const th = await traverse(owner, { filter: "human", q: S }, { limit: 2 });
  const ch = await counts(owner, { q: S });
  ok("filter=human: recorrido (limit=2) = counts.human", th.rows.length === ch?.human, `${th.rows.length} vs ${ch?.human}`);
  ok("filter=human: incluye las 3 con IA pausada y cliente esperando", humanIds.every((id) => th.rows.some((r) => r.id === id)));
  ok("filter=human: toda fila con handoff o IA apagada", th.rows.every((r) => r.handoffAt !== null || r.aiEnabled === false));
  ok("filter=human (026): toda fila esperando respuesta", th.rows.every((r) => r.awaitingSince != null));

  // stage: mueve 4 leads a otra etapa abierta.
  const board = (await owner.api("/api/pipeline/board")).json;
  const stageNames = [30, 31, 32, 33].map(nameOf);
  const leads = (board?.leads ?? []).filter((l) => stageNames.includes(l.contact?.name));
  const target2 = (board?.stages ?? []).find((s) => s.kind === "open" && !leads.some((l) => l.stageId === s.id));
  ok("hay 4 leads sembrados y una etapa abierta destino", leads.length === 4 && !!target2,
    `${leads.length} ${target2?.id}`);
  if (target2) {
    for (const l of leads) {
      await owner.api(`/api/pipeline/leads/${l.id}`, {
        method: "PATCH",
        body: body({ stageId: target2.id, position: 0 }),
      });
    }
    const ts = await traverse(owner, { stage: target2.id, q: S });
    const cs = await counts(owner, { stage: target2.id, q: S });
    ok("stage: exactamente las 4 movidas", ts.rows.length === 4 && ts.rows.every((r) => stageNames.includes(r.contact?.name)),
      ts.rows.map((r) => r.contact?.name).join());
    ok("stage: stageId del DTO = la etapa", ts.rows.every((r) => r.stageId === target2.id && r.stageName === target2.name));
    ok("stage: counts.all = 4", cs?.all === 4, JSON.stringify(cs));
  }
  const tNoStage = await owner.api(`/api/conversations${qs({ stage: "stg_inexistente", limit: 50 })}`);
  ok("stage inexistente → 200 lista vacía", tNoStage.res.ok && (tNoStage.json?.conversations ?? []).length === 0, short(tNoStage));

  // channel.
  const twa = await traverse(owner, { channel: "whatsapp", q: S });
  const cwa = await counts(owner, { channel: "whatsapp", q: S });
  ok("channel=whatsapp: las 130", twa.rows.length === SEED && twa.rows.every((r) => r.channel === "whatsapp"), `${twa.rows.length}`);
  ok("channel=whatsapp: counts.all = byChannel.whatsapp = 130", cwa?.all === SEED && cwa?.byChannel?.whatsapp === SEED,
    JSON.stringify(cwa));
  const tig = await traverse(owner, { channel: "instagram", q: S });
  const cig = await counts(owner, { channel: "instagram", q: S });
  ok("channel=instagram: 0 filas y counts.all = 0", tig.rows.length === 0 && cig?.all === 0);
  ok("byChannel ignora el channel pedido", cig?.byChannel?.whatsapp === SEED, JSON.stringify(cig?.byChannel));
  ok("channel inválido → ignorado (todas)", ((await counts(owner, { channel: "fax", q: S }))?.all ?? -1) === SEED);

  // 020: filtros combinables (origen, sin asignar, por cerrar) y vista en /counts.
  const tad = await traverse(owner, { origin: "ad", q: S });
  const tnone = await traverse(owner, { origin: "none", q: S });
  const corg = await counts(owner, { q: S });
  ok("origin=ad ∪ origin=none particionan la lista (ninguna sembrada vino de anuncio)",
    tad.rows.length === 0 && tnone.rows.length === SEED, `${tad.rows.length} + ${tnone.rows.length}`);
  ok("counts.origin cuadra con los recorridos", corg?.origin?.ad === 0 && corg?.origin?.none === SEED,
    JSON.stringify(corg?.origin));
  const cUnreadOrigin = await counts(owner, { filter: "unread", q: S });
  ok("counts con vista: origin.none = counts.unread (facetado dentro de la vista)",
    cUnreadOrigin?.origin?.none === cUnreadOrigin?.unread, JSON.stringify(cUnreadOrigin));
  const tLegacy = await traverse(owner, { filter: "unassigned", q: S });
  const tNuevo = await traverse(owner, { unassigned: 1, q: S });
  ok("compat: filter=unassigned (viejo) ≡ unassigned=1 (nuevo)",
    tLegacy.rows.length === tNuevo.rows.length && tNuevo.rows.every((r) => r.assignedTo === null),
    `${tLegacy.rows.length} vs ${tNuevo.rows.length}`);
  const tOriginBad = await traverse(owner, { origin: "tele", q: S });
  ok("origin inválido → ignorado (todas)", tOriginBad.rows.length === SEED, `${tOriginBad.rows.length}`);

  // q: acentos y teléfono con formato.
  const tq = await traverse(owner, { q: `jose nandu ${S}` });
  const cq = await counts(owner, { q: `JOSÉ ÑANDÚ ${S}` });
  ok(`q sin acentos encuentra las ${ACCENTED} "José Ñandú"`, tq.rows.length === ACCENTED &&
    tq.rows.every((r) => r.contact?.name?.startsWith("José Ñandú")), tq.rows.map((r) => r.contact?.name).join());
  ok("counts con q acentuada coincide", cq?.all === ACCENTED, JSON.stringify(cq));
  const phoneConv = byIndex(40);
  const digits = String(phoneConv?.contact?.phone ?? "").replace(/\D/g, "");
  const pretty = `+${digits.slice(0, 2)} ${digits.slice(2, 5)}-${digits.slice(5, 9)} ${digits.slice(9)}`;
  const tp = await owner.api(`/api/conversations${qs({ q: pretty, limit: 50 })}`);
  ok(`q por teléfono con formato (${pretty}) la encuentra`, (tp.json?.conversations ?? []).some((r) => r.id === phoneConv?.id),
    short(tp));
  const tpct = await owner.api(`/api/conversations${qs({ q: "%", limit: 50 })}`);
  ok("q = \"%\" no lista todo (comodín escapado)", tpct.res.ok && !(tpct.json?.conversations ?? []).some((r) => seededIds.has(r.id)));

  await waitQuiet();

  console.log("\n== f) Vendedor: visibilidad en lista, ids, detalle y contadores ==");
  const ownersConv = byIndex(50);
  const sellersConv = byIndex(51);
  const freeConv = byIndex(52);
  let r = await owner.api(`/api/conversations/${ownersConv?.id}/assign`, {
    method: "POST",
    body: body({ userId: ownerUserId }),
  });
  ok("owner se asigna una conversación", r.res.ok, short(r));
  r = await owner.api(`/api/conversations/${sellersConv?.id}/assign`, {
    method: "POST",
    body: body({ userId: sellerUserId }),
  });
  ok("owner asigna otra al vendedor", r.res.ok, short(r));
  r = await seller.api(`/api/conversations?ids=${ownersConv?.id},${freeConv?.id},cv_no_existe`);
  const lote = ids(r.json?.conversations ?? []);
  ok("?ids=: la del owner y la inexistente AUSENTES, la libre presente",
    lote.length === 1 && lote[0] === freeConv?.id, lote.join());
  ok("?ids=: nextCursor null", r.json?.nextCursor === null);
  r = await seller.api(`/api/conversations/${ownersConv?.id}`);
  ok("vendedor: GET /:id de la del owner → 404", r.res.status === 404, short(r));
  r = await seller.api(`/api/conversations/${sellersConv?.id}`);
  ok("vendedor: GET /:id de la suya → 200", r.res.ok && r.json?.conversation?.id === sellersConv?.id, short(r));
  r = await owner.api(`/api/conversations/${ownersConv?.id}`);
  ok("owner: GET /:id → 200 con preview y stageId", r.res.ok && r.json?.conversation?.preview !== undefined &&
    "stageId" in (r.json?.conversation ?? {}), short(r));
  const tsel = await traverse(seller, { q: S });
  const csel = await counts(seller, { q: S });
  ok("vendedor: recorrido = counts.all y sin la del owner",
    tsel.rows.length === csel?.all && !tsel.rows.some((x) => x.id === ownersConv?.id), `${tsel.rows.length} vs ${csel?.all}`);
  ok("vendedor: ve SEED - 1 de las sembradas", csel?.all === SEED - 1, JSON.stringify(csel));
  ok("vendedor: teamMode = true", csel?.teamMode === true);
  const tmine = await traverse(seller, { filter: "mine", q: S });
  ok("vendedor: filter=mine = counts.mine = 1 (la suya)",
    tmine.rows.length === 1 && tmine.rows[0]?.id === sellersConv?.id && csel?.mine === 1, JSON.stringify(ids(tmine.rows)));
  const tAssignedMe = await traverse(seller, { assigned: "me", filter: "unassigned", q: S });
  ok("assigned=me ∧ filter=unassigned se intersectan → vacío", tAssignedMe.rows.length === 0);
  const cAssigned = await counts(seller, { assigned: "me", q: S });
  ok("counts con assigned=me: all = 1", cAssigned?.all === 1, JSON.stringify(cAssigned));
  const ownerCounts = await counts(owner, { q: S });
  ok("owner: teamMode = true (hay miembros/asignadas)", ownerCounts?.teamMode === true);

  // 020 (D4): la tarjeta del anuncio —con su miniatura— la ven todos los
  // roles, pero la miniatura no cuelga de ningún mensaje: /api/media la sirve
  // al vendedor solo si VE una conversación que llegó por ese anuncio.
  const adLead = async (n, tag) => {
    const name = `Anuncio vend ${RUN} ${tag}`;
    await owner.api("/api/dev/wa-mock/inbound", {
      method: "POST",
      body: body({
        phoneNumberId: PN,
        from: `52166${RUN}9${n}`,
        name,
        text: "vengo del anuncio",
        adHeadline: `Promo ${tag} ${RUN}`,
        adSourceId: `1207${RUN}${n}`,
        adThumbnailUrl: `${BASE}/api/dev/wa-mock/cdn/anuncio-${RUN}-${n}.jpg`,
        waMessageId: `wamid.e2e.pag.${S}.ad.${n}`,
      }),
    });
    let conv = null;
    let det = null;
    await until(async () => {
      conv = (await owner.api(`/api/conversations${qs({ q: name })}`)).json?.conversations?.[0];
      if (!conv) return false;
      det = (await owner.api(`/api/contacts/${conv.contact.id}`)).json;
      return !!det?.anuncio?.imageUrl;
    }, 20000);
    return { conv, imageUrl: det?.anuncio?.imageUrl ?? null };
  };
  const libre = await adLead(1, "libre");
  const delOwner = await adLead(2, "owner");
  ok("(setup) dos leads de anuncio con miniatura copiada", !!libre.imageUrl && !!delOwner.imageUrl &&
    libre.imageUrl !== delOwner.imageUrl, `${libre.imageUrl} ${delOwner.imageUrl}`);
  r = await owner.api(`/api/conversations/${delOwner.conv?.id}/assign`, {
    method: "POST",
    body: body({ userId: ownerUserId }),
  });
  ok("(setup) el owner se queda una de las de anuncio", r.res.ok, short(r));
  const detVend = (await seller.api(`/api/contacts/${libre.conv?.contact?.id}`)).json;
  ok("vendedor: la tarjeta del anuncio le llega (D4)",
    detVend?.anuncio?.headline === `Promo libre ${RUN}` && detVend?.anuncio?.imageUrl === libre.imageUrl,
    JSON.stringify(detVend?.anuncio));
  const miniVend = await seller.api(libre.imageUrl ?? "/api/media/x");
  ok("vendedor: ve la miniatura de una conversación que ve", miniVend.res.status === 200, `status=${miniVend.res.status}`);
  const miniAjena = await seller.api(delOwner.imageUrl ?? "/api/media/x");
  ok("vendedor: la miniatura de una conversación ajena → 404", miniAjena.res.status === 404,
    `status=${miniAjena.res.status}`);

  console.log("\n== g) Deep link, 404, 422, cursor basura, limit=0 y compat ==");
  const old = byIndex(0);
  r = await owner.api(`/api/conversations?contact=${old?.contact?.id}`);
  ok("?contact=: devuelve esa conversación (0 o 1 fila)",
    (r.json?.conversations ?? []).length === 1 && r.json.conversations[0].id === old?.id, short(r));
  r = await owner.api(`/api/conversations?contact=ct_no_existe`);
  ok("?contact= inexistente → lista vacía", r.res.ok && (r.json?.conversations ?? []).length === 0);
  r = await owner.api(`/api/conversations/cv_no_existe_${S}`);
  ok("GET /:id inexistente → 404", r.res.status === 404, short(r));
  r = await owner.api("/api/conversations?assigned=todas");
  ok("lista assigned=todas → 422 invalid_query", r.res.status === 422 && r.json?.error?.code === "invalid_query", short(r));
  r = await owner.api("/api/conversations/counts?assigned=todas");
  ok("counts assigned=todas → 422 invalid_query", r.res.status === 422 && r.json?.error?.code === "invalid_query", short(r));
  const p1 = await owner.api(`/api/conversations?limit=${PAGE}`);
  r = await owner.api(`/api/conversations?limit=${PAGE}&cursor=basura`);
  ok("cursor basura → 200 primera página", r.res.ok &&
    ids(r.json?.conversations ?? []).join() === ids(p1.json?.conversations ?? []).join(), short(r));
  r = await owner.api("/api/conversations?limit=0");
  ok("limit=0 → 1 fila y nextCursor", r.res.ok && (r.json?.conversations ?? []).length === 1 && !!r.json?.nextCursor, short(r));
  r = await owner.api("/api/conversations?limit=abc");
  ok("limit ilegible → 50", r.res.ok && (r.json?.conversations ?? []).length === Math.min(PAGE, cAll?.all ?? 0), short(r));
  r = await owner.api("/api/conversations");
  const cEnd = await counts(owner);
  ok("sin limit → lista completa con nextCursor null (D-06-1)",
    r.res.ok && r.json?.nextCursor === null && (r.json?.conversations ?? []).length === cEnd?.all,
    `${(r.json?.conversations ?? []).length} vs ${cEnd?.all}`);
  r = await owner.api(`/api/conversations?since=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}&q=${S}`);
  ok("since (compat) → 200 con nextCursor null", r.res.ok && r.json?.nextCursor === null && (r.json?.conversations ?? []).length > 0,
    short(r));

  console.log("\n== h) UI: /inbox?contact= de una conversación fuera de la 1.ª página (CA-06-05) ==");
  r = await owner.api(`/api/conversations?limit=${PAGE}`);
  ok("la del enlace NO está en la primera página",
    !ids(r.json?.conversations ?? []).includes(old?.id), short(r));
  await deepLinkUi(old);
  await liveListUi();
}

/**
 * CA-06-05 en el navegador: con la sesión del owner (su cookie, sin otro
 * login que gaste el limitador), el enlace abre la conversación antigua:
 * queda seleccionada, su fila se pinta y está A LA VISTA en la lista (no
 * enterrada bajo la página 1), y el hilo abierto muestra al contacto.
 */
async function deepLinkUi(old) {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const url = new URL(BASE);
    await ctx.addCookies(
      owner.jar.cookie
        .split("; ")
        .filter(Boolean)
        .map((pair) => {
          const at = pair.indexOf("=");
          return { name: pair.slice(0, at), value: pair.slice(at + 1), domain: url.hostname, path: "/" };
        })
    );
    const page = await ctx.newPage();
    await page.goto(`${BASE}/inbox?contact=${old.contact.id}`, { waitUntil: "load" });
    const row = page.locator(`li[data-conversation-id="${old.id}"]`);
    const selected = await until(async () => (await row.locator("span.bg-brand").count()) === 1, 20000);
    ok("UI: la conversación del enlace queda seleccionada", selected);
    // Se deja correr el scroll infinito (el centinela puede pedir páginas):
    // la fila debe SEGUIR a la vista, no solo en el primer instante.
    await sleep(2500);
    const where = () =>
      row.evaluate((li) => {
        const box = li.getBoundingClientRect();
        let el = li.parentElement;
        while (el && getComputedStyle(el).overflowY !== "auto") el = el.parentElement;
        const view = (el ?? document.documentElement).getBoundingClientRect();
        const first = li.parentElement?.querySelector("li[data-conversation-id]");
        return {
          inView: box.top >= view.top - 1 && box.bottom <= view.bottom + 1,
          first: first === li,
          box: [Math.round(box.top), Math.round(box.bottom)],
          view: [Math.round(view.top), Math.round(view.bottom)],
          rows: li.parentElement?.children.length ?? 0,
        };
      });
    let pos = null;
    const inView = await until(async () => (pos = await where()).inView, 5000);
    ok("UI: su fila está a la vista en la lista", inView, JSON.stringify(pos));
    ok("UI: anclada al tope de la lista", pos?.first === true, JSON.stringify(pos));
    const thread = await until(
      async () => (await page.getByText(old.contact.name, { exact: true }).count()) >= 2,
      10000
    );
    ok("UI: el hilo abierto muestra al contacto (lista + cabecera)", thread);
    await ctx.close();
  } finally {
    await browser.close();
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

/**
 * i) La Bandeja en vivo, en el navegador (salvedades de la revisión de 06):
 * qué pide un entrante, scroll infinito completo, alt-tab y reconexión sin
 * perder lo cargado, y la página 2 que falla con «Reintentar».
 */
async function liveListUi() {
  console.log("\n== i) UI en vivo: eventos, scroll infinito, alt-tab, red ==");
  const browser = await chromium.launch();
  const url = new URL(BASE);
  const cookies = owner.jar.cookie
    .split("; ")
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), domain: url.hostname, path: "/" };
    });
  const rowIds = (page) =>
    page.$$eval("li[data-conversation-id]", (lis) => lis.map((li) => li.dataset.conversationId));
  const scroller = (page) =>
    page.locator("li[data-conversation-id]").first().evaluate((li) => {
      let el = li.parentElement;
      while (el && getComputedStyle(el).overflowY !== "auto") el = el.parentElement;
      return el ? { top: el.scrollTop, height: el.scrollHeight } : null;
    });
  const scrollToEnd = (page) =>
    page.locator("li[data-conversation-id]").first().evaluate((li) => {
      let el = li.parentElement;
      while (el && getComputedStyle(el).overflowY !== "auto") el = el.parentElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    const reqs = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/api/conversations")) reqs.push(`${u.pathname}${u.search}`);
    });
    // 027: hay vendedor (modo equipo) → la Bandeja del owner abre en un
    // alcance. Se fija el Buzón (las 7 y 9 del guion están sin asignar).
    await page.goto(`${BASE}/inbox?scope=inbox`, { waitUntil: "load" });
    await page.locator("li[data-conversation-id]").first().waitFor({ timeout: 20000 });
    await sleep(2500); // primera página, contadores y SSE conectado

    // 1) Un entrante → solo `?ids=` + `/counts`.
    reqs.length = 0;
    ok("UI: entrante en vivo entregado", (await inbound(7, `en vivo ${S}`)).res.ok);
    await until(async () => reqs.some((u) => u.includes("ids=")), 15000);
    await sleep(2500);
    const lists = reqs.filter((u) => u.startsWith("/api/conversations?") && !u.includes("ids="));
    const idsReqs = reqs.filter((u) => u.includes("ids="));
    const countReqs = reqs.filter((u) => u.startsWith("/api/conversations/counts"));
    ok("UI: el entrante pide `?ids=`", idsReqs.length >= 1, JSON.stringify(reqs));
    ok("UI: el entrante pide `/counts`", countReqs.length >= 1, JSON.stringify(reqs));
    ok("UI: nada de lista completa ni página 1 por el evento", lists.length === 0, JSON.stringify(lists));
    ok(
      "UI: `/counts` como mucho uno por resolución de ids (badge/título no piden aparte)",
      countReqs.length <= idsReqs.length,
      JSON.stringify(reqs)
    );
    // 027: lo que la lista del Buzón debe llegar a cargar completo.
    const all = (await counts(owner, { assigned: "unassigned" })).all;

    // 2) Scroll infinito hasta el final.
    const end = page.getByText("No hay más conversaciones");
    const reached = await until(async () => {
      await scrollToEnd(page);
      return (await end.count()) > 0;
    }, 90000);
    ok("UI: scroll infinito hasta «No hay más conversaciones»", !!reached);
    let dom = await rowIds(page);
    ok("UI: sin ids repetidos en el DOM", dupes(dom).length === 0, JSON.stringify(dupes(dom)));
    ok(`UI: todas cargadas (${dom.length} = counts.all ${all})`, dom.length === all, `${dom.length} vs ${all}`);
    const before = await scroller(page);
    const loaded = dom.length;

    // 3) Alt-tab simulado: oculta y vuelve.
    await page.evaluate(() => {
      const set = (v) => Object.defineProperty(document, "visibilityState", { value: v, configurable: true });
      set("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      set("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await sleep(3000);
    dom = await rowIds(page);
    const afterTab = await scroller(page);
    ok("UI: alt-tab no descarta lo cargado", dom.length >= loaded, `${dom.length} vs ${loaded}`);
    ok("UI: alt-tab conserva la posición del scroll", (afterTab?.top ?? 0) >= (before?.top ?? 0) * 0.8, `${JSON.stringify(before)} → ${JSON.stringify(afterTab)}`);
    ok("UI: tras alt-tab sigue sin repetidos", dupes(dom).length === 0);

    // 4) Corte de red + entrante mientras tanto + reconexión.
    await ctx.setOffline(true);
    await sleep(2000);
    ok("UI: entrante con la pestaña sin red", (await inbound(9, `sin red ${S}`)).res.ok);
    await sleep(1000);
    reqs.length = 0;
    await ctx.setOffline(false);
    const caught = await until(async () => {
      const ids = await rowIds(page);
      const top = await page.locator("li[data-conversation-id]").first().innerText();
      return ids.length >= loaded && top.includes(nameOf(9)) ? true : null;
    }, 30000);
    dom = await rowIds(page);
    ok("UI: al reconectar se pone al día (la del entrante sube al tope)", !!caught, (await page.locator("li[data-conversation-id]").first().innerText()).slice(0, 80));
    ok("UI: la reconexión no pierde lo cargado", dom.length >= loaded, `${dom.length} vs ${loaded}`);
    ok("UI: tras la reconexión sin repetidos", dupes(dom).length === 0);
    await ctx.close();

    // 5) La página 2 falla → «Reintentar».
    const rctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await rctx.addCookies(cookies);
    const rp = await rctx.newPage();
    let failed = 0;
    await rp.route(/\/api\/conversations\?.*cursor=/, async (route) => {
      if (failed === 0) {
        failed++;
        return route.fulfill({ status: 500, body: "{}" });
      }
      return route.continue();
    });
    await rp.goto(`${BASE}/inbox`, { waitUntil: "load" });
    await rp.locator("li[data-conversation-id]").first().waitFor({ timeout: 20000 });
    const first = (await rowIds(rp)).length;
    const retry = rp.getByRole("button", { name: "Reintentar" });
    const shown = await until(async () => {
      await scrollToEnd(rp);
      return (await retry.count()) > 0;
    }, 20000);
    ok("UI: la página 2 falla → «Reintentar» al pie", !!shown && failed === 1);
    ok("UI: lo ya cargado se queda", (await rowIds(rp)).length === first);
    await retry.first().click().catch(() => {});
    const more = await until(async () => (await rowIds(rp)).length > first, 15000);
    ok("UI: «Reintentar» carga la página 2", !!more, `${(await rowIds(rp)).length} vs ${first}`);
    ok("UI: sin repetidos tras reintentar", dupes(await rowIds(rp)).length === 0);
    await rctx.close();
  } finally {
    await browser.close();
  }
}
