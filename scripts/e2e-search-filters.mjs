/**
 * Self-test E2E de comportamiento — búsqueda de la Bandeja y filtro por etapa
 * del embudo (Bandeja + Contactos). Guion tests/e2e/us-busqueda-filtros.md.
 *
 * Reproduce el fallo reportado el 2026-08-05: teclear en el buscador mientras
 * la página aún hidrata descartaba el texto en silencio, y el teléfono solo
 * se encontraba con los dígitos crudos (no como se pinta en pantalla).
 *
 * Uso: node scripts/e2e-search-filters.mjs
 * Requiere: app corriendo (pnpm dev) con WA_MOCK_ENABLED=true y Playwright.
 */
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const PN = "PN-SEARCH-1";
const S = Math.random().toString(36).slice(2, 6).toUpperCase();
let failures = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const req = ctx.request;

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
await req.put(`${BASE}/api/settings/whatsapp`, {
  data: { wabaId: "WABA-SEARCH", phoneNumberId: PN, token: "tok-s" },
});

const SUF = String(Math.floor(Math.random() * 9e6) + 1e6); // 7 dígitos únicos
const PHONE = `521462${SUF}`; // Meta manda 521…; el CRM canoniza a 52…
const PHONE2 = `521559${SUF}`;
const FMT = `+52 462 ${SUF.slice(0, 3)} ${SUF.slice(3)}`;
const people = [
  { from: PHONE, name: `Zoraida${S} Belier`, text: "hola, vi su anuncio" },
  { from: PHONE2, name: `Josué${S} Ramírez`, text: "quiero informes" },
  { fromUserId: `bsu_${S}`, name: `Anónima${S} Sin Tel`, text: "buenas" },
];
for (const [i, p] of people.entries()) {
  await req.post(`${BASE}/api/dev/wa-mock/inbound`, {
    data: { phoneNumberId: PN, ...p, waMessageId: `wamid.s.${S}.${i}` },
  });
}
await new Promise((res) => setTimeout(res, 2500));
const convs = (await (await req.get(`${BASE}/api/conversations`)).json()).conversations;
ok("las 3 personas de prueba están en la bandeja",
   people.every((p) => convs.some((c) => c.contact.name === p.name)),
   JSON.stringify(convs.map((c) => c.contact.name)));

const page = await ctx.newPage();
// Una entrada por FILA (022: la fila lleva además el botón de archivar).
const rows = () => page.locator("ul > li[data-conversation-id]").allInnerTexts();

/**
 * 06: búsqueda, etapa y pastillas son filtros de SERVIDOR (la búsqueda con
 * debounce de 300 ms + la petición). Una espera fija de 300-400 ms corría
 * contra esa petición; se espera la respuesta de la lista con los
 * parámetros esperados (`want(params)`) y un respiro para pintar. Si la
 * acción no cambia nada (no hay petición), se sigue al vencer el tope.
 */
const settle = async (action, want = () => true) => {
  const resp = page
    .waitForResponse((r) => {
      const u = new URL(r.url());
      return u.pathname === "/api/conversations" && u.searchParams.has("limit") &&
        !u.searchParams.has("cursor") && want(u.searchParams);
    }, { timeout: 8000 })
    .catch(() => null);
  await action();
  await resp;
  await page.waitForTimeout(150);
};
const withQ = (q) => (p) => (p.get("q") ?? "") === q.trim();

console.log("\n== Bandeja: teclear mientras la página aún carga (el bug) ==");
await page.goto(`${BASE}/inbox`, { waitUntil: "commit" });
const box = page.getByLabel("Buscar conversación");
await box.waitFor({ timeout: 15000 });
await box.fill(`Zoraida${S}`); // sucede ANTES de que hidrate React
await page.getByText(`Zoraida${S}`).first().waitFor({ timeout: 20000 });
await page.waitForTimeout(2500);

ok("el texto tecleado sobrevive a la hidratación",
   (await box.inputValue()) === `Zoraida${S}`, JSON.stringify(await box.inputValue()));
let list = await rows();
ok("y la lista quedó filtrada a esa persona",
   list.length === 1 && list[0].includes(`Zoraida${S}`), JSON.stringify(list));

