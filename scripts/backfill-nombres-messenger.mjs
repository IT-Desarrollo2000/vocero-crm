/**
 * Backfill de nombres de Messenger.
 *
 * Hasta este arreglo, sin "Business Asset User Profile Access" todo contacto
 * de Messenger quedaba como "Contacto de Messenger". La ingesta ya pide el
 * nombre por la conversación de la Página (`src/server/messenger/profile.ts`)
 * y renombra a cada contacto en su siguiente mensaje; este script adelanta eso
 * para los que no vuelvan a escribir.
 *
 * Para cada contacto de Messenger que SIGUE con el nombre de respaldo, y cuya
 * organización tiene la Página conectada, pide
 * `GET /{pageId}/conversations?platform=messenger&user_id={psid}&fields=participants`
 * con el token de esa Página y toma el participante cuyo id es el PSID (nunca
 * la Página). Idempotente: solo toca contactos con el respaldo, y el UPDATE
 * repite esa condición, así que un nombre editado por el operador (aunque sea
 * mientras corre) jamás se pisa.
 *
 * Uso (bash):
 *   DATABASE_URL=... ENCRYPTION_KEY=... node scripts/backfill-nombres-messenger.mjs           # solo cuenta (dry-run)
 *   DATABASE_URL=... ENCRYPTION_KEY=... node scripts/backfill-nombres-messenger.mjs --apply   # escribe
 *
 * NO lee `.env`: la BD y la clave se pasan explícitas, para que nunca corra
 * por accidente contra la base equivocada. Opcionales: META_GRAPH_BASE_URL y
 * META_GRAPH_API_VERSION (mismos valores por defecto que la app; el self-test
 * los apunta al wa-mock). No imprime tokens ni nombres: solo ids y conteos.
 */
import { createDecipheriv } from "node:crypto";
import postgres from "postgres";

const FALLBACK = "Contacto de Messenger";
const FB_PREFIX = "fb:";
const REQUEST_TIMEOUT_MS = 10_000;

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
if (args.has("--apply") && args.has("--dry-run")) {
  console.error("Usa --dry-run o --apply, no ambos.");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
const keyB64 = process.env.ENCRYPTION_KEY;
if (!url || !keyB64) {
  console.error("Faltan DATABASE_URL y/o ENCRYPTION_KEY en el entorno.");
  process.exit(1);
}
const key = Buffer.from(keyB64, "base64");
if (key.length !== 32) {
  console.error("ENCRYPTION_KEY debe ser 32 bytes en base64.");
  process.exit(1);
}
const graphBase = (process.env.META_GRAPH_BASE_URL || "https://graph.facebook.com").replace(/\/$/, "");
const graphVersion = process.env.META_GRAPH_API_VERSION || "v25.0";

/** Mismo formato que `src/lib/crypto` (AES-256-GCM, base64 cipher/iv/tag). */
function decryptSecret({ cipher, iv, tag }) {
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(cipher, "base64")), d.final()]).toString("utf8");
}

/** Mismo criterio que `participantName` en `src/server/messenger/profile.ts`. */
function participantName(res, psid) {
  for (const conv of res?.data ?? []) {
    const p = conv?.participants?.data?.find?.((x) => x?.id === psid);
    const name = typeof p?.name === "string" ? p.name.trim() : "";
    if (name) return name;
  }
  return null;
}

