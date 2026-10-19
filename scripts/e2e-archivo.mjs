/**
 * Self-test E2E — 022: archivo de conversaciones y nombre de perfil (API).
 * Guiones humanos: tests/e2e/us-archivo.md · tests/e2e/us-nombre-contacto.md
 *
 * Conduce la app real (wa-mock) con dos cookie jars (Propietario + Vendedor):
 *   a) setup: owner, WhatsApp (wa-mock), alta de un Vendedor
 *   b) nombre: el nick llega como name + profileName; renombrar; el siguiente
 *      entrante NO pisa el nombre pero SÍ actualiza el nick; búsqueda por nick;
 *      nombre vacío / 121 caracteres → error sin cambios
 *   c) archivo manual: sale de "Todas" y de los contadores, entra a
 *      "Archivadas", la búsqueda la trae con archivedAt; entrante y saliente
 *      la desarchivan; el Vendedor archiva lo que ve; SSE `conversation.updated`
 *   d) limpieza masiva (owner): conteo previo = archivadas; respeta cita
 *      futura, etapa "No archivar" y traspaso reciente; Vendedor → 403;
 *      days inválido → 4xx; SSE `conversations.bulk` llega al Vendedor
 *   e) auto-archivo: apagado por defecto (no archiva), encendido archiva con
 *      motivo `auto`; ajustes solo owner; días inválidos → 4xx
 *
 * Requiere BD AISLADA recién migrada (lee/escribe `booking`, `lead` y
 * `handoff_at` por SQL). Uso:
 *   node --env-file=.env.e2e scripts/e2e-archivo.mjs
 * Sale con código 1 si algún check falla.
 */
import postgres from "postgres";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const S = Math.random().toString(36).slice(2, 8);
const PN = "PN-E2E-ARCH";
const DAY = 24 * 60 * 60 * 1000;

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
const until = async (fn, ms = 15000) => {
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

const owner = client();
const seller = client();
const OWNER_EMAIL = "e2e@vocero.test";
const OWNER_PASSWORD = "password-e2e-123";
const SELLER_EMAIL = `vend.arch.${S}@vocero.test`;
const SELLER_PASSWORD = "password-vend-123";

const sql = postgres(process.env.DATABASE_URL, {
  max: 1,
  onnotice: () => {},
  connection: { search_path: "vocero" },
});

let seq = 0;
const phone = () => `52155${String(Date.now()).slice(-5)}${String(seq++).padStart(3, "0")}`;

/** Entrante por wa-mock; `daysAgo` fabrica antigüedad (timestamp del mensaje). */
function inbound(from, name, { daysAgo = 0, text = "hola, informes" } = {}) {
  return owner.api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: body({
      phoneNumberId: PN,
      from,
      name,
      text,
      waMessageId: `wamid.e2e.arch.${S}.${Math.random().toString(36).slice(2, 10)}`,
      timestamp: Math.floor((Date.now() - daysAgo * DAY) / 1000),
    }),
  });
}

async function list(c, query = "") {
  return (await c.api(`/api/conversations${query}`)).json?.conversations ?? [];
}
async function counts(c, query = "") {
  return (await c.api(`/api/conversations/counts${query}`)).json ?? {};
}
async function convByPhone(c, from, query = "") {
  return (await list(c, query)).find((cv) => cv.contact?.phone?.endsWith(from.slice(-10))) ?? null;
}
/** Entrante + espera a que exista la conversación (la busca por ?q=teléfono). */
async function newConversation(name, opts) {
  const from = phone();
  const r = await inbound(from, name, opts);
  if (!r.res.ok) throw new Error(`inbound ${short(r)}`);
  let cv = null;
  await until(async () => {
    cv = (await list(owner, `?q=${from.slice(-10)}`))[0] ?? null;
    return !!cv;
  });
  return { from, cv };
}
async function getConv(c, id) {
  return (await c.api(`/api/conversations?ids=${id}`)).json?.conversations?.[0] ?? null;
}
const archive = (c, id, archived) =>
  c.api(`/api/conversations/${id}`, { method: "PATCH", body: body({ archived }) });

