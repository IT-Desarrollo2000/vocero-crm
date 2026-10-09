/**
 * Self-test E2E de comportamiento — responsividad (teléfono / tableta / escritorio).
 * Guion: tests/e2e/responsividad.md
 *
 * Verifica que el CRM se pueda USAR desde el teléfono, no solo que "quepa":
 *  - el lateral se vuelve cajón con hamburguesa y se cierra al navegar;
 *  - la Bandeja se comporta como maestro-detalle (lista ↔ hilo con "volver");
 *  - el panel de detalles flota sobre el hilo en vez de robarle ancho;
 *  - ninguna pantalla recorta contenido a lo ancho (main no desborda);
 *  - los campos de texto miden ≥16px (si no, iOS hace zoom y descuadra todo);
 *  - en escritorio NADA de lo anterior cambia (el lateral sigue fijo);
 *  - en escritorio el lateral se contrae a iconos y lo recuerda (cookie), sin
 *    afectar al cajón móvil.
 *
 * Uso: node scripts/e2e-responsive.mjs
 * Requiere: app corriendo (pnpm dev) con WA_MOCK_ENABLED=true y Playwright.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const PN = "PN-RESP-1";
const S = Math.random().toString(36).slice(2, 6).toUpperCase();
const SHOTS = "scratch/responsive";
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

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 820, height: 1180 };
const DESKTOP = { width: 1440, height: 900 };
const RUTAS = [
  "/inbox",
  "/pipeline",
  "/contacts",
  "/agent",
  "/lab",
  "/settings/whatsapp",
];

mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: DESKTOP });
const req = ctx.request;
// El canal SSE se corta en el navegador: no aporta nada al diseño y cada
// stream vivo ocupa una ranura del servidor de `next dev` — a la ~15ª carga
// el servidor deja de contestar (se cuelga el guion, no el producto).
await ctx.route("**/api/events*", (route) => route.abort());

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
await req.put(`${BASE}/api/settings/whatsapp`, {
  data: { wabaId: "WABA-RESP", phoneNumberId: PN, token: "tok-resp" },
});

const NAME = `Prospecto${S}`;
await req.post(`${BASE}/api/dev/wa-mock/inbound`, {
  data: {
    phoneNumberId: PN,
    from: `521462${Math.floor(Math.random() * 9e6) + 1e6}`,
    name: NAME,
    text: "hola, vi su anuncio y quiero saber cuánto cuesta el diagnóstico",
    waMessageId: `wamid.resp.${S}`,
  },
});
const listo = await until(async () => {
  const d = await (await req.get(`${BASE}/api/conversations`)).json();
  return d.conversations.some((c) => c.contact.name === NAME);
});
ok("conversación de prueba creada", listo);

// Calienta cada ruta: en `pnpm dev` la primera visita compila (3-4 s) y el
// guion mediría la compilación, no el diseño.
// La primera visita a cada ruta la COMPILA (`next dev`), y algunas pasan de
// los 30 s por defecto de Playwright. Se calientan por HTTP, sin navegador: un
// `page.goto` abriría además el canal SSE de la app, y varias páginas con SSE
// vivo a la vez dejan clavado al servidor de desarrollo.
ctx.setDefaultNavigationTimeout(120000);
ctx.setDefaultTimeout(30000);
for (const ruta of RUTAS) {
  await req.get(`${BASE}${ruta}`, { timeout: 180000 });
}

/** Ancho real del contenido contra el ancho visible del contenedor. */
const desborde = (page) =>
  page.evaluate(() => {
    const main = document.querySelector("main");
    const doc = document.documentElement;
    return {
      mainOver: main ? main.scrollWidth - main.clientWidth : 0,
      docOver: doc.scrollWidth - window.innerWidth,
    };
  });

async function recorrer(page, etiqueta) {
  for (const ruta of RUTAS) {
    await page.goto(`${BASE}${ruta}`, { waitUntil: "domcontentloaded" });
    // Nada de `networkidle`: el canal SSE queda abierto a propósito y la
    // espera nunca se cumpliría.
    await sleep(900);
    const d = await desborde(page);
    ok(
      `${etiqueta} ${ruta} sin recorte horizontal`,
      d.mainOver <= 1 && d.docOver <= 1,
      `main +${d.mainOver}px · documento +${d.docOver}px`
    );
    await page.screenshot({
      path: `${SHOTS}/${etiqueta}${ruta.replace(/\//g, "-")}.png`,
      fullPage: false,
    });
  }
}

console.log("\n== 1. Teléfono (390×844): ninguna pantalla se recorta ==");
const phone = await ctx.newPage();
await phone.setViewportSize(PHONE);
await recorrer(phone, "phone");