async function nameByConversation(pageId, psid, token) {
  const q = new URLSearchParams({ platform: "messenger", user_id: psid, fields: "participants" });
  const res = await fetch(`${graphBase}/${graphVersion}/${pageId}/conversations?${q}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = json?.error;
    throw new Error(`Meta ${res.status}${e?.code ? ` code ${e.code}` : ""}${e?.error_subcode ? `/${e.error_subcode}` : ""}`);
  }
  return participantName(json, psid);
}

// Mismo search_path que la app (`src/lib/db/index.ts`).
const sql = postgres(url, {
  max: 1,
  onnotice: () => {},
  connection: { search_path: "vocero, extensions" },
});

const totals = { candidatos: 0, conNombre: 0, sinNombre: 0, errores: 0, actualizados: 0 };
let exitCode = 0;

try {
  const creds = await sql`
    SELECT organization_id, page_id, status, token_cipher, token_iv, token_tag
    FROM messenger_credentials`;
  const credsByOrg = new Map(creds.map((c) => [c.organization_id, c]));

  const contacts = await sql`
    SELECT id, organization_id, wa_identity
    FROM contact
    WHERE channel = 'messenger' AND name = ${FALLBACK}
    ORDER BY organization_id, id`;

  const byOrg = new Map();
  for (const c of contacts) {
    if (!byOrg.has(c.organization_id)) byOrg.set(c.organization_id, []);
    byOrg.get(c.organization_id).push(c);
  }

  console.log(`[backfill] modo ${apply ? "APPLY (escribe)" : "dry-run (no escribe; usa --apply)"}`);
  console.log(`[backfill] contactos de Messenger con el respaldo: ${contacts.length} en ${byOrg.size} organización(es)`);

  for (const [orgId, list] of byOrg) {
    const cred = credsByOrg.get(orgId);
    if (!cred) {
      console.log(`[backfill] ${orgId}: ${list.length} contacto(s) sin Página conectada → se omiten`);
      continue;
    }
    if (cred.status !== "connected") {
      console.log(`[backfill] ${orgId}: ${list.length} contacto(s), la Página pide reconectar → se omiten`);
      continue;
    }
    let token;
    try {
      token = decryptSecret({ cipher: cred.token_cipher, iv: cred.token_iv, tag: cred.token_tag });
    } catch {
      console.error(`[backfill] ${orgId}: no se pudo descifrar el token (¿ENCRYPTION_KEY de otra instancia?) → se omite`);
      exitCode = 1;
      continue;
    }

    const org = { candidatos: list.length, conNombre: 0, sinNombre: 0, errores: 0, actualizados: 0 };
    for (const c of list) {
      if (!c.wa_identity.startsWith(FB_PREFIX)) {
        org.sinNombre++;
        continue;
      }
      const psid = c.wa_identity.slice(FB_PREFIX.length);
      let name = null;
      try {
        name = await nameByConversation(cred.page_id, psid, token);
      } catch (err) {
        org.errores++;
        console.log(`[backfill]   ${c.id}: ${err instanceof Error ? err.message : "error"}`);
        continue;
      }
      if (!name) {
        org.sinNombre++;
        continue;
      }
      org.conNombre++;
      if (!apply) continue;
      // `name = respaldo` otra vez: si el operador lo renombró mientras
      // corría, no se toca. Igual que la ingesta, el nombre de Graph es
      // también el de perfil (022).
      const res = await sql`
        UPDATE contact
        SET name = ${name}, profile_name = ${name}, updated_at = ${new Date()}
        WHERE id = ${c.id} AND organization_id = ${orgId}
          AND channel = 'messenger' AND name = ${FALLBACK}`;
      org.actualizados += res.count;
    }
    console.log(
      `[backfill] ${orgId}: ${org.candidatos} candidato(s), ${org.conNombre} con nombre, ` +
        `${org.sinNombre} sin nombre, ${org.errores} error(es)` +
        (apply ? `, ${org.actualizados} actualizado(s)` : "")
    );
    for (const k of Object.keys(totals)) totals[k] += org[k];
  }

  console.log(
    `[backfill] TOTAL: ${totals.conNombre} ${apply ? "renombrable(s)" : "se renombrarían"}` +
      (apply ? `, ${totals.actualizados} actualizado(s)` : "") +
      `, ${totals.sinNombre} sin nombre, ${totals.errores} error(es)`
  );
  // Línea final legible por máquina (la usa el self-test).
  console.log(`BACKFILL_RESULT ${JSON.stringify({ apply, ...totals })}`);
} catch (err) {
  console.error("[backfill] falló:", err instanceof Error ? err.message : err);
  exitCode = 1;
} finally {
  await sql.end();
}
process.exit(exitCode);
