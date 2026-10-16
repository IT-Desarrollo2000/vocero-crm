/**
 * Self-test E2E de comportamiento — conduce la app real en localhost con los
 * mocks (wa-mock + ai-mock) por las superficies de usuario, en vez de darle
 * el guion al humano. Cubre tests/e2e/us-bsuid.md y tests/e2e/us-bot-api.md.
 *
 * Uso:
 *   1) app corriendo con WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL → wa-mock,
 *      BOT_API_KEY configurada y BD migrada
 *   2) node --env-file=.env scripts/e2e-selftest.mjs
 *
 * Sale con código 1 si algún check falla (apto para CI o para el gate previo
 * a declarar "Hecho").
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
const PN = "PN-E2E-1";

/* ---------- 018: archivos REALES (el tipo se decide por la firma) ---------- */

/** JPEG 1×1 válido. */
const JPEG_1X1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==",
  "base64"
);

/** PNG 1×1 válido (también sirve de favicon). */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** Cabecera PNG real + relleno hasta `size` bytes (para el tope de tamaño). */
function bigPng(size) {
  const buf = Buffer.alloc(size);
  PNG_1X1.copy(buf, 0, 0, Math.min(PNG_1X1.length, size));
  return buf;
}

/** PDF de una página en blanco con su tabla xref (`%PDF-1.4…`). */
function minimalPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
const PDF_BYTES = minimalPdf();

/** Ejecutable de Windows (`MZ…`). */
const EXE_BYTES = Buffer.concat([
  Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]),
  Buffer.from("This program cannot be run in DOS mode.", "latin1"),
]);

/** Office binario antiguo (OLE: `D0 CF 11 E0 A1 B1 1A E1`). */
const OLE_DOC_BYTES = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.alloc(504),
]);

/**
 * ZIP mínimo REAL (entradas "stored") con directorio central — portado de
 * tests/unit/helpers/zip.ts. La política solo lee los nombres del directorio
 * central, así que el contenido de cada entrada es irrelevante.
 */