console.log("\n== 2. Teléfono: el lateral es un cajón con hamburguesa ==");
await phone.goto(`${BASE}/pipeline`);
const hamburguesa = phone.getByRole("button", { name: "Abrir el menú" });
await hamburguesa.waitFor({ timeout: 20000 });
ok("la hamburguesa se ve", await hamburguesa.isVisible());
const linkBandeja = phone.getByRole("link", { name: /Bandeja/ });
ok(
  "el lateral arranca oculto (sus enlaces no son alcanzables)",
  !(await linkBandeja.isVisible())
);
await hamburguesa.click();
ok(
  "al tocar la hamburguesa el cajón abre",
  await until(async () => await linkBandeja.isVisible(), 3000)
);
// El cajón NO debe empujar el contenido: sale encima.
const encima = await phone.evaluate(() => {
  const aside = document.querySelector("aside");
  const main = document.querySelector("main");
  if (!aside || !main) return null;
  const a = aside.getBoundingClientRect();
  const m = main.getBoundingClientRect();
  return { asideLeft: Math.round(a.left), mainLeft: Math.round(m.left) };
});
ok(
  "el cajón flota encima del contenido (no lo empuja)",
  encima !== null && encima.asideLeft <= 1 && encima.mainLeft <= 1,
  JSON.stringify(encima)
);
await phone.screenshot({ path: `${SHOTS}/phone-cajon-abierto.png` });
await linkBandeja.click();
await until(async () => phone.url().includes("/inbox"), 15000);
ok("navegar desde el cajón lleva a la Bandeja", phone.url().includes("/inbox"));
ok(
  "el cajón se cierra solo al navegar",
  await until(async () => !(await linkBandeja.isVisible()), 5000)
);

console.log("\n== 3. Teléfono: la Bandeja es maestro-detalle ==");
await phone.goto(`${BASE}/inbox`);
const fila = phone.getByText(NAME).first();
await fila.waitFor({ timeout: 20000 });
ok("la lista de conversaciones ocupa la pantalla", await fila.isVisible());
const anchoLista = await phone.evaluate(() => {
  const sec = document.querySelector("main > div > section");
  return sec ? Math.round(sec.getBoundingClientRect().width) : 0;
});
ok(
  "la lista usa el ancho completo del teléfono",
  anchoLista >= PHONE.width - 8,
  `${anchoLista}px de ${PHONE.width}`
);
await fila.click();
const composer = phone.getByPlaceholder("Escribe una respuesta");
ok(
  "al elegir una conversación se abre el hilo",
  await until(async () => await composer.isVisible(), 15000)
);
ok("la lista cede la pantalla al hilo", !(await fila.isVisible()));
const volver = phone.getByRole("button", { name: "Volver a las conversaciones" });
ok("aparece el botón de volver", await volver.isVisible());
await phone.screenshot({ path: `${SHOTS}/phone-hilo.png` });

// El compositor debe quedar DENTRO de la pantalla (100dvh, no 100vh).
const compBox = await composer.boundingBox();
ok(
  "el compositor queda dentro de la pantalla",
  compBox !== null && compBox.y + compBox.height <= PHONE.height,
  compBox ? `borde inferior en ${Math.round(compBox.y + compBox.height)}px` : "sin caja"
);
// iOS: menos de 16px = zoom automático al enfocar.
const fuenteComp = await composer.evaluate((el) =>
  parseFloat(getComputedStyle(el).fontSize)
);
ok(
  "el compositor usa ≥16px (iOS no hace zoom al enfocar)",
  fuenteComp >= 16,
  `${fuenteComp}px`
);

console.log("\n== 4. Teléfono: los detalles flotan sobre el hilo ==");
const abrirDetalles = phone.getByRole("button", { name: "Mostrar detalles" });
ok("el panel de detalles arranca cerrado en el teléfono", await abrirDetalles.isVisible());
await abrirDetalles.click();
await sleep(500);
const cajonDetalles = await phone.evaluate(() => {
  const secs = [...document.querySelectorAll("main > div > section")];
  const panel = secs[secs.length - 1];
  if (!panel) return null;
  const r = panel.getBoundingClientRect();
  return {
    right: Math.round(r.right),
    width: Math.round(r.width),
    fixed: getComputedStyle(panel).position === "fixed",
  };
});
ok(
  "los detalles entran como cajón pegado al borde derecho",
  cajonDetalles !== null &&
    cajonDetalles.fixed &&
    Math.abs(cajonDetalles.right - PHONE.width) <= 2 &&
    cajonDetalles.width <= PHONE.width,
  JSON.stringify(cajonDetalles)
);
const dEnDetalles = await desborde(phone);
ok(
  "con los detalles abiertos la pantalla sigue sin recortarse",
  dEnDetalles.docOver <= 1,
  `documento +${dEnDetalles.docOver}px`
);
await phone.screenshot({ path: `${SHOTS}/phone-detalles.png` });
await phone
  .getByRole("button", { name: "Cerrar los detalles" })
  .click()
  .catch(() => null);
