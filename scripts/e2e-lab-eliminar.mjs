/**
 * Self-test E2E de comportamiento — Laboratorio: eliminar una evaluación
 * desde la UI. Guion: tests/e2e/us4-lab.md ("Eliminar una evaluación — UI").
 *
 * La API (409 en curso, 200, 404, cascada de conversaciones de prueba) ya la
 * cubre `labChecks` en scripts/e2e-selftest.mjs; aquí se prueba lo que solo se
 * ve en pantalla:
 *  - la fila de una corrida en curso NO ofrece "Eliminar evaluación";
 *  - "Cancelar" en la confirmación no borra nada (ni siquiera llama al DELETE);
 *  - "Sí, eliminar" quita la fila, la corrida responde 404 y, si era la
 *    seleccionada, el reporte pasa a la siguiente corrida (sin errores de
 *    página).
 *
 * El id de la corrida nunca se pinta: lo que muestra el panel de reporte se
 * observa en el cable (GET /api/lab/runs/:id que lo alimenta).
 *
 * Uso: node --env-file=.env.e2e scripts/e2e-lab-eliminar.mjs
 * Requiere: app corriendo (pnpm dev) con WA_MOCK_ENABLED=true, el proveedor de
 * IA apuntando al ai-mock (OPENROUTER_BASE_URL) y Playwright.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const SHOTS = "scratch/lab";
const LAB_TIMEOUT_MS = 180_000;
let failures = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
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

mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const req = ctx.request;
ctx.setDefaultNavigationTimeout(120000);
ctx.setDefaultTimeout(30000);

const fin = async () => {
  console.log(
    failures === 0
      ? `\n✅ Laboratorio (eliminar): todo verde. Capturas en ${SHOTS}/`
      : `\n❌ Laboratorio (eliminar): ${failures} fallo(s). Capturas en ${SHOTS}/`
  );
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
};

const listarCorridas = async () =>
  (await (await req.get(`${BASE}/api/lab/runs`)).json()).runs ?? [];

/** Espera a que la corrida deje de estar `running`; devuelve su estado final. */
async function esperarFin(runId) {
  const t0 = Date.now();
  let status = "running";
  await until(async () => {
    const d = await req.get(`${BASE}/api/lab/runs/${runId}`);
    status = (await d.json())?.run?.status ?? `http ${d.status()}`;
    return status !== "running";
  }, LAB_TIMEOUT_MS);
  console.log(
    `  ..  corrida ${runId} terminó en ${((Date.now() - t0) / 1000).toFixed(1)}s (status=${status})`
  );
  return status;
}

async function lanzar() {
  const r = await req.post(`${BASE}/api/lab/runs`);
  const data = await r.json().catch(() => null);
  if (data?.error?.code === "ai_not_configured") {
    ok(
      "el proveedor de IA está configurado (OPENROUTER_API_TOKEN + OPENROUTER_BASE_URL → ai-mock)",
      false,
      JSON.stringify(data)
    );
    await fin();
  }
  ok(
    "POST /api/lab/runs → 202 con runId",
    r.status() === 202 && !!data?.runId,
    `status=${r.status()} ${JSON.stringify(data)}`
  );
  if (!data?.runId) await fin();
  return data.runId;
}

console.log("== Setup ==");
let r = await req.post(`${BASE}/api/auth/sign-up/email`, {
  headers: { origin: BASE },
  data: {
    email: "e2e@vocero.test",
    password: "password-e2e-123",
    name: "Operador E2E",
  },
});
if (!r.ok())
  r = await req.post(`${BASE}/api/auth/sign-in/email`, {
    headers: { origin: BASE },
    data: { email: "e2e@vocero.test", password: "password-e2e-123" },
  });
ok("login", r.ok());
if (!r.ok()) await fin();

// Una corrida huérfana de una ejecución abortada bloquearía el POST.
ok(
  "no hay corridas del Laboratorio en curso",
  await until(
    async () => !(await listarCorridas()).some((c) => c.status === "running"),
    LAB_TIMEOUT_MS
  )
);

