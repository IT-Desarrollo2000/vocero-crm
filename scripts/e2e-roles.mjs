/**
 * Self-test E2E — roles y permisos (dev-tasks/00): Propietario / Vendedor.
 * Guion humano: tests/e2e/us-roles.md
 *
 * Conduce la app real con flujos HTTP de verdad (sign-up/sign-in de Better
 * Auth, sin mocks de sesión) y dos cookie jars (owner y vendedor):
 *   a) primer registro (BD vacía) o login del owner e2e → org + owner
 *   b) owner da de alta a un vendedor → el vendedor inicia sesión
 *   c) vendedor: 403 `forbidden` en ~25 llamadas de Propietario (el owner
 *      relee que nada cambió) y 200 en su operación diaria
 *   d) /api/auth/organization/* → 404 para ambos; sigue habiendo 1 org
 *   h) Playwright: menú, páginas 404, /settings → Mi cuenta, cambio de nombre
 *   e) gestión de equipo: cambio de rol, self_change, carrera de dos owners
 *      que se degradan a la vez (uno 200, el otro last_owner)
 *   f) restablecer contraseña: la vieja falla, la temporal entra
 *   g) baja con sesión abierta → 401; login → 403 "dado de baja"; re-alta
 *      con el mismo correo → relinked y vuelve a entrar
 *
 * Presupuesto del limitador de login (10 / 10 min por IP y ruta): este guion
 * hace ≤ 7 POST a /sign-in/email y ≤ 3 a /sign-up/email (dos son altas de
 * equipo internas). Playwright reutiliza las cookies: no inicia sesión. Para
 * correrlo DOS veces seguidas, reinicia el servidor entre corridas.
 *
 * Uso:
 *   1) BD migrada (0013 incluida) y app corriendo con WA_MOCK_ENABLED=true y
 *      META_GRAPH_BASE_URL → wa-mock (p. ej. .env.e2e, BD aislada en :5433)
 *   2) node --env-file=.env.e2e scripts/e2e-roles.mjs
 *
 * Sale con código 1 si algún check falla.
 */
import { chromium } from "playwright";
import postgres from "postgres";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const S = Math.random().toString(36).slice(2, 8);

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
const short = (r) => `${r.res.status} ${JSON.stringify(r.json)?.slice(0, 160)}`;

const owner = client();
const seller = client();
const owner2 = client();

const OWNER_EMAIL = "e2e@vocero.test";
const OWNER_PASSWORD = "password-e2e-123";
const SELLER_EMAIL = `vendedor.${S}@vocero.test`;
const SELLER_PASSWORD = "password-vend-123";
const OWNER2_EMAIL = `socio.${S}@vocero.test`;
const OWNER2_PASSWORD = "password-socio-123";
const PN = "PN-E2E-ROLES";

const db = process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: "vocero, extensions" },
    })
  : null;

async function countOrgs() {
  if (!db) return null;
  const rows = await db`SELECT count(*)::int AS n FROM organization`;
  return rows[0]?.n ?? null;
}

function signIn(c, email, password) {
  return c.api("/api/auth/sign-in/email", {
    method: "POST",
    body: body({ email, password }),
  });
}

async function teamMember(email) {
  const t = await owner.api("/api/settings/team");
  return (t.json?.members ?? []).find((m) => m.email === email) ?? null;
}

/** Instantánea de lo que un vendedor NO debe poder cambiar. */
async function ownerSnapshot() {
  const [profile, stages, templates, wa, kb, team, cal] = await Promise.all([
    owner.api("/api/agent/profile"),
    owner.api("/api/pipeline/stages"),
    owner.api("/api/templates"),
    owner.api("/api/settings/whatsapp"),
    owner.api("/api/kb"),
    owner.api("/api/settings/team"),
    owner.api("/api/calendar/settings"),
  ]);
  return JSON.stringify({
    profile: profile.json,
    stages: stages.json,
    templates: templates.json,
    wa: wa.json,
    kb: kb.json,
    team: team.json,
    cal: cal.json,
  });
}