await sleep(400);

console.log("\n== 5. Tableta (820×1180) ==");
const tablet = phone;
await tablet.setViewportSize(TABLET);
await recorrer(tablet, "tablet");
await tablet.goto(`${BASE}/inbox`);
await tablet.getByText(NAME).first().click();
await tablet.getByPlaceholder("Escribe una respuesta").waitFor({ timeout: 20000 });
const dosColumnas = await tablet.evaluate(() => {
  const secs = [...document.querySelectorAll("main > div > section")];
  return secs.slice(0, 2).map((s) => Math.round(s.getBoundingClientRect().width));
});
ok(
  "en tableta conviven lista e hilo (dos columnas)",
  dosColumnas.length === 2 && dosColumnas[0] > 200 && dosColumnas[1] > 300,
  JSON.stringify(dosColumnas)
);
await tablet.screenshot({ path: `${SHOTS}/tablet-inbox.png` });

console.log("\n== 6. Escritorio (1440×900): nada cambió ==");
const desk = tablet;
await desk.setViewportSize(DESKTOP);
await recorrer(desk, "desktop");
await desk.goto(`${BASE}/inbox`);
await desk.getByText(NAME).first().click();
await desk.getByPlaceholder("Escribe una respuesta").waitFor({ timeout: 20000 });
ok(
  "el lateral sigue fijo (sin hamburguesa)",
  !(await desk.getByRole("button", { name: "Abrir el menú" }).isVisible()) &&
    (await desk.getByRole("link", { name: /Bandeja/ }).isVisible())
);
const medirColumnas = () =>
  desk.evaluate(() => {
    const aside = document.querySelector("aside");
    const secs = [...document.querySelectorAll("main > div > section")];
    return {
      aside: aside ? Math.round(aside.getBoundingClientRect().width) : 0,
      secs: secs.map((s) => Math.round(s.getBoundingClientRect().width)),
    };
  });
// El panel abre con transición de 220 ms: medir apenas aparece el compositor
// atraparía un ancho a medio camino.
const columnasOk = (t) =>
  t.aside === 224 && t.secs[0] === 360 && t.secs.at(-1) === 320;
await until(async () => columnasOk(await medirColumnas()), 8000);
const tres = await medirColumnas();
ok(
  "escritorio conserva lateral 224px + lista 360px + hilo + detalles 320px",
  columnasOk(tres),
  JSON.stringify(tres)
);
await desk.screenshot({ path: `${SHOTS}/desktop-inbox.png` });
// Las pastillas (Todas / No leídas / Atención humana) y el selector de etapa
// no se salen de la columna de 360px: si no caben, bajan de línea.
const filtros = await desk.evaluate(() => {
  const lista = document.querySelector("main > div > section");
  const sel = document.querySelector('select[aria-label="Filtrar por etapa del embudo"]');
  const pastilla = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("Atención humana")
  );
  if (!lista || !sel || !pastilla) return null;
  const l = lista.getBoundingClientRect();
  const dentro = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.left >= l.left && r.right <= l.right + 0.5;
  };
  return { selector: dentro(sel), pastilla: dentro(pastilla) };
});
ok(
  "los filtros de la Bandeja caben en la columna (nada se sale por la derecha)",
  filtros?.selector === true && filtros?.pastilla === true,
  JSON.stringify(filtros)
);

console.log("\n== 7. Escritorio: el lateral se contrae y lo recuerda ==");
const anchoLateral = () =>
  desk.evaluate(() => {
    const aside = document.querySelector("aside");
    return aside ? Math.round(aside.getBoundingClientRect().width) : 0;
  });
