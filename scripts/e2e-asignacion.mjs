/**
 * Self-test E2E — asignación de conversaciones (dev-tasks/09, parte a).
 * Guion humano: tests/e2e/us-asignacion.md
 *
 * Conduce la app real con tres cookie jars (Propietario + vendedores A y B,
 * dados de alta por POST /api/settings/team) y el wa-mock:
 *   a) owner entra, conecta WhatsApp (wa-mock) y da de alta a A y B
 *   b) inbound → conversación sin asignar, visible para A y B
 *   c) A y B la toman A LA VEZ → uno 200 y el otro 409 already_assigned
 *      (sin `assignedTo` al Vendedor; el owner con `expect` sí lo recibe)
 *   d) el perdedor: fuera de su lista; detalle/mensajes/envío/plantilla/
 *      leído/liberar → 404; asignarse → 409; asignar a otro → 403
 *   e) adjunto: el responsable y el owner lo ven, el otro vendedor → 404
 *   f) SSE REAL (fetch + AbortController): el vendedor ajeno NO recibe el
 *      `message.new` de la conversación del otro; sí recibe el de una sin
 *      asignar y `conversation.updated` reducido a `{ id }`
 *   g) "responder = tomar": un vendedor responde una sin asignar → queda suya;
 *      carrera de dos envíos → uno 200, otro 404 y UN solo mensaje sale
 *   h) owner reasigna → el anterior pierde acceso (404) y el nuevo la ve en
 *      "Mías"; 422 invalid_assignee; liberar idempotente
 *   i) start-conversation sobre una ajena → 409 assigned_to_other
 *   j) handoff vía /api/bot/handoff (si hay BOT_API_KEY): no cambia el
 *      responsable
 *   k) baja de un vendedor → sus conversaciones vuelven a "sin asignar"
 *
 * Presupuesto del limitador de login: 3 POST a /sign-in|sign-up (owner, A, B).
 * Streams SSE: como mucho 2 abiertos a la vez y SIEMPRE se cierran.
 *
 * Uso:
 *   1) BD migrada (0015 incluida) y app corriendo con WA_MOCK_ENABLED=true y
 *      META_GRAPH_BASE_URL → wa-mock (p. ej. .env.e2e, BD aislada en :5433)
 *   2) node --env-file=.env.e2e scripts/e2e-asignacion.mjs
 *
 * Sale con código 1 si algún check falla.
 */

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const BOT_KEY = process.env.BOT_API_KEY;
const S = Math.random().toString(36).slice(2, 8);
const PN = "PN-E2E-ASIG";

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
const sellerA = client();
const sellerB = client();

const OWNER_EMAIL = "e2e@vocero.test";
const OWNER_PASSWORD = "password-e2e-123";
const A_EMAIL = `vend.a.${S}@vocero.test`;
const B_EMAIL = `vend.b.${S}@vocero.test`;
const SELLER_PASSWORD = "password-vend-123";

function signIn(c, email, password) {
  return c.api("/api/auth/sign-in/email", {
    method: "POST",
    body: body({ email, password }),
  });
}