async function main() {
  console.log("== a) Primer registro o login del owner ==");
  let su = await owner.api("/api/auth/sign-up/email", {
    method: "POST",
    body: body({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: "Operador E2E" }),
  });
  const firstSignup = su.res.ok;
  if (!su.res.ok) {
    // Re-corrida: el correo ya existe (o el registro se cerró).
    su = await signIn(owner, OWNER_EMAIL, OWNER_PASSWORD);
  }
  ok(
    `owner ${firstSignup ? "registrado (primer registro)" : "inició sesión"}`,
    su.res.ok,
    short(su)
  );
  const me = await teamMember(OWNER_EMAIL);
  ok("el owner tiene membresía owner en la org", me?.role === "owner", JSON.stringify(me));
  const orgsBefore = await countOrgs();
  ok("hay exactamente 1 organización", orgsBefore === 1, `orgs=${orgsBefore}`);

  // Estado de partida para las relecturas: WhatsApp conectado, una entrada de
  // KB y un prompt conocido.
  const conn = await owner.api("/api/settings/whatsapp", {
    method: "PUT",
    body: body({ wabaId: "WABA-E2E-ROLES", phoneNumberId: PN, token: "tok-e2e-roles" }),
  });
  ok("owner conecta WhatsApp (wa-mock)", conn.res.ok, short(conn));
  const kbNew = await owner.api("/api/kb", {
    method: "POST",
    body: body({ kind: "qa", question: `¿Horario? ${S}`, answer: "9 a 18" }),
  });
  ok("owner crea una entrada de KB", kbNew.res.status === 201, short(kbNew));
  const kbId = kbNew.json?.entry?.id ?? "kb_inexistente";
  const prof = await owner.api("/api/agent/profile", {
    method: "PUT",
    body: body({ instructions: `Prompt del dueño ${S}` }),
  });
  ok("owner fija el prompt del agente", prof.res.ok, short(prof));

  const contact = await owner.api("/api/contacts", {
    method: "POST",
    body: body({ name: `Lead Roles ${S}`, phone: `52155${String(Date.now()).slice(-8)}` }),
  });
  ok("owner crea un contacto (con su lead)", contact.res.status === 201, short(contact));

  console.log("\n== b) Alta de vendedor + su login ==");
  const add = await owner.api("/api/settings/team", {
    method: "POST",
    body: body({ name: "Vendedor E2E", email: SELLER_EMAIL, password: SELLER_PASSWORD }),
  });
  ok("POST /api/settings/team → 201", add.res.status === 201 && !add.json?.relinked, short(add));
  const sellerMember = await teamMember(SELLER_EMAIL);
  ok("el vendedor aparece como member", sellerMember?.role === "member", JSON.stringify(sellerMember));
  const sIn = await signIn(seller, SELLER_EMAIL, SELLER_PASSWORD);
  ok("el vendedor inicia sesión (el bloqueo de baja no rompe el alta)", sIn.res.ok, short(sIn));

  console.log("\n== c) Vendedor: 403 en lo del Propietario ==");
  const before = await ownerSnapshot();
  const stages = (await owner.api("/api/pipeline/stages")).json?.stages ?? [];
  const stageId = stages[0]?.id ?? "stg_inexistente";
  const FORBIDDEN = [
    ["PUT", "/api/settings/whatsapp", { wabaId: "HACK", phoneNumberId: "HACK", token: "hack" }],
    ["GET", "/api/settings/whatsapp"],
    ["POST", "/api/settings/whatsapp/test", {}],
    ["GET", "/api/settings/webhook"],
    ["GET", "/api/settings/instagram"],
    ["DELETE", "/api/settings/messenger"],
    ["GET", "/api/settings/capi"],
    ["POST", "/api/settings/capi/events/retry", {}],
    ["GET", "/api/settings/google"],
    ["DELETE", "/api/settings/zoom"],
    ["PUT", "/api/settings/branding", { name: "HACK" }],
    ["DELETE", "/api/settings/branding/favicon"],
    ["GET", "/api/kb"],
    ["POST", "/api/kb", { kind: "qa", question: "hack", answer: "hack" }],
    ["PATCH", `/api/kb/${kbId}`, { answer: "HACK" }],
    ["DELETE", `/api/kb/${kbId}`],
    ["GET", "/api/kb/size"],
    ["GET", "/api/lab/runs"],
    ["POST", "/api/lab/runs", {}],
    ["DELETE", "/api/lab/runs/run_inexistente"],
    ["POST", "/api/lab/suggestions/apply", { instructions: "HACK" }],
    ["PUT", "/api/agent/profile", { instructions: "HACKED" }],
    // Body inválido: si la guarda corriera DESPUÉS de parseBody daría 400.
    ["PUT", "/api/agent/profile", { instructions: 123 }],
    ["POST", "/api/pipeline/stages", { name: "HACK" }],
    ["PATCH", `/api/pipeline/stages/${stageId}`, { name: "HACK" }],
    ["DELETE", `/api/pipeline/stages/${stageId}`],
    ["POST", "/api/templates", { name: "hack", language: "es", category: "UTILITY", body: "hack" }],
    ["POST", "/api/templates/sync", {}],
    ["GET", "/api/calendar/settings"],
    ["PUT", "/api/calendar/settings", { slotMinutes: 5 }],
    ["POST", "/api/seed/demo", {}],
    ["GET", "/api/settings/team"],
    ["POST", "/api/settings/team", { name: "Intruso", email: `intruso.${S}@vocero.test`, password: "password-123" }],
    ["PATCH", `/api/settings/team/${me?.id}`, { role: "member" }],
    ["DELETE", `/api/settings/team/${me?.id}`],
    ["POST", `/api/settings/team/${me?.id}/reset-password`, {}],
  ];
  for (const [method, path, payload] of FORBIDDEN) {
    const r = await seller.api(path, {
      method,
      ...(payload !== undefined ? { body: body(payload) } : {}),
    });
    ok(
      `${method} ${path}${payload && typeof payload.instructions === "number" ? " (body inválido)" : ""} → 403 forbidden`,
      r.res.status === 403 && r.json?.error?.code === "forbidden",
      short(r)
    );
  }
  const after = await ownerSnapshot();
  ok("el owner relee: prompt, credenciales, etapas, KB, plantillas, equipo y agenda intactos", before === after);
  ok("no se creó la cuenta del intruso", (await teamMember(`intruso.${S}@vocero.test`)) === null);

  console.log("\n== c) Vendedor: 200 en su operación diaria ==");
  const convs = await seller.api("/api/conversations");
  ok("GET /api/conversations → 200", convs.res.status === 200, short(convs));
  const board = await seller.api("/api/pipeline/board");
  ok("GET /api/pipeline/board → 200", board.res.status === 200, short(board));
  const lead = (board.json?.leads ?? []).find((l) => l.contact?.name === `Lead Roles ${S}`);
  const target = (board.json?.stages ?? []).find(
    (s) => s.kind === "open" && s.id !== lead?.stageId
  );
  ok("el tablero trae el lead y otra etapa abierta", !!lead && !!target);
  const move = await seller.api(`/api/pipeline/leads/${lead?.id}`, {
    method: "PATCH",
    body: body({ stageId: target?.id, position: 0 }),
  });
  const moved = ((await owner.api("/api/pipeline/board")).json?.leads ?? []).find(
    (l) => l.id === lead?.id
  );
  ok(
    "PATCH /api/pipeline/leads/:id (mover) → 200 y el lead cambió de etapa",
    move.res.status === 200 && moved?.stageId === target?.id,
    `${short(move)} stage=${moved?.stageId}`
  );
  const tpl = await seller.api("/api/templates");
  ok("GET /api/templates → 200", tpl.res.status === 200, short(tpl));
  const sp = await seller.api("/api/agent/profile");
  ok(
    "GET /api/agent/profile → 200 solo con enabled (sin instructions/escalationRules/tone/greeting)",
    sp.res.status === 200 &&
      typeof sp.json?.profile?.enabled === "boolean" &&
      Object.keys(sp.json.profile).join(",") === "enabled" &&
      typeof sp.json?.aiConfigured === "boolean",
    short(sp)
  );
  const op = await owner.api("/api/agent/profile");
  ok("el owner sí ve las instrucciones", op.json?.profile?.instructions === `Prompt del dueño ${S}`);

  console.log("\n== d) Plugin organization bloqueado ==");
  for (const [who, c] of [
    ["owner", owner],
    ["vendedor", seller],
  ]) {
    const r = await c.api("/api/auth/organization/create", {
      method: "POST",
      body: body({ name: `Org pirata ${S}`, slug: `pirata-${who}-${S}` }),
    });
    ok(`POST /api/auth/organization/create (${who}) → 404`, r.res.status === 404, short(r));
  }
  const upd = await seller.api("/api/auth/organization/update-member-role", {
    method: "POST",
    body: body({ memberId: sellerMember?.id, role: "owner" }),
  });
  ok("POST /api/auth/organization/update-member-role (vendedor) → 404", upd.res.status === 404, short(upd));
  ok("sigue habiendo 1 organización", (await countOrgs()) === 1);
  ok("el vendedor sigue siendo member", (await teamMember(SELLER_EMAIL))?.role === "member");

  console.log("\n== h) Playwright: lo que ve cada rol ==");
  await browserChecks();

  console.log("\n== e) Gestión de equipo: roles ==");
  const sId = sellerMember?.id;
  let r = await owner.api(`/api/settings/team/${sId}`, { method: "PATCH", body: body({ role: "owner" }) });
  ok("owner promueve al vendedor a owner → 200", r.res.status === 200 && r.json?.member?.role === "owner", short(r));
  const sAsOwner = await seller.api("/api/settings/team");
  ok("el cambio de rol surte efecto en la siguiente petición (GET team → 200)", sAsOwner.res.status === 200, short(sAsOwner));
  r = await owner.api(`/api/settings/team/${sId}`, { method: "PATCH", body: body({ role: "member" }) });
  ok("owner lo regresa a vendedor → 200", r.res.status === 200 && r.json?.member?.role === "member", short(r));
  const sBack = await seller.api("/api/settings/team");
  ok("de vuelta a vendedor: GET team → 403", sBack.res.status === 403, short(sBack));

  r = await owner.api(`/api/settings/team/${me?.id}`, { method: "PATCH", body: body({ role: "member" }) });
  ok("owner cambia su propio rol → 409 self_change", r.res.status === 409 && r.json?.error?.code === "self_change", short(r));
  r = await owner.api(`/api/settings/team/${me?.id}`, { method: "DELETE" });
  ok("owner se da de baja a sí mismo → 409 self_change", r.res.status === 409 && r.json?.error?.code === "self_change", short(r));

  // Último owner: con UN owner es inalcanzable por la API (el actor ya es
  // owner y no puede tocarse a sí mismo); solo aparece en la carrera de dos
  // owners que se degradan mutuamente a la vez.
  r = await owner.api("/api/settings/team", {
    method: "POST",
    body: body({ name: "Socio E2E", email: OWNER2_EMAIL, password: OWNER2_PASSWORD }),
  });
  ok("alta del socio → 201", r.res.status === 201, short(r));
  const o2 = await teamMember(OWNER2_EMAIL);
  r = await owner.api(`/api/settings/team/${o2?.id}`, { method: "PATCH", body: body({ role: "owner" }) });
  ok("el socio pasa a owner", r.res.status === 200, short(r));
  const o2In = await signIn(owner2, OWNER2_EMAIL, OWNER2_PASSWORD);
  ok("el socio inicia sesión", o2In.res.ok, short(o2In));

  const [ra, rb] = await Promise.all([
    owner.api(`/api/settings/team/${o2?.id}`, { method: "PATCH", body: body({ role: "member" }) }),
    owner2.api(`/api/settings/team/${me?.id}`, { method: "PATCH", body: body({ role: "member" }) }),
  ]);
  const statuses = [ra, rb].map((x) => x.res.status);
  const loser = ra.res.status === 200 ? rb : ra;
  ok(
    "dos owners se degradan a la vez → exactamente uno 200 y el otro 409 last_owner",
    statuses.filter((s) => s === 200).length === 1 &&
      loser.res.status === 409 &&
      loser.json?.error?.code === "last_owner",
    `${short(ra)} | ${short(rb)}`
  );
  const ownersAfterRace = ((await (ra.res.status === 200 ? owner : owner2).api("/api/settings/team")).json?.members ?? [])
    .filter((m) => m.role === "owner");
  ok("tras la carrera queda exactamente 1 owner", ownersAfterRace.length === 1, JSON.stringify(ownersAfterRace.map((m) => m.email)));

  // Reparación: el ganador re-promueve al perdedor; luego el owner original
  // degrada al socio (estado final: e2e owner, socio vendedor).
  if (ra.res.status !== 200 && rb.res.status === 200) {
    r = await owner2.api(`/api/settings/team/${me?.id}`, { method: "PATCH", body: body({ role: "owner" }) });
    ok("reparación: el socio re-promueve al owner original", r.res.status === 200, short(r));
    r = await owner.api(`/api/settings/team/${o2?.id}`, { method: "PATCH", body: body({ role: "member" }) });
    ok("reparación: el owner original degrada al socio", r.res.status === 200, short(r));
  }
  const finalTeam = (await owner.api("/api/settings/team")).json?.members ?? [];
  ok(
    "estado final: e2e es el único owner",
    finalTeam.filter((m) => m.role === "owner").map((m) => m.email).join() === OWNER_EMAIL,
    JSON.stringify(finalTeam.map((m) => [m.email, m.role]))
  );

  console.log("\n== f) Restablecer contraseña del vendedor ==");
  r = await owner.api(`/api/settings/team/${sId}/reset-password`, { method: "POST" });
  const temp = r.json?.temporaryPassword;
  ok("POST reset-password → 200 con temporal (≥16)", r.res.status === 200 && typeof temp === "string" && temp.length >= 16, short(r));
  const revoked = await seller.api("/api/conversations");
  ok("la sesión anterior del vendedor quedó revocada (401)", revoked.res.status === 401, short(revoked));
  const oldPw = await signIn(client(), SELLER_EMAIL, SELLER_PASSWORD);
  ok("la contraseña vieja ya no entra", !oldPw.res.ok, short(oldPw));
  const tempIn = await signIn(seller, SELLER_EMAIL, temp ?? "x");
  ok("la temporal entra", tempIn.res.ok, short(tempIn));
  r = await owner.api(`/api/settings/team/${me?.id}/reset-password`, { method: "POST" });
  ok("restablecer la propia por aquí → 409 self_change", r.res.status === 409 && r.json?.error?.code === "self_change", short(r));

  console.log("\n== g) Baja y re-alta ==");
  const alive = await seller.api("/api/conversations");
  ok("el vendedor tiene una sesión viva", alive.res.status === 200, short(alive));
  r = await owner.api(`/api/settings/team/${sId}`, { method: "DELETE" });
  ok("DELETE /api/settings/team/:id → 200", r.res.status === 200, short(r));
  const dead = await seller.api("/api/conversations");
  ok("su siguiente petición → 401", dead.res.status === 401, short(dead));
  ok("ya no aparece en el equipo", (await teamMember(SELLER_EMAIL)) === null);
  const blocked = await signIn(client(), SELLER_EMAIL, temp ?? "x");
  ok(
    "su login → 403 \"Tu acceso fue dado de baja…\"",
    blocked.res.status === 403 && /dado de baja/.test(JSON.stringify(blocked.json)),
    short(blocked)
  );
  const NEW_PW = "password-vuelve-123";
  r = await owner.api("/api/settings/team", {
    method: "POST",
    body: body({ name: "Vendedor E2E", email: SELLER_EMAIL, password: NEW_PW }),
  });
  ok("re-alta con el mismo correo → 201 relinked:true", r.res.status === 201 && r.json?.relinked === true, short(r));
  ok("vuelve a aparecer como member", (await teamMember(SELLER_EMAIL))?.role === "member");
  const back = await signIn(seller, SELLER_EMAIL, NEW_PW);
  ok("vuelve a entrar con la nueva contraseña", back.res.ok, short(back));
  const backApi = await seller.api("/api/conversations");
  ok("y opera (GET /api/conversations → 200)", backApi.res.status === 200, short(backApi));
  r = await owner.api("/api/settings/team", {
    method: "POST",
    body: body({ name: "Vendedor E2E", email: SELLER_EMAIL, password: NEW_PW }),
  });
  ok("re-alta de un miembro activo → 409 duplicate", r.res.status === 409 && r.json?.error?.code === "duplicate", short(r));
  ok("al final sigue habiendo 1 organización", (await countOrgs()) === 1);
}