function makeZip(names) {
  const local = [];
  const central = [];
  const le16 = (n) => [n & 0xff, (n >> 8) & 0xff];
  const le32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  for (const name of names) {
    const nb = [...Buffer.from(name, "utf8")];
    const data = [0x78];
    const offset = local.length;
    local.push(
      0x50, 0x4b, 0x03, 0x04, ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0),
      ...le32(0), ...le32(data.length), ...le32(data.length), ...le16(nb.length), ...le16(0),
      ...nb, ...data
    );
    central.push(
      0x50, 0x4b, 0x01, 0x02, ...le16(20), ...le16(20), ...le16(0), ...le16(0), ...le16(0),
      ...le16(0), ...le32(0), ...le32(data.length), ...le32(data.length), ...le16(nb.length),
      ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(offset), ...nb
    );
  }
  const eocd = [
    0x50, 0x4b, 0x05, 0x06, ...le16(0), ...le16(0), ...le16(names.length),
    ...le16(names.length), ...le32(central.length), ...le32(local.length), ...le16(0),
  ];
  return Buffer.from([...local, ...central, ...eocd]);
}
const DOCX_LIMPIO = makeZip(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
const DOCX_MACROS = makeZip([
  "[Content_Types].xml",
  "_rels/.rels",
  "word/document.xml",
  "word/vbaProject.bin",
]);
const ZIP_GENERICO = makeZip(["leeme.txt", "fotos/uno.jpg"]);
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Sube un archivo por el compositor (multipart). → { status, json } */
async function sendFile(convId, bytes, fileName, type, caption) {
  const form = new FormData();
  form.set("file", new Blob([bytes], { type }), fileName);
  if (caption) form.set("caption", caption);
  const res = await fetch(`${BASE}/api/conversations/${convId}/messages/media`, {
    method: "POST",
    headers: { cookie, origin: BASE },
    body: form,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** GET de un binario con la sesión del operador. */
const getMedia = (assetId) =>
  fetch(`${BASE}/api/media/${assetId}`, { headers: { cookie, origin: BASE } });

/**
 * Espera (polling) a que aparezca un mensaje que cumpla `pred` y, si trae
 * adjunto, a que su descarga en segundo plano termine (`fetchStatus` final).
 */
async function waitMessage(convId, pred, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  let found = null;
  while (Date.now() < until) {
    const msgs = (await api(`/api/conversations/${convId}/messages`)).json?.messages ?? [];
    found = msgs.find(pred) ?? null;
    if (found && found.media?.fetchStatus !== "pending") return found;
    await sleep(500);
  }
  return found;
}

async function main() {
  if (!BOT_KEY || BOT_KEY.length < 16) {
    console.error(
      "BOT_API_KEY ausente o corta (<16): los checks de /api/bot/* no pueden correr."
    );
    process.exit(1);
  }

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

  const conn = await api("/api/settings/whatsapp", {
    method: "PUT",
    body: JSON.stringify({
      wabaId: "WABA-E2E",
      phoneNumberId: PN,
      token: "tok-e2e",
    }),
  });
  ok(
    "conexión WhatsApp guardada (vía wa-mock)",
    conn.res.ok,
    JSON.stringify(conn.json)
  );

  console.log("\n== WhatsApp: acceso del token a la WABA ==");
  const putWa = (token) =>
    api("/api/settings/whatsapp", {
      method: "PUT",
      body: JSON.stringify({ wabaId: "WABA-E2E", phoneNumberId: PN, token }),
    });
  const sinAcceso = await putWa("tok-e2e-noasignado-id777");
  ok(
    "token cuyo usuario no está asignado a la WABA → 422 y no se guarda",
    sinAcceso.res.status === 422 && sinAcceso.json?.error?.code === "waba_not_assigned",
    JSON.stringify(sinAcceso.json)
  );
  const tras422 = (await api("/api/settings/whatsapp")).json?.connection;
  ok("la conexión anterior sigue intacta", tras422?.tokenLast4 === "-e2e", tras422?.tokenLast4);
  const sinSuscribir = await putWa("tok-e2e-nosuscribe");
  ok(
    "suscripción rechazada → se guarda con aviso visible",
    sinSuscribir.res.ok &&
      sinSuscribir.json?.subscribed === false &&
      /no se pudo suscribir/.test(sinSuscribir.json?.warning ?? ""),
    JSON.stringify(sinSuscribir.json)
  );
  const conAcceso = await putWa("tok-e2e-asignado-id555");
  ok(
    "usuario asignado y suscripción ok → sin aviso",
    conAcceso.res.ok && conAcceso.json?.subscribed === true && !conAcceso.json?.warning,
    JSON.stringify(conAcceso.json)
  );
  const restaura = await putWa("tok-e2e");
  ok("se restaura el token del self-test", restaura.res.ok, JSON.stringify(restaura.json));
  await api("/api/dev/wa-mock/outbox", { method: "DELETE" });

  console.log("\n== us-bsuid: inbound sin wa_id ==");
  const inb1 = await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      fromUserId: "bsu_e2e_1",
      name: "Dueña Dental",
      text: "hola, vi su anuncio",
      waMessageId: "wamid.e2e.bsuid.1",
    }),
  });
  ok("inbound BSUID entregado", inb1.res.ok, JSON.stringify(inb1.json));
  await sleep(1200);

  let convs = (await api("/api/conversations")).json?.conversations ?? [];
  const bsuidConv = convs.find((c) => c.contact.name === "Dueña Dental");
  ok("conversación con nombre de perfil (no el BSUID crudo)", !!bsuidConv);
  ok("contacto BSUID sin teléfono", bsuidConv?.contact.phone === null);

  const reply = await api(`/api/conversations/${bsuidConv?.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: "¡Hola! Te atendemos enseguida" }),
  });
  ok("respuesta a contacto BSUID enviable", reply.res.ok, JSON.stringify(reply.json));

  const outbox = (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  ok(
    "el destinatario del envío es el BSUID",
    outbox.some((o) => o.to === "bsu_e2e_1"),
    JSON.stringify(outbox.map((o) => o.to))
  );

  // Idempotencia: re-entrega del mismo wa_message_id
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      fromUserId: "bsu_e2e_1",
      name: "Dueña Dental",
      text: "hola, vi su anuncio",
      waMessageId: "wamid.e2e.bsuid.1",
    }),
  });
  await sleep(800);
  const msgs =
    (await api(`/api/conversations/${bsuidConv?.id}/messages`)).json?.messages ??
    [];
  const inCount = msgs.filter((m) => m.direction === "in").length;
  ok("webhook duplicado no duplica mensajes", inCount === 1, `in=${inCount}`);

  console.log("\n== us-bsuid: reconciliación 521/52 ==");
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: "5214621349768",
      name: "Kevin MX",
      text: "uno",
    }),
  });
  await sleep(800);
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({ phoneNumberId: PN, from: "524621349768", text: "dos" }),
  });
  await sleep(800);
  const contacts =
    (await api("/api/contacts?q=Kevin%20MX")).json?.contacts ?? [];
  ok(
    "521 y 52 resuelven a UN solo contacto",
    contacts.length === 1,
    `n=${contacts.length}`
  );

  const mxConv = ((await api("/api/conversations")).json?.conversations ?? []).find(
    (c) => c.contact.name === "Kevin MX"
  );
  ok("el contacto reconciliado conserva su conversación", !!mxConv);

  // Issue #35: un destinatario argentino llega como `549` + 10 dígitos y hay
  // que ENVIARLE sin el 9. La identidad, en cambio, conserva lo que Meta
  // reporta: si se reescribiera, dejaría de casar con el `wa_id` de cada
  // webhook y el contacto se partiría en dos.
  console.log("\n== us-bsuid: destinatario argentino (549 → 54) ==");
  const AR_REPORTADO = "5491122334455";
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: AR_REPORTADO,
      name: "Lead AR",
      text: "hola desde Argentina",
      waMessageId: "wamid.e2e.ar.1",
    }),
  });
  await sleep(1200);
  const convAr = ((await api("/api/conversations")).json?.conversations ?? []).find(
    (c) => c.contact.name === "Lead AR"
  );
  ok("la conversación argentina se creó", Boolean(convAr));
  ok(
    "la identidad guardada conserva el 9 que reporta Meta",
    convAr?.contact.phone === AR_REPORTADO,
    `phone=${convAr?.contact.phone}`
  );

  if (convAr) {
    // Se cuenta lo que ya había en vez de vaciar el outbox: el DELETE del
    // wa-mock reinicia su contador de wa_message_id, y en una RE-CORRIDA eso
    // choca con los mensajes que ya están en la base (unique) y tumba el envío
    // con un 500 que no tiene nada que ver con lo que se está probando.
    const outboxAntes =
      ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
    const envioAr = await api(`/api/conversations/${convAr.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "respuesta a Argentina" }),
    });
    ok("el mensaje a Argentina se envía", envioAr.res.ok, `status=${envioAr.res.status}`);
    const outboxAr = (
      (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []
    ).slice(outboxAntes);
    ok(
      "por el cable viaja SIN el 9 (lo que la lista de permitidos acepta)",
      outboxAr.some((o) => o.to === "541122334455"),
      JSON.stringify(outboxAr.map((o) => o.to))
    );
    ok(
      "…y nunca con el 9, que es lo que devolvía 131030",
      !outboxAr.some((o) => o.to === AR_REPORTADO),
      JSON.stringify(outboxAr.map((o) => o.to))
    );
  }

  console.log("\n== us-bot-api: autorización ==");
  const noKey = await api("/api/bot/media/media123");
  ok("media sin API key → 401", noKey.res.status === 401);
  const badKey = await api("/api/bot/media/media123", {
    headers: { "x-api-key": "x".repeat(BOT_KEY.length) },
  });
  ok("media con API key equivocada → 401", badKey.res.status === 401);
  const resetNoKey = await api("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: mxConv?.id }),
  });
  ok("reset sin API key → 401", resetNoKey.res.status === 401);

  console.log("\n== us-bot-api: typing + leído ==");
  const convId = mxConv?.id;
  const outboxBeforeTyping =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  const typ = await bot("/api/bot/typing", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  ok(
    "POST /api/bot/typing → ok:true (leído + escribiendo…)",
    typ.res.ok && typ.json?.ok === true,
    JSON.stringify(typ.json)
  );
  const outboxAfterTyping =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  ok(
    "typing NO contamina el outbox",
    outboxAfterTyping === outboxBeforeTyping,
    `antes=${outboxBeforeTyping} después=${outboxAfterTyping}`
  );

  const typ404 = await bot("/api/bot/typing", {
    method: "POST",
    body: JSON.stringify({ conversationId: "cv_no_existe" }),
  });
  ok("typing con conversación inexistente → 404", typ404.res.status === 404);

  console.log("\n== us-bot-api: media proxy ==");
  const med = await bot("/api/bot/media/media123");
  const medBytes = med.res.ok ? await med.res.arrayBuffer() : new ArrayBuffer(0);
  ok(
    "GET /api/bot/media/{id} → binario con content-type",
    med.res.ok &&
      medBytes.byteLength > 0 &&
      (med.res.headers.get("content-type") ?? "").includes("image"),
    `status=${med.res.status} bytes=${medBytes.byteLength}`
  );
  const medBad = await bot("/api/bot/media/no-es-media");
  ok(
    "mediaId que Graph no reconoce → error tipado, no 500",
    medBad.res.status === 404 || medBad.res.status === 502,
    `status=${medBad.res.status}`
  );

  console.log("\n== us-bot-api: perfil del agente + knowledge base ==");
  const profNoKey = await api("/api/bot/profile");
  ok("perfil sin API key → 401", profNoKey.res.status === 401);

  const putProf = await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({
      name: "Sofi",
      tone: "cálido y directo",
      instructions: "Vendemos limpiezas dentales.",
      escalationRules: "Urgencias de dolor → humano.",
      greeting: "¡Hola! Soy Sofi",
      enabled: false,
    }),
  });
  ok("perfil guardado desde la pantalla Agente", putProf.res.ok);
  const kbQa = await api("/api/kb", {
    method: "POST",
    body: JSON.stringify({
      kind: "qa",
      question: "¿Cuánto cuesta?",
      answer: "$800.",
    }),
  });
  ok("entrada de KB creada desde la pantalla", kbQa.res.ok, JSON.stringify(kbQa.json));

  const prof = await bot("/api/bot/profile");
  ok(
    "GET /api/bot/profile → 200 con el perfil de la pantalla",
    prof.res.ok && prof.json?.profile?.name === "Sofi",
    JSON.stringify(prof.json?.profile)
  );
  ok(
    "el knowledge base viaja renderizado (P:/R:)",
    typeof prof.json?.kb === "string" && prof.json.kb.includes("P: ¿Cuánto cuesta?"),
    JSON.stringify(prof.json?.kb)
  );
  ok(
    "`enabled` NO viaja: gobierna la IA in-process, no al bot externo",
    prof.json?.profile && !("enabled" in prof.json.profile)
  );
  ok("`resources` presente y vacío", Array.isArray(prof.json?.resources));

  await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({ tone: "seco y breve" }),
  });
  const profAgain = await bot("/api/bot/profile");
  ok(
    "editar el tono se refleja al instante (sin caché)",
    profAgain.json?.profile?.tone === "seco y breve",
    JSON.stringify(profAgain.json?.profile?.tone)
  );

  console.log("\n== us-bot-api: contexto conversacional ==");
  const ctxNoKey = await api(`/api/bot/context?conversationId=${convId}`);
  ok("contexto sin API key → 401", ctxNoKey.res.status === 401);

  const ctx = await bot(`/api/bot/context?conversationId=${convId}`);
  ok(
    "GET /api/bot/context por conversationId → 200",
    ctx.res.ok && ctx.json?.conversation?.id === convId,
    JSON.stringify(ctx.json?.conversation)
  );
  ok(
    "trae la identidad estable del contacto (no solo el teléfono)",
    typeof ctx.json?.contact?.waIdentity === "string" &&
      ctx.json.contact.waIdentity.length > 0
  );
  ok(
    "trae la etapa del lead en el pipeline",
    typeof ctx.json?.lead?.stageName === "string",
    JSON.stringify(ctx.json?.lead)
  );
  ok(
    "la ventana de 24 h viaja abierta tras un entrante reciente",
    ctx.json?.conversation?.windowOpen === true &&
      ctx.json?.conversation?.windowRemainingMs > 0,
    JSON.stringify(ctx.json?.conversation)
  );

  const ctxByIdentity = await bot(
    `/api/bot/context?waIdentity=${encodeURIComponent(ctx.json.contact.waIdentity)}`
  );
  ok(
    "resolver por waIdentity da la MISMA conversación",
    ctxByIdentity.json?.conversation?.id === convId,
    JSON.stringify(ctxByIdentity.json?.conversation?.id)
  );

  const ctxSinArgs = await bot("/api/bot/context");
  ok("contexto sin waIdentity ni conversationId → 422", ctxSinArgs.res.status === 422);
  const ctx404 = await bot("/api/bot/context?conversationId=cv_no_existe");
  ok("contexto de una conversación inexistente → 404", ctx404.res.status === 404);

  console.log("\n== us-bot-api: ficha de calificación ==");
  const fichaNoKey = await api("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({ conversationId: convId, ficha: { rubro: "x" } }),
  });
  ok("ficha sin API key → 401", fichaNoKey.res.status === 401);

  const f1 = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({
      conversationId: convId,
      ficha: { rubro: "dentista", geo: "Querétaro", calificado: true },
    }),
  });
  ok(
    "PUT /api/bot/ficha → 200 con la ficha completa",
    f1.res.ok && f1.json?.ficha?.rubro === "dentista",
    JSON.stringify(f1.json)
  );
  ok(
    "las claves las pone el negocio: el CRM guarda lo que le manden",
    f1.json?.ficha?.geo === "Querétaro" && f1.json?.ficha?.calificado === true,
    JSON.stringify(f1.json?.ficha)
  );

  const ctxConFicha = await bot(`/api/bot/context?conversationId=${convId}`);
  ok(
    "la ficha viaja en el contexto del siguiente turno",
    ctxConFicha.json?.contact?.ficha?.rubro === "dentista",
    JSON.stringify(ctxConFicha.json?.contact?.ficha)
  );

  const f2 = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({
      conversationId: convId,
      ficha: { presupuesto: "20 mil", geo: null },
    }),
  });
  ok(
    "merge campo a campo: lo ausente se conserva",
    f2.json?.ficha?.rubro === "dentista" && f2.json?.ficha?.presupuesto === "20 mil",
    JSON.stringify(f2.json?.ficha)
  );
  ok(
    "null explícito borra la clave",
    f2.json?.ficha && !("geo" in f2.json.ficha),
    JSON.stringify(f2.json?.ficha)
  );

  const fBasura = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({
      conversationId: convId,
      ficha: { anidado: { a: 1 }, vacío: "", bueno: "  sí  " },
    }),
  });
  ok(
    "lo que no se entiende se ignora sin 422 (no se le tiran datos al bot)",
    fBasura.res.ok &&
      fBasura.json?.ficha?.bueno === "sí" &&
      !("anidado" in fBasura.json.ficha) &&
      !("vacío" in fBasura.json.ficha),
    JSON.stringify(fBasura.json?.ficha)
  );

  const fNoConv = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({ conversationId: "cv_no_existe", ficha: { a: "b" } }),
  });
  ok("ficha de conversación inexistente → 404", fNoConv.res.status === 404);
  const fSinFicha = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({ conversationId: convId }),
  });
  ok("cuerpo sin `ficha` → 422", fSinFicha.res.status === 422);

  console.log("\n== us-bot-api: el bot envía a través del CRM ==");
  const sendNoKey = await api("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, text: "hola" }),
  });
  ok("envío sin API key → 401", sendNoKey.res.status === 401);

  const outboxBeforeBot =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  const botSend = await bot("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, text: "Hola, soy el bot." }),
  });
  ok(
    "POST /api/bot/messages → 200 con messageId",
    botSend.res.ok && typeof botSend.json?.messageId === "string",
    JSON.stringify(botSend.json)
  );
  const outboxAfterBot =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  ok(
    "el mensaje salió de verdad por el canal de WhatsApp",
    outboxAfterBot === outboxBeforeBot + 1,
    `antes=${outboxBeforeBot} después=${outboxAfterBot}`
  );
  const botMsg = ((await api(`/api/conversations/${convId}/messages`)).json
    ?.messages ?? []).find((m) => m.id === botSend.json?.messageId);
  ok(
    "queda en la bandeja marcado como IA (aiGenerated + origin=ai)",
    botMsg?.aiGenerated === true && botMsg?.origin === "ai",
    JSON.stringify({ aiGenerated: botMsg?.aiGenerated, origin: botMsg?.origin })
  );
  const sendNoConv = await bot("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: "cv_no_existe", text: "hola" }),
  });
  ok("envío a conversación inexistente → 404", sendNoConv.res.status === 404);
  const sendVacio = await bot("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, text: "" }),
  });
  ok("texto vacío → 422 (no se manda un mensaje en blanco)", sendVacio.res.status === 422);

  console.log("\n== us-bot-api: el bot pide un humano ==");
  const hoNoKey = await api("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, reason: "cliente" }),
  });
  ok("handoff sin API key → 401", hoNoKey.res.status === 401);

  const ho = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, reason: "hostilidad" }),
  });
  ok("POST /api/bot/handoff → 200", ho.res.ok && ho.json?.ok === true);
  await sleep(300);
  let convTrasHandoff = ((await api("/api/conversations")).json?.conversations ?? [])
    .find((c) => c.id === convId);
  ok(
    "la conversación queda pausada y con su motivo",
    convTrasHandoff?.aiEnabled === false &&
      !!convTrasHandoff?.handoffAt &&
      convTrasHandoff?.handoffReason === "hostilidad",
    JSON.stringify({
      aiEnabled: convTrasHandoff?.aiEnabled,
      reason: convTrasHandoff?.handoffReason,
    })
  );
  const primerHandoffAt = convTrasHandoff?.handoffAt;

  const hoRepe = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, reason: "cliente" }),
  });
  await sleep(300);
  convTrasHandoff = ((await api("/api/conversations")).json?.conversations ?? [])
    .find((c) => c.id === convId);
  ok(
    "repetir el handoff es idempotente: no pisa la hora ni el motivo original",
    hoRepe.res.ok &&
      convTrasHandoff?.handoffAt === primerHandoffAt &&
      convTrasHandoff?.handoffReason === "hostilidad",
    JSON.stringify({
      antes: primerHandoffAt,
      ahora: convTrasHandoff?.handoffAt,
      reason: convTrasHandoff?.handoffReason,
    })
  );

  const hoNoConv = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: "cv_no_existe", reason: "cliente" }),
  });
  ok("handoff de conversación inexistente → 404", hoNoConv.res.status === 404);

  // El handoff jamás debe perderse por un motivo que no esté en el catálogo:
  // el bot se quedaría hablándole a alguien que pidió un humano.
  await bot("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  await sleep(300);
  const hoRaro = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, reason: "porque sí" }),
  });
  await sleep(300);
  convTrasHandoff = ((await api("/api/conversations")).json?.conversations ?? [])
    .find((c) => c.id === convId);
  ok(
    "un motivo fuera del catálogo NO tira el handoff (cae a 'modelo')",
    hoRaro.res.ok &&
      convTrasHandoff?.aiEnabled === false &&
      convTrasHandoff?.handoffReason === "modelo",
    JSON.stringify({
      status: hoRaro.res.status,
      reason: convTrasHandoff?.handoffReason,
    })
  );

  await bot("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  await sleep(300);
  const hoSinReason = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  await sleep(300);
  convTrasHandoff = ((await api("/api/conversations")).json?.conversations ?? [])
    .find((c) => c.id === convId);
  ok(
    "sin motivo también pausa (cae a 'modelo')",
    hoSinReason.res.ok && convTrasHandoff?.handoffReason === "modelo",
    JSON.stringify(convTrasHandoff?.handoffReason)
  );
  await bot("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  await sleep(300);

  console.log("\n== us-bot-api: IA pausada y reset ==");
  const pause = await api(`/api/conversations/${convId}`, {
    method: "PATCH",
    body: JSON.stringify({ aiEnabled: false }),
  });
  ok("IA pausada desde la bandeja", pause.res.ok, JSON.stringify(pause.json));

  const typPaused = await bot("/api/bot/typing", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  ok(
    "typing con IA pausada → ok:false ai_paused (no toca Meta)",
    typPaused.res.ok &&
      typPaused.json?.ok === false &&
      typPaused.json?.reason === "ai_paused",
    JSON.stringify(typPaused.json)
  );

  const outboxBeforePaused =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  const sendPaused = await bot("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, text: "¿sigo yo?" }),
  });
  ok(
    "el bot NO habla sobre una conversación tomada por un humano → 409 ai_paused",
    sendPaused.res.status === 409 &&
      sendPaused.json?.error?.code === "ai_paused",
    JSON.stringify(sendPaused.json)
  );
  const outboxAfterPaused =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  ok(
    "y el rechazo ocurre ANTES de tocar Meta",
    outboxAfterPaused === outboxBeforePaused,
    `antes=${outboxBeforePaused} después=${outboxAfterPaused}`
  );

  const msgsBeforeReset =
    ((await api(`/api/conversations/${convId}/messages`)).json?.messages ?? [])
      .length;
  const rst = await bot("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  ok(
    "POST /api/bot/reset → ok:true",
    rst.res.ok && rst.json?.ok === true,
    JSON.stringify(rst.json)
  );
  await sleep(400);
  convs = (await api("/api/conversations")).json?.conversations ?? [];
  const afterReset = convs.find((c) => c.id === convId);
  ok(
    "reset reactiva la IA (sale del handoff)",
    afterReset?.aiEnabled === true && !afterReset?.handoffAt,
    JSON.stringify({
      aiEnabled: afterReset?.aiEnabled,
      handoffAt: afterReset?.handoffAt,
    })
  );
  const msgsAfterReset =
    ((await api(`/api/conversations/${convId}/messages`)).json?.messages ?? [])
      .length;
  ok(
    "el reset conserva el historial (auditoría)",
    msgsAfterReset === msgsBeforeReset,
    `antes=${msgsBeforeReset} después=${msgsAfterReset}`
  );

  const stages = (await api("/api/pipeline/stages")).json?.stages ?? [];
  const firstStage = [...stages].sort((a, b) => a.position - b.position)[0];
  const detail = (await api(`/api/contacts/${afterReset?.contact.id}`)).json;
  ok(
    "reset regresa el lead a la primera etapa",
    !detail?.lead || detail?.stage?.id === firstStage?.id,
    `etapa=${detail?.stage?.name} esperada=${firstStage?.name}`
  );

  console.log("\n== 008: paridad inbox — echoes de coexistence (US1) ==");
  const LEAD = "5214627008001"; // canónica: 524627008001

  // Un inbound primero: la conversación existe y la ventana queda abierta.
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD,
      name: "Lead 008",
      text: "hola, quiero informes",
      waMessageId: "wamid.e2e.008.in.1",
    }),
  });
  await sleep(1200);
  const findConv008 = async () =>
    (((await api("/api/conversations")).json?.conversations) ?? []).find(
      (c) => c.contact.phone === "524627008001"
    );
  let conv008 = await findConv008();
  ok("conversación del lead 008 creada", Boolean(conv008), "sin conversación");
  const inboundAtBefore = conv008?.lastInboundAt;

  // Echo: el dueño contesta A MANO desde la app del teléfono.
  const echo1 = await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: LEAD,
      text: "te contesto yo, dame un minuto",
      waMessageId: "wamid.e2e.008.echo.1",
    }),
  });
  ok("echo entregado al webhook", echo1.res.ok, JSON.stringify(echo1.json));
  await sleep(900);

  const msgs1 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const manual1 = msgs1.find((m) => m.text === "te contesto yo, dame un minuto");
  ok(
    "el mensaje manual aparece como saliente origin=manual",
    manual1?.direction === "out" && manual1?.origin === "manual" && manual1?.status === "sent",
    JSON.stringify(manual1)
  );

  conv008 = await findConv008();
  ok(
    "la IA quedó pausada con handoff manual_reply",
    conv008?.aiEnabled === false && conv008?.handoffReason === "manual_reply",
    JSON.stringify({ aiEnabled: conv008?.aiEnabled, reason: conv008?.handoffReason })
  );
  ok(
    "el echo NO tocó la ventana de 24 h (lastInboundAt intacto)",
    conv008?.lastInboundAt === inboundAtBefore,
    `${inboundAtBefore} → ${conv008?.lastInboundAt}`
  );

  // Idempotencia: el mismo echo otra vez no duplica.
  await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: LEAD,
      text: "te contesto yo, dame un minuto",
      waMessageId: "wamid.e2e.008.echo.1",
    }),
  });
  await sleep(700);
  const msgs2 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  ok(
    "echo duplicado (mismo wamid) no duplica el mensaje",
    msgs2.filter((m) => m.text === "te contesto yo, dame un minuto").length === 1
  );

  // Variante defensiva: echoes bajo la clave `messages`.
  await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: LEAD,
      text: "segundo mensaje manual",
      waMessageId: "wamid.e2e.008.echo.2",
      useMessagesKey: true,
    }),
  });
  await sleep(700);
  const msgs3 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  ok(
    "echo bajo la clave `messages` también se ingiere (parser tolerante)",
    msgs3.some((m) => m.text === "segundo mensaje manual" && m.origin === "manual")
  );

  // El equipo escribe PRIMERO desde la app (echo): el contacto nace con su
  // número; cuando el cliente responde, toma su nombre de perfil, y un nombre
  // editado por el equipo ya no se pisa.
  const NSUF = String(Date.now()).slice(-5);
  const NUM = `52146270${NSUF}`;
  const byText = async (t) =>
    ((await api("/api/conversations")).json?.conversations ?? []).find((c) =>
      String(c.preview ?? "").includes(t)
    );
  await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({ phoneNumberId: PN, to: NUM, text: `le escribo yo primero ${NSUF}`, waMessageId: `wamid.e2e.nombre.${NSUF}.1` }),
  });
  await sleep(900);
  let cvNom = await byText(`le escribo yo primero ${NSUF}`);
  ok("contacto nacido de un echo → su número como nombre", /^\d+$/.test(cvNom?.contact.name ?? ""), cvNom?.contact.name);
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({ phoneNumberId: PN, from: NUM, name: "Lucía Pérez", text: `hola soy yo ${NSUF}`, waMessageId: `wamid.e2e.nombre.${NSUF}.2` }),
  });
  await sleep(1500);
  cvNom = await byText(`hola soy yo ${NSUF}`);
  ok("cuando el cliente escribe, toma su nombre de perfil", cvNom?.contact.name === "Lucía Pérez", cvNom?.contact.name);
  if (cvNom) {
    await api(`/api/contacts/${cvNom.contact.id}`, { method: "PATCH", body: JSON.stringify({ name: "Lucía (VIP)" }) });
  }
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({ phoneNumberId: PN, from: NUM, name: "Lu", text: `otra vez yo ${NSUF}`, waMessageId: `wamid.e2e.nombre.${NSUF}.3` }),
  });
  await sleep(1500);
  cvNom = await byText(`otra vez yo ${NSUF}`);
  ok("un nombre editado por el equipo no se pisa con el del perfil", cvNom?.contact.name === "Lucía (VIP)", cvNom?.contact.name);

  // Echo hacia un número SIN conversación previa → la crea.
  await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: "5214627008002",
      text: "hola, te escribo del anuncio",
      waMessageId: "wamid.e2e.008.echo.3",
    }),
  });
  await sleep(700);
  const convNew = (((await api("/api/conversations")).json?.conversations) ?? []).find(
    (c) => c.contact.phone === "524627008002"
  );
  ok("echo a número nuevo crea contacto y conversación", Boolean(convNew));

  // Reactivación desde el CRM (flujo existente de handoff).
  const react = await api(`/api/conversations/${conv008.id}`, {
    method: "PATCH",
    body: JSON.stringify({ reactivate: true }),
  });
  conv008 = await findConv008();
  ok(
    "reactivar la IA desde el CRM limpia el handoff",
    react.res.ok && conv008?.aiEnabled === true && !conv008?.handoffReason
  );

  console.log("\n== 008: enviar adjuntos desde el composer (US2) ==");
  const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0xff, 0xd9]);
  const mediaForm = new FormData();
  mediaForm.set(
    "file",
    new Blob([JPEG_BYTES], { type: "image/jpeg" }),
    "local.jpg"
  );
  mediaForm.set("caption", "mira nuestro local");
  const upRes = await fetch(`${BASE}/api/conversations/${conv008.id}/messages/media`, {
    method: "POST",
    headers: { cookie, origin: BASE },
    body: mediaForm,
  });
  const upJson = await upRes.json().catch(() => null);
  ok("imagen con caption enviada (201)", upRes.status === 201, JSON.stringify(upJson));

  const msgs4 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const sentImg = msgs4.find((m) => m.media?.caption === "mira nuestro local");
  ok(
    "el saliente con imagen trae asset disponible y origin=operator",
    sentImg?.type === "image" &&
      sentImg?.origin === "operator" &&
      sentImg?.media?.fetchStatus === "available",
    JSON.stringify(sentImg)
  );

  const imgBin = await fetch(`${BASE}/api/media/${sentImg?.media?.assetId}`, {
    headers: { cookie, origin: BASE },
  });
  ok(
    "GET /api/media/{id} sirve el binario con su content-type",
    imgBin.ok && (imgBin.headers.get("content-type") ?? "").includes("image/jpeg")
  );

  const outbox008 = (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  ok(
    "el envío llegó a Graph como type=image con media id subido",
    outbox008.some((o) => o.type === "image" && JSON.stringify(o.body).includes("media-up-"))
  );

  // Camino infeliz: archivo que excede el límite (imagen > 5 MB) → 413 previo.
  // 018: el tipo se decide por la firma, así que el PNG lleva su cabecera
  // real (6 MB de ceros ya no "es" un PNG: sería 415).
  const bigForm = new FormData();
  bigForm.set(
    "file",
    new Blob([bigPng(6 * 1024 * 1024)], { type: "image/png" }),
    "grande.png"
  );
  const bigRes = await fetch(`${BASE}/api/conversations/${conv008.id}/messages/media`, {
    method: "POST",
    headers: { cookie, origin: BASE },
    body: bigForm,
  });
  ok("imagen de 6 MB → 413 too_large ANTES de enviar", bigRes.status === 413);

  // Ubicación (payload estructurado, sin archivo).
  const locRes = await api(`/api/conversations/${conv008.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      type: "location",
      location: { latitude: 21.019, longitude: -101.257, name: "Oficina Central" },
    }),
  });
  ok("ubicación enviada", locRes.res.ok, JSON.stringify(locRes.json));
  const msgs5 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const sentLoc = msgs5.find((m) => m.type === "location" && m.direction === "out");
  ok(
    "la ubicación viaja como payload (lat/long/name) sin binario",
    sentLoc?.media?.kind === "location" && sentLoc?.media?.payload?.latitude === 21.019,
    JSON.stringify(sentLoc?.media)
  );
  const outboxLoc = (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  ok(
    "Graph recibió type=location",
    outboxLoc.some((o) => o.type === "location")
  );

  console.log("\n== 008: previews de adjuntos entrantes (US3) ==");
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD,
      type: "image",
      mediaId: "media-e2e-img-1",
      caption: "foto de mi negocio",
      waMessageId: "wamid.e2e.008.in.img",
    }),
  });
  await sleep(1600); // ingesta + descarga in-process del binario
  const msgs6 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const inImg = msgs6.find((m) => m.media?.caption === "foto de mi negocio");
  ok(
    "imagen entrante queda disponible tras la descarga in-process",
    inImg?.direction === "in" &&
      inImg?.media?.kind === "image" &&
      inImg?.media?.fetchStatus === "available",
    JSON.stringify(inImg?.media)
  );
  const inImgBin = await fetch(`${BASE}/api/media/${inImg?.media?.assetId}`, {
    headers: { cookie, origin: BASE },
  });
  ok("el binario entrante se sirve desde el volumen local", inImgBin.ok);

  // Ubicación entrante: payload directo, sin binario (404 en /api/media).
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD,
      type: "location",
      location: { latitude: 20.5, longitude: -100.8, name: "Mi taller" },
      waMessageId: "wamid.e2e.008.in.loc",
    }),
  });
  await sleep(900);
  const msgs7 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const inLoc = msgs7.find((m) => m.type === "location" && m.direction === "in");
  ok(
    "ubicación entrante trae payload directo",
    inLoc?.media?.payload?.name === "Mi taller",
    JSON.stringify(inLoc?.media)
  );

  // Camino infeliz: media cuya descarga falla (metadata sin url) → failed,
  // el mensaje se conserva y /api/media responde 410.
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD,
      type: "image",
      mediaId: "broken-no-url",
      waMessageId: "wamid.e2e.008.in.broken",
    }),
  });
  await sleep(1600);
  const msgs8 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const broken = msgs8.find((m) => m.id !== inImg?.id && m.media?.fetchStatus === "failed");
  ok(
    "descarga fallida degrada a failed sin perder el mensaje",
    Boolean(broken),
    JSON.stringify(msgs8.filter((m) => m.media).map((m) => m.media))
  );
  if (broken) {
    const goneRes = await fetch(`${BASE}/api/media/${broken.media.assetId}`, {
      headers: { cookie, origin: BASE },
    });
    ok("asset fallido → 410 gone en /api/media", goneRes.status === 410);
  }

  // Echo CON adjunto (AC-5 de US1): la foto que el dueño mandó desde el cel.
  await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: LEAD,
      type: "image",
      mediaId: "media-e2e-echo-img",
      caption: "así quedaría tu logo",
      waMessageId: "wamid.e2e.008.echo.img",
    }),
  });
  await sleep(1600);
  const msgs9 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const echoImg = msgs9.find((m) => m.media?.caption === "así quedaría tu logo");
  ok(
    "echo con imagen: manual + asset descargado y previsualizable",
    echoImg?.origin === "manual" && echoImg?.media?.fetchStatus === "available",
    JSON.stringify(echoImg?.media)
  );

  await agendaChecks();
  await recordatoriosChecks();
  await atribucionChecks();
  // 020 fase B: el reporte de anuncios (con la bandera en cualquier posición).
  await reporteAnunciosChecks();
  await canalesChecks();
  const antesDelLab = await reporteAnuncios("range=7d");
  await labChecks();
  await reporteAnunciosLabChecks(antesDelLab);
  await asignacionChecks();
  // 018: AL FINAL — su último paso (la purga de 30 días) expira TODO adjunto.
  await adjuntosChecks();
  // 020 fase B: AL FINAL — da de alta un Vendedor (cambia la forma del equipo).
  await reporteAnunciosVendedorChecks();

  console.log(`\n=====${checks - failures}/${checks} checks OK, ${failures} fallos =====`);
  process.exit(failures > 0 ? 1 : 0);
}

/* ============================================================
 * 015 — Motor de agenda universal (tests/e2e/us-agenda.md)
 *
 * Cubre las dos configuraciones de la bandera, las dos garantías
 * innegociables con sus CÓDIGOS EXACTOS, la carrera del hueco, el enlace
 * pendiente cuando el proveedor falla, y el sandbox del Laboratorio.
 * ============================================================ */

/* ============================================================
 * 10 — Recordatorios de cita y reporte de citas (el guion completo, con
 * reloj simulado, claim concurrente, sandbox y reintento, es
 * scripts/e2e-recordatorios.mjs). Aquí: la bandera y que las superficies
 * respondan.
 * ============================================================ */

async function recordatoriosChecks() {
  const encendida = /^(on|1|true|si|sí|yes)$/i.test(
    (process.env.AGENDA ?? "").trim()
  );
  console.log("\n== 10: recordatorios de cita ==");
  const tick = await api("/api/dev/reminders/tick", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const rep = await api("/api/reports/bookings");
  if (!encendida) {
    ok("/api/dev/reminders/tick → 404 con la agenda apagada", tick.res.status === 404, `status=${tick.res.status}`);
    ok("/api/reports/bookings → 404 con la agenda apagada", rep.res.status === 404, `status=${rep.res.status}`);
    return;
  }
  ok(
    "tick forzado → 200 con el resultado de la vuelta",
    tick.res.ok && typeof tick.json?.claimed === "number" && typeof tick.json?.now === "string",
    JSON.stringify(tick.json)
  );
  ok(
    "reporte de citas → 200 con sus tres bloques",
    rep.res.ok && ["offers", "attendance", "byReminder"].every((k) => rep.json?.[k]),
    `status=${rep.res.status}`
  );
  const lista = (await api("/api/bookings")).json;
  ok(
    "GET /api/bookings trae businessTimezone y reminders por cita",
    typeof lista?.businessTimezone === "string" &&
      (lista?.bookings ?? []).every((b) => Array.isArray(b.reminders)),
    JSON.stringify(lista?.businessTimezone)
  );
}

async function agendaChecks() {
  const encendida = /^(on|1|true|si|sí|yes)$/i.test(
    (process.env.AGENDA ?? "").trim()
  );

  console.log("\n== 015: la bandera de la agenda ==");
  const rutas = [
    "/api/calendar/settings",
    "/api/calendar/availability",
    "/api/bookings",
  ];

  if (!encendida) {
    // Con la bandera apagada la agenda NO EXISTE: ni rutas de operador, ni de
    // servicio, ni pantallas. Es la mitad del contrato que casi nunca se
    // prueba, y la que toda instancia normal usa.
    for (const ruta of rutas) {
      const { res } = await api(ruta);
      ok(`${ruta} → 404 con la agenda apagada`, res.status === 404, `status=${res.status}`);
    }
    const botAvail = await bot("/api/bot/availability?conversationId=x");
    ok(
      "/api/bot/availability → 404 con la agenda apagada",
      botAvail.res.status === 404,
      `status=${botAvail.res.status}`
    );
    const page = await fetch(`${BASE}/bookings`, { headers: { cookie } });
    ok("la pantalla /bookings no existe", page.status === 404, `status=${page.status}`);
    console.log("  (agenda apagada: el resto de los checks de 015 no aplican)");
    return;
  }

  for (const ruta of rutas) {
    const { res } = await api(ruta);
    ok(`${ruta} responde con la agenda encendida`, res.ok, `status=${res.status}`);
  }

  console.log("\n== 015: configuración de la agenda (US2) ==");
  const defaults = (await api("/api/calendar/settings")).json?.settings;
  ok(
    "una instancia sin configurar da defaults usables, no 404",
    defaults?.slotMinutes === 30 && defaults?.connector === "enlace-fijo",
    JSON.stringify(defaults)
  );

  const SALA = "https://meet.ejemplo.test/sala-fija";
  const guardado = await api("/api/calendar/settings", {
    method: "PUT",
    body: JSON.stringify({
      weeklyHours: {
        mon: [{ start: "09:00", end: "18:00" }],
        tue: [{ start: "09:00", end: "18:00" }],
        wed: [{ start: "09:00", end: "18:00" }],
        thu: [{ start: "09:00", end: "18:00" }],
        fri: [{ start: "09:00", end: "18:00" }],
        sat: [{ start: "09:00", end: "18:00" }],
        sun: [{ start: "09:00", end: "18:00" }],
      },
      slotMinutes: 30,
      minNoticeHours: 0,
      maxDaysAhead: 7,
      connector: "enlace-fijo",
      meetingLink: SALA,
    }),
  });
  ok("se guarda el horario y la sala fija", guardado.res.ok, `status=${guardado.res.status}`);

  const tzMala = await api("/api/calendar/settings", {
    method: "PUT",
    body: JSON.stringify({ timezone: "Marte/Olympus" }),
  });
  ok(
    "una zona horaria inventada se rechaza (422) en vez de romper el motor",
    tzMala.res.status === 422,
    `status=${tzMala.res.status}`
  );

  const disp = (await api("/api/calendar/availability")).json?.slots ?? [];
  ok("hay huecos ofrecibles tras configurar", disp.length > 0, `slots=${disp.length}`);
  ok(
    "cada hueco trae el día EN PALABRAS, no solo la hora",
    Boolean(disp[0]?.dayLabel && disp[0]?.time),
    JSON.stringify(disp[0])
  );

  console.log("\n== 015: las dos garantías (US3) ==");
  const LEAD_A = "5214627015001";
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD_A,
      name: "Lead agenda A",
      text: "quiero agendar",
      waMessageId: "wamid.e2e.015.a.1",
    }),
  });
  const LEAD_B = "5214627015002";
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD_B,
      name: "Lead agenda B",
      text: "yo también quiero",
      waMessageId: "wamid.e2e.015.b.1",
    }),
  });
  await sleep(1500);

  const convsAgenda = (await api("/api/conversations")).json?.conversations ?? [];
  const convA = convsAgenda.find((c) => c.contact.phone === "524627015001");
  const convB = convsAgenda.find((c) => c.contact.phone === "524627015002");
  ok("dos conversaciones de prueba listas", Boolean(convA && convB));
  if (!convA || !convB) return;

  const ofertaA = await bot(
    `/api/bot/availability?conversationId=${convA.id}&limit=12&perDay=3&days=5`
  );
  const slotsA = ofertaA.json?.slots ?? [];
  ok("ofrecer horarios devuelve huecos", slotsA.length > 0, `slots=${slotsA.length}`);
  ok(
    "el reparto cubre más de un día (no todo hoy)",
    (ofertaA.json?.diasConAgenda ?? []).length > 1,
    JSON.stringify(ofertaA.json?.diasConAgenda)
  );

  // GARANTÍA 1: un instante libre pero JAMÁS ofrecido se rechaza.
  const noOfrecido = await bot("/api/bot/bookings", {
    method: "POST",
    body: JSON.stringify({
      conversationId: convA.id,
      // Un minuto después de un hueco real: válido, libre, y nunca ofrecido.
      startUtc: new Date(Date.parse(slotsA[0].startUtc) + 60_000).toISOString(),
    }),
  });
  ok(
    "horario no ofrecido → 409 slot_not_offered (código EXACTO)",
    noOfrecido.res.status === 409 &&
      noOfrecido.json?.error?.code === "slot_not_offered",
    `status=${noOfrecido.res.status} body=${JSON.stringify(noOfrecido.json)}`
  );
  ok(
    "y devuelve lo que SÍ se ofreció, para re-ofrecer sin inventar",
    (noOfrecido.json?.slots ?? []).length > 0
  );

  // Camino feliz: 201 EXACTO, no 200.
  const elegido = slotsA[0].startUtc;
  const creada = await bot("/api/bot/bookings", {
    method: "POST",
    body: JSON.stringify({ conversationId: convA.id, startUtc: elegido }),
  });
  ok(
    "reservar responde 201 Created (NO 200): es contrato",
    creada.res.status === 201,
    `status=${creada.res.status}`
  );
  ok(
    "la respuesta trae etiqueta y el enlace de la sala fija",
    creada.json?.label && creada.json?.meetingLink === SALA,
    JSON.stringify(creada.json)
  );
  ok("el enlace no queda pendiente con el conector soberano", creada.json?.linkPending === false);

  const dispTrasReserva = (await api("/api/calendar/availability")).json?.slots ?? [];
  ok(
    "el hueco reservado desaparece de la disponibilidad",
    !dispTrasReserva.some((s) => s.startUtc === elegido)
  );

  const lista = (await api("/api/bookings")).json?.bookings ?? [];
  ok(
    "la cita aparece en Citas, marcada como agendada por la IA",
    lista.some((b) => b.id === creada.json?.bookingId && b.source === "ai"),
    JSON.stringify(lista.map((b) => ({ id: b.id, source: b.source })))
  );

  // GARANTÍA 2: la carrera. B tenía el mismo hueco ofrecido y llega tarde.
  const ofertaB = await bot(
    `/api/bot/availability?conversationId=${convB.id}&limit=12&perDay=3&days=5`
  );
  // Se le ofrece a B exactamente el hueco que A acaba de tomar: se simula la
  // oferta previa a la reserva de A, que es como ocurre en la vida real.
  const tomado = await bot("/api/bot/bookings", {
    method: "POST",
    body: JSON.stringify({ conversationId: convB.id, startUtc: elegido }),
  });
  ok(
    "el hueco ya tomado → 409 (nunca una segunda cita)",
    tomado.res.status === 409,
    `status=${tomado.res.status} body=${JSON.stringify(tomado.json)}`
  );
  ok(
    "el sobre del error va ANIDADO y `slots` es HERMANO",
    typeof tomado.json?.error?.code === "string" && Array.isArray(tomado.json?.slots),
    JSON.stringify(tomado.json)
  );

  const listaTrasCarrera = (await api("/api/bookings")).json?.bookings ?? [];
  const activasEnElHueco = listaTrasCarrera.filter(
    (b) =>
      b.scheduledAtUtc === elegido &&
      (b.status === "agendada" || b.status === "realizada")
  );
  ok(
    "CERO doble-agendamiento: una sola cita activa en ese instante",
    activasEnElHueco.length === 1,
    `activas=${activasEnElHueco.length}`
  );

  // Las alternativas del 409 ya son la oferta vigente: reservables de una.
  const alternativa = (tomado.json?.slots ?? [])[0];
  if (alternativa) {
    const conAlternativa = await bot("/api/bot/bookings", {
      method: "POST",
      body: JSON.stringify({
        conversationId: convB.id,
        startUtc: alternativa.startUtc,
      }),
    });
    ok(
      "una alternativa del 409 se reserva de inmediato (201)",
      conAlternativa.res.status === 201,
      `status=${conAlternativa.res.status}`
    );
  } else {
    ok("el 409 trajo alternativas frescas", false, "lista vacía");
  }

  // Reprogramar por la superficie del bot: 200, no 201.
  const ofertaMover = await bot(
    `/api/bot/availability?conversationId=${convA.id}&limit=12&perDay=3&days=5`
  );
  const destino = (ofertaMover.json?.slots ?? [])[0];
  if (destino) {
    const movida = await bot("/api/bot/bookings", {
      method: "PATCH",
      body: JSON.stringify({
        conversationId: convA.id,
        startUtc: destino.startUtc,
      }),
    });
    ok(
      "reprogramar responde 200 (NO 201): no crea un recurso nuevo",
      movida.res.status === 200,
      `status=${movida.res.status}`
    );
  }

  console.log("\n== 015: el operador y el enlace pendiente (US4) ==");
  const bookingId = creada.json?.bookingId;
  const cancelada1 = await api(`/api/bookings/${bookingId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "cancel" }),
  });
  const cancelada2 = await api(`/api/bookings/${bookingId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "cancel" }),
  });
  ok(
    "cancelar dos veces no falla (idempotente)",
    cancelada1.res.ok && cancelada2.res.ok,
    `${cancelada1.res.status}/${cancelada2.res.status}`
  );

  const reintentoInvalido = await api(`/api/bookings/${bookingId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "retry_link" }),
  });
  ok(
    "reintentar el enlace de una cita que sí lo tiene → 422",
    reintentoInvalido.res.status === 422,
    `status=${reintentoInvalido.res.status}`
  );

  // El conector caído: la cita SE CREA igual, con el enlace pendiente.
  await api("/api/calendar/settings", {
    method: "PUT",
    body: JSON.stringify({ connector: "zoom" }),
  });
  const ofertaPend = await bot(
    `/api/bot/availability?conversationId=${convA.id}&limit=12&perDay=3&days=5`
  );
  const slotPend = (ofertaPend.json?.slots ?? [])[0];
  if (slotPend) {
    const sinProveedor = await bot("/api/bot/bookings", {
      method: "POST",
      body: JSON.stringify({
        conversationId: convA.id,
        startUtc: slotPend.startUtc,
      }),
    });
    ok(
      "con el proveedor sin conectar, la cita SE CREA igual (201)",
      sinProveedor.res.status === 201,
      `status=${sinProveedor.res.status}`
    );
    ok(
      "…y avisa que el enlace queda pendiente, en vez de prometerlo",
      sinProveedor.json?.linkPending === true &&
        sinProveedor.json?.meetingLink === null,
      JSON.stringify(sinProveedor.json)
    );

    const listaPend = (await api("/api/bookings")).json?.bookings ?? [];
    ok(
      "la cita sin enlace se ve como tal en Citas",
      listaPend.some(
        (b) => b.id === sinProveedor.json?.bookingId && b.linkPending === true
      )
    );
  }

  // Se restaura el conector soberano para no dejar la instancia a medias.
  await api("/api/calendar/settings", {
    method: "PUT",
    body: JSON.stringify({ connector: "enlace-fijo" }),
  });

  console.log("\n== 015: conector Zoom contra su mock ==");
  const zoomMockUp = await fetch(`${BASE}/api/dev/zoom-mock/_state`);
  if (!zoomMockUp.ok) {
    console.log("  (zoom-mock no disponible: se omiten los checks del conector)");
  } else {
    await fetch(`${BASE}/api/dev/zoom-mock/_reset`, { method: "POST" });

    const malas = await api("/api/settings/zoom", {
      method: "PUT",
      body: JSON.stringify({
        accountId: "acc",
        clientId: "cli",
        clientSecret: "secreto-invalid",
      }),
    });
    ok(
      "credenciales que el proveedor rechaza NO se guardan (422)",
      malas.res.status === 422,
      `status=${malas.res.status}`
    );
    ok(
      "…y la conexión sigue sin existir",
      (await api("/api/settings/zoom")).json?.connection === null
    );

    const buenas = await api("/api/settings/zoom", {
      method: "PUT",
      body: JSON.stringify({
        accountId: "acc",
        clientId: "cli",
        clientSecret: "secreto-bueno",
      }),
    });
    ok("credenciales válidas se guardan", buenas.res.ok, `status=${buenas.res.status}`);
    ok(
      "hacia el navegador solo salen los últimos 4 del secreto",
      buenas.json?.connection?.secretLast4 === "ueno" &&
        !JSON.stringify(buenas.json).includes("secreto-bueno"),
      JSON.stringify(buenas.json)
    );

    await api("/api/calendar/settings", {
      method: "PUT",
      body: JSON.stringify({ connector: "zoom" }),
    });
    const ofertaZoom = await bot(
      `/api/bot/availability?conversationId=${convB.id}&limit=12&perDay=3&days=5`
    );
    const slotZoom = (ofertaZoom.json?.slots ?? [])[0];
    if (slotZoom) {
      const conZoom = await bot("/api/bot/bookings", {
        method: "POST",
        body: JSON.stringify({
          conversationId: convB.id,
          startUtc: slotZoom.startUtc,
        }),
      });
      ok(
        "agendar con Zoom crea la reunión y devuelve su enlace",
        conZoom.res.status === 201 &&
          typeof conZoom.json?.meetingLink === "string" &&
          conZoom.json.meetingLink.includes("zoom.mock"),
        JSON.stringify(conZoom.json)
      );

      const estado = await (await fetch(`${BASE}/api/dev/zoom-mock/_state`)).json();
      ok(
        "el proveedor recibió la reunión con su tema y su hora",
        estado.meetings?.length === 1 &&
          estado.meetings[0].topic.startsWith("Cita —"),
        JSON.stringify(estado.meetings)
      );

      // Cancelar borra la reunión en el proveedor.
      await api(`/api/bookings/${conZoom.json.bookingId}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "cancel" }),
      });
      const estado2 = await (await fetch(`${BASE}/api/dev/zoom-mock/_state`)).json();
      ok(
        "cancelar la cita borra la reunión en el proveedor",
        (estado2.deleted ?? []).length === 1,
        JSON.stringify(estado2)
      );
    }

    await api("/api/settings/zoom", { method: "DELETE" });
    await api("/api/calendar/settings", {
      method: "PUT",
      body: JSON.stringify({ connector: "enlace-fijo" }),
    });
  }

  // El sandbox del Laboratorio (una cita de prueba jamás llega a un conector)
  // NO se verifica aquí: las conversaciones del Laboratorio no son alcanzables
  // desde la API pública —a propósito—, así que desde fuera solo podría
  // observarse por ausencia, que es una prueba débil. Vive en
  // `tests/unit/agenda-sandbox.test.ts`, que afirma lo que de verdad importa:
  // que el conector no se llama, ni al crear, ni al reprogramar, ni al
  // cancelar.
}

main().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});

/* ============================================================
 * 016 — Atribución de anuncios y Conversions API (tests/e2e/us-atribucion.md)
 *
 * Cubre las dos configuraciones de la bandera, la conexión del dataset, la
 * captura del anuncio, los dos eventos con la FORMA de su payload, el dedup,
 * y —lo que más importa— que un fallo de Meta jamás cuesta el movimiento del
 * lead.
 *
 * Los contactos llevan un sufijo por corrida: el dedup de conversiones es
 * permanente por diseño, así que re-correr el arnés contra la MISMA base
 * tiene que estrenar leads o estaría midiendo los de la corrida anterior.
 * ============================================================ */

/* ============================================================
 * 020 — Origen de leads, fase A (specs/020-origen-de-leads/plan.md)
 *
 * El anuncio de origen se guarda SIEMPRE (la bandera ATRIBUCION solo decide
 * el ctwa_clid), gana el primero (D1), su miniatura se copia una vez por
 * anuncio y NO la purga la caché de 30 días (lo afirma `adjuntosChecks`, que
 * corre al final), la fila y el detalle lo traen, el filtro Origen se combina
 * con la vista y la etapa con contadores coherentes, y la fuente se deduce y
 * se corrige a mano (D3). Corre con la bandera apagada Y encendida.
 * ============================================================ */

/** Ruta servible de la miniatura copiada (la afirma la purga, al final). */
let MINIATURA_ANUNCIO = null;

async function anuncioOrigenChecks(encendida) {
  const modo = encendida ? "encendida" : "apagada";
  const SUF = String(Date.now()).slice(-6);
  const tel = (n) => `52166${SUF}${n}`;
  const AD1 = `1202${SUF}01`;
  const AD2 = `1202${SUF}02`;
  const POST = `1202${SUF}03`;
  const AD_FUERA = `1202${SUF}04`;
  const thumb = (id) => `${BASE}/api/dev/wa-mock/cdn/anuncio-${id}.jpg`;
  const CLID = `clid-020-${SUF}`;
  const TITULAR = `Kit de verano ${SUF}`;
  const inbound = (body) =>
    api("/api/dev/wa-mock/inbound", {
      method: "POST",
      body: JSON.stringify({ phoneNumberId: PN, ...body }),
    });
  const lista = async (params = {}) =>
    (await api(`/api/conversations?${new URLSearchParams({ q: SUF, ...params })}`)).json
      ?.conversations ?? [];
  const contadores = async (params = {}) =>
    (await api(`/api/conversations/counts?${new URLSearchParams({ q: SUF, ...params })}`))
      .json;
  const detalle = async (contactId) => (await api(`/api/contacts/${contactId}`)).json;
  /** Espera a que la miniatura (que se copia en segundo plano) aparezca. */
  const conImagen = async (contactId) => {
    let d = null;
    for (let i = 0; i < 30; i++) {
      d = await detalle(contactId);
      if (d?.anuncio?.imageUrl) break;
      await sleep(400);
    }
    return d;
  };
  const conversacionDe = async (name) => {
    for (let i = 0; i < 20; i++) {
      const c = (await lista()).find((x) => x.contact.name === name);
      if (c) return c;
      await sleep(400);
    }
    return null;
  };

  console.log(`\n== 020: anuncio de origen (atribución ${modo}) ==`);

  const NOM_A = `Lead anuncio A ${SUF}`;
  await inbound({
    from: tel("1"),
    name: NOM_A,
    text: "vi su anuncio",
    ctwaClid: CLID,
    adHeadline: TITULAR,
    adSourceId: AD1,
    adMediaType: "video",
    adThumbnailUrl: thumb(AD1),
    waMessageId: `wamid.e2e.020.${SUF}.a1`,
  });
  await sleep(1200);
  // Otro referral en la MISMA conversación: el primero gana (D1).
  await inbound({
    from: tel("1"),
    name: NOM_A,
    text: "sigo aquí",
    ctwaClid: `${CLID}-otro`,
    adHeadline: "Anuncio que no debe ganar",
    adSourceId: AD2,
    waMessageId: `wamid.e2e.020.${SUF}.a2`,
  });
  const convA = await conversacionDe(NOM_A);
  ok("la conversación del anuncio está en la Bandeja", !!convA);
  const ctA = convA?.contact?.id;
  const detA = ctA ? await conImagen(ctA) : null;
  const anA = detA?.anuncio;
  ok(
    `con la bandera ${modo}, el anuncio de origen SE GUARDA`,
    anA?.sourceId === AD1 && anA?.sourceType === "ad",
    JSON.stringify(anA)
  );
  ok(
    "first-touch: el segundo referral no pisa al primero",
    anA?.headline === TITULAR && anA?.sourceId === AD1,
    JSON.stringify(anA?.headline)
  );
  ok(
    "la tarjeta trae texto, 'con video', fecha y enlace https",
    anA?.body === "Escríbenos por WhatsApp" &&
      anA?.mediaType === "video" &&
      !Number.isNaN(Date.parse(anA?.capturedAt ?? "")) &&
      anA?.sourceUrl === "https://fb.me/anuncio-de-prueba",
    JSON.stringify(anA)
  );
  ok(
    `hasCtwaClid = ${encendida} (solo si existe y la bandera está encendida)`,
    anA?.hasCtwaClid === encendida,
    JSON.stringify(anA?.hasCtwaClid)
  );
  ok(
    "el valor del ctwa_clid jamás viaja al cliente",
    !JSON.stringify(detA ?? {}).includes(CLID)
  );
  const guardado = ctA
    ? (await api(`/api/dev/attribution?contact=${ctA}`)).json?.rows ?? []
    : [];
  ok(
    encendida
      ? "encendida: el ctwa_clid se guarda (columna y raw)"
      : "apagada: el ctwa_clid NO se guarda (ni columna ni raw)",
    guardado.length === 1 &&
      guardado[0].ctwaClidColumn === encendida &&
      guardado[0].ctwaClidInRaw === encendida,
    JSON.stringify(guardado)
  );

  ok(
    "la miniatura se copió como adjunto propio (ruta de medios)",
    /^\/api\/media\/[\w.-]+$/.test(anA?.imageUrl ?? ""),
    JSON.stringify(anA?.imageUrl)
  );
  if (anA?.imageUrl) {
    const img = await fetch(`${BASE}${anA.imageUrl}`, { headers: { cookie, origin: BASE } });
    ok(
      "y se sirve como imagen",
      img.status === 200 && /^image\//.test(img.headers.get("content-type") ?? ""),
      `${img.status} ${img.headers.get("content-type")}`
    );
    MINIATURA_ANUNCIO = anA.imageUrl;
  }

  ok(
    "fuente deducida: Anuncio (nadie la capturó)",
    detA?.contact?.source?.value === "anuncio" && detA?.contact?.source?.source === "deducida",
    JSON.stringify(detA?.contact?.source)
  );

  // Otro lead del MISMO anuncio: reutiliza la miniatura (una por source_id).
  const NOM_B = `Lead anuncio B ${SUF}`;
  await inbound({
    from: tel("2"),
    name: NOM_B,
    text: "hola, también lo vi",
    adHeadline: TITULAR,
    adSourceId: AD1,
    adThumbnailUrl: thumb(AD1),
    waMessageId: `wamid.e2e.020.${SUF}.b1`,
  });
  // Una publicación (no anuncio) y una orgánica.
  const NOM_P = `Lead publicacion ${SUF}`;
  await inbound({
    from: tel("3"),
    name: NOM_P,
    text: "vi tu publicación",
    adHeadline: `Mi publicación ${SUF}`,
    adSourceId: POST,
    adSourceType: "post",
    waMessageId: `wamid.e2e.020.${SUF}.p1`,
  });
  const NOM_O = `Lead organico 020 ${SUF}`;
  await inbound({
    from: tel("4"),
    name: NOM_O,
    text: "hola",
    waMessageId: `wamid.e2e.020.${SUF}.o1`,
  });
  // Camino infeliz: miniatura fuera de los hosts de Meta → no se descarga.
  const NOM_E = `Lead miniatura ajena ${SUF}`;
  await inbound({
    from: tel("5"),
    name: NOM_E,
    text: "hola",
    adHeadline: `Anuncio raro ${SUF}`,
    adSourceId: AD_FUERA,
    adThumbnailUrl: "https://example.com/creativo.jpg",
    waMessageId: `wamid.e2e.020.${SUF}.e1`,
  });

  const convB = await conversacionDe(NOM_B);
  const detB = convB ? await conImagen(convB.contact.id) : null;
  ok(
    "mismo anuncio, misma miniatura (una por source_id)",
    !!detB?.anuncio?.imageUrl && detB.anuncio.imageUrl === anA?.imageUrl,
    `${detB?.anuncio?.imageUrl} vs ${anA?.imageUrl}`
  );
  const convE = await conversacionDe(NOM_E);
  await sleep(1500);
  const detE = convE ? await detalle(convE.contact.id) : null;
  ok(
    "una miniatura fuera de Meta no se descarga y la tarjeta sale igual",
    detE?.anuncio?.headline === `Anuncio raro ${SUF}` && detE?.anuncio?.imageUrl === null,
    JSON.stringify(detE?.anuncio)
  );

  /* ---------- La fila de la Bandeja (y el `?ids=` que dispara el SSE) ---------- */
  await conversacionDe(NOM_O);
  const filas = await lista();
  const fila = (n) => filas.find((c) => c.contact.name === n);
  ok(
    "la fila trae el anuncio {headline, sourceType} para la etiqueta",
    fila(NOM_A)?.anuncio?.headline === TITULAR && fila(NOM_A)?.anuncio?.sourceType === "ad",
    JSON.stringify(fila(NOM_A)?.anuncio)
  );
  ok(
    "una publicación llega marcada (la etiqueta dirá «Publicación»)",
    fila(NOM_P)?.anuncio?.sourceType === "post",
    JSON.stringify(fila(NOM_P)?.anuncio)
  );
  ok("una orgánica no trae anuncio", fila(NOM_O)?.anuncio === null, JSON.stringify(fila(NOM_O)?.anuncio));
  const porIds = (await api(`/api/conversations?ids=${fila(NOM_A)?.id}`)).json?.conversations ?? [];
  ok(
    "el ?ids= (lo que pide la Bandeja tras un conversation.updated) también lo trae",
    porIds[0]?.anuncio?.headline === TITULAR,
    JSON.stringify(porIds[0]?.anuncio)
  );
  const detP = fila(NOM_P) ? await detalle(fila(NOM_P).contact.id) : null;
  ok(
    "una publicación deduce «Contenido orgánico» (no «Anuncio»)",
    detP?.anuncio?.sourceType === "post" && detP?.contact?.source?.value === "organico",
    JSON.stringify(detP?.contact?.source)
  );

  /* ---------- Filtro Origen combinado con una vista y una etapa ---------- */
  const nombres = (l) => l.map((c) => c.contact.name).sort();
  const deAnuncio = await lista({ origin: "ad" });
  ok(
    "Origen = De anuncio: solo los de anuncio (no la publicación ni la orgánica)",
    JSON.stringify(nombres(deAnuncio)) === JSON.stringify([NOM_A, NOM_B, NOM_E].sort()),
    JSON.stringify(nombres(deAnuncio))
  );
  const dePublicacion = await lista({ origin: "post" });
  ok(
    "Origen = De publicación: solo la publicación",
    JSON.stringify(nombres(dePublicacion)) === JSON.stringify([NOM_P]),
    JSON.stringify(nombres(dePublicacion))
  );
  const sinOrigen = await lista({ origin: "none" });
  ok(
    "Origen = Sin origen: solo la orgánica",
    JSON.stringify(nombres(sinOrigen)) === JSON.stringify([NOM_O]),
    JSON.stringify(nombres(sinOrigen))
  );
  const c0 = await contadores();
  ok(
    "contadores de Origen: de anuncio 3, de publicación 1, sin origen 1",
    c0?.origin?.ad === 3 && c0?.origin?.post === 1 && c0?.origin?.none === 1,
    JSON.stringify(c0?.origin)
  );

  // B leída; A y la publicación a otra etapa.
  if (convB) {
    await api(`/api/conversations/${convB.id}`, {
      method: "PATCH",
      body: JSON.stringify({ markRead: true }),
    });
  }
  const board = (await api("/api/pipeline/board")).json;
  const leadDe = (n) => board?.leads?.find((l) => l.contact.name === n);
  const etapaInicial = leadDe(NOM_A)?.stageId;
  const etapa2 = board?.stages?.find((s) => s.kind === "open" && s.id !== etapaInicial);
  for (const n of [NOM_A, NOM_P]) {
    const lead = leadDe(n);
    if (lead && etapa2) {
      await api(`/api/pipeline/leads/${lead.id}`, {
        method: "PATCH",
        body: JSON.stringify({ stageId: etapa2.id }),
      });
    }
  }
  ok("(setup) hay una segunda etapa abierta y los leads existen", !!etapa2 && !!leadDe(NOM_A));
  await sleep(500);

  const combo = { filter: "unread", origin: "ad", stage: etapa2?.id ?? "" };
  const filasCombo = await lista(combo);
  const cCombo = await contadores(combo);
  ok(
    "No leídas + De anuncio + Etapa: solo A",
    JSON.stringify(nombres(filasCombo)) === JSON.stringify([NOM_A]),
    JSON.stringify(nombres(filasCombo))
  );
  ok(
    "contadores coherentes con la combinación (vista = filas; facetas)",
    cCombo?.unread === filasCombo.length &&
      cCombo?.all === 1 && // Todas con De anuncio + etapa: A
      cCombo?.origin?.ad === 1 && // No leídas + etapa, de anuncio: A
      cCombo?.origin?.post === 1 && // No leídas + etapa, de publicación: P
      cCombo?.origin?.none === 0, // la orgánica sigue en la etapa inicial
    JSON.stringify({ unread: cCombo?.unread, all: cCombo?.all, origin: cCombo?.origin })
  );
  const sinEtapa = { filter: "unread", origin: "ad" };
  const filasSinEtapa = await lista(sinEtapa);
  const cSinEtapa = await contadores(sinEtapa);
  ok(
    "No leídas + De anuncio (sin etapa): A y la de miniatura ajena; B ya está leída",
    JSON.stringify(nombres(filasSinEtapa)) === JSON.stringify([NOM_A, NOM_E].sort()) &&
      cSinEtapa?.unread === 2 &&
      cSinEtapa?.all === 3,
    JSON.stringify({ filas: nombres(filasSinEtapa), unread: cSinEtapa?.unread, all: cSinEtapa?.all })
  );

  /* ---------- Fuente: deducida → capturada a mano → deducida (D3) ---------- */
  if (ctA) {
    const p1 = await api(`/api/contacts/${ctA}`, {
      method: "PATCH",
      body: JSON.stringify({ source: "referido" }),
    });
    ok(
      "la fuente se corrige a mano y queda «capturada»",
      p1.res.ok &&
        p1.json?.contact?.source?.value === "referido" &&
        p1.json?.contact?.source?.source === "capturada",
      JSON.stringify(p1.json)
    );
    const tras = await detalle(ctA);
    ok(
      "lo capturado manda sobre el anuncio",
      tras?.contact?.source?.value === "referido" && tras?.anuncio?.sourceId === AD1,
      JSON.stringify(tras?.contact?.source)
    );
    const p2 = await api(`/api/contacts/${ctA}`, {
      method: "PATCH",
      body: JSON.stringify({ source: null }),
    });
    ok(
      "source: null vuelve a la deducida (Anuncio)",
      p2.json?.contact?.source?.value === "anuncio" && p2.json?.contact?.source?.source === "deducida",
      JSON.stringify(p2.json?.contact?.source)
    );
    const malo = await api(`/api/contacts/${ctA}`, {
      method: "PATCH",
      body: JSON.stringify({ source: "desconocida" }),
    });
    ok("una fuente fuera del catálogo → 422", malo.res.status === 422, `status=${malo.res.status}`);
  }
}

/* ============================================================
 * 020 fase B — Reportes → Anuncios (GET /api/reports/ads, solo Propietario).
 *
 * Siembra por los flujos reales (wa-mock): 3 leads del anuncio X (con
 * miniatura), 2 del anuncio Y, 1 de una publicación y 2 orgánicos; mueve
 * algunos a Ganado con y sin monto (uno en USD) y compara el reporte como
 * DELTA contra una línea base (la BD de E2E trae datos de los demás checks y
 * el guion corre en serie). Por anuncio se cuadra exacto por los `source_id`
 * únicos de la corrida. No depende de ATRIBUCION: el origen se captura siempre.
 * ============================================================ */

function reporteAnuncios(qs = "range=7d") {
  return api(`/api/reports/ads?${qs}`);
}

const fuenteDe = (rep, value) =>
  rep?.json?.bySource?.ok ? rep.json.bySource.data.rows.find((r) => r.value === value) : null;
const otraMoneda = (amount, cur) =>
  amount?.otherCurrencies?.find((o) => o.currency === cur)?.amountCents ?? 0;

async function reporteAnunciosChecks() {
  console.log("\n== 020 fase B: Reportes → Anuncios ==");
  const SUF = String(Date.now()).slice(-6);
  const tel = (n) => `52177${SUF}${n}`;
  const AD_X = `1203${SUF}01`;
  const AD_Y = `1203${SUF}02`;
  const POST = `1203${SUF}03`;
  const TIT_X = `Promo X ${SUF}`;
  const TIT_Y = `Promo Y ${SUF}`;
  const thumb = (id) => `${BASE}/api/dev/wa-mock/cdn/anuncio-${id}.jpg`;
  const inbound = (body) =>
    api("/api/dev/wa-mock/inbound", {
      method: "POST",
      body: JSON.stringify({ phoneNumberId: PN, ...body }),
    });

  const base = await reporteAnuncios();
  ok(
    "GET /api/reports/ads (owner) → 200 con los tres bloques ok",
    base.res.status === 200 &&
      base.json?.summary?.ok === true &&
      base.json?.bySource?.ok === true &&
      base.json?.byAd?.ok === true,
    `${base.res.status} ${JSON.stringify(base.json)?.slice(0, 300)}`
  );
  ok(
    "por fuente: las seis fuentes en su orden",
    JSON.stringify(base.json?.bySource?.data?.rows?.map((r) => r.value)) ===
      JSON.stringify(["anuncio", "organico", "referido", "conocido", "otro", "desconocida"]),
    JSON.stringify(base.json?.bySource?.data?.rows?.map((r) => r.value))
  );

  const leads = [
    { k: "x1", ad: AD_X, tit: TIT_X, img: true, media: "video" },
    { k: "x2", ad: AD_X, tit: TIT_X, img: true, media: "video" },
    { k: "x3", ad: AD_X, tit: TIT_X, img: true, media: "video" },
    { k: "y1", ad: AD_Y, tit: TIT_Y },
    { k: "y2", ad: AD_Y, tit: TIT_Y },
    { k: "p1", ad: POST, tit: `Mi post ${SUF}`, type: "post" },
    { k: "o1" },
    { k: "o2" },
  ];
  const nombre = (k) => `Rep anuncios ${k} ${SUF}`;
  for (const [i, l] of leads.entries()) {
    await inbound({
      from: tel(String(i + 1)),
      name: nombre(l.k),
      text: "hola, quiero info",
      ...(l.ad
        ? {
            adSourceId: l.ad,
            ...(l.tit ? { adHeadline: l.tit } : {}),
            ...(l.type ? { adSourceType: l.type } : {}),
            ...(l.media ? { adMediaType: l.media } : {}),
            ...(l.img ? { adThumbnailUrl: thumb(l.ad) } : {}),
          }
        : {}),
      waMessageId: `wamid.e2e.020b.${SUF}.${l.k}`,
    });
  }

  // Los leads nacen con el primer mensaje.
  let board = null;
  for (let i = 0; i < 30; i++) {
    board = (await api("/api/pipeline/board")).json;
    const n = leads.filter((l) => board?.leads?.some((x) => x.contact?.name === nombre(l.k))).length;
    if (n === leads.length) break;
    await sleep(400);
  }
  const leadDe = (k) => board?.leads?.find((x) => x.contact?.name === nombre(k));
  const ganado = board?.stages?.find((s) => s.kind === "won");
  ok(
    "(setup) los 8 leads existen y hay etapa Ganado",
    leads.every((l) => leadDe(l.k)) && !!ganado,
    `leads=${leads.filter((l) => leadDe(l.k)).length} won=${ganado?.id}`
  );
  const gana = async (k, extra = {}) => {
    const lead = leadDe(k);
    if (!lead || !ganado) return false;
    const r = await api(`/api/pipeline/leads/${lead.id}`, {
      method: "PATCH",
      body: JSON.stringify({ stageId: ganado.id, ...extra }),
    });
    return r.res.ok;
  };
  const movidos = [
    await gana("x1", { amountCents: 150000 }), // MXN (la del negocio)
    await gana("x2"), // ganado SIN monto
    await gana("y1", { amountCents: 5000, currency: "USD" }), // otra moneda
    await gana("p1", { amountCents: 30000 }),
    await gana("o1", { amountCents: 10000 }),
  ];
  ok("(setup) 5 leads movidos a Ganado", movidos.every(Boolean), JSON.stringify(movidos));

  // La miniatura de X se copia en segundo plano: se espera a que aparezca.
  let rep = null;
  let filaX = null;
  for (let i = 0; i < 30; i++) {
    rep = await reporteAnuncios();
    filaX = rep.json?.byAd?.data?.rows?.find((r) => r.sourceId === AD_X);
    if (filaX?.imageUrl) break;
    await sleep(400);
  }
  const filas = rep?.json?.byAd?.data?.rows ?? [];
  const filaY = filas.find((r) => r.sourceId === AD_Y);
  const filaP = filas.find((r) => r.sourceId === POST);

  /* ---------- Por anuncio (exacto) ---------- */
  ok(
    "anuncio X: 3 leads, 2 ventas, 67 % de cierre, titular y tipo",
    filaX?.leads === 3 &&
      filaX?.won === 2 &&
      Math.abs((filaX?.winRate ?? 0) - 2 / 3) < 1e-9 &&
      filaX?.title === TIT_X &&
      filaX?.sourceType === "ad" &&
      filaX?.mediaType === "video",
    JSON.stringify(filaX)
  );
  ok(
    "anuncio X: monto 1,500.00 MXN y 1 venta sin monto (cuenta, no suma)",
    filaX?.wonAmount?.currency === "MXN" &&
      filaX?.wonAmount?.amountCents === 150000 &&
      filaX?.wonAmount?.wonWithoutAmount === 1 &&
      filaX?.wonAmount?.otherCurrencies?.length === 0,
    JSON.stringify(filaX?.wonAmount)
  );
  ok(
    "anuncio X: miniatura servible por la ruta de medios",
    /^\/api\/media\/[\w.-]+$/.test(filaX?.imageUrl ?? ""),
    JSON.stringify(filaX?.imageUrl)
  );
  if (filaX?.imageUrl) {
    const img = await fetch(`${BASE}${filaX.imageUrl}`, { headers: { cookie, origin: BASE } });
    ok(
      "y la miniatura se sirve como imagen",
      img.status === 200 && /^image\//.test(img.headers.get("content-type") ?? ""),
      `${img.status} ${img.headers.get("content-type")}`
    );
  }
  ok(
    "anuncio Y: 2 leads, 1 venta; el monto en USD va APARTE (no se suma a MXN)",
    filaY?.leads === 2 &&
      filaY?.won === 1 &&
      filaY?.wonAmount?.amountCents === 0 &&
      otraMoneda(filaY?.wonAmount, "USD") === 5000 &&
      filaY?.imageUrl === null,
    JSON.stringify(filaY)
  );
  ok(
    "publicación: su propia fila, tipo post, con su titular, 1 venta de 300.00",
    filaP?.sourceType === "post" &&
      filaP?.title === `Mi post ${SUF}` &&
      filaP?.leads === 1 &&
      filaP?.won === 1 &&
      filaP?.wonAmount?.amountCents === 30000,
    JSON.stringify(filaP)
  );
  const orden = filas.map((r) => r.sourceId);
  ok(
    "ordenado por leads: X antes que Y antes que la publicación",
    orden.indexOf(AD_X) < orden.indexOf(AD_Y) && orden.indexOf(AD_Y) < orden.indexOf(POST),
    JSON.stringify(orden)
  );
  ok(
    "una sola fila por source_id (agrupa) y total ≥ filas ≤ 50",
    [AD_X, AD_Y, POST].every((id) => filas.filter((r) => r.sourceId === id).length === 1) &&
      (rep?.json?.byAd?.data?.total ?? 0) >= filas.length &&
      filas.length <= 50,
    `total=${rep?.json?.byAd?.data?.total} filas=${filas.length}`
  );

  /* ---------- Por fuente (delta) ---------- */
  const d = (value, campo) => (fuenteDe(rep, value)?.[campo] ?? NaN) - (fuenteDe(base, value)?.[campo] ?? NaN);
  const dMonto = (value) =>
    (fuenteDe(rep, value)?.wonAmount?.amountCents ?? NaN) -
    (fuenteDe(base, value)?.wonAmount?.amountCents ?? NaN);
  const dSinMonto = (value) =>
    (fuenteDe(rep, value)?.wonAmount?.wonWithoutAmount ?? NaN) -
    (fuenteDe(base, value)?.wonAmount?.wonWithoutAmount ?? NaN);
  const resumen = (value) =>
    JSON.stringify({
      conv: d(value, "conversations"),
      leads: d(value, "leads"),
      won: d(value, "won"),
      monto: dMonto(value),
      sinMonto: dSinMonto(value),
    });
  ok(
    "por fuente · Anuncio: +5 conversaciones, +5 leads, +3 ventas, +1,500.00 MXN, +1 sin monto",
    resumen("anuncio") === JSON.stringify({ conv: 5, leads: 5, won: 3, monto: 150000, sinMonto: 1 }),
    resumen("anuncio")
  );
  ok(
    "por fuente · Anuncio: +50.00 USD aparte",
    otraMoneda(fuenteDe(rep, "anuncio")?.wonAmount, "USD") -
      otraMoneda(fuenteDe(base, "anuncio")?.wonAmount, "USD") ===
      5000
  );
  ok(
    "por fuente · Contenido orgánico (la publicación): +1, +1, +1, +300.00",
    resumen("organico") === JSON.stringify({ conv: 1, leads: 1, won: 1, monto: 30000, sinMonto: 0 }),
    resumen("organico")
  );
  ok(
    "por fuente · Sin identificar (orgánicos): +2, +2, +1, +100.00",
    resumen("desconocida") === JSON.stringify({ conv: 2, leads: 2, won: 1, monto: 10000, sinMonto: 0 }),
    resumen("desconocida")
  );
  ok(
    "por fuente · Referido/Conocido/Otro sin cambios",
    ["referido", "conocido", "otro"].every((v) => d(v, "leads") === 0 && d(v, "conversations") === 0)
  );

  /* ---------- Resumen (delta y coherencia) ---------- */
  const s0 = base.json?.summary?.data;
  const s1 = rep?.json?.summary?.data;
  const dS = {
    conv: (s1?.conversations ?? NaN) - (s0?.conversations ?? NaN),
    adConv: (s1?.adConversations ?? NaN) - (s0?.adConversations ?? NaN),
    leads: (s1?.adLeads ?? NaN) - (s0?.adLeads ?? NaN),
    won: (s1?.adWon ?? NaN) - (s0?.adWon ?? NaN),
    monto: (s1?.adWonAmount?.amountCents ?? NaN) - (s0?.adWonAmount?.amountCents ?? NaN),
  };
  ok(
    "resumen: +8 conversaciones, +5 de anuncio, +5 leads, +3 ventas, +1,500.00 MXN",
    JSON.stringify(dS) === JSON.stringify({ conv: 8, adConv: 5, leads: 5, won: 3, monto: 150000 }),
    JSON.stringify(dS)
  );
  const anuncio = fuenteDe(rep, "anuncio");
  const totalConv = (rep?.json?.bySource?.data?.rows ?? []).reduce((a, r) => a + r.conversations, 0);
  ok(
    "resumen = fila Anuncio de Por fuente, y el % de anuncio = de anuncio / total",
    s1?.adLeads === anuncio?.leads &&
      s1?.adWon === anuncio?.won &&
      s1?.adWonAmount?.amountCents === anuncio?.wonAmount?.amountCents &&
      s1?.conversations === totalConv &&
      Math.abs((s1?.adShare ?? -1) - s1?.adConversations / s1?.conversations) < 1e-9,
    JSON.stringify({ s1, anuncio })
  );
  ok(
    "resumen trae el rango previo del mismo largo",
    !!s1?.previous && typeof s1.previous.conversations === "number" && s1.previous.to < rep.json.range.from,
    JSON.stringify(s1?.previous)
  );

  /* ---------- Camino infeliz y rango vacío ---------- */
  const vacio = await reporteAnuncios("range=custom&from=2020-01-01&to=2020-01-07");
  const vb = vacio.json;
  ok(
    "rango sin datos → 200, bloques ok y vacíos (sin error)",
    vacio.res.status === 200 &&
      vb?.summary?.ok &&
      vb.summary.data.conversations === 0 &&
      vb.summary.data.adShare === null &&
      vb?.bySource?.ok &&
      vb.bySource.data.rows.every((r) => r.conversations === 0 && r.leads === 0 && r.winRate === null) &&
      vb?.byAd?.ok &&
      vb.byAd.data.rows.length === 0 &&
      vb.byAd.data.total === 0,
    JSON.stringify(vb)?.slice(0, 400)
  );
  const malo = await reporteAnuncios("range=custom&from=2026-02-10&to=2026-01-01");
  ok(
    "rango inválido → 422 invalid_range",
    malo.res.status === 422 && malo.json?.error?.code === "invalid_range",
    `${malo.res.status} ${JSON.stringify(malo.json)}`
  );
  const page = await fetch(`${BASE}/reports/ads`, { headers: { cookie } });
  const html = await page.text();
  ok(
    "la pantalla /reports/ads existe y la pestaña Anuncios es un enlace real",
    page.status === 200 && html.includes('href="/reports/ads') && !html.includes(">Anuncios<span"),
    `status=${page.status}`
  );
}

/** El Laboratorio no mueve el reporte de anuncios. */
async function reporteAnunciosLabChecks(antes) {
  console.log("\n== 020 fase B: el Laboratorio no cuenta en Reportes → Anuncios ==");
  const despues = await reporteAnuncios("range=7d");
  ok(
    "tras correr el Laboratorio, Por fuente y el resumen no cambian",
    antes?.json?.bySource?.ok &&
      JSON.stringify(antes.json.bySource.data) === JSON.stringify(despues.json?.bySource?.data) &&
      antes.json.summary?.data?.conversations === despues.json?.summary?.data?.conversations,
    JSON.stringify({
      antes: antes?.json?.summary?.data?.conversations,
      despues: despues?.json?.summary?.data?.conversations,
    })
  );
}

/** Solo Propietario (D4): el Vendedor recibe 403 en la API y 404 en la página. */
async function reporteAnunciosVendedorChecks() {
  console.log("\n== 020 fase B: Reportes → Anuncios solo para el Propietario ==");
  const SUF = String(Date.now()).slice(-6);
  const email = `vend.ads.${SUF}@vocero.test`;
  const password = "password-vend-ads-123";
  const alta = await api("/api/settings/team", {
    method: "POST",
    body: JSON.stringify({ name: "Vendedor Anuncios", email, password }),
  });
  ok("(setup) alta del vendedor", alta.res.ok, `${alta.res.status} ${JSON.stringify(alta.json)}`);
  // Su propio cookie jar: el `cookie` global es la sesión del Propietario.
  const login = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password }),
  });
  const sellerCookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  ok("(setup) el vendedor inicia sesión", login.ok && !!sellerCookie, String(login.status));
  const r = await fetch(`${BASE}/api/reports/ads?range=7d`, {
    headers: { cookie: sellerCookie, origin: BASE },
  });
  const j = await r.json().catch(() => null);
  ok(
    "GET /api/reports/ads como Vendedor → 403 forbidden",
    r.status === 403 && j?.error?.code === "forbidden",
    `${r.status} ${JSON.stringify(j)}`
  );
  const p = await fetch(`${BASE}/reports/ads`, {
    headers: { cookie: sellerCookie },
    redirect: "manual",
  });
  ok("/reports/ads para el Vendedor → 404", p.status === 404, String(p.status));
}

async function atribucionChecks() {
  const encendida = /^(on|1|true|si|sí|yes)$/i.test(
    (process.env.ATRIBUCION ?? "").trim()
  );
  const SUF = String(Date.now()).slice(-6);
  const tel = (n) => `52155${SUF}${n}`;
  const nom = (base) => `${base} ${SUF}`;

  // 020: el anuncio de origen se captura con la bandera en CUALQUIER posición.
  await anuncioOrigenChecks(encendida);

  console.log("\n== 016: la bandera de la atribución ==");

  if (!encendida) {
    for (const ruta of ["/api/settings/capi", "/api/settings/capi/events"]) {
      const { res } = await api(ruta);
      ok(
        `${ruta} → 404 con la atribución apagada`,
        res.status === 404,
        `status=${res.status}`
      );
    }
    const put = await api("/api/settings/capi", {
      method: "PUT",
      body: JSON.stringify({ datasetId: "ds-e2e" }),
    });
    ok(
      "PUT /api/settings/capi → 404 con la atribución apagada",
      put.res.status === 404,
      `status=${put.res.status}`
    );
    const page = await fetch(`${BASE}/settings/ads`, { headers: { cookie } });
    ok(
      "la pantalla /settings/ads no existe",
      page.status === 404,
      `status=${page.status}`
    );

    // Y un mensaje que SÍ viene de un anuncio se atiende como cualquier otro:
    // la instancia que no atribuye no se entera del referral, pero tampoco se
    // rompe con él.
    const inb = await api("/api/dev/wa-mock/inbound", {
      method: "POST",
      body: JSON.stringify({
        phoneNumberId: PN,
        from: tel("1"),
        name: nom("Lead con anuncio apagada"),
        text: "vi su anuncio",
        ctwaClid: "clid-apagada",
        waMessageId: `wamid.e2e.016.off.${SUF}`,
      }),
    });
    ok("inbound con anuncio entregado igual", inb.res.ok);
    await sleep(1400);
    const convsOff = (await api("/api/conversations")).json?.conversations ?? [];
    ok(
      "la conversación del anuncio existe (la ingesta no se rompe)",
      convsOff.some((c) => c.contact.name === nom("Lead con anuncio apagada"))
    );
    console.log(
      "  (atribución apagada: el resto de los checks de 016 no aplican)"
    );
    return;
  }

  /* ---------------- US2: conectar el dataset ---------------- */

  console.log("\n== 016: conectar el dataset (US2) ==");
  // Se parte de desconectado: así el primer check afirma lo que dice afirmar
  // aunque el arnés se re-corra sobre la misma base.
  await api("/api/settings/capi", { method: "DELETE" });
  const vacio = await api("/api/settings/capi");
  ok(
    "sin configurar responde 200 con capi: null (no 404)",
    vacio.res.status === 200 && vacio.json?.capi === null,
    JSON.stringify(vacio.json)
  );

  const board0 = (await api("/api/pipeline/board")).json;
  const etapaCalificado = board0.stages.filter((s) => s.kind === "open").at(-1);
  const etapaGanada = board0.stages.find((s) => s.kind === "won");
  const etapaInicial = board0.stages.find((s) => s.kind === "open");

  const etapaAjena = await api("/api/settings/capi", {
    method: "PUT",
    body: JSON.stringify({
      datasetId: "ds-e2e",
      qualifiedStageId: "stg_de_otro_negocio",
    }),
  });
  ok(
    "una etapa que no es del negocio se rechaza con 422 etapa_invalida",
    etapaAjena.res.status === 422 &&
      etapaAjena.json?.error?.code === "etapa_invalida",
    `status=${etapaAjena.res.status} ${JSON.stringify(etapaAjena.json)}`
  );

  const guardado = await api("/api/settings/capi", {
    method: "PUT",
    body: JSON.stringify({
      datasetId: "ds-e2e",
      qualifiedStageId: etapaCalificado.id,
    }),
  });
  ok(
    "se guarda el dataset sin pegar token",
    guardado.res.ok,
    `status=${guardado.res.status}`
  );

  const cfg = (await api("/api/settings/capi")).json?.capi;
  ok(
    "reusó el token de WhatsApp y solo muestra sus últimos 4",
    cfg?.datasetId === "ds-e2e" && cfg?.tokenLast4 === "-e2e",
    JSON.stringify(cfg)
  );
  ok(
    "el token completo NUNCA sale del servidor",
    !JSON.stringify(cfg).includes("tok-e2e"),
    JSON.stringify(cfg)
  );

  /* ---------------- US3 + US4: capturar y calificar ---------------- */

  console.log("\n== 016: del anuncio al lead calificado (US3/US4) ==");
  await api("/api/dev/wa-mock/capi-events", { method: "DELETE" });

  const CLID = `clid-e2e-${SUF}`;
  const NOMBRE_AD = nom("Lead de anuncio");
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: tel("2"),
      name: NOMBRE_AD,
      text: "hola, vengo del anuncio",
      ctwaClid: CLID,
      adHeadline: "Kit de verano",
      waMessageId: `wamid.e2e.016.ad.${SUF}.1`,
    }),
  });
  await sleep(1400);

  // Segundo mensaje con OTRO referral: el primero gana y no se sobreescribe.
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: tel("2"),
      name: NOMBRE_AD,
      text: "sigo aquí",
      ctwaClid: "clid-que-no-debe-ganar",
      waMessageId: `wamid.e2e.016.ad.${SUF}.2`,
    }),
  });
  await sleep(1200);

  const board1 = (await api("/api/pipeline/board")).json;
  const leadAd = board1.leads.find((l) => l.contact.name === NOMBRE_AD);
  ok("el lead del anuncio existe en el tablero", !!leadAd);

  const mov1 = await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  ok(
    "el lead se mueve a la etapa calificada",
    mov1.res.ok,
    `status=${mov1.res.status}`
  );
  await sleep(800);

  const act1 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const calificado = act1.find(
    (e) => e.eventName === "QualifiedLead" && e.contactName === NOMBRE_AD
  );
  ok(
    "se reportó QualifiedLead con acuse de Meta",
    calificado?.status === "sent" && !!calificado?.fbTraceId,
    JSON.stringify(calificado)
  );
  ok(
    "la actividad dice de qué anuncio vino",
    calificado?.adHeadline === "Kit de verano",
    JSON.stringify(calificado)
  );

  const capi1 = (await api("/api/dev/wa-mock/capi-events")).json?.capiEvents ?? [];
  const evento1 = capi1.find((e) => e.eventName === "QualifiedLead");
  ok(
    "el evento viajó con el ctwa_clid del PRIMER referral",
    evento1?.ctwaClid === CLID,
    JSON.stringify(evento1?.ctwaClid)
  );
  ok(
    "y con custom_data.lead_stage (lo único reglable en Meta)",
    evento1?.customData?.lead_stage === "qualified",
    JSON.stringify(evento1?.customData)
  );

  // Dedup: sacarlo y volverlo a meter no re-reporta.
  await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaInicial.id }),
  });
  await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  await sleep(800);
  const act2 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const califsDeEste = act2.filter(
    (e) => e.eventName === "QualifiedLead" && e.contactName === NOMBRE_AD
  );
  ok(
    "volver a calificar NO reporta dos veces",
    califsDeEste.length === 1,
    `${califsDeEste.length} filas`
  );

  /* ---------------- US5: la venta ---------------- */

  console.log("\n== 016: la venta (US5) ==");
  const venta = await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      stageId: etapaGanada.id,
      amountCents: 45050,
      currency: "MXN",
    }),
  });
  ok("el trato se marca como ganado", venta.res.ok, `status=${venta.res.status}`);
  await sleep(800);

  const act3 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const compra = act3.find(
    (e) => e.eventName === "Purchase" && e.contactName === NOMBRE_AD
  );
  ok("se reportó la venta", compra?.status === "sent", JSON.stringify(compra));

  const capi2 = (await api("/api/dev/wa-mock/capi-events")).json?.capiEvents ?? [];
  const evento2 = capi2.find((e) => e.eventName === "Purchase");
  ok(
    "la venta viajó en UNIDADES de la moneda, no en centavos",
    evento2?.customData?.value === 450.5 &&
      evento2?.customData?.currency === "MXN",
    JSON.stringify(evento2?.customData)
  );

  await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaGanada.id }),
  });
  await sleep(800);
  const act4 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const comprasDeEste = act4.filter(
    (e) => e.eventName === "Purchase" && e.contactName === NOMBRE_AD
  );
  ok(
    "re-ganar NO manda una segunda compra (a Meta no se le des-envía nada)",
    comprasDeEste.length === 1,
    `${comprasDeEste.length} filas`
  );

  /* ---------------- Los caminos infelices ---------------- */

  console.log("\n== 016: caminos infelices ==");

  // Un lead que no vino de un anuncio: se registra el motivo y nada falla.
  const NOMBRE_ORG = nom("Lead organico");
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: tel("3"),
      name: NOMBRE_ORG,
      text: "hola",
      waMessageId: `wamid.e2e.016.org.${SUF}`,
    }),
  });
  await sleep(1400);
  const board2 = (await api("/api/pipeline/board")).json;
  const leadOrg = board2.leads.find((l) => l.contact.name === NOMBRE_ORG);
  await api(`/api/pipeline/leads/${leadOrg.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  await sleep(800);
  const act5 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const omitido = act5.find((e) => e.contactName === NOMBRE_ORG);
  ok(
    "un lead sin anuncio queda OMITIDO con el motivo escrito",
    omitido?.status === "skipped" && /ctwa_clid/.test(omitido?.error ?? ""),
    JSON.stringify(omitido)
  );

  // Meta rechazando: el 200 mentiroso (events_received: 0).
  const NOMBRE_FAIL = nom("Lead con Meta caido");
  await api("/api/settings/capi", {
    method: "PUT",
    body: JSON.stringify({
      datasetId: "ds-e2e-fail",
      qualifiedStageId: etapaCalificado.id,
    }),
  });
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: tel("4"),
      name: NOMBRE_FAIL,
      text: "vengo del anuncio",
      ctwaClid: `clid-fail-${SUF}`,
      waMessageId: `wamid.e2e.016.fail.${SUF}`,
    }),
  });
  await sleep(1400);
  const board3 = (await api("/api/pipeline/board")).json;
  const leadFail = board3.leads.find((l) => l.contact.name === NOMBRE_FAIL);
  const movFail = await api(`/api/pipeline/leads/${leadFail.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  ok(
    "con Meta rechazando, el lead SE MUEVE igual",
    movFail.res.ok,
    `status=${movFail.res.status}`
  );
  await sleep(800);
  const board4 = (await api("/api/pipeline/board")).json;
  const leadFail2 = board4.leads.find((l) => l.contact.name === NOMBRE_FAIL);
  ok(
    "y se queda en la etapa a la que lo movieron",
    leadFail2?.stageId === etapaCalificado.id,
    JSON.stringify(leadFail2?.stageId)
  );
  const act6 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const fallido = act6.find((e) => e.contactName === NOMBRE_FAIL);
  ok(
    "la fila queda FALLIDA con lo que dijo Meta (200 pero events_received=0)",
    fallido?.status === "failed" &&
      /events_received=0/.test(fallido?.error ?? ""),
    JSON.stringify(fallido)
  );

  // Desconectar: deja de reportarse, pero la bitácora de lo ya dicho se queda.
  const del = await api("/api/settings/capi", { method: "DELETE" });
  ok("se puede desconectar", del.res.ok);
  const trasBorrar = (await api("/api/settings/capi")).json;
  ok("tras desconectar, no hay configuración", trasBorrar?.capi === null);
  const act7 = (await api("/api/settings/capi/events")).json?.events ?? [];
  ok(
    "los eventos ya reportados NO se borran al desconectar",
    act7.length >= 3,
    `${act7.length} filas`
  );
}

/* ============================================================
 * 014/017 — Canales Instagram y Messenger (tests/e2e/us-canales.md)
 *
 * Con cada canal apagado: su superficie no existe (404). Encendido: se
 * conecta validando el token, un DM entra firmado por el webhook real y crea
 * UN contacto, la re-entrega no duplica, la respuesta llega al transporte
 * del canal con el destinatario correcto, fuera de las 24 h sale etiquetada
 * como agente humano, pasados 7 días se rechaza, y los fallos del proveedor
 * degradan con un error claro en vez de un 500.
 * ============================================================ */

/**
 * Cuentas de Instagram y Messenger del self-test. A nivel de módulo porque
 * las conecta `canalesChecks` y las reutiliza `adjuntosChecks` (018).
 */
const CANAL_SUF = String(Date.now()).slice(-6);
const CANALES = [
  {
    channel: "instagram",
    label: "Instagram",
    settings: "/api/settings/instagram",
    webhook: "ig",
    page: "/settings/instagram",
    accountId: `1784${CANAL_SUF}`,
    connect: (accountId, token) => ({ source: "meta", igUserId: accountId, token }),
  },
  {
    channel: "messenger",
    label: "Messenger",
    settings: "/api/settings/messenger",
    webhook: "fb",
    page: "/settings/messenger",
    accountId: `1099${CANAL_SUF}`,
    connect: (accountId, token) => ({ pageId: accountId, token }),
  },
];

/** Canales opcionales encendidos según la bandera `CHANNELS`. */
function canalesEncendidos() {
  return new Set(
    (process.env.CHANNELS ?? "")
      .split(",")
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * 020 fase C — El anuncio de origen en Instagram (Click-to-Direct) y
 * Messenger (Click-to-Messenger): `message.referral` con el DM, first-touch,
 * referral malformado que no tumba el mensaje, `referral` suelto en un hilo
 * existente (origen sin mensaje nuevo) y, en Messenger, el botón Empezar
 * (`postback.referral`) de alguien que el CRM no conocía.
 */
async function origenDeAnuncioCanal({ c, inbound, SUF, pre, existente }) {
  console.log(`\n== 020: ${c.label} — anuncio de origen ==`);
  const AD = (n) => `1203${SUF}${c.channel === "instagram" ? 1 : 2}${n}`;
  const thumb = (id) => `${BASE}/api/dev/wa-mock/cdn/anuncio-${id}.jpg`;
  const esIg = c.channel === "instagram";
  const referral = (n, titular) => ({
    ref: `promo-${n}`,
    ad_id: AD(n),
    source: "ADS",
    type: "OPEN_THREAD",
    ads_context_data: {
      ad_title: titular,
      // Instagram manda la miniatura del video en `video_url`.
      ...(esIg ? { video_url: thumb(AD(n)) } : { photo_url: thumb(AD(n)), post_id: `${c.accountId}_77${SUF}` }),
    },
  });
  const lista = async () => (await api("/api/conversations")).json?.conversations ?? [];
  const porTexto = async (t) => {
    for (let i = 0; i < 20; i++) {
      const x = (await lista()).find((cv) => cv.channel === c.channel && cv.preview?.includes(t));
      if (x) return x;
      await sleep(400);
    }
    return null;
  };
  const detalle = async (contactId) => (await api(`/api/contacts/${contactId}`)).json;
  /** Espera hasta que el anuncio del contacto cumpla `cond` (miniatura en 2.º plano). */
  const esperarAnuncio = async (contactId, cond) => {
    let d = null;
    for (let i = 0; i < 30; i++) {
      d = await detalle(contactId);
      if (cond(d?.anuncio)) break;
      await sleep(400);
    }
    return d;
  };
  const mensajes = async (convId) =>
    ((await api(`/api/conversations/${convId}/messages`)).json?.messages ?? []).filter(
      (m) => m.direction === "in"
    );

  /* --- DM con message.referral --- */
  const TIT = `Anuncio ${c.label} ${SUF}`;
  const sA = `${pre}${SUF}ad1`;
  const tA = `vengo del anuncio ${c.label} ${SUF}`;
  const inA = await inbound({ senderId: sA, text: tA, mid: `mid.e2e.${c.channel}.${SUF}.ad1`, referral: referral(1, TIT) });
  ok(`DM con referral entregado`, inA.res.ok, JSON.stringify(inA.json));
  const cvA = await porTexto(tA);
  ok(
    `la conversación sale "De anuncio" con su titular`,
    cvA?.anuncio?.headline === TIT && cvA?.anuncio?.sourceType === "ad",
    JSON.stringify(cvA?.anuncio)
  );
  const deAnuncio =
    (await api(`/api/conversations?origin=ad&channel=${c.channel}`)).json?.conversations ?? [];
  ok(`el filtro Origen = De anuncio la incluye`, deAnuncio.some((x) => x.id === cvA?.id));
  const dA = cvA ? await esperarAnuncio(cvA.contact.id, (a) => !!a?.imageUrl) : null;
  const anA = dA?.anuncio;
  ok(
    `tarjeta: id del anuncio, titular, ${esIg ? "video" : "imagen"}, sin identificador de clic`,
    anA?.sourceId === AD(1) &&
      anA?.headline === TIT &&
      anA?.mediaType === (esIg ? "video" : "image") &&
      anA?.hasCtwaClid === false,
    JSON.stringify(anA)
  );
  ok(
    esIg
      ? `Instagram: sin enlace a la publicación (no hay forma fiable)`
      : `Messenger: enlace https a la publicación (post_id)`,
    esIg
      ? anA?.sourceUrl === null
      : anA?.sourceUrl === `https://www.facebook.com/${c.accountId}_77${SUF}`,
    JSON.stringify(anA?.sourceUrl)
  );
  ok(
    `la miniatura se copió como adjunto propio y se sirve`,
    /^\/api\/media\/[\w.-]+$/.test(anA?.imageUrl ?? "") &&
      (await fetch(`${BASE}${anA.imageUrl}`, { headers: { cookie, origin: BASE } })).status === 200,
    JSON.stringify(anA?.imageUrl)
  );
  ok(
    `fuente deducida: Anuncio`,
    dA?.contact?.source?.value === "anuncio" && dA?.contact?.source?.source === "deducida",
    JSON.stringify(dA?.contact?.source)
  );

  /* --- first-touch --- */
  await inbound({
    senderId: sA,
    text: `otro anuncio ${SUF}`,
    mid: `mid.e2e.${c.channel}.${SUF}.ad1b`,
    referral: referral(2, "No debe ganar"),
  });
  await sleep(1200);
  const dA2 = cvA ? await detalle(cvA.contact.id) : null;
  const filasA = cvA
    ? (await api(`/api/dev/attribution?contact=${cvA.contact.id}`)).json?.rows ?? []
    : [];
  ok(
    `first-touch: el segundo referral no pisa al primero`,
    dA2?.anuncio?.sourceId === AD(1) && dA2?.anuncio?.headline === TIT && filasA.length === 1,
    JSON.stringify({ a: dA2?.anuncio?.sourceId, filas: filasA.length })
  );

  /* --- referral malformado: el mensaje entra igual --- */
  const tB = `referral raro ${c.label} ${SUF}`;
  const inB = await inbound({ senderId: `${pre}${SUF}ad2`, text: tB, mid: `mid.e2e.${c.channel}.${SUF}.ad2`, referral: "basura" });
  const tC = `contexto raro ${c.label} ${SUF}`;
  const inC = await inbound({
    senderId: `${pre}${SUF}ad3`,
    text: tC,
    mid: `mid.e2e.${c.channel}.${SUF}.ad3`,
    referral: { source: "ADS", ad_id: { raro: true }, ads_context_data: 42 },
  });
  const cvB = await porTexto(tB);
  const cvC = await porTexto(tC);
  ok(
    `referral malformado no rompe la ingesta: los dos mensajes entran`,
    inB.res.ok && inC.res.ok && !!cvB && !!cvC,
    JSON.stringify({ b: inB.res.status, c: inC.res.status, cvB: !!cvB, cvC: !!cvC })
  );
  ok(`un referral que no es objeto no deja origen`, cvB?.anuncio === null, JSON.stringify(cvB?.anuncio));
  ok(
    `uno de anuncio con datos rotos queda "De anuncio" sin titular ni id`,
    cvC?.anuncio?.sourceType === "ad" && cvC?.anuncio?.headline === null,
    JSON.stringify(cvC?.anuncio)
  );

  /* --- referral suelto en un hilo existente: origen sin mensaje nuevo --- */
  const antes = existente ? (await mensajes(existente.id)).length : -1;
  const TIT_S = `Anuncio de regreso ${c.label} ${SUF}`;
  const suelto = await inbound({
    senderId: `${pre}${SUF}1`,
    extraEvents: [
      {
        sender: { id: `${pre}${SUF}1` },
        recipient: { id: c.accountId },
        timestamp: Date.now(),
        referral: referral(3, TIT_S),
      },
    ],
  });
  ok(`referral suelto entregado`, suelto.res.ok, JSON.stringify(suelto.json));
  const dS = existente
    ? await esperarAnuncio(existente.contact.id, (a) => a?.headline === TIT_S)
    : null;
  const despues = existente ? (await mensajes(existente.id)).length : -2;
  const mismasS = (await lista()).filter((x) => x.contact.id === existente?.contact.id);
  ok(
    `referral suelto en hilo existente: origen aplicado sin mensaje nuevo`,
    dS?.anuncio?.sourceId === AD(3) && antes === despues && antes > 0 && mismasS.length === 1,
    JSON.stringify({ a: dS?.anuncio?.sourceId, antes, despues, convs: mismasS.length })
  );

  /* --- Messenger: botón Empezar de alguien que el CRM no conocía --- */
  if (!esIg) {
    const conteo = async () =>
      (await api(`/api/conversations/counts?channel=${c.channel}`)).json?.byChannel?.[c.channel] ?? -1;
    const n0 = await conteo();
    const sD = `${pre}${SUF}ad4`;
    const TIT_P = `Anuncio con Empezar ${SUF}`;
    const pb = await inbound({
      senderId: sD,
      extraEvents: [
        {
          sender: { id: sD },
          recipient: { id: c.accountId },
          timestamp: Date.now(),
          postback: { title: "Empezar", payload: "GET_STARTED", referral: referral(4, TIT_P) },
        },
      ],
    });
    await sleep(1200);
    const n1 = await conteo();
    ok(
      `postback.referral sin contacto previo: crea contacto y conversación sin mensaje`,
      pb.res.ok && n1 === n0 + 1,
      JSON.stringify({ n0, n1 })
    );
    const tD = `ya escribo tras Empezar ${SUF}`;
    await inbound({ senderId: sD, text: tD, mid: `mid.e2e.${c.channel}.${SUF}.ad4` });
    const cvD = await porTexto(tD);
    const n2 = await conteo();
    ok(
      `su primer mensaje cae en esa conversación, con el origen ya puesto`,
      cvD?.anuncio?.headline === TIT_P && n2 === n1 && (cvD ? (await mensajes(cvD.id)).length : 0) === 1,
      JSON.stringify({ anuncio: cvD?.anuncio, n1, n2 })
    );
  }
}

