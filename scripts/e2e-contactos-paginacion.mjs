/**
 * Self-test E2E de comportamiento — paginación del directorio de Contactos.
 *
 * Antes: `GET /api/contacts` cortaba en 200 con un `.limit(200)` mudo; con más
 * contactos, el dueño "perdía" el resto (también en la búsqueda y en el filtro
 * por etapa) sin ningún aviso. Ahora pagina con `limit`/`offset` y devuelve
 * `total` + `nextOffset`; la pantalla dice "Mostrando X de Y" y ofrece
 * "Cargar más".
 *
 * Uso: node scripts/e2e-contactos-paginacion.mjs
 * Requiere: app corriendo (pnpm dev) con WA_MOCK_ENABLED=true y Playwright.
 */
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
// Solo LETRAS: la búsqueda también casa teléfonos por dígitos (≥3), y un
// sufijo con números ampliaría `?q=` a contactos ajenos.
const S = Array.from({ length: 5 }, () =>
  String.fromCharCode(65 + Math.floor(Math.random() * 26))
).join("");
const N = 60; // más que una página por defecto (50)
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
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(200);
  }
  return false;
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const req = ctx.request;
const getJson = async (path) => {
  const res = await req.get(`${BASE}${path}`);
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status(), json };
};

console.log("== Setup ==");
let r = await req.post(`${BASE}/api/auth/sign-up/email`, {
  headers: { origin: BASE },
  data: { email: "e2e@vocero.test", password: "password-e2e-123", name: "Operador E2E" },
});
if (!r.ok())
  r = await req.post(`${BASE}/api/auth/sign-in/email`, {
    headers: { origin: BASE },
    data: { email: "e2e@vocero.test", password: "password-e2e-123" },
  });
ok("login", r.ok());

// Nombre con sufijo único: todo lo que sigue se aísla con `?q=Pag${S}` para no
// depender de lo que haya dejado otro guion en la misma BD.
const NAME = `Pag${S}`;
const BASE_TEL = String(Math.floor(Math.random() * 9e5) + 1e5); // 6 dígitos
let created = 0;
for (let i = 0; i < N; i++) {
  const ii = String(i).padStart(2, "0");
  const res = await req.post(`${BASE}/api/contacts`, {
    headers: { origin: BASE },
    data: { name: `${NAME} ${ii}`, phone: `5215580${BASE_TEL}${ii}` },
  });
  if (res.status() === 201) created++;
}
ok(`alta de ${N} contactos de prueba`, created === N, `${created}/${N}`);

console.log("\n== API: total y páginas sin duplicados ni huecos ==");
const q = encodeURIComponent(NAME);
const first = await getJson(`/api/contacts?q=${q}`);
ok("GET sin limit → 200", first.status === 200, String(first.status));
ok("forma compatible: sigue trayendo `contacts`", Array.isArray(first.json?.contacts));
ok(`total = ${N} (cuenta con el mismo filtro)`, first.json?.total === N,
   JSON.stringify(first.json?.total));
ok("default: una página de 50, no todo",
   first.json?.contacts?.length === 50, String(first.json?.contacts?.length));
ok("nextOffset apunta a la página 2", first.json?.nextOffset === 50,
   JSON.stringify(first.json?.nextOffset));

const ids = [];
let offset = 0;
let pages = 0;
let lastNext;
while (offset !== null && pages < 10) {
  const p = await getJson(`/api/contacts?q=${q}&limit=25&offset=${offset}`);
  pages++;
  for (const c of p.json?.contacts ?? []) ids.push(c.id);
  lastNext = p.json?.nextOffset ?? null;
  offset = lastNext;
}
ok("limit=25 → 3 páginas", pages === 3, String(pages));
ok("sin duplicados entre páginas", new Set(ids).size === ids.length,
   `${ids.length} ids, ${new Set(ids).size} únicos`);
ok(`sin huecos: la unión son los ${N}`, new Set(ids).size === N, String(new Set(ids).size));
ok("la última página dice que ya no hay más", lastNext === null, JSON.stringify(lastNext));

const huge = await getJson(`/api/contacts?q=${q}&limit=500`);
ok("limit=500 se ajusta al máximo (200), no responde error",
   huge.status === 200 && huge.json?.contacts?.length === N && huge.json?.nextOffset === null,
   JSON.stringify({ status: huge.status, n: huge.json?.contacts?.length }));