/** Cookies del jar de Node → cookies del navegador (sin gastar logins). */
function toBrowserCookies(jar) {
  const host = new URL(BASE).hostname;
  return jar.cookie
    .split(/;\s*/)
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf("=");
      return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: host, path: "/" };
    });
}

async function browserChecks() {
  const browser = await chromium.launch();
  try {
    for (const [who, c] of [
      ["vendedor", seller],
      ["owner", owner],
    ]) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      // SSE fuera: cada stream vivo ocupa una ranura de `next dev`.
      await ctx.route("**/api/events*", (route) => route.abort());
      await ctx.addCookies(toBrowserCookies(c.jar));
      const page = await ctx.newPage();
      page.setDefaultTimeout(60000);
      const isSeller = who === "vendedor";

      await page.goto(`${BASE}/inbox`, { waitUntil: "load", timeout: 90000 });
      const nav = page.locator("nav").first();
      await until(async () => (await nav.getByText("Bandeja").count()) > 0);
      const hasAgent = (await nav.getByText("Agente", { exact: true }).count()) > 0;
      const hasLab = (await nav.getByText("Laboratorio", { exact: true }).count()) > 0;
      ok(
        isSeller
          ? `${who}: el lateral NO tiene "Agente" ni "Laboratorio"`
          : `${who}: el lateral SÍ tiene "Agente" y "Laboratorio"`,
        isSeller ? !hasAgent && !hasLab : hasAgent && hasLab,
        `agente=${hasAgent} lab=${hasLab} url=${page.url()}`
      );

      for (const path of ["/agent", "/lab", "/settings/whatsapp", "/settings/team", "/settings/templates"]) {
        const res = await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 90000 });
        const status = res?.status();
        ok(
          `${who}: ${path} → ${isSeller ? "404" : "200"}`,
          isSeller ? status === 404 : status === 200,
          `status=${status}`
        );
      }

      await page.goto(`${BASE}/settings`, { waitUntil: "load", timeout: 90000 });
      const dest = isSeller ? "/settings/account" : "/settings/whatsapp";
      ok(
        `${who}: /settings → ${dest}`,
        await until(() => new URL(page.url()).pathname === dest),
        page.url()
      );

      if (isSeller) {
        await page.goto(`${BASE}/settings/account`, { waitUntil: "load", timeout: 90000 });
        const settingsNav = await page.getByRole("link", { name: "Equipo" }).count();
        ok("vendedor: Ajustes no muestra la pestaña Equipo", settingsNav === 0);
        const NEW_NAME = `Vendedora ${S}`;
        const input = page.locator("#account-name");
        await input.waitFor();
        await input.fill(NEW_NAME);
        // En next dev el clic puede caer antes de hidratar: reintenta.
        const saved = await until(async () => {
          if ((await page.getByText("Nombre guardado").count()) > 0) return true;
          await page.getByRole("button", { name: "Guardar nombre" }).click({ timeout: 2000 });
          await sleep(800);
          return (await page.getByText("Nombre guardado").count()) > 0;
        }, 30000);
        ok("vendedor: Mi cuenta guarda el nombre", saved);
        ok(
          "vendedor: el lateral muestra el nombre nuevo",
          await until(async () => (await page.locator("aside, nav").getByText(NEW_NAME).count()) > 0, 20000)
        );
        const team = await owner.api("/api/settings/team");
        ok(
          "el owner ve el nombre nuevo en Equipo",
          (team.json?.members ?? []).some((m) => m.email === SELLER_EMAIL && m.name === NEW_NAME)
        );
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

main()
  .catch((err) => {
    failures++;
    console.error("ERROR inesperado:", err);
  })
  .finally(async () => {
    await db?.end().catch(() => {});
    console.log(`\n${checks - failures}/${checks} checks OK`);
    process.exit(failures > 0 ? 1 : 0);
  });