async function canalesChecks() {
  const on = canalesEncendidos();
  const SUF = CANAL_SUF;
  const VT = process.env.META_WEBHOOK_VERIFY_TOKEN;
  const DAY = 24 * 60 * 60 * 1000;

  for (const c of CANALES) {
    console.log(`\n== ${c.label}: la bandera del canal ==`);

    if (!on.has(c.channel)) {
      const get = await api(c.settings);
      ok(`${c.settings} → 404 con el canal apagado`, get.res.status === 404, `status=${get.res.status}`);
      const hook = await fetch(`${BASE}/api/webhooks/${c.webhook}/${VT}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      ok(`webhook /${c.webhook} → 404 con el canal apagado`, hook.status === 404, `status=${hook.status}`);
      const page = await fetch(`${BASE}${c.page}`, { headers: { cookie } });
      ok(`la pantalla ${c.page} no existe`, page.status === 404, `status=${page.status}`);
      continue;
    }

    const outbox = async () => (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
    const inbound = (body) =>
      api("/api/dev/wa-mock/channel-inbound", {
        method: "POST",
        body: JSON.stringify({ channel: c.channel, accountId: c.accountId, ...body }),
      });
    const send = (convId, text) =>
      api(`/api/conversations/${convId}/messages`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
    const reconnect = (token) =>
      api(c.settings, { method: "PUT", body: JSON.stringify(c.connect(c.accountId, token)) });

    /* ---------- conectar ---------- */
    console.log(`\n== ${c.label}: conectar ==`);
    await api(c.settings, { method: "DELETE" });

    const bad = await reconnect("tok-e2e-invalid");
    ok(`token inválido → 422 y no se guarda`, bad.res.status === 422, `status=${bad.res.status}`);
    const ajeno = await reconnect("tok-e2e-id999");
    ok(
      `token de otra cuenta → 422 id_mismatch`,
      ajeno.res.status === 422 && ajeno.json?.error?.code === "id_mismatch",
      JSON.stringify(ajeno.json)
    );
    const tras = (await api(c.settings)).json;
    ok(`tras los rechazos no hay conexión guardada`, tras?.connection === null, JSON.stringify(tras?.connection));

    const good = await reconnect("tok-e2e-canal");
    ok(`conexión guardada`, good.res.ok, JSON.stringify(good.json));
    if (c.channel === "messenger") {
      // 020 fase C: la Página se suscribe también a los campos que traen el
      // anuncio de origen sin mensaje (hilo existente y botón Empezar).
      const subs = (await api("/api/dev/wa-mock/outbox")).json?.subscriptions ?? [];
      const ultima = subs.filter((s) => s.accountId === c.accountId).at(-1);
      ok(
        `la Página se suscribe a messages, messaging_referrals y messaging_postbacks`,
        JSON.stringify(ultima?.fields) ===
          JSON.stringify(["messages", "messaging_referrals", "messaging_postbacks"]) &&
          ultima?.accepted === true &&
          JSON.stringify(good.json?.subscribedFields) === JSON.stringify(ultima?.fields) &&
          !good.json?.warning,
        JSON.stringify({ ultima, resp: good.json })
      );
      // Si Meta rechaza los campos nuevos, se reintenta solo con messages: la
      // conexión no se rompe y la pantalla avisa.
      const parcial = await reconnect("tok-e2e-sinreferrals");
      const subs2 = (await api("/api/dev/wa-mock/outbox")).json?.subscriptions ?? [];
      const ult2 = subs2.filter((s) => s.accountId === c.accountId).slice(-2);
      ok(
        `campos de anuncios rechazados → reintenta solo con messages y avisa`,
        parcial.res.ok &&
          parcial.json?.subscribed === true &&
          JSON.stringify(parcial.json?.subscribedFields) === JSON.stringify(["messages"]) &&
          /messaging_referrals/.test(parcial.json?.warning ?? "") &&
          ult2[0]?.accepted === false &&
          ult2[0]?.fields?.length === 3 &&
          ult2[1]?.accepted === true &&
          JSON.stringify(ult2[1]?.fields) === JSON.stringify(["messages"]),
        JSON.stringify({ resp: parcial.json, ult2 })
      );
      await reconnect("tok-e2e-canal");
    }
    const estado = (await api(c.settings)).json;
    ok(
      `el token nunca sale entero (solo sus últimos 4)`,
      estado?.connection?.tokenLast4 === "anal" && !JSON.stringify(estado).includes("tok-e2e-canal"),
      JSON.stringify(estado?.connection)
    );
    ok(
      `la pantalla expone la URL del webhook /${c.webhook}`,
      typeof estado?.webhook?.url === "string" && estado.webhook.url.includes(`/api/webhooks/${c.webhook}/`),
      JSON.stringify(estado?.webhook)
    );
    const pantalla = await fetch(`${BASE}${c.page}`, { headers: { cookie } });
    ok(`la pantalla ${c.page} existe`, pantalla.status === 200, `status=${pantalla.status}`);

    /* ---------- recibir ---------- */
    console.log(`\n== ${c.label}: recibir ==`);
    const pre = c.channel === "instagram" ? "ig" : "psid";
    const sender = `${pre}${SUF}1`;
    await api("/api/dev/wa-mock/outbox", { method: "DELETE" });

    const firma = await fetch(`${BASE}/api/webhooks/${c.webhook}/${VT}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" },
      body: JSON.stringify({ object: c.channel === "instagram" ? "instagram" : "page", entry: [] }),
    });
    ok(`webhook con firma falsa → 401`, firma.status === 401, `status=${firma.status}`);
    const segMalo = await fetch(`${BASE}/api/webhooks/${c.webhook}/no-es-el-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    ok(`webhook con segmento equivocado → 404`, segMalo.status === 404, `status=${segMalo.status}`);
    const hs = await fetch(
      `${BASE}/api/webhooks/${c.webhook}/${VT}?hub.mode=subscribe&hub.verify_token=${VT}&hub.challenge=reto123`
    );
    ok(`handshake de suscripción devuelve el challenge`, hs.status === 200 && (await hs.text()) === "reto123");

    const mid1 = `mid.e2e.${c.channel}.${SUF}.1`;
    const in1 = await inbound({ senderId: sender, text: `hola, ¿tienen disponibilidad? ${SUF}`, mid: mid1 });
    ok(`DM entregado al webhook firmado`, in1.res.ok, JSON.stringify(in1.json));
    // Re-entrega del mismo mid + un eco + una lectura: nada de eso duplica.
    await inbound({ senderId: sender, text: `hola, ¿tienen disponibilidad? ${SUF}`, mid: mid1 });
    await inbound({
      senderId: sender,
      text: "eco de la cuenta",
      mid: `mid.e2e.${c.channel}.${SUF}.echo`,
      echo: true,
      extraEvents: [{ sender: { id: sender }, recipient: { id: c.accountId }, read: { watermark: Date.now() } }],
    });
    await sleep(1500);

    const cv = ((await api("/api/conversations")).json?.conversations ?? []).find(
      (x) => x.channel === c.channel && x.preview?.includes(`disponibilidad? ${SUF}`)
    );
    ok(`el DM crea una conversación con canal ${c.channel}`, !!cv);
    ok(`el contacto toma el nombre del perfil del canal`, cv?.contact.name === `Cliente ${c.label}`, cv?.contact.name);

    // Si Meta niega el perfil (función no aprobada), el DM entra igual con el
    // nombre de respaldo.
    const sinPerfil = await inbound({
      senderId: `${pre}${SUF}sinperfil`,
      text: `sin perfil ${SUF}`,
      mid: `mid.e2e.${c.channel}.${SUF}.sinperfil`,
    });
    await sleep(1500);
    const cvSin = ((await api("/api/conversations")).json?.conversations ?? []).find(
      (x) => x.channel === c.channel && x.preview?.includes(`sin perfil ${SUF}`)
    );
    ok(
      `sin perfil disponible → entra con el nombre de respaldo del canal`,
      sinPerfil.res.ok && cvSin?.contact.name === `Contacto de ${c.label}`,
      cvSin?.contact.name
    );
    ok(`el contacto no tiene teléfono`, cv?.contact.phone === null);
    const msgs = (await api(`/api/conversations/${cv?.id}/messages`)).json?.messages ?? [];
    const entrantes = msgs.filter((m) => m.direction === "in");
    ok(`re-entrega y eco no duplican: un solo entrante`, entrantes.length === 1, JSON.stringify(entrantes.map((m) => m.text)));
    ok(`dentro de 24 h se responde libre`, cv?.replyMode === "free", cv?.replyMode);
    // 018: sí manda archivos (matriz del canal), pero no ubicación/contactos.
    ok(
      `el canal no ofrece plantillas ni ubicación/contactos, sí archivos`,
      cv?.templates === false &&
        cv?.outboundStructured === false &&
        typeof cv?.outboundFiles?.accept === "string",
      JSON.stringify({ t: cv?.templates, s: cv?.outboundStructured, f: cv?.outboundFiles?.accept })
    );

    // Un segundo mensaje del mismo remitente cae en la MISMA conversación.
    await inbound({ senderId: sender, text: "¿y precios?", mid: `mid.e2e.${c.channel}.${SUF}.2` });
    await sleep(1200);
    const mismas = ((await api("/api/conversations")).json?.conversations ?? []).filter(
      (x) => x.contact.id === cv?.contact.id
    );
    ok(`mismo remitente → mismo contacto y misma conversación`, mismas.length === 1, `${mismas.length}`);

    await origenDeAnuncioCanal({ c, inbound, SUF, pre, existente: cv });

    /* ---------- responder ---------- */
    console.log(`\n== ${c.label}: responder ==`);
    const texto = `Claro, te comparto horarios ${SUF}`;
    const r1 = await send(cv?.id, texto);
    ok(`respuesta del operador aceptada`, r1.res.ok, JSON.stringify(r1.json));
    const ob = (await outbox()).find((o) => o.body?.message?.text === texto);
    ok(`llega al transporte del canal con el destinatario correcto`, ob?.to === sender, JSON.stringify(ob));
    ok(`sale por la cuenta conectada`, ob?.phoneNumberId === c.accountId, ob?.phoneNumberId);
    ok(`dentro de ventana no lleva etiqueta`, !!ob && !ob.body.tag, JSON.stringify(ob?.body));
    if (c.channel === "messenger") {
      ok(`messaging_type RESPONSE`, ob?.body?.messaging_type === "RESPONSE", ob?.body?.messaging_type);
    }
    const hilo = (await api(`/api/conversations/${cv?.id}/messages`)).json?.messages ?? [];
    const salida = hilo.find((m) => m.text === texto);
    ok(`el mensaje queda 'sent' (el canal no manda acuses)`, salida?.status === "sent", salida?.status);

    const largo = c.channel === "instagram" ? "é".repeat(600) : "a".repeat(2001);
    const r2 = await send(cv?.id, largo);
    ok(`texto que excede el límite → 422 claro`, r2.res.status === 422, `status=${r2.res.status} ${r2.json?.error?.message}`);

    const ubic = await api(`/api/conversations/${cv?.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ type: "location", location: { latitude: 21.0, longitude: -101.2 } }),
    });
    ok(
      `ubicación en ${c.label} → 422 unsupported_channel (no 500)`,
      ubic.res.status === 422 && ubic.json?.error?.code === "unsupported_channel",
      `status=${ubic.res.status} ${JSON.stringify(ubic.json)}`
    );
    // 018: el canal ya acepta imágenes (el detalle por tipo está en
    // adjuntosChecks); lo que dice ser JPEG y no lo es → 415, no 500.
    const imgRes = await sendFile(cv?.id, JPEG_1X1, "foto.jpg", "image/jpeg");
    ok(`imagen JPEG real en ${c.label} → aceptada`, imgRes.status === 201, `status=${imgRes.status} ${JSON.stringify(imgRes.json)}`);
    const fake = await sendFile(cv?.id, Buffer.from("hola"), "x.jpg", "image/jpeg");
    ok(`"JPEG" que no lo es en ${c.label} → 415 claro (no 500)`, fake.status === 415, `status=${fake.status}`);
    const tplRes = await api(`/api/contacts/${cv?.contact.id}/start-conversation`, {
      method: "POST",
      body: JSON.stringify({ templateId: "tpl-cualquiera" }),
    });
    ok(`plantilla para un contacto de ${c.label} → 422`, tplRes.res.status === 422, `status=${tplRes.res.status}`);

    /* ---------- fuera de ventana ---------- */
    console.log(`\n== ${c.label}: fuera de las 24 h ==`);
    await inbound({
      senderId: `${pre}${SUF}2`,
      text: `escribí hace 3 días ${SUF}`,
      mid: `mid.e2e.${c.channel}.${SUF}.3d`,
      timestamp: Date.now() - 3 * DAY,
    });
    await inbound({
      senderId: `${pre}${SUF}3`,
      text: `escribí hace 8 días ${SUF}`,
      mid: `mid.e2e.${c.channel}.${SUF}.8d`,
      timestamp: Date.now() - 8 * DAY,
    });
    await sleep(1500);
    const lista = (await api("/api/conversations")).json?.conversations ?? [];
    const c3 = lista.find((x) => x.channel === c.channel && x.preview?.includes(`hace 3 días ${SUF}`));
    const c8 = lista.find((x) => x.channel === c.channel && x.preview?.includes(`hace 8 días ${SUF}`));
    ok(`a los 3 días el modo es agente humano`, c3?.replyMode === "human_agent", c3?.replyMode);
    ok(`a los 8 días el canal está cerrado`, c8?.replyMode === "closed", c8?.replyMode);

    const t3 = `Retomo tu consulta ${SUF}`;
    const r3 = await send(c3?.id, t3);
    ok(`respuesta humana a los 3 días aceptada`, r3.res.ok, JSON.stringify(r3.json));
    const ob3 = (await outbox()).find((o) => o.body?.message?.text === t3);
    ok(
      `sale con la etiqueta HUMAN_AGENT`,
      ob3?.body?.tag === "HUMAN_AGENT" && ob3?.body?.messaging_type === "MESSAGE_TAG",
      JSON.stringify(ob3?.body)
    );
    const antes8 = (await outbox()).length;
    const r8 = await send(c8?.id, "hola?");
    ok(
      `a los 8 días → 409 window_closed con motivo claro`,
      r8.res.status === 409 && r8.json?.error?.code === "window_closed" && /7 días/.test(r8.json?.error?.message ?? ""),
      `status=${r8.res.status} ${JSON.stringify(r8.json)}`
    );
    ok(`y no se intentó el envío`, (await outbox()).length === antes8);

    /* ---------- fallos del proveedor ---------- */
    console.log(`\n== ${c.label}: fallos del proveedor ==`);
    await reconnect("tok-e2e-nohumanagent");
    const rNh = await send(c3?.id, "sin permiso");
    ok(
      `sin la función Human Agent → 409 que lo dice (no un error genérico)`,
      rNh.res.status === 409 && /Human Agent/.test(rNh.json?.error?.message ?? ""),
      `status=${rNh.res.status} ${JSON.stringify(rNh.json)}`
    );

    await reconnect("tok-e2e-down");
    const rDown = await send(cv?.id, "¿sigues ahí?");
    ok(`plataforma caída → 503 meta_unavailable`, rDown.res.status === 503, `status=${rDown.res.status} ${JSON.stringify(rDown.json)}`);
    const trasCaida = (await api(c.settings)).json?.connection;
    ok(`una caída NO marca el token como muerto`, trasCaida?.status === "connected", trasCaida?.status);

    // El token muere DESPUÉS de guardarse: el PUT lo valida contra Meta, así
    // que se reemplaza por la puerta de pruebas y se observa el envío.
    const kill = await api("/api/dev/wa-mock/channel-token", {
      method: "POST",
      body: JSON.stringify({ channel: c.channel, token: "tok-e2e-muerto-invalid" }),
    });
    ok(`(setup) token reemplazado por uno revocado`, kill.res.ok, JSON.stringify(kill.json));
    const rDead = await send(cv?.id, "hola de nuevo");
    ok(
      `token revocado → 409 reconnect_required`,
      rDead.res.status === 409 && rDead.json?.error?.code === "reconnect_required",
      JSON.stringify(rDead.json)
    );
    const trasMuerte = (await api(c.settings)).json?.connection;
    ok(`y la conexión queda pidiendo reconectar`, trasMuerte?.status === "reconnect_required", trasMuerte?.status);
    const rTras = await send(cv?.id, "otro intento");
    ok(`los envíos siguientes se pausan sin llamar a Meta`, rTras.json?.error?.code === "reconnect_required", JSON.stringify(rTras.json));

    // Deja el canal sano para quien corra después.
    await reconnect("tok-e2e-canal");
  }
}