// La primera visita COMPILA la ruta en `next dev`: se calienta por HTTP para
// que la corrida en curso no termine mientras la página aún se compila.
await req.get(`${BASE}/lab`, { timeout: 180000 });

const page = await ctx.newPage();
const erroresPagina = [];
page.on("pageerror", (e) => erroresPagina.push(e.message));
const deletes = [];
page.on("request", (q) => {
  if (q.method() === "DELETE" && q.url().includes("/api/lab/runs/"))
    deletes.push(q.url());
});

// Filas del historial: hijos `div.rounded-lg` del bloque que lleva "Historial".
// La API ordena por fecha descendente: la fila 0 es la más reciente.
const historial = page
  .locator("div.space-y-2")
  .filter({ has: page.getByText("Historial", { exact: true }) });
const filas = historial.locator(":scope > div.rounded-lg");
const reporte = page.getByText("Reporte", { exact: true });

// "load" (no "domcontentloaded"): en dev React tarda en hidratar y un clic
// antes de eso cae en un botón sin manejador. Nada de `networkidle`: el canal
// SSE queda abierto a propósito y la espera nunca se cumpliría.
await page.goto(`${BASE}/lab`, { waitUntil: "load" });
await page.getByRole("button", { name: /Correr evaluación|Corrida en curso/ }).waitFor();

console.log("\n== 1. Una corrida en curso no se puede eliminar desde la UI ==");
const runA = await lanzar();
await page.reload({ waitUntil: "load" });
const filaEnCurso = filas.first();
await until(async () => (await filas.count()) > 0, 20000);
const enCursoPintada = await until(
  async () => await filaEnCurso.getByText("En curso…").isVisible(),
  10000
);
const siguePorApi =
  (await (await req.get(`${BASE}/api/lab/runs/${runA}`)).json())?.run?.status ===
  "running";
ok(
  "la fila más reciente muestra la corrida en curso",
  enCursoPintada,
  siguePorApi
    ? "la API dice running pero la fila no lo pinta"
    : "la corrida terminó antes de pintar la página (prueba no concluyente)"
);
ok(
  "la fila en curso NO ofrece 'Eliminar evaluación'",
  enCursoPintada &&
    (await filaEnCurso.getByRole("button", { name: "Eliminar evaluación" }).count()) === 0
);
await page.screenshot({ path: `${SHOTS}/1-en-curso.png` });

console.log("\n== 2. Dos corridas terminadas ==");
const finA = await esperarFin(runA);
ok("la primera corrida termina (done/failed)", finA === "done" || finA === "failed", finA);
const runB = await lanzar();
const finB = await esperarFin(runB);
ok("la segunda corrida termina (done/failed)", finB === "done" || finB === "failed", finB);
if (finA === "running" || finB === "running") await fin();

await page.reload({ waitUntil: "load" });
const corridas = await listarCorridas();
ok(
  "la API lista la corrida nueva primero y la anterior después",
  corridas[0]?.id === runB && corridas[1]?.id === runA,
  JSON.stringify(corridas.slice(0, 2).map((c) => c.id))
);
await until(async () => (await filas.count()) === corridas.length, 20000);
const filasAntes = await filas.count();
ok(
  "el historial pinta una fila por corrida",
  filasAntes === corridas.length && filasAntes >= 2,
  `${filasAntes} filas, ${corridas.length} corridas`
);
await page.screenshot({ path: `${SHOTS}/2-antes.png` });

console.log("\n== 3. Cancelar no borra nada ==");
const primera = filas.first();
const papelera = primera.getByRole("button", { name: "Eliminar evaluación" });
const confirmar = primera.getByRole("button", { name: "Sí, eliminar" });
const pregunta = primera.getByText("¿Eliminar?");
// Reintenta solo mientras no aparezca la confirmación: si el primer clic cayó
// antes de hidratar no hizo nada, y una vez abierta la papelera desaparece.
const abrirConfirmacion = () =>
  until(async () => {
    if (await pregunta.isVisible()) return true;
    await papelera.click({ timeout: 2000 });
    return await pregunta.isVisible();
  }, 15000);