console.log("\n== Bandeja: búsqueda tolerante ==");
const search = async (q) => {
  await settle(() => box.fill(q), withQ(q));
  return rows();
};
const has = (l, name) => l.some((t) => t.includes(name));

list = await search(`josue${S}`.toLowerCase());
ok("'josue' encuentra a 'Josué' (sin acento)", has(list, `Josué${S}`), JSON.stringify(list.length));
list = await search(`RAMÍREZ`);
ok("mayúsculas y acentos indistintos", has(list, `Josué${S}`), JSON.stringify(list.length));
list = await search(FMT);
ok("teléfono con formato, tal como se ve en pantalla", has(list, `Zoraida${S}`), JSON.stringify(list));
list = await search(`462 ${SUF.slice(0,3)}`);
ok("fragmento de teléfono con espacios", has(list, `Zoraida${S}`), JSON.stringify(list));
list = await search(`462-${SUF.slice(0,3)}-${SUF.slice(3)}`);
ok("teléfono con guiones", has(list, `Zoraida${S}`), JSON.stringify(list));
list = await search("vi su anuncio");
ok("NO busca dentro de los mensajes (el nombre del dueño los inunda)",
   !has(list, `Zoraida${S}`), JSON.stringify(list));
list = await search(`Zoraida${S} Belier`);
ok("nombre completo, con espacio, coincide", has(list, `Zoraida${S}`), JSON.stringify(list.length));
list = await search(`zzz-no-existe-${S}`);
ok("sin coincidencias → lista vacía", list.length === 0, JSON.stringify(list));
list = await search("46");
ok("dos dígitos sueltos no emparejan teléfonos",
   !has(list, `Zoraida${S}`), JSON.stringify(list));

await search(`Zoraida${S}`);
await settle(() => page.getByLabel("Limpiar búsqueda").click(), withQ(""));
ok("el botón X limpia la búsqueda", (await box.inputValue()) === "");
ok("y vuelven todas las conversaciones", (await rows()).length >= 3);

console.log("\n== Bandeja: filtro por etapa del embudo ==");
// 020 (rediseño 4.4): la etapa vive en el panel "Filtros" (combinable con la
// vista). Se abre el panel antes de tocarla y se cierra con "Listo".
const filtrosBtn = page.getByRole("button", { name: /^Filtros/ });
const abrirFiltros = async () => {
  if ((await filtrosBtn.getAttribute("aria-expanded")) !== "true") await filtrosBtn.click();
  await page.getByRole("dialog", { name: "Filtros de la Bandeja" }).waitFor({ timeout: 5000 });
};
const cerrarFiltros = async () => {
  const listo = page.getByRole("button", { name: "Listo" });
  if (await listo.isVisible().catch(() => false)) await listo.click();
};
const rowOf2 = (l, name) => l.find((t) => t.includes(name)) ?? "";
await abrirFiltros();
const sel = page.getByLabel("Filtrar por etapa del embudo");
ok("el selector de etapa existe (dentro del panel Filtros)", await sel.isVisible());
const options = await sel.locator("option").allInnerTexts();
ok("ofrece 'Toda etapa' + las etapas presentes",
   options[0] === "Toda etapa" && options.length > 1, JSON.stringify(options));
const stage = options[1];
await settle(() => sel.selectOption(stage), (p) => p.has("stage"));
list = await rows();
ok(`filtrar por '${stage}' deja solo esa etapa`,
   list.length > 0 && list.every((t) => t.includes(stage)), JSON.stringify(list.length));
await settle(() => sel.selectOption("all"), (p) => !p.has("stage"));
ok("volver a 'Toda etapa' restaura la lista", (await rows()).length >= 3);

await settle(() => box.fill(`Zoraida${S}`), withQ(`Zoraida${S}`));
await settle(() => sel.selectOption(stage), (p) => p.has("stage") && withQ(`Zoraida${S}`)(p));
list = await rows();
ok("búsqueda y etapa se combinan (nunca contradicen)",
   list.every((t) => t.includes(`Zoraida${S}`) && t.includes(stage)), JSON.stringify(list));
await page.screenshot({ path: ".tmp/e2e-inbox.png" });