/* ============================================================
 * US4 — Laboratorio: eliminar una evaluación (tests/e2e/us4-lab.md)
 *
 * Una corrida en curso NO se elimina (409 run_in_progress: el índice UNIQUE
 * parcial es el candado de concurrencia); una terminada se va con sus casos
 * y sus conversaciones de prueba. Las conversaciones se observan por la
 * API de mensajes (no filtra is_test): 200 ANTES y 404 DESPUÉS, para que la
 * ausencia sea una prueba de verdad y no un "no encontré nada".
 * ============================================================ */

async function labChecks() {
  console.log("\n== Laboratorio: eliminar evaluación ==");
  const LAB_TIMEOUT_MS = 180_000;

  // Una corrida huérfana de una ejecución abortada bloquearía el POST.
  const t0 = Date.now();
  for (;;) {
    const runs = (await api("/api/lab/runs")).json?.runs ?? [];
    if (!runs.some((r) => r.status === "running")) break;
    if (Date.now() - t0 > LAB_TIMEOUT_MS) {
      ok("(setup) no hay corridas del Laboratorio en curso", false, "sigue una en curso tras 180s");
      return;
    }
    await sleep(1000);
  }

  // 08 — Una BD limpia siembra el set neutro; us4-lab.md describe el de autos.
  const restore = await api("/api/lab/personas/restore-defaults", {
    method: "POST",
    body: JSON.stringify({ set: "autos" }),
  });
  ok(
    "POST /api/lab/personas/restore-defaults {set:autos} → 200",
    restore.res.status === 200 && restore.json?.set === "autos",
    `status=${restore.res.status} ${JSON.stringify(restore.json)?.slice(0, 200)}`
  );

  const launch = await api("/api/lab/runs", { method: "POST" });
  if (launch.json?.error?.code === "ai_not_configured") {
    ok(
      "Laboratorio: el proveedor de IA está configurado (OPENROUTER_API_TOKEN + OPENROUTER_BASE_URL → ai-mock)",
      false,
      JSON.stringify(launch.json)
    );
    return;
  }
  const runId = launch.json?.runId;
  ok("POST /api/lab/runs → 202 con runId", launch.res.status === 202 && !!runId, `status=${launch.res.status} ${JSON.stringify(launch.json)}`);
  if (!runId) return;

  const enCurso = await api(`/api/lab/runs/${runId}`, { method: "DELETE" });
  ok(
    "DELETE de una corrida en curso → 409 run_in_progress",
    enCurso.res.status === 409 && enCurso.json?.error?.code === "run_in_progress",
    `status=${enCurso.res.status} ${JSON.stringify(enCurso.json)}`
  );

  const tRun = Date.now();
  let detail = null;
  for (;;) {
    const d = await api(`/api/lab/runs/${runId}`);
    detail = d.json;
    if (detail?.run && detail.run.status !== "running") break;
    if (Date.now() - tRun > LAB_TIMEOUT_MS) break;
    await sleep(1000);
  }
  console.log(`  ..  corrida terminó en ${((Date.now() - tRun) / 1000).toFixed(1)}s (status=${detail?.run?.status})`);
  ok(
    "la corrida termina (done/failed) dentro del timeout",
    detail?.run && detail.run.status !== "running",
    JSON.stringify(detail?.run)
  );
  if (!detail?.run || detail.run.status === "running") return;

  const convIds = (detail.cases ?? []).map((c) => c.conversationId).filter(Boolean);
  ok(
    "el detalle expone las conversaciones de prueba de sus casos",
    detail.run.status === "failed" || convIds.length > 0,
    JSON.stringify(detail.cases?.map((c) => c.conversationId))
  );
  const faltantes = [];
  for (const cid of convIds) {
    const m = await api(`/api/conversations/${cid}/messages`);
    if (m.res.status !== 200) faltantes.push(`${cid}:${m.res.status}`);
  }
  ok(
    `(antes) sus ${convIds.length} conversaciones de prueba existen (200)`,
    faltantes.length === 0,
    faltantes.join(", ")
  );

  const del = await api(`/api/lab/runs/${runId}`, { method: "DELETE" });
  ok("DELETE de una corrida terminada → 200", del.res.status === 200, `status=${del.res.status} ${JSON.stringify(del.json)}`);

  const trasBorrar = await api(`/api/lab/runs/${runId}`);
  ok("el detalle de la corrida eliminada → 404", trasBorrar.res.status === 404, `status=${trasBorrar.res.status}`);

  const lista = (await api("/api/lab/runs")).json?.runs ?? [];
  ok("la lista ya no incluye la corrida", !lista.some((r) => r.id === runId));

  const sobrevivientes = [];
  for (const cid of convIds) {
    const m = await api(`/api/conversations/${cid}/messages`);
    if (m.res.status !== 404) sobrevivientes.push(`${cid}:${m.res.status}`);
  }
  ok(
    `sus ${convIds.length} conversaciones de prueba se borraron (404)`,
    sobrevivientes.length === 0,
    sobrevivientes.join(", ")
  );

  const otraVez = await api(`/api/lab/runs/${runId}`, { method: "DELETE" });
  ok("DELETE repetido → 404", otraVez.res.status === 404, `status=${otraVez.res.status}`);
  const inexistente = await api("/api/lab/runs/tr_no_existe_e2e", { method: "DELETE" });
  ok("DELETE de un id inexistente → 404", inexistente.res.status === 404, `status=${inexistente.res.status}`);
}