// El ancho se anima (200 ms): se espera a que asiente en vez de medir de una.
const asienta = (px) => until(async () => (await anchoLateral()) === px, 5000);
await desk.getByRole("button", { name: "Contraer menú" }).click();
ok("al contraer, el lateral mide 64px", await asienta(64), `${await anchoLateral()}px`);
ok(
  "contraído, la Bandeja sigue alcanzable por su nombre",
  await desk.getByRole("link", { name: /Bandeja/ }).isVisible()
);
await desk.screenshot({ path: `${SHOTS}/desktop-lateral-contraido.png` });
// "load" (no "domcontentloaded"): en dev React tarda en hidratar y un clic
// antes de eso cae en un botón sin manejador.
await desk.reload({ waitUntil: "load" });
const expandir = desk.getByRole("button", { name: "Expandir menú" });
await expandir.waitFor({ timeout: 20000 });
ok(
  "al recargar sigue contraído (la cookie persistió)",
  await asienta(64),
  `${await anchoLateral()}px`
);
// Reintenta solo mientras siga diciendo "Expandir": si el primer clic llegó
// antes de hidratar no hizo nada, y si ya expandió no se vuelve a alternar.
await until(async () => {
  if (await expandir.isVisible()) await expandir.click({ timeout: 2000 });
  return (await anchoLateral()) === 224;
}, 10000);
ok("al expandir vuelve a 224px", await asienta(224), `${await anchoLateral()}px`);

console.log("\n== 8. Teléfono: la cookie contraída no encoge el cajón ==");
await ctx.addCookies([
  { name: "vocero-nav-collapsed", value: "1", url: BASE },
]);
await desk.setViewportSize(PHONE);
await desk.goto(`${BASE}/pipeline`, { waitUntil: "load" });
const abrir = desk.getByRole("button", { name: "Abrir el menú" });
await abrir.waitFor({ timeout: 20000 });
// Mismo cuidado con la hidratación: se reintenta mientras el cajón no abra.
await until(async () => {
  const visible = await desk.getByRole("link", { name: /Bandeja/ }).isVisible();
  if (!visible) await abrir.click({ timeout: 2000 });
  return visible;
}, 10000);
// 17rem = 272px: el ancho del cajón de siempre.
ok(
  "en móvil el cajón abre completo aunque la cookie diga contraído",
  await until(async () => (await anchoLateral()) === 272, 3000),
  `${await anchoLateral()}px`
);
ok(
  "en móvil el cajón muestra las etiquetas",
  await desk.locator("aside").getByText("Bandeja", { exact: true }).isVisible()
);
ok(
  "en móvil no aparece el botón de contraer",
  !(await desk.getByRole("button", { name: /(Contraer|Expandir) menú/ }).isVisible())
);
// Deja la cookie expandida: otros guiones comparten el navegador/la sesión.
await ctx.addCookies([
  { name: "vocero-nav-collapsed", value: "0", url: BASE },
]);

console.log("\n== 9. Agente: el interruptor de encendido no se sale del riel ==");
await desk.setViewportSize({ width: 1400, height: 900 });
await desk.goto(`${BASE}/agent`, { waitUntil: "load" });
const sw = desk.getByRole("switch", { name: "Agente encendido" });
await sw.waitFor({ timeout: 20000 });
// Margen de la perilla a cada lado del riel (px). Antes era absolute sin
// left: quedaba centrada y al encender se salía por la derecha.
const margenes = () =>
  sw.evaluate((el) => {
    const t = el.getBoundingClientRect();
    const k = el.firstElementChild.getBoundingClientRect();
    return {
      on: el.getAttribute("aria-checked") === "true",
      izq: Math.round(k.left - t.left),
      der: Math.round(t.right - k.right),
      arriba: Math.round(k.top - t.top),
      abajo: Math.round(t.bottom - k.bottom),
    };
  });
const dentro = (m) =>
  m.izq >= 1 &&
  m.der >= 1 &&
  Math.abs(m.arriba - m.abajo) <= 1 &&
  (m.on ? m.der <= 3 : m.izq <= 3);
// La perilla anima (transition-transform): se espera a que asiente.
const asientaSw = async () => {
  let m = await margenes();
  await until(async () => dentro((m = await margenes())), 3000);
  return m;
};
const estado = (m) => (m.on ? "encendido" : "apagado");
const antes = await asientaSw();
ok(`perilla dentro del riel (${estado(antes)})`, dentro(antes), JSON.stringify(antes));
if (await sw.isEnabled()) {
  // Un solo clic (la página ya cargó con "load"): reintentar podría alternarlo
  // dos veces mientras se guarda el perfil.
  await sw.click();
  await until(async () => (await margenes()).on !== antes.on, 8000);
  const despues = await asientaSw();
  ok(`perilla dentro del riel (${estado(despues)})`, dentro(despues), JSON.stringify(despues));
  // Deja el agente como estaba: otros guiones dependen de él.
  await sw.click();
  await until(async () => (await margenes()).on === antes.on, 5000);
}

console.log(
  failures === 0
    ? `\n✅ Responsividad: todo verde. Capturas en ${SHOTS}/`
    : `\n❌ Responsividad: ${failures} fallo(s). Capturas en ${SHOTS}/`
);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