console.log("\n== Bandeja (020): botón Filtros, etiquetas removibles y estado en la URL ==");
await cerrarFiltros();
ok("el botón dice cuántos filtros hay activos",
   /\(1 activos\)/.test((await filtrosBtn.getAttribute("aria-label")) ?? ""),
   await filtrosBtn.getAttribute("aria-label"));
ok("el filtro activo se ve como etiqueta removible",
   await page.getByRole("button", { name: `Quitar filtro: Etapa: ${stage}` }).isVisible());
const urlNow = new URL(page.url());
ok("la URL guarda la búsqueda y la etapa",
   urlNow.searchParams.get("q") === `Zoraida${S}` && urlNow.searchParams.has("stage"),
   urlNow.search);
await page.reload({ waitUntil: "load" });
await page.getByText(`Zoraida${S}`).first().waitFor({ timeout: 20000 });
await page.waitForTimeout(800);
list = await rows();
ok("al recargar, los filtros siguen puestos (vienen de la URL)",
   list.length >= 1 && list.every((t) => t.includes(`Zoraida${S}`) && t.includes(stage)) &&
     (await box.inputValue()) === `Zoraida${S}`,
   JSON.stringify({ list, box: await box.inputValue() }));
await settle(
  () => page.getByRole("button", { name: `Quitar filtro: Etapa: ${stage}` }).click(),
  (p) => !p.has("stage")
);
ok("la x quita el filtro (y sale de la URL)",
   !new URL(page.url()).searchParams.has("stage") &&
     !(await page.getByRole("button", { name: /^Quitar filtro: Etapa/ }).isVisible().catch(() => false)));

console.log("\n== Bandeja (020): filtro Origen + etiqueta del anuncio ==");
const PUB = `Publi${S} Anuncio`;
await req.post(`${BASE}/api/dev/wa-mock/inbound`, {
  data: {
    phoneNumberId: PN,
    from: `521477${SUF}`,
    name: PUB,
    text: "vengo del anuncio",
    adHeadline: `Promo ${S}`,
    adSourceId: `1209${SUF}`,
    waMessageId: `wamid.s.${S}.ad`,
  },
});
await settle(() => box.fill(S), withQ(S));
await page.getByText(PUB).first().waitFor({ timeout: 20000 });
list = await rows();
ok("la fila del anuncio lleva «Anuncio · <titular>»",
   rowOf2(list, PUB).includes(`Anuncio · Promo ${S}`), JSON.stringify(rowOf2(list, PUB)));
ok("las orgánicas no llevan etiqueta de anuncio",
   !rowOf2(list, `Zoraida${S}`).includes("Anuncio ·"));
await abrirFiltros();
const deAnuncio = page.getByRole("button", { name: /^De anuncio/ });
await settle(() => deAnuncio.click(), (p) => p.get("origin") === "ad" && withQ(S)(p));
await page.waitForTimeout(600);
list = await rows();
const nAnuncio = Number((await deAnuncio.innerText()).replace(/\D/g, ""));
ok("Origen = De anuncio deja solo la del anuncio", list.length === 1 && has(list, PUB),
   JSON.stringify(list));
ok("y su contador coincide con la lista", nAnuncio === list.length,
   JSON.stringify({ nAnuncio, filas: list.length }));
await cerrarFiltros();
await settle(
  () => page.getByRole("button", { name: /^No leídas/ }).click(),
  (p) => p.get("filter") === "unread" && p.get("origin") === "ad"
);
await page.waitForTimeout(600);
list = await rows();
const nUnread = Number(
  (await page.getByRole("button", { name: /^No leídas/ }).innerText()).replace(/\D/g, "")
);
ok("la vista No leídas se combina con el Origen (y su contador cuadra)",
   list.length === 1 && has(list, PUB) && nUnread === list.length,
   JSON.stringify({ list, nUnread }));
await settle(
  () => page.getByRole("button", { name: "Limpiar", exact: true }).first().click(),
  (p) => !p.has("origin")
);
ok("«Limpiar» quita los filtros del panel y deja la vista",
   new URL(page.url()).searchParams.get("filter") === "unread" &&
     !new URL(page.url()).searchParams.has("origin"),
   new URL(page.url()).search);