/* ============================================================
 * 09 — Asignación (T-09-16; el guion completo con vendedores es
 * scripts/e2e-asignacion.mjs). Como Propietario: cada conversación trae
 * `assignedTo`/`assignedAt` y el owner las sigue viendo todas — las de este
 * guion quedan "sin asignar" (el envío del Propietario no asigna).
 * ============================================================ */

async function asignacionChecks() {
  console.log("\n== 09: asignación (vista del Propietario) ==");
  const todas = (await api("/api/conversations")).json?.conversations ?? [];
  ok("el owner ve conversaciones en la Bandeja", todas.length > 0, `n=${todas.length}`);
  const sinCampos = todas.filter((c) => !("assignedTo" in c) || !("assignedAt" in c));
  ok(
    "cada conversación trae assignedTo y assignedAt",
    sinCampos.length === 0,
    sinCampos.map((c) => c.id).join(", ")
  );
  ok(
    "assignedAt presente si y solo si hay responsable",
    todas.every((c) => (c.assignedTo === null) === (c.assignedAt === null)),
    JSON.stringify(todas.filter((c) => (c.assignedTo === null) !== (c.assignedAt === null)).map((c) => c.id))
  );
  ok(
    "las del self-test siguen sin asignar (el envío del owner no asigna)",
    todas
      .filter((c) => c.contact?.name === "Dueña Dental")
      .every((c) => c.assignedTo === null),
    JSON.stringify(todas.filter((c) => c.contact?.name === "Dueña Dental").map((c) => c.assignedTo))
  );

  // La org puede traer asignaciones de guiones previos (e2e-asignacion corre
  // sobre la misma BD): se comprueban particiones, no un estado fijo.
  const yo = (await api("/api/auth/get-session")).json?.user?.id;
  const ids = (list) => list.map((c) => c.id).sort().join(",");
  const all = (await api("/api/conversations?assigned=all")).json?.conversations ?? [];
  ok("?assigned=all = la lista por defecto", ids(all) === ids(todas));
  const libres = (await api("/api/conversations?assigned=unassigned")).json?.conversations ?? [];
  ok(
    "?assigned=unassigned = exactamente las sin responsable",
    ids(libres) === ids(todas.filter((c) => c.assignedTo === null))
  );
  const mias = (await api("/api/conversations?assigned=me")).json?.conversations ?? [];
  ok(
    "?assigned=me = exactamente las del owner",
    !!yo && ids(mias) === ids(todas.filter((c) => c.assignedTo?.userId === yo)),
    `yo=${yo} n=${mias.length}`
  );
  const deOtros = todas.filter((c) => c.assignedTo && c.assignedTo.userId !== yo);
  ok(
    "el owner ve todas: también las asignadas a otros",
    todas.length === libres.length + mias.length + deOtros.length,
    `todas=${todas.length} libres=${libres.length} mias=${mias.length} otros=${deOtros.length}`
  );
  const malo = await api("/api/conversations?assigned=otro");
  ok("?assigned inválido → 422", malo.res.status === 422, `status=${malo.res.status}`);
}