const junk = await getJson(`/api/contacts?q=${q}&limit=abc&offset=-5`);
ok("parámetros basura → default, sin romper",
   junk.status === 200 && junk.json?.contacts?.length === 50,
   JSON.stringify({ status: junk.status, n: junk.json?.contacts?.length }));
const beyond = await getJson(`/api/contacts?q=${q}&offset=1000`);
ok("offset más allá del final → vacío, total intacto, sin siguiente",
   beyond.json?.contacts?.length === 0 && beyond.json?.total === N && beyond.json?.nextOffset === null,
   JSON.stringify(beyond.json));

// Archivar uno: sale del total por defecto y vuelve con `archived=true`.
const archivedId = ids[0];
await req.patch(`${BASE}/api/contacts/${archivedId}`, {
  headers: { origin: BASE },
  data: { archived: true },
});
const sinArch = await getJson(`/api/contacts?q=${q}&limit=200`);
const conArch = await getJson(`/api/contacts?q=${q}&limit=200&archived=true`);
ok("archivado fuera del total por defecto (filtro en SQL, antes de paginar)",
   sinArch.json?.total === N - 1 && sinArch.json?.contacts?.length === N - 1,
   JSON.stringify({ total: sinArch.json?.total, n: sinArch.json?.contacts?.length }));
ok("y dentro con archived=true", conArch.json?.total === N, JSON.stringify(conArch.json?.total));
await req.patch(`${BASE}/api/contacts/${archivedId}`, {
  headers: { origin: BASE },
  data: { archived: false },
});

console.log("\n== UI: Mostrando X de Y + Cargar más ==");
const page = await ctx.newPage();
// `load` y no `commit`: en next dev, un clic antes de hidratar se pierde.
await page.goto(`${BASE}/contacts`, { waitUntil: "load" });
const box = page.getByLabel("Buscar contacto");
await box.waitFor({ timeout: 15000 });
await box.fill(NAME);
const rows = () => page.locator("ul > li").count();
const counter = page.getByText(/Mostrando \d+ de \d+/);

ok("primera página: 50 filas",
   await until(async () => (await rows()) === 50), String(await rows()));
ok(`"Mostrando 50 de ${N}"`,
   await until(async () => (await counter.innerText().catch(() => "")) === `Mostrando 50 de ${N}`),
   await counter.innerText().catch(() => "(no visible)"));
const more = page.getByRole("button", { name: "Cargar más" });
ok("hay botón Cargar más", await more.isVisible());
await more.click();
ok(`tras Cargar más: ${N} filas`,
   await until(async () => (await rows()) === N), String(await rows()));
ok(`"Mostrando ${N} de ${N}"`,
   await until(async () => (await counter.innerText().catch(() => "")) === `Mostrando ${N} de ${N}`),
   await counter.innerText().catch(() => "(no visible)"));
ok("sin más páginas, el botón desaparece",
   await until(async () => !(await more.isVisible())));
const texts = await page.locator("ul > li").allInnerTexts();
const names = texts.map((t) => t.match(new RegExp(`${NAME} \\d{2}`))?.[0]).filter(Boolean);
ok("en pantalla, sin repetidos", new Set(names).size === N, String(new Set(names).size));

// Cambiar la búsqueda reinicia la paginación (no arrastra la página 2).
await box.fill(`${NAME} 0`); // 00..09 → 10
ok("al cambiar la búsqueda se reinicia: 10 de 10",
   await until(async () => (await counter.innerText().catch(() => "")) === "Mostrando 10 de 10"),
   await counter.innerText().catch(() => "(no visible)"));
ok("y sin Cargar más", !(await more.isVisible()));
await box.fill(NAME);
ok("volver a la búsqueda amplia → de nuevo 50 de " + N,
   await until(async () => (await counter.innerText().catch(() => "")) === `Mostrando 50 de ${N}`),
   await counter.innerText().catch(() => "(no visible)"));

await page.screenshot({ path: ".tmp/e2e-contactos-paginacion.png" }).catch(() => {});

await browser.close();
console.log(`\n${failures === 0 ? "TODO VERDE" : `${failures} FALLO(S)`}`);
process.exit(failures ? 1 : 0);