function openStream(c) {
  const ctrl = new AbortController();
  const state = { events: [] };
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
    } catch {}
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
  console.log("== a) Setup ==");
  let su = await owner.api("/api/auth/sign-up/email", {
    method: "POST",
    body: body({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: "Operador E2E" }),
  });
  if (!su.res.ok)
    su = await owner.api("/api/auth/sign-in/email", {
      method: "POST",
      body: body({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
    });
  ok("owner con sesión", su.res.ok, short(su));
  const conn = await owner.api("/api/settings/whatsapp", {
    method: "PUT",
    body: body({ wabaId: "WABA-E2E-ARCH", phoneNumberId: PN, token: "tok-e2e-arch" }),
  });
  ok("owner conecta WhatsApp (wa-mock)", conn.res.ok, short(conn));
  const alta = await owner.api("/api/settings/team", {
    method: "POST",
    body: body({ name: `Vendedor ${S}`, email: SELLER_EMAIL, password: SELLER_PASSWORD }),
  });
  ok("alta del Vendedor → 201", alta.res.status === 201, short(alta));
  const si = await seller.api("/api/auth/sign-in/email", {
    method: "POST",
    body: body({ email: SELLER_EMAIL, password: SELLER_PASSWORD }),
  });
  ok("Vendedor con sesión", si.res.ok, short(si));
  const [{ id: orgId } = {}] =
    await sql`select organization_id as id from meta_credentials where phone_number_id = ${PN} limit 1`.catch(
      () => [{}]
    );
  ok("organización localizada por SQL", !!orgId);

  // ---------------------------------------------------------------- B
  console.log("\n== b) Nombre de perfil y renombrar ==");
  const nick = `Dios es amor ${S}`;
  const { from: nFrom, cv: nCv } = await newConversation(nick);
  ok("entrante crea conversación con el nick como nombre", nCv?.contact?.name === nick, JSON.stringify(nCv?.contact));
  ok("profileName = nick", nCv?.contact?.profileName === nick);
  const contactId = nCv?.contact?.id;
  const real = `María del Carmen ${S}`;
  const renStream = openStream(seller);
  await sleep(500);
  const ren = await owner.api(`/api/contacts/${contactId}`, { method: "PATCH", body: body({ name: real }) });
  ok("PATCH name → 200", ren.res.ok, short(ren));
  ok(
    "SSE conversation.updated al renombrar (llega a otro usuario)",
    await until(async () => renStream.state.events.some((e) => e.type === "conversation.updated" && e.data?.conversation?.id === nCv.id), 5000),
    JSON.stringify(renStream.state.events.map((e) => e.type))
  );
  await renStream.close();
  let cur = await getConv(owner, nCv.id);
  ok("la conversación muestra el nombre nuevo", cur?.contact?.name === real);
  ok("conserva el nick en profileName", cur?.contact?.profileName === nick);
  ok(
    "búsqueda por el nick encuentra al renombrado",
    (await list(owner, `?q=${encodeURIComponent(nick)}`)).some((c) => c.id === nCv.id)
  );
  ok(
    "búsqueda por el nombre nuevo (sin acentos) la encuentra",
    (await list(owner, `?q=${encodeURIComponent(`maria del carmen ${S}`)}`)).some((c) => c.id === nCv.id)
  );
  await inbound(nFrom, nick);
  await sleep(800);
  cur = await getConv(owner, nCv.id);
  ok("un entrante NO revierte el nombre", cur?.contact?.name === real, cur?.contact?.name);
  const nick2 = `Mary ${S}`;
  await inbound(nFrom, nick2);
  ok(
    "un entrante con otro nick actualiza profileName",
    await until(async () => (await getConv(owner, nCv.id))?.contact?.profileName === nick2)
  );
  ok("…y el nombre sigue intacto", (await getConv(owner, nCv.id))?.contact?.name === real);
  const empty = await owner.api(`/api/contacts/${contactId}`, { method: "PATCH", body: body({ name: "   " }) });
  ok("nombre vacío → 4xx", empty.res.status >= 400 && empty.res.status < 500, short(empty));
  const long = await owner.api(`/api/contacts/${contactId}`, {
    method: "PATCH",
    body: body({ name: "x".repeat(121) }),
  });
  ok("nombre de 121 caracteres → 4xx", long.res.status >= 400 && long.res.status < 500, short(long));
  ok("tras los errores el nombre no cambió", (await getConv(owner, nCv.id))?.contact?.name === real);
  const sRen = await seller.api(`/api/contacts/${contactId}`, {
    method: "PATCH",
    body: body({ name: `${real} (V)` }),
  });
  ok("el Vendedor también puede renombrar", sRen.res.ok, short(sRen));
  await owner.api(`/api/contacts/${contactId}`, { method: "PATCH", body: body({ name: real }) });

  // ---------------------------------------------------------------- A manual
  console.log("\n== c) Archivo manual ==");
  const { from: xFrom, cv: x } = await newConversation(`Archivable ${S}`);
  const before = await counts(owner);
  const stream = openStream(owner);
  await sleep(500);
  const a1 = await archive(owner, x.id, true);
  ok("PATCH archived:true → 200", a1.res.ok, short(a1));
  const xa = await getConv(owner, x.id);
  ok("archivedAt presente y motivo manual", !!xa?.archivedAt && xa?.archivedReason === "manual", JSON.stringify(xa && { a: xa.archivedAt, r: xa.archivedReason }));
  ok("sale de Todas", !(await list(owner)).some((c) => c.id === x.id));
  ok("aparece en Archivadas", (await list(owner, "?filter=archived")).some((c) => c.id === x.id));
  const after = await counts(owner);
  ok(
    "contadores: all −1 y archived +1",
    after.all === before.all - 1 && after.archived === (before.archived ?? 0) + 1,
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`
  );
  const found = (await list(owner, `?q=${xFrom.slice(-10)}`)).find((c) => c.id === x.id);
  ok("la búsqueda trae la archivada con archivedAt", !!found?.archivedAt);
  ok(
    "SSE conversation.updated por el archivo",
    await until(async () => stream.state.events.some((e) => e.type === "conversation.updated" && e.data?.conversation?.id === x.id), 5000)
  );
  await stream.close();
  await inbound(xFrom, `Archivable ${S}`, { text: "sigo interesado" });
  ok("un entrante la desarchiva", await until(async () => !(await getConv(owner, x.id))?.archivedAt));
  ok("…y vuelve a Todas", (await list(owner)).some((c) => c.id === x.id));
  await archive(owner, x.id, true);
  const send = await owner.api(`/api/conversations/${x.id}/messages`, {
    method: "POST",
    body: body({ text: "¡Hola de nuevo!" }),
  });
  ok("envío del operador en archivada → 2xx", send.res.ok, short(send));
  ok("un saliente la desarchiva", await until(async () => !(await getConv(owner, x.id))?.archivedAt));
  const sA = await archive(seller, x.id, true);
  ok("el Vendedor archiva una visible (sin asignar)", sA.res.ok, short(sA));
  const sU = await archive(seller, x.id, false);
  ok("…y la desarchiva", sU.res.ok && !sU.json?.conversation?.archivedAt, short(sU));
  const { cv: mine } = await newConversation(`Del owner ${S}`);
  const ownerId = (await owner.api("/api/settings/team")).json?.members?.find((m) => m.email === OWNER_EMAIL)?.userId;
  await owner.api(`/api/conversations/${mine.id}/assign`, { method: "POST", body: body({ userId: ownerId }) });
  const sForeign = await archive(seller, mine.id, true);
  ok("el Vendedor NO archiva una ajena → 404", sForeign.res.status === 404, short(sForeign));
  const bad = await owner.api(`/api/conversations/${x.id}`, { method: "PATCH", body: body({ archived: "si" }) });
  ok("archived no booleano → 4xx", bad.res.status >= 400 && bad.res.status < 500, short(bad));

  // ---------------------------------------------------------------- A masiva
  console.log("\n== d) Limpiar inactivas (owner) ==");
  const { cv: old1 } = await newConversation(`Vieja simple ${S}`, { daysAgo: 20 });
  const { cv: old2 } = await newConversation(`Vieja con cita ${S}`, { daysAgo: 20 });
  const { cv: old3 } = await newConversation(`Vieja en negociación ${S}`, { daysAgo: 20 });
  const { cv: old4 } = await newConversation(`Vieja con traspaso ${S}`, { daysAgo: 20 });
  const { cv: recent } = await newConversation(`Reciente ${S}`, { daysAgo: 2 });
  ok("conversaciones viejas creadas", !!(old1 && old2 && old3 && old4 && recent));
  await sql`insert into booking (id, organization_id, kind, status, contact_id, conversation_id, scheduled_at, duration_minutes)
            values (${`bk_e2e_${S}`}, ${orgId}, 'session', 'agendada', ${old2.contact.id}, ${old2.id}, ${new Date(Date.now() + 2 * DAY)}, 30)`;
  const st = await owner.api("/api/pipeline/stages", { method: "POST", body: body({ name: `Negociación ${S}` }) });
  ok("etapa nueva → 201", st.res.status === 201, short(st));
  const stageId = st.json?.stage?.id;
  const keep = await owner.api(`/api/pipeline/stages/${stageId}`, { method: "PATCH", body: body({ keepActive: true }) });
  ok("PATCH keepActive → 200", keep.res.ok, short(keep));
  const sKeep = await seller.api(`/api/pipeline/stages/${stageId}`, { method: "PATCH", body: body({ keepActive: false }) });
  ok("Vendedor no cambia keepActive → 403", sKeep.res.status === 403, short(sKeep));
  const upd = await sql`update lead set stage_id = ${stageId} where contact_id = ${old3.contact.id} returning id`;
  ok("lead de old3 en la etapa 'No archivar'", upd.length === 1);
  await sql`update conversation set handoff_at = ${new Date(Date.now() - DAY)} where id = ${old4.id}`;

  const sBulk = await seller.api("/api/conversations/archive-inactive", { method: "POST", body: body({ days: 14, dryRun: true }) });
  ok("Vendedor → 403 en limpieza masiva", sBulk.res.status === 403, short(sBulk));
  const badDays = await owner.api("/api/conversations/archive-inactive", { method: "POST", body: body({ days: 0, dryRun: true }) });
  ok("days 0 → 4xx", badDays.res.status >= 400 && badDays.res.status < 500, short(badDays));
  const dry = await owner.api("/api/conversations/archive-inactive", { method: "POST", body: body({ days: 14, dryRun: true }) });
  ok("dryRun → 200 con count ≥ 1", dry.res.ok && dry.json?.count >= 1, short(dry));
  ok("dryRun no archiva nada", !(await getConv(owner, old1.id))?.archivedAt);
  const sellerStream = openStream(seller);
  await sleep(500);
  const apply = await owner.api("/api/conversations/archive-inactive", { method: "POST", body: body({ days: 14, dryRun: false }) });
  ok("aplicar → count igual al previo", apply.res.ok && apply.json?.count === dry.json?.count, `${short(dry)} / ${short(apply)}`);
  const o1 = await getConv(owner, old1.id);
  ok("old1 archivada con motivo bulk", !!o1?.archivedAt && o1?.archivedReason === "bulk");
  ok("excepción: cita futura no se archiva", !(await getConv(owner, old2.id))?.archivedAt);
  ok("excepción: etapa 'No archivar' no se archiva", !(await getConv(owner, old3.id))?.archivedAt);
  ok("excepción: traspaso reciente no se archiva", !(await getConv(owner, old4.id))?.archivedAt);
  ok("la reciente no se archiva", !(await getConv(owner, recent.id))?.archivedAt);
  ok(
    "SSE conversations.bulk llega al Vendedor",
    await until(async () => sellerStream.state.events.some((e) => e.type === "conversations.bulk"), 5000),
    JSON.stringify(sellerStream.state.events.map((e) => e.type))
  );
  await sellerStream.close();
  const again = await owner.api("/api/conversations/archive-inactive", { method: "POST", body: body({ days: 14, dryRun: true }) });
  ok("segunda pasada: 0 por archivar (idempotente)", again.json?.count === 0, short(again));

  // ---------------------------------------------------------------- A auto
  console.log("\n== e) Auto-archivo ==");
  const g = await owner.api("/api/settings/inbox");
  ok(
    "ajustes por defecto: apagado, 14 días",
    g.res.ok && g.json?.settings?.autoArchiveEnabled === false && g.json?.settings?.autoArchiveDays === 14,
    short(g)
  );
  ok("Vendedor → 403 en ajustes", (await seller.api("/api/settings/inbox")).res.status === 403);
  const sPut = await seller.api("/api/settings/inbox", {
    method: "PUT",
    body: body({ autoArchiveEnabled: true, autoArchiveDays: 14 }),
  });
  ok("Vendedor → 403 al guardar ajustes", sPut.res.status === 403, short(sPut));
  const { cv: old5 } = await newConversation(`Vieja auto ${S}`, { daysAgo: 20 });
  const off = await owner.api("/api/dev/inbox/auto-archive", { method: "POST", body: body({}) });
  ok("tick con el interruptor apagado → 200", off.res.ok, short(off));
  ok("apagado no archiva", !(await getConv(owner, old5.id))?.archivedAt);
  const badPut = await owner.api("/api/settings/inbox", {
    method: "PUT",
    body: body({ autoArchiveEnabled: true, autoArchiveDays: 0 }),
  });
  ok("días 0 → 4xx", badPut.res.status >= 400 && badPut.res.status < 500, short(badPut));
  const on = await owner.api("/api/settings/inbox", {
    method: "PUT",
    body: body({ autoArchiveEnabled: true, autoArchiveDays: 14 }),
  });
  ok("encender auto-archivo → 200", on.res.ok, short(on));
  ok("GET refleja encendido", (await owner.api("/api/settings/inbox")).json?.settings?.autoArchiveEnabled === true);
  const tick = await owner.api("/api/dev/inbox/auto-archive", { method: "POST", body: body({}) });
  ok("tick encendido → 200 sin fallos", tick.res.ok && !tick.json?.failed, short(tick));
  const o5 = await getConv(owner, old5.id);
  ok("encendido archiva la vieja con motivo auto", !!o5?.archivedAt && o5?.archivedReason === "auto");
  ok("…respeta la cita futura", !(await getConv(owner, old2.id))?.archivedAt);
  ok("…respeta la etapa 'No archivar'", !(await getConv(owner, old3.id))?.archivedAt);
  ok("…no toca la reciente", !(await getConv(owner, recent.id))?.archivedAt);
  const badTick = await owner.api("/api/dev/inbox/auto-archive", { method: "POST", body: body({ advanceDays: -1 }) });
  ok("advanceDays inválido → 4xx", badTick.res.status >= 400 && badTick.res.status < 500, short(badTick));
  await owner.api("/api/settings/inbox", { method: "PUT", body: body({ autoArchiveEnabled: false, autoArchiveDays: 14 }) });

  console.log(`\n${checks - failures}/${checks} checks OK`);
  await sql.end();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await sql.end().catch(() => {});
  process.exit(1);
});