await settle(() => page.getByRole("button", { name: /^Todas/ }).click(), (p) => !p.has("filter"));

console.log("\n== Bandeja: pastilla 'Por atender' ==");
// Se provoca el handoff con un echo del mock (el dueño contesta a mano desde
// el teléfono → handoff manual_reply): no requiere BOT_API_KEY.
await box.fill("");
const echo = await req.post(`${BASE}/api/dev/wa-mock/echo`, {
  data: {
    phoneNumberId: PN,
    to: PHONE2,
    text: "te atiendo yo",
    waMessageId: `wamid.s.${S}.echo`,
  },
});
ok("echo del dueño entregado al webhook", echo.ok(), String(echo.status()));
await new Promise((res) => setTimeout(res, 1500));
const convsHo = (await (await req.get(`${BASE}/api/conversations`)).json()).conversations;
const byName = (n) => convsHo.find((c) => c.contact.name === n);
ok("la conversación de Josué quedó por atender (setup)",
   !!byName(`Josué${S} Ramírez`)?.handoffAt,
   JSON.stringify(byName(`Josué${S} Ramírez`)?.handoffReason));
ok("la de Zoraida NO (caso negativo)", !byName(`Zoraida${S} Belier`)?.handoffAt);

// "Por atender" también es el texto del distintivo de cada renglón; el
// nombre accesible de los renglones empieza por el contacto, así que el ancla
// ^ aísla la pastilla.
const hoPill = page.getByRole("button", { name: /^Por atender/ });
// Recarga: lo que se prueba es el filtro, no la propagación por SSE.
await page.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded" });
await page.getByText(`Josué${S}`).first().waitFor({ timeout: 20000 });
await settle(() => hoPill.click(), (p) => p.get("filter") === "human");
list = await rows();
// Toda fila del filtro lleva UNO de los dos distintivos, nunca ambos: handoff
// → "Por atender"; IA apagada a mano sin handoff → "IA pausada".
const oneBadge = (t) => t.includes("Por atender") !== t.includes("IA pausada");
const rowOf = (l, name) => l.find((t) => t.includes(name)) ?? "";
ok("la pastilla deja solo conversaciones con un distintivo (y solo uno)",
   list.length > 0 && list.every(oneBadge),
   JSON.stringify(list.filter((t) => !oneBadge(t)).slice(0, 2)));
ok("Josué (con handoff) aparece", has(list, `Josué${S}`), JSON.stringify(list.length));
ok("Josué lleva 'Por atender', no 'IA pausada'",
   rowOf(list, `Josué${S}`).includes("Por atender") &&
     !rowOf(list, `Josué${S}`).includes("IA pausada"),
   JSON.stringify(rowOf(list, `Josué${S}`)));
ok("Zoraida (sin handoff) no aparece", !has(list, `Zoraida${S}`));
const pillCount = Number((await hoPill.innerText()).replace(/\D/g, ""));
ok("el contador de la pastilla coincide con la lista", pillCount === list.length,
   JSON.stringify({ pillCount, filas: list.length }));

// IA apagada a mano SIN handoff: misma API que el switch "IA en esta
// conversación" del panel de contacto (PATCH { aiEnabled }).
const anon = `Anónima${S}`;
const anonConv = convsHo.find((c) => c.contact.name === `${anon} Sin Tel`);
ok("la conversación de Anónima existe y no tiene handoff (setup)",
   !!anonConv && !anonConv.handoffAt && anonConv.aiEnabled !== false,
   JSON.stringify(anonConv && { handoffAt: anonConv.handoffAt, aiEnabled: anonConv.aiEnabled }));
const setAi = (aiEnabled) =>
  req.patch(`${BASE}/api/conversations/${anonConv?.id}`, { data: { aiEnabled } });
const pausar = await setAi(false);
ok("pausar la IA de Anónima (PATCH aiEnabled:false)", pausar.ok(), String(pausar.status()));
await page.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded" });
await page.getByText(`Josué${S}`).first().waitFor({ timeout: 20000 });
await settle(() => hoPill.click(), (p) => p.get("filter") === "human");
list = await rows();
ok("con la IA pausada, Anónima aparece en 'Por atender'", has(list, anon),
   JSON.stringify(list.length));