/* ============================================================
 * 018 — Adjuntos seguros (tests/e2e/us-adjuntos.md)
 *
 * El tipo de un archivo lo decide la FIRMA de sus bytes, no la extensión: por
 * eso cada caso manda bytes reales (PDF, JPEG, ZIP de Office, MZ, OLE). Cubre
 * envío y recepción en los tres canales, lo que se bloquea, cómo se sirve
 * (cabeceras), la URL firmada /api/media/out y la caché de 30 días. Con
 * CHANNELS apagado solo corre WhatsApp. Va AL FINAL del self-test: la purga
 * adelanta el reloj 31 días y expira todos los adjuntos de la BD.
 * ============================================================ */
async function adjuntosChecks() {
  const SUF = String(Date.now()).slice(-6);
  const on = canalesEncendidos();
  const outbox = async () => (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  const msgsOf = async (convId) =>
    (await api(`/api/conversations/${convId}/messages`)).json?.messages ?? [];
  const isNosniff = (r) => r.headers.get("x-content-type-options") === "nosniff";
  const isSandboxed = (r) => /sandbox/.test(r.headers.get("content-security-policy") ?? "");
  const disposition = (r) => r.headers.get("content-disposition") ?? "";
  /** Un asset disponible antes de la purga (para AC-8). */
  let assetVivo = null;

  /* ---------- WhatsApp: enviar (AC-1, AC-2, AC-3) ---------- */
  console.log("\n== 018: WhatsApp — enviar archivos ==");
  const LEAD_ADJ = "5214627018001";
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD_ADJ,
      name: "Adjuntos E2E",
      text: `te mando unos archivos ${SUF}`,
      waMessageId: `wamid.e2e.018.${SUF}.hola`,
    }),
  });
  let conv = null;
  for (let i = 0; i < 20 && !conv; i++) {
    await sleep(500);
    conv = ((await api("/api/conversations")).json?.conversations ?? []).find(
      (c) => c.contact.name === "Adjuntos E2E"
    );
  }
  ok("(setup) conversación de WhatsApp para adjuntos", !!conv);
  if (!conv) return;
  ok(
    "WhatsApp: el compositor ofrece archivos (accept con PDF y Word) y ubicación/contactos",
    conv.outboundStructured === true &&
      /\.pdf/.test(conv.outboundFiles?.accept ?? "") &&
      /\.docx/.test(conv.outboundFiles?.accept ?? ""),
    JSON.stringify({ s: conv.outboundStructured, f: conv.outboundFiles?.accept })
  );

  await api("/api/dev/wa-mock/outbox", { method: "DELETE" });
  const pdfOut = await sendFile(conv.id, PDF_BYTES, "cotizacion.pdf", "application/pdf", `cotización ${SUF}`);
  ok("WhatsApp: PDF real → enviado", pdfOut.status === 201, `status=${pdfOut.status} ${JSON.stringify(pdfOut.json)}`);
  const jpgOut = await sendFile(conv.id, JPEG_1X1, "auto.jpg", "image/jpeg", `foto auto ${SUF}`);
  ok("WhatsApp: JPEG real → enviado", jpgOut.status === 201, `status=${jpgOut.status} ${JSON.stringify(jpgOut.json)}`);
  const docxOut = await sendFile(conv.id, DOCX_LIMPIO, "propuesta.docx", DOCX_MIME);
  ok("WhatsApp: .docx limpio → enviado", docxOut.status === 201, `status=${docxOut.status} ${JSON.stringify(docxOut.json)}`);
  let ob = await outbox();
  ok(
    "Graph recibió el PDF como document (con su nombre) y el JPEG como image",
    ob.some((o) => o.type === "document" && JSON.stringify(o.body).includes("cotizacion.pdf")) &&
      ob.some((o) => o.type === "image"),
    JSON.stringify(ob.map((o) => o.type))
  );

  const antes = (await outbox()).length;
  const rechazos = [
    ["un .exe (MZ)", EXE_BYTES, "programa.exe", "application/octet-stream", /ejecutable/],
    ["un .exe disfrazado de PDF", EXE_BYTES, "cotizacion.pdf", "application/pdf", /ejecutable/],
    ["un .zip genérico", ZIP_GENERICO, "fotos.zip", "application/zip", /comprimidos/],
    ["un .docx con vbaProject.bin", DOCX_MACROS, "macro.docx", DOCX_MIME, /macros/],
    ["un .doc antiguo (OLE)", OLE_DOC_BYTES, "viejo.doc", "application/msword", /\.docx/],
  ];
  for (const [label, bytes, name, type, reason] of rechazos) {
    const r = await sendFile(conv.id, bytes, name, type);
    ok(
      `WhatsApp: ${label} → 415 con razón clara`,
      r.status === 415 && reason.test(r.json?.error?.message ?? ""),
      `status=${r.status} ${JSON.stringify(r.json)}`
    );
  }
  const grande = await sendFile(conv.id, bigPng(6 * 1024 * 1024), "grande.png", "image/png");
  ok(
    "WhatsApp: PNG real de 6 MB → 413 con el límite",
    grande.status === 413 && /5 MB/.test(grande.json?.error?.message ?? ""),
    `status=${grande.status} ${JSON.stringify(grande.json)}`
  );
  ok("ningún rechazo llegó a Graph", (await outbox()).length === antes);

  /* ---------- Servir lo enviado (AC-6) ---------- */
  console.log("\n== 018: cómo se sirven los archivos ==");
  let hilo = await msgsOf(conv.id);
  const pdfMsg = hilo.find((m) => m.media?.caption === `cotización ${SUF}`);
  const jpgMsg = hilo.find((m) => m.media?.caption === `foto auto ${SUF}`);
  ok(
    "el PDF enviado queda en el hilo como documento disponible",
    pdfMsg?.media?.kind === "document" &&
      pdfMsg.media.fetchStatus === "available" &&
      pdfMsg.media.mimeType === "application/pdf",
    JSON.stringify(pdfMsg?.media)
  );
  const pdfGet = await getMedia(pdfMsg?.media?.assetId);
  ok(
    "GET del PDF: 200 application/pdf como DESCARGA (attachment con nombre)",
    pdfGet.status === 200 &&
      (pdfGet.headers.get("content-type") ?? "").startsWith("application/pdf") &&
      /^attachment;/.test(disposition(pdfGet)) &&
      /cotizacion\.pdf/.test(disposition(pdfGet)),
    `${pdfGet.status} ${pdfGet.headers.get("content-type")} ${disposition(pdfGet)}`
  );
  ok("GET del PDF: nosniff + CSP sandbox", isNosniff(pdfGet) && isSandboxed(pdfGet));
  const jpgGet = await getMedia(jpgMsg?.media?.assetId);
  ok(
    "GET de la imagen: 200 image/jpeg inline",
    jpgGet.status === 200 &&
      (jpgGet.headers.get("content-type") ?? "").startsWith("image/jpeg") &&
      /^inline/.test(disposition(jpgGet)) &&
      isNosniff(jpgGet) &&
      isSandboxed(jpgGet),
    `${jpgGet.status} ${jpgGet.headers.get("content-type")} ${disposition(jpgGet)}`
  );
  assetVivo = pdfMsg?.media?.assetId ?? null;

  /* ---------- WhatsApp: recibir (AC-4) ---------- */
  console.log("\n== 018: WhatsApp — recibir archivos ==");
  const inboundWa = (body) =>
    api("/api/dev/wa-mock/inbound", {
      method: "POST",
      body: JSON.stringify({ phoneNumberId: PN, from: LEAD_ADJ, ...body }),
    });
  await inboundWa({
    type: "document",
    mediaId: `media-e2e-html-pdf-${SUF}`,
    filename: "factura.pdf",
    caption: `factura ${SUF}`,
    waMessageId: `wamid.e2e.018.${SUF}.html`,
  });
  await inboundWa({
    type: "document",
    mediaId: `media-e2e-cot-pdf-${SUF}`,
    filename: "orden.pdf",
    caption: `orden ${SUF}`,
    waMessageId: `wamid.e2e.018.${SUF}.pdf`,
  });
  const htmlMsg = await waitMessage(conv.id, (m) => m.media?.caption === `factura ${SUF}`);
  ok(
    "HTML que dice ser PDF → blocked, con razón y sin guardar el binario",
    htmlMsg?.media?.fetchStatus === "blocked" && /HTML/.test(htmlMsg.media.blockedReason ?? ""),
    JSON.stringify(htmlMsg?.media)
  );
  const htmlGet = await getMedia(htmlMsg?.media?.assetId);
  const htmlBody = await htmlGet.text();
  ok(
    "GET del bloqueado → 415 blocked y JAMÁS el HTML",
    htmlGet.status === 415 && /blocked/.test(htmlBody) && !/<script/i.test(htmlBody),
    `${htmlGet.status} ${htmlBody.slice(0, 120)}`
  );
  const pdfIn = await waitMessage(conv.id, (m) => m.media?.caption === `orden ${SUF}`);
  ok(
    "PDF entrante real → disponible con MIME detectado",
    pdfIn?.media?.fetchStatus === "available" && pdfIn.media.mimeType === "application/pdf",
    JSON.stringify(pdfIn?.media)
  );
  const pdfInGet = await getMedia(pdfIn?.media?.assetId);
  ok(
    "GET del PDF entrante → attachment + nosniff + sandbox",
    pdfInGet.status === 200 &&
      /^attachment;/.test(disposition(pdfInGet)) &&
      isNosniff(pdfInGet) &&
      isSandboxed(pdfInGet),
    `${pdfInGet.status} ${disposition(pdfInGet)}`
  );

  /* ---------- URL firmada pública (AC-7) ---------- */
  // Instagram ya no la usa para enviar (sube los bytes); la ruta sigue viva
  // y su firma se prueba a fondo en tests/unit/media-signed-url.test.ts.
  console.log("\n== 018: URL firmada /api/media/out ==");
  const basura = await fetch(`${BASE}/api/media/out/esto-no-es-un-token`);
  ok("token basura → 404", basura.status === 404, `status=${basura.status}`);
  const basura2 = await fetch(`${BASE}/api/media/out/${"A".repeat(20)}.${"B".repeat(43)}`);
  ok("token con forma válida pero firma falsa → 404", basura2.status === 404, `status=${basura2.status}`);

  /* ---------- Messenger e Instagram ---------- */
  for (const c of CANALES) {
    if (!on.has(c.channel)) {
      console.log(`\n== 018: ${c.label} — canal apagado, se omiten sus adjuntos ==`);
      continue;
    }
    console.log(`\n== 018: ${c.label} — recibir archivos (AC-5) ==`);
    const pre = c.channel === "instagram" ? "ig" : "psid";
    const sender = `${pre}${SUF}adj`;
    const tag = `${c.channel} ${SUF}`;
    const inbound = (body) =>
      api("/api/dev/wa-mock/channel-inbound", {
        method: "POST",
        body: JSON.stringify({ channel: c.channel, accountId: c.accountId, senderId: sender, ...body }),
      });
    const hola = await inbound({ text: `adjuntos ${tag}`, mid: `mid.e2e.018.${tag}.0` });
    ok(`(setup) DM de ${c.label} entregado`, hola.res.ok, JSON.stringify(hola.json));
    let cv = null;
    for (let i = 0; i < 20 && !cv; i++) {
      await sleep(500);
      cv = ((await api("/api/conversations")).json?.conversations ?? []).find(
        (x) => x.channel === c.channel && x.preview?.includes(`adjuntos ${tag}`)
      );
    }
    ok(`(setup) conversación de ${c.label} para adjuntos`, !!cv);
    if (!cv) continue;
    const cdn = (id) => `/api/dev/wa-mock/cdn/${id}`;
    const cases = [
      ["foto", "image", `foto-${c.channel}-${SUF}`],
      ["cotizacion", "file", `cot-pdf-${c.channel}-${SUF}`],
      ["programa", "file", `manual-exe-${c.channel}-${SUF}`],
      ["vencida", "image", `foto-expired-${c.channel}-${SUF}`],
    ];
    let n = 1;
    for (const [caption, type, id] of cases) {
      await inbound({
        text: `${caption} ${tag}`,
        mid: `mid.e2e.018.${tag}.${n++}`,
        attachments: [{ type, payload: { url: cdn(id) } }],
      });
    }
    await inbound({
      mid: `mid.e2e.018.${tag}.story`,
      attachments: [{ type: "story_mention", payload: { url: "https://lookaside.fbsbx.com/story/1" } }],
    });

    const foto = await waitMessage(cv.id, (m) => m.media?.caption === `foto ${tag}`);
    ok(
      `${c.label}: foto entrante → imagen disponible`,
      foto?.direction === "in" && foto.media?.kind === "image" && foto.media.fetchStatus === "available",
      JSON.stringify(foto?.media)
    );
    const fotoGet = await getMedia(foto?.media?.assetId);
    ok(
      `${c.label}: la foto se ve inline (200 image/jpeg)`,
      fotoGet.status === 200 &&
        (fotoGet.headers.get("content-type") ?? "").startsWith("image/jpeg") &&
        /^inline/.test(disposition(fotoGet)),
      `${fotoGet.status} ${fotoGet.headers.get("content-type")} ${disposition(fotoGet)}`
    );
    const cot = await waitMessage(cv.id, (m) => m.media?.caption === `cotizacion ${tag}`);
    ok(
      `${c.label}: PDF entrante → documento disponible`,
      cot?.media?.kind === "document" &&
        cot.media.fetchStatus === "available" &&
        cot.media.mimeType === "application/pdf",
      JSON.stringify(cot?.media)
    );
    const cotGet = await getMedia(cot?.media?.assetId);
    ok(
      `${c.label}: el PDF se descarga (200 attachment, nosniff, sandbox)`,
      cotGet.status === 200 &&
        /^attachment;/.test(disposition(cotGet)) &&
        isNosniff(cotGet) &&
        isSandboxed(cotGet),
      `${cotGet.status} ${disposition(cotGet)}`
    );
    const exe = await waitMessage(cv.id, (m) => m.media?.caption === `programa ${tag}`);
    ok(
      `${c.label}: ejecutable entrante → blocked`,
      exe?.media?.fetchStatus === "blocked" && !!exe.media.blockedReason,
      JSON.stringify(exe?.media)
    );
    const exeGet = await getMedia(exe?.media?.assetId);
    ok(`${c.label}: GET del ejecutable → 415`, exeGet.status === 415, `status=${exeGet.status}`);
    const vencida = await waitMessage(cv.id, (m) => m.media?.caption === `vencida ${tag}`);
    ok(
      `${c.label}: URL del CDN caducada → failed sin perder el mensaje`,
      vencida?.media?.fetchStatus === "failed",
      JSON.stringify(vencida?.media)
    );
    const vencidaGet = await getMedia(vencida?.media?.assetId);
    ok(`${c.label}: GET del fallido → 410`, vencidaGet.status === 410, `status=${vencidaGet.status}`);
    const story = await waitMessage(cv.id, (m) => /\[Adjunto no soportado/.test(m.text ?? ""));
    ok(
      `${c.label}: story_mention → "[Adjunto no soportado…]" (no un mensaje vacío)`,
      story?.direction === "in",
      JSON.stringify(story?.text)
    );

    console.log(`\n== 018: ${c.label} — enviar archivos (AC-1, AC-2) ==`);
    await api("/api/dev/wa-mock/outbox", { method: "DELETE" });
    const capImg = `mira esta foto ${tag}`;
    const img = await sendFile(cv.id, JPEG_1X1, "auto.jpg", "image/jpeg", capImg);
    ok(`${c.label}: imagen → enviada`, img.status === 201, `status=${img.status} ${JSON.stringify(img.json)}`);
    const pdf = await sendFile(cv.id, PDF_BYTES, "cotizacion.pdf", "application/pdf");
    ok(`${c.label}: PDF → enviado`, pdf.status === 201, `status=${pdf.status} ${JSON.stringify(pdf.json)}`);
    ob = await outbox();
    const adj = ob.filter((o) => o.type === "attachment" && o.to === sender);
    const obImg = adj.find((o) => o.attachment?.attachmentType === "image");
    const obPdf = adj.find((o) => o.attachment?.attachmentType === "file");
    if (c.channel === "messenger") {
      ok(
        "Messenger: la imagen sale por multipart (filedata con bytes)",
        obImg?.attachment?.channel === "messenger" && obImg.attachment.bytes === JPEG_1X1.length,
        JSON.stringify(obImg?.attachment)
      );
      ok(
        "Messenger: el PDF sale como file con su nombre y bytes",
        obPdf?.attachment?.channel === "messenger" &&
          obPdf.attachment.bytes === PDF_BYTES.length &&
          obPdf.attachment.fileName === "cotizacion.pdf",
        JSON.stringify(obPdf?.attachment)
      );
      const docx = await sendFile(cv.id, DOCX_LIMPIO, "propuesta.docx", DOCX_MIME);
      ok(
        "Messenger: .docx limpio → enviado",
        docx.status === 201,
        `status=${docx.status} ${JSON.stringify(docx.json)}`
      );
    } else {
      // Arreglo IG: Meta no logra descargar URLs de nuestro dominio, así que
      // el CRM SUBE los bytes (message_attachments con filedata) y envía por
      // attachment_id. El mock registra la subida en `uploads`.
      const upsIg = ((await api("/api/dev/wa-mock/outbox")).json?.uploads ?? []).filter(
        (u) => u.channel === "instagram"
      );
      const upImg = upsIg.find((u) => u.id === obImg?.attachment?.attachmentId);
      const upPdf = upsIg.find((u) => u.id === obPdf?.attachment?.attachmentId);
      ok(
        "Instagram: la imagen se SUBIÓ por filedata (bytes, image/jpeg, no reutilizable)",
        !!upImg &&
          upImg.bytes === JPEG_1X1.length &&
          /^image\/jpeg/.test(upImg.mime ?? "") &&
          upImg.attachmentType === "image" &&
          upImg.isReusable === false &&
          upImg.fileName === "auto.jpg",
        JSON.stringify({ upsIg, att: obImg?.attachment })
      );
      ok(
        "Instagram: la imagen sale por attachment_id en message.attachments (sin URL)",
        obImg?.attachment?.channel === "instagram" &&
          obImg.attachment.shape === "attachments" &&
          !JSON.stringify(obImg.body ?? {}).includes("\"url\""),
        JSON.stringify(obImg?.body)
      );
      ok(
        "Instagram: el PDF se SUBIÓ (bytes + nombre) y sale como file en message.attachment",
        !!upPdf &&
          upPdf.bytes === PDF_BYTES.length &&
          upPdf.mime === "application/pdf" &&
          upPdf.fileName === "cotizacion.pdf" &&
          obPdf?.attachment?.channel === "instagram" &&
          obPdf.attachment.shape === "attachment" &&
          !JSON.stringify(obPdf.body ?? {}).includes("\"url\""),
        JSON.stringify({ upPdf, att: obPdf?.attachment })
      );
      const docx = await sendFile(cv.id, DOCX_LIMPIO, "propuesta.docx", DOCX_MIME);
      ok(
        "Instagram: .docx limpio → 415 \"Instagram solo acepta…\"",
        docx.status === 415 && /Instagram solo acepta/.test(docx.json?.error?.message ?? ""),
        `status=${docx.status} ${JSON.stringify(docx.json)}`
      );
    }
    ob = await outbox();
    ok(
      `${c.label}: el pie del adjunto sale como un texto aparte`,
      ob.some((o) => o.type === "text" && o.to === sender && o.body?.message?.text === capImg),
      JSON.stringify(ob.map((o) => [o.type, o.body?.message?.text ?? null]))
    );
    const malo = await sendFile(cv.id, EXE_BYTES, "programa.exe", "application/octet-stream");
    ok(`${c.label}: .exe → 415`, malo.status === 415, `status=${malo.status}`);
    const hiloCv = await msgsOf(cv.id);
    // En estos canales el pie viaja como texto aparte, y así queda en el hilo.
    const salidaImg = hiloCv.filter((m) => m.direction === "out" && m.media?.kind === "image").at(-1);
    ok(
      `${c.label}: la imagen enviada queda 'sent' con su asset disponible`,
      salidaImg?.status === "sent" && salidaImg.media?.fetchStatus === "available",
      JSON.stringify({ s: salidaImg?.status, m: salidaImg?.media })
    );
    ok(
      `${c.label}: y el pie queda en el hilo como su propio mensaje`,
      hiloCv.some((m) => m.direction === "out" && m.type === "text" && m.text === capImg)
    );
  }

  /* ---------- Un mensaje con varios adjuntos = UNA respuesta de la IA ---------- */
  // Un DM con imagen + PDF + story_mention se ingiere como 3 mensajes; el
  // agente debe responder UNA vez, con todos ya en la BD (no una por ítem).
  const conAgente = CANALES.filter((c) => on.has(c.channel));
  if (conAgente.length) {
    const prof = await api("/api/agent/profile", {
      method: "PUT",
      body: JSON.stringify({ name: "Sofi", enabled: true }),
    });
    ok("(setup) agente in-process encendido", prof.res.ok, JSON.stringify(prof.json));
    for (const c of conAgente) {
      console.log(`\n== 018: ${c.label} — varios adjuntos, un solo turno del agente ==`);
      const sender = `${c.channel === "instagram" ? "ig" : "psid"}${SUF}ia`;
      const inbound = (body) =>
        api("/api/dev/wa-mock/channel-inbound", {
          method: "POST",
          body: JSON.stringify({ channel: c.channel, accountId: c.accountId, senderId: sender, ...body }),
        });
      await inbound({ text: `hola agente ${c.channel} ${SUF}`, mid: `mid.e2e.018.ia.${c.channel}.${SUF}.0` });
      let cvIa = null;
      for (let i = 0; i < 30 && !cvIa; i++) {
        await sleep(500);
        for (const x of ((await api("/api/conversations")).json?.conversations ?? []).filter(
          (x) => x.channel === c.channel
        )) {
          if ((await msgsOf(x.id)).some((m) => m.text === `hola agente ${c.channel} ${SUF}`)) {
            cvIa = x;
            break;
          }
        }
      }
      ok(`(setup) conversación de ${c.label} con el agente`, !!cvIa);
      if (!cvIa) continue;
      const aiCount = async () => (await msgsOf(cvIa.id)).filter((m) => m.aiGenerated).length;
      for (let i = 0; i < 40 && (await aiCount()) < 1; i++) await sleep(500);
      const antesIa = await aiCount();
      ok(`${c.label}: el agente respondió el saludo`, antesIa === 1, `ia=${antesIa}`);
      await inbound({
        text: `te mando todo ${SUF}`,
        mid: `mid.e2e.018.ia.${c.channel}.${SUF}.1`,
        attachments: [
          { type: "image", payload: { url: `/api/dev/wa-mock/cdn/foto-ia-${c.channel}-${SUF}` } },
          { type: "file", payload: { url: `/api/dev/wa-mock/cdn/cot-pdf-ia-${c.channel}-${SUF}` } },
          { type: "story_mention", payload: { url: "https://lookaside.fbsbx.com/story/2" } },
        ],
      });
      for (let i = 0; i < 40 && (await aiCount()) < antesIa + 1; i++) await sleep(500);
      // Margen para que un segundo turno (el bug) tuviera tiempo de salir.
      await sleep(5000);
      const hiloIa = await msgsOf(cvIa.id);
      const entrantes = hiloIa.filter((m) => m.direction === "in").length;
      const nuevasIa = (await aiCount()) - antesIa;
      ok(`${c.label}: el DM con 3 adjuntos entró como 3 mensajes`, entrantes === 4, `in=${entrantes}`);
      ok(`${c.label}: y la IA respondió UNA sola vez`, nuevasIa === 1, `respuestas nuevas=${nuevasIa}`);
    }
    await api("/api/agent/profile", { method: "PUT", body: JSON.stringify({ enabled: false }) });
  }

  /* ---------- Caché de 30 días (AC-8) — SIEMPRE al final ---------- */
  console.log("\n== 018: la caché de 30 días ==");
  const fav = await fetch(`${BASE}/api/settings/branding/favicon`, {
    method: "PUT",
    headers: { cookie, origin: BASE, "content-type": "image/png" },
    body: PNG_1X1,
  });
  ok("(setup) favicon de marca subido", fav.ok, `status=${fav.status}`);
  const antesPurga = await getMedia(assetVivo);
  ok("antes de la purga el PDF se sirve", antesPurga.status === 200, `status=${antesPurga.status}`);
  const hoy = await api("/api/dev/media/purge", { method: "POST", body: JSON.stringify({}) });
  ok(
    "purga con el reloj de hoy: no expira nada reciente",
    hoy.res.ok && hoy.json?.expired === 0,
    JSON.stringify(hoy.json)
  );
  const purga = await api("/api/dev/media/purge", {
    method: "POST",
    body: JSON.stringify({ advanceDays: 31 }),
  });
  ok(
    "purga con el reloj adelantado 31 días → expira los adjuntos",
    purga.res.ok && purga.json?.expired > 0,
    JSON.stringify(purga.json)
  );
  const tras = await getMedia(assetVivo);
  const trasJson = await tras.json().catch(() => null);
  ok(
    "GET del PDF purgado → 410 expired",
    tras.status === 410 && trasJson?.error?.code === "expired",
    `${tras.status} ${JSON.stringify(trasJson)}`
  );
  hilo = await msgsOf(conv.id);
  const pdfTras = hilo.find((m) => m.media?.assetId === assetVivo);
  ok(
    "el hilo conserva el mensaje, ahora con fetchStatus=expired",
    pdfTras?.media?.fetchStatus === "expired",
    JSON.stringify(pdfTras?.media)
  );
  const bloqueadoTras = hilo.find((m) => m.media?.caption === `factura ${SUF}`);
  ok(
    "un bloqueado SIGUE bloqueado (no tiene archivo: purgarlo solo borraría el aviso)",
    bloqueadoTras?.media?.fetchStatus === "blocked",
    JSON.stringify(bloqueadoTras?.media)
  );
  const otra = await api("/api/dev/media/purge", {
    method: "POST",
    body: JSON.stringify({ advanceDays: 31 }),
  });
  ok(
    "la purga es idempotente (segunda vuelta: 0)",
    otra.res.ok && otra.json?.expired === 0,
    JSON.stringify(otra.json)
  );
  const favTras = await fetch(`${BASE}/api/branding/favicon`);
  const favBytes = Buffer.from(await favTras.arrayBuffer());
  ok(
    "el favicon de marca NO se purga",
    favTras.status === 200 && favBytes.equals(PNG_1X1),
    `${favTras.status} ${favTras.headers.get("content-type")} ${favBytes.length}B`
  );
  // 020: la miniatura del anuncio de origen (copiada en `anuncioOrigenChecks`)
  // sobrevive a la purga con el reloj adelantado 31 días: su URL de Meta ya
  // habría caducado y no habría de dónde volver a bajarla.
  ok("(setup) hay una miniatura de anuncio que vigilar", !!MINIATURA_ANUNCIO);
  if (MINIATURA_ANUNCIO) {
    const mini = await fetch(`${BASE}${MINIATURA_ANUNCIO}`, { headers: { cookie, origin: BASE } });
    ok(
      "la miniatura del anuncio NO se purga (sigue sirviéndose tras 31 días)",
      mini.status === 200 && /^image\//.test(mini.headers.get("content-type") ?? ""),
      `${mini.status} ${mini.headers.get("content-type")}`
    );
  }
}