ok("la papelera abre la confirmación", await abrirConfirmacion());
ok("se ve '¿Eliminar?' y el botón 'Sí, eliminar'", await confirmar.isVisible());
ok(
  "mientras confirma, la papelera de esa fila se oculta",
  !(await papelera.isVisible())
);
await primera.getByRole("button", { name: "Cancelar" }).click();
ok(
  "'Cancelar' cierra la confirmación y vuelve la papelera",
  await until(async () => !(await pregunta.isVisible()) && (await papelera.isVisible()), 5000)
);
await sleep(500);
ok("el nº de filas no cambió", (await filas.count()) === filasAntes, `${await filas.count()} filas`);
ok("no se llamó al DELETE", deletes.length === 0, deletes.join(", "));
const sigue = await req.get(`${BASE}/api/lab/runs/${runB}`);
ok("la corrida sigue existiendo (GET → 200)", sigue.status() === 200, `status=${sigue.status()}`);

console.log("\n== 4. Eliminar la corrida seleccionada ==");
// Primero la anterior y luego la más reciente: así se comprueba que el panel
// de reporte de verdad sigue a la selección.
const detalleDe = (id) =>
  page.waitForResponse(
    (res) =>
      res.request().method() === "GET" &&
      res.url().endsWith(`/api/lab/runs/${id}`) &&
      res.status() === 200,
    { timeout: 20000 }
  );
let espera = detalleDe(runA);
await filas.nth(1).locator("button").first().click();
ok("al elegir la corrida anterior, el reporte la carga", !!(await espera.catch(() => null)));
espera = detalleDe(runB);
await primera.locator("button").first().click();
ok("al elegir la más reciente, el reporte la carga", !!(await espera.catch(() => null)));
ok(
  "la fila elegida queda marcada como seleccionada",
  await until(
    async () => /border-brand/.test((await primera.getAttribute("class")) ?? ""),
    5000
  )
);
ok("el panel muestra el reporte", await reporte.isVisible());

const detalleTras = page
  .waitForResponse(
    (res) =>
      res.request().method() === "GET" &&
      /\/api\/lab\/runs\/[^/?]+$/.test(new URL(res.url()).pathname) &&
      !res.url().endsWith(`/api/lab/runs/${runB}`),
    { timeout: 20000 }
  )
  .catch(() => null);
ok("la papelera abre la confirmación", await abrirConfirmacion());
const respDelete = page
  .waitForResponse(
    (res) => res.request().method() === "DELETE" && res.url().endsWith(`/api/lab/runs/${runB}`),
    { timeout: 20000 }
  )
  .catch(() => null);
await confirmar.click();
const del = await respDelete;
ok("'Sí, eliminar' llama al DELETE → 200", del?.status() === 200, `status=${del?.status()}`);
ok(
  "la fila desaparece (nº de filas −1)",
  await until(async () => (await filas.count()) === filasAntes - 1, 10000),
  `${await filas.count()} filas (antes ${filasAntes})`
);
const borrada = await req.get(`${BASE}/api/lab/runs/${runB}`);
ok("GET /api/lab/runs/:id de la eliminada → 404", borrada.status() === 404, `status=${borrada.status()}`);
ok(
  "la lista de la API ya no la incluye",
  !(await listarCorridas()).some((c) => c.id === runB)
);
const siguiente = await detalleTras;
ok(
  "el reporte se autoselecciona en la siguiente corrida",
  siguiente?.url().endsWith(`/api/lab/runs/${runA}`) && siguiente.status() === 200,
  siguiente ? `${siguiente.status()} ${siguiente.url()}` : "no se pidió otro detalle"
);
ok(
  "la nueva primera fila (la siguiente) queda seleccionada",
  await until(
    async () => /border-brand/.test((await filas.first().getAttribute("class")) ?? ""),
    5000
  )
);
ok("el panel sigue mostrando un reporte (no el estado vacío)", await reporte.isVisible());
await page.screenshot({ path: `${SHOTS}/3-despues.png` });
ok("sin errores de página", erroresPagina.length === 0, erroresPagina.join(" | "));

await fin();