const phone = () => `52155${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;

function inbound(from, name, extra = {}) {
  return owner.api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({
      phoneNumberId: PN,
      from,
      name,
      text: "hola, quiero informes",
      waMessageId: `wamid.e2e.asig.${S}.${Math.random().toString(36).slice(2, 10)}`,
      ...extra,
    }),
  });
}

async function list(c, query = "") {
  return (await c.api(`/api/conversations${query}`)).json?.conversations ?? [];
}
async function findByName(c, name) {
  return (await list(c)).find((cv) => cv.contact?.name === name) ?? null;
}
function assign(c, id, payload) {
  return c.api(`/api/conversations/${id}/assign`, { method: "POST", body: body(payload) });
}
function sendText(c, id, text) {
  return c.api(`/api/conversations/${id}/messages`, { method: "POST", body: body({ text }) });
}
async function outboxTexts() {
  const ob = (await owner.api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  return ob.map((o) => JSON.stringify(o.body));
}

/**
 * Lee el stream SSE REAL de un actor. Junta `{ type, data }` hasta `close()`,
 * que aborta el fetch y espera a que el lector termine.
 */
function openStream(c) {
  const ctrl = new AbortController();
  const state = { connected: false, events: [] };
  const done = (async () => {
    try {
      const res = await fetch(`${BASE}/api/events`, {
        headers: { cookie: c.jar.cookie, accept: "text/event-stream", origin: BASE },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith(": conectado")) state.connected = true;
          let type = null;
          let data = null;
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) type = line.slice(7).trim();
            else if (line.startsWith("data: ")) data = line.slice(6);
          }
          if (type) {
            let parsed = null;
            try {
              parsed = JSON.parse(data ?? "null");
            } catch {}
            state.events.push({ type, data: parsed });
          }
        }
      }
    } catch {
      /* AbortError al cerrar */
    }
  })();
  return {
    state,
    async close() {
      ctrl.abort();
      await done;
    },
  };
}

async function main() {
  console.log("== a) Owner, WhatsApp y alta de vendedores ==");
  let su = await owner.api("/api/auth/sign-up/email", {
    method: "POST",
    body: body({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: "Operador E2E" }),
  });
  if (!su.res.ok) su = await signIn(owner, OWNER_EMAIL, OWNER_PASSWORD);
  ok("owner registrado o con sesión", su.res.ok, short(su));
  const conn = await owner.api("/api/settings/whatsapp", {
    method: "PUT",
    body: body({ wabaId: "WABA-E2E-ASIG", phoneNumberId: PN, token: "tok-e2e-asig" }),
  });
  ok("owner conecta WhatsApp (wa-mock)", conn.res.ok, short(conn));

  for (const [email, name] of [
    [A_EMAIL, `Vendedor A ${S}`],
    [B_EMAIL, `Vendedor B ${S}`],
  ]) {
    const r = await owner.api("/api/settings/team", {
      method: "POST",
      body: body({ name, email, password: SELLER_PASSWORD }),
    });
    ok(`alta de ${name} → 201`, r.res.status === 201, short(r));
  }
  const team = (await owner.api("/api/settings/team")).json?.members ?? [];
  const memberA = team.find((m) => m.email === A_EMAIL);
  const memberB = team.find((m) => m.email === B_EMAIL);
  ok("GET /api/settings/team expone userId de cada miembro", !!memberA?.userId && !!memberB?.userId);
  const ownerUserId = team.find((m) => m.email === OWNER_EMAIL)?.userId;
  ok("A inicia sesión", (await signIn(sellerA, A_EMAIL, SELLER_PASSWORD)).res.ok);
  ok("B inicia sesión", (await signIn(sellerB, B_EMAIL, SELLER_PASSWORD)).res.ok);
  const ids = { A: memberA?.userId, B: memberB?.userId };
  const actors = { A: sellerA, B: sellerB };

  console.log("\n== b) Inbound → sin asignar, visible para ambos ==");
  const phone1 = phone();
  const name1 = `Asig Uno ${S}`;
  ok("inbound 1 entregado", (await inbound(phone1, name1)).res.ok);
  ok("aparece para el owner", await until(async () => !!(await findByName(owner, name1))));
  const conv1 = await findByName(owner, name1);
  const id1 = conv1?.id;
  ok("nace sin asignar (assignedTo null, assignedAt null)", conv1?.assignedTo === null && conv1?.assignedAt === null, JSON.stringify(conv1?.assignedTo));
  ok("A la ve", !!(await findByName(sellerA, name1)));
  ok("B la ve", !!(await findByName(sellerB, name1)));
  const unassignedA = await list(sellerA, "?assigned=unassigned");
  ok("A la ve en ?assigned=unassigned", unassignedA.some((c) => c.id === id1));
  const badQuery = await sellerA.api("/api/conversations?assigned=todas");
  ok("?assigned=otro → 422 invalid_query", badQuery.res.status === 422 && badQuery.json?.error?.code === "invalid_query", short(badQuery));

  console.log("\n== c) Carrera: A y B toman a la vez ==");
  const [ra, rb] = await Promise.all([
    assign(sellerA, id1, { userId: ids.A }),
    assign(sellerB, id1, { userId: ids.B }),
  ]);
  const statuses = [ra.res.status, rb.res.status].sort();
  ok("uno 200 y el otro 409", statuses.join() === "200,409", `${short(ra)} | ${short(rb)}`);
  const W = ra.res.status === 200 ? "A" : "B"; // ganador
  const L = W === "A" ? "B" : "A"; // perdedor
  const loserRes = W === "A" ? rb : ra;
  ok(
    "el 409 es already_assigned y al Vendedor NO le dice quién",
    loserRes.json?.error?.code === "already_assigned" && loserRes.json?.error?.assignedTo === undefined,
    short(loserRes)
  );
  const after = await findByName(owner, name1);
  ok(`en BD queda un solo responsable (${W})`, after?.assignedTo?.userId === ids[W] && !!after?.assignedAt, JSON.stringify(after?.assignedTo));
  ok("el responsable trae su nombre", after?.assignedTo?.name === `Vendedor ${W} ${S}`, JSON.stringify(after?.assignedTo));
  const again = await assign(actors[W], id1, { userId: ids[W] });
  ok("tomar la propia otra vez → 200 idempotente", again.res.status === 200 && again.json?.conversation?.assignedTo?.userId === ids[W], short(again));
  const ownerExpect = await assign(owner, id1, { userId: ids[L], expect: "unassigned" });
  ok(
    "owner con expect:unassigned sobre una asignada → 409 con assignedTo",
    ownerExpect.res.status === 409 && ownerExpect.json?.error?.assignedTo?.userId === ids[W],
    short(ownerExpect)
  );

  console.log(`\n== d) ${L} (perdedor) ya no la ve ==`);
  const loser = actors[L];
  ok(`${L}: no está en su lista`, !(await list(loser)).some((c) => c.id === id1));
  ok(`${L}: tampoco en ?assigned=unassigned`, !(await list(loser, "?assigned=unassigned")).some((c) => c.id === id1));
  let r = await loser.api(`/api/conversations/${id1}/messages`);
  ok(`${L}: GET messages → 404`, r.res.status === 404, short(r));
  r = await sendText(loser, id1, `intruso ${S}`);
  ok(`${L}: POST messages → 404`, r.res.status === 404, short(r));
  r = await loser.api(`/api/conversations/${id1}/messages/template`, {
    method: "POST",
    body: body({ templateId: "tpl_inexistente" }),
  });
  ok(`${L}: POST template → 404 de conversación (no de plantilla)`, r.res.status === 404 && /Conversaci/.test(r.json?.error?.message ?? ""), short(r));
  r = await actors[W].api(`/api/conversations/${id1}/messages/template`, {
    method: "POST",
    body: body({ templateId: "tpl_inexistente" }),
  });
  ok(`${W}: POST template con id falso → 404 de PLANTILLA (pasó la compuerta)`, r.res.status === 404 && /Plantilla/.test(r.json?.error?.message ?? ""), short(r));
  r = await loser.api(`/api/conversations/${id1}`, { method: "PATCH", body: body({ markRead: true }) });
  ok(`${L}: PATCH markRead → 404`, r.res.status === 404, short(r));
  r = await assign(loser, id1, { userId: null });
  ok(`${L}: liberar la ajena → 404`, r.res.status === 404, short(r));
  r = await assign(loser, id1, { userId: ids[L] });
  ok(`${L}: tomarla → 409 already_assigned`, r.res.status === 409 && r.json?.error?.code === "already_assigned", short(r));
  r = await assign(loser, id1, { userId: ids[W] });
  ok(`${L}: asignar a otro → 403 forbidden`, r.res.status === 403 && r.json?.error?.code === "forbidden", short(r));
  r = await assign(owner, "cv_inexistente", { userId: null });
  ok("owner: conversación inexistente → 404", r.res.status === 404, short(r));
  r = await assign(owner, id1, { userId: "usr_inexistente" });
  ok("owner: asignar a un no-miembro → 422 invalid_assignee", r.res.status === 422 && r.json?.error?.code === "invalid_assignee", short(r));
  r = await assign(owner, id1, { userid: ids[W] });
  ok("body inválido → 422 invalid_body", r.res.status === 422 && r.json?.error?.code === "invalid_body", short(r));

  console.log("\n== e) Adjuntos ==");
  ok(
    "inbound con imagen a la conversación asignada",
    (await inbound(phone1, name1, { type: "image", mediaId: `media-asig-${S}`, caption: `foto ${S}`, text: undefined })).res.ok
  );
  let assetId = null;
  await until(async () => {
    const msgs = (await actors[W].api(`/api/conversations/${id1}/messages`)).json?.messages ?? [];
    assetId = msgs.find((m) => m.media?.caption === `foto ${S}`)?.media?.assetId ?? null;
    return !!assetId;
  });
  ok("el adjunto llegó (assetId)", !!assetId);
  await sleep(1200); // descarga in-process del binario
  const mediaW = await actors[W].api(`/api/media/${assetId}`);
  ok(`${W}: GET /api/media/:id → no 404`, mediaW.res.status !== 404, `${mediaW.res.status}`);
  const mediaO = await owner.api(`/api/media/${assetId}`);
  ok("owner: GET /api/media/:id → no 404", mediaO.res.status !== 404, `${mediaO.res.status}`);
  const mediaL = await loser.api(`/api/media/${assetId}`);
  ok(`${L}: GET /api/media/:id → 404`, mediaL.res.status === 404, `${mediaL.res.status}`);

  console.log("\n== f) SSE real: cada quien recibe solo lo suyo ==");
  const phone2 = phone();
  const name2 = `Asig Dos ${S}`;
  const sW = openStream(actors[W]);
  const sL = openStream(loser);
  try {
    ok("ambos streams conectados", await until(() => sW.state.connected && sL.state.connected, 15000));
    ok("inbound a la conversación de " + W, (await inbound(phone1, name1, { text: `para ${W} ${S}` })).res.ok);
    const gotW = await until(
      () => sW.state.events.some((e) => e.type === "message.new" && e.data?.conversationId === id1),
      8000
    );
    ok(`${W} recibe message.new de la suya (con el mensaje completo)`, gotW && sW.state.events.some((e) => e.type === "message.new" && e.data?.conversationId === id1 && e.data?.message));
    await sleep(3000);
    ok(
      `${L} NO recibe message.new ni message.status de la conversación de ${W}`,
      !sL.state.events.some((e) => (e.type === "message.new" || e.type === "message.status") && e.data?.conversationId === id1),
      JSON.stringify(sL.state.events.map((e) => [e.type, e.data?.conversationId ?? e.data?.conversation?.id]))
    );
    const upd = sL.state.events.filter((e) => e.type === "conversation.updated");
    ok(
      `${L} sí recibe conversation.updated, reducido a { id }`,
      upd.length > 0 && upd.every((e) => Object.keys(e.data ?? {}).join() === "conversation" && Object.keys(e.data.conversation ?? {}).join() === "id"),
      JSON.stringify(upd.slice(0, 3))
    );
    ok("inbound a un contacto nuevo (sin asignar)", (await inbound(phone2, name2)).res.ok);
    const gotL = await until(
      () =>
        sL.state.events.some(
          (e) => e.type === "message.new" && e.data?.conversationId && e.data.conversationId !== id1
        ),
      10000
    );
    ok(`${L} SÍ recibe message.new de una sin asignar`, gotL);
    ok(`nunca recibió lab.run`, !sL.state.events.some((e) => e.type === "lab.run"));
  } finally {
    await sW.close();
    await sL.close();
  }

  console.log("\n== g) Responder = tomar ==");
  ok("la conversación 2 aparece", await until(async () => !!(await findByName(owner, name2))));
  const id2 = (await findByName(owner, name2))?.id;
  r = await sendText(loser, id2, `respuesta de ${L} ${S}`);
  ok(`${L} responde una sin asignar → 200`, r.res.status === 200, short(r));
  ok(`y queda asignada a ${L} sin pasos extra`, (await findByName(owner, name2))?.assignedTo?.userId === ids[L]);
  ok(`${W} ya no la ve`, !(await list(actors[W])).some((c) => c.id === id2));
  r = await sendText(owner, id1, `supervisión ${S}`);
  ok("el owner responde la de " + W + " → 200 y NO se la queda (D-09-3)", r.res.status === 200 && (await findByName(owner, name1))?.assignedTo?.userId === ids[W], short(r));

  const phone3 = phone();
  const name3 = `Asig Tres ${S}`;
  ok("inbound 3 (para la carrera de envío)", (await inbound(phone3, name3)).res.ok);
  ok("la conversación 3 aparece", await until(async () => !!(await findByName(owner, name3))));
  const id3 = (await findByName(owner, name3))?.id;
  // Sin agente durante la carrera: el outbox solo debe tener lo de los vendedores.
  await owner.api(`/api/conversations/${id3}`, { method: "PATCH", body: body({ aiEnabled: false }) });
  await sleep(1500);
  await owner.api("/api/dev/wa-mock/outbox", { method: "DELETE" });
  const textA = `carrera A ${S}`;
  const textB = `carrera B ${S}`;
  const [sa, sb] = await Promise.all([sendText(sellerA, id3, textA), sendText(sellerB, id3, textB)]);
  ok(
    "dos vendedores envían a la vez → uno 200 y el otro 404",
    [sa.res.status, sb.res.status].sort().join() === "200,404",
    `${short(sa)} | ${short(sb)}`
  );
  const raceWinner = sa.res.status === 200 ? "A" : "B";
  const texts = await outboxTexts();
  const outA = texts.filter((t) => t.includes(textA)).length;
  const outB = texts.filter((t) => t.includes(textB)).length;
  ok("el outbox tiene UN solo mensaje de la carrera (el del ganador)", outA + outB === 1 && (raceWinner === "A" ? outA : outB) === 1, `A=${outA} B=${outB}`);
  ok("la conversación quedó del ganador", (await findByName(owner, name3))?.assignedTo?.userId === ids[raceWinner]);

  console.log("\n== h) Owner reasigna; liberar ==");
  r = await assign(owner, id1, { userId: ids[L] });
  ok(`owner reasigna la 1 de ${W} a ${L} → 200`, r.res.status === 200 && r.json?.conversation?.assignedTo?.userId === ids[L], short(r));
  ok(`${W} ya no la ve`, !(await list(actors[W])).some((c) => c.id === id1));
  r = await actors[W].api(`/api/conversations/${id1}/messages`);
  ok(`${W}: GET messages → 404`, r.res.status === 404, short(r));
  const mediaW2 = await actors[W].api(`/api/media/${assetId}`);
  ok(`${W}: su adjunto viejo → 404 (historial del navegador)`, mediaW2.res.status === 404, `${mediaW2.res.status}`);
  ok(`${L} la ve en ?assigned=me`, (await list(loser, "?assigned=me")).some((c) => c.id === id1));
  r = await assign(loser, id1, { userId: null });
  ok(`${L} libera la suya → 200 sin responsable`, r.res.status === 200 && r.json?.conversation?.assignedTo === null && r.json?.conversation?.assignedAt === null, short(r));
  r = await assign(loser, id1, { userId: null });
  ok("liberar una sin asignar → 200 sin cambios", r.res.status === 200 && r.json?.conversation?.assignedTo === null, short(r));
  ok(`${W} la vuelve a ver (sin asignar)`, (await list(actors[W], "?assigned=unassigned")).some((c) => c.id === id1));
  r = await assign(owner, id1, { userId: ids[L] });
  ok(`owner se la asigna a ${L} de nuevo`, r.res.status === 200, short(r));
  if (ownerUserId) {
    r = await assign(owner, id3, { userId: ownerUserId });
    ok("owner se asigna a sí mismo → 200", r.res.status === 200 && r.json?.conversation?.assignedTo?.userId === ownerUserId, short(r));
    ok(`${raceWinner} pierde la 3`, !(await list(actors[raceWinner])).some((c) => c.id === id3));
  }

  console.log("\n== i) start-conversation sobre una ajena ==");
  const contact1 = (await findByName(owner, name1))?.contact?.id;
  r = await actors[W].api(`/api/contacts/${contact1}/start-conversation`, {
    method: "POST",
    body: body({ templateId: "tpl_inexistente" }),
  });
  ok(
    `${W}: iniciar con el contacto de ${L} → 409 assigned_to_other (sin nombre)`,
    r.res.status === 409 && r.json?.error?.code === "assigned_to_other" && !JSON.stringify(r.json).includes(`Vendedor ${L}`),
    short(r)
  );

  console.log("\n== j) Handoff no cambia el responsable ==");
  if (!BOT_KEY || BOT_KEY.length < 16) {
    console.log("  (omitido: sin BOT_API_KEY)");
  } else {
    const ho = await fetch(`${BASE}/api/bot/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": BOT_KEY },
      body: body({ conversationId: id1, reason: "cliente" }),
    });
    ok("POST /api/bot/handoff → 200", ho.ok, `${ho.status}`);
    const c1 = await findByName(owner, name1);
    ok(`sigue asignada a ${L} y con handoffAt`, c1?.assignedTo?.userId === ids[L] && !!c1?.handoffAt);
    ok(`${W} no la ve`, !(await list(actors[W])).some((c) => c.id === id1));
  }

  console.log(`\n== k) Baja de ${L} → sus conversaciones vuelven a sin asignar ==`);
  const memberL = L === "A" ? memberA : memberB;
  const mine = (await list(owner)).filter((c) => c.assignedTo?.userId === ids[L]).map((c) => c.id);
  ok(`${L} tiene conversaciones asignadas antes de la baja`, mine.length >= 2, JSON.stringify(mine));
  r = await owner.api(`/api/settings/team/${memberL?.id}`, { method: "DELETE" });
  ok(`DELETE /api/settings/team/${L} → 200`, r.res.status === 200, short(r));
  const afterBaja = await list(owner);
  ok(
    "todas las suyas quedaron sin asignar",
    mine.every((id) => afterBaja.find((c) => c.id === id)?.assignedTo === null),
    JSON.stringify(afterBaja.filter((c) => mine.includes(c.id)).map((c) => c.assignedTo))
  );
  const unassignedW = await list(actors[W], "?assigned=unassigned");
  ok(`${W} las ve en "Sin asignar"`, mine.every((id) => unassignedW.some((c) => c.id === id)));
  ok("el owner sigue viendo todo", [id1, id2, id3].every((id) => afterBaja.some((c) => c.id === id)));
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