ok("y lleva el distintivo 'IA pausada', no 'Por atender'",
   rowOf(list, anon).includes("IA pausada") && !rowOf(list, anon).includes("Por atender"),
   JSON.stringify(rowOf(list, anon)));
const pillCount2 = Number((await hoPill.innerText()).replace(/\D/g, ""));
ok("el contador sube con ella y coincide con la lista",
   pillCount2 === list.length && pillCount2 === pillCount + 1,
   JSON.stringify({ antes: pillCount, ahora: pillCount2, filas: list.length }));

const reactivar = await setAi(true);
ok("reactivar la IA de Anónima (PATCH aiEnabled:true)", reactivar.ok(), String(reactivar.status()));
await page.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded" });
await page.getByText(`Josué${S}`).first().waitFor({ timeout: 20000 });
await settle(() => hoPill.click(), (p) => p.get("filter") === "human");
list = await rows();
ok("con la IA reactivada, Anónima sale del filtro", !has(list, anon),
   JSON.stringify(list.length));

await settle(() => box.fill(`Zoraida${S}`), (p) => withQ(`Zoraida${S}`)(p) && p.get("filter") === "human");
ok("búsqueda de alguien sin handoff + pastilla → estado vacío coherente",
   (await rows()).length === 0 &&
     (await page.getByText("No hay conversaciones por atender.").isVisible()));
await settle(() => box.fill(""), withQ(""));
await settle(() => page.getByRole("button", { name: /^Todas/ }).click(), (p) => !p.has("filter"));
ok("volver a 'Todas' restaura la lista", (await rows()).length >= 3);

console.log("\n== Contactos: búsqueda tolerante + filtro por etapa ==");
const cp = await ctx.newPage();
await cp.goto(`${BASE}/contacts`, { waitUntil: "domcontentloaded" });
const cbox = cp.getByLabel("Buscar contacto");
await cbox.waitFor({ timeout: 15000 });
await cp.getByText(`Zoraida${S}`).first().waitFor({ timeout: 20000 });
const cRows = () => cp.locator("ul > li").allInnerTexts();

await cbox.fill(`josue${S}`.toLowerCase());
await cp.waitForTimeout(900);
let cl = await cRows();
ok("'josue' encuentra a 'Josué' (búsqueda del servidor, sin acentos)",
   has(cl, `Josué${S}`), JSON.stringify(cl.length));
await cbox.fill(FMT);
await cp.waitForTimeout(900);
cl = await cRows();
ok("teléfono con formato desde el servidor", has(cl, `Zoraida${S}`), JSON.stringify(cl));
await cbox.fill("");
await cp.waitForTimeout(900);
cl = await cRows();
ok("la etapa se pinta en la ficha del contacto", cl.some((t) => t.includes(stage)),
   JSON.stringify(cl.slice(0, 2)));

const cSel = cp.getByLabel("Filtrar por etapa del embudo");
ok("Contactos tiene selector de etapa", await cSel.isVisible());
const cOptions = await cSel.locator("option").allInnerTexts();
ok("las etapas vienen del pipeline completo",
   cOptions[0] === "Toda etapa" && cOptions.length > 1, JSON.stringify(cOptions));
await cSel.selectOption(stage);
await cp.waitForTimeout(900);
cl = await cRows();
ok(`Contactos filtrado por '${stage}'`,
   cl.length > 0 && cl.every((t) => t.includes(stage)), JSON.stringify(cl.length));

// Camino infeliz: una etapa sin nadie no debe romper la pantalla.
const empty = cOptions[cOptions.length - 1];
await cSel.selectOption(empty);
await cp.waitForTimeout(900);
const emptyCount = (await cRows()).length;
ok(`etapa '${empty}' sin contactos → pantalla estable (${emptyCount} filas)`,
   emptyCount >= 0 && (await cp.getByText("Contactos").first().isVisible()));
await cp.screenshot({ path: ".tmp/e2e-contacts.png" });

await browser.close();
console.log(`\n${failures === 0 ? "TODO VERDE" : `${failures} FALLO(S)`}`);
process.exit(failures ? 1 : 0);
