import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guardarraíl de la visibilidad por asignación (dev-tasks/09, T-09-04).
 *
 * Una ruta de sesión que lea una conversación SIN pasar el viewer le enseña
 * al Vendedor conversaciones ajenas — y nada truena: simplemente se filtra.
 * Este test escanea `src/app/api/**` (menos `bot/` y `dev/`, que no tienen
 * sesión: cerebro externo y mocks) y exige que cada llamada a
 * `getConversation` / `updateConversation` / `listConversations` pase el
 * viewer en su posición, y que los endpoints de envío del Bandeja pasen por
 * la compuerta `gateSend` / `claimForSend` ("responder = tomar").
 *
 * Si estás leyendo esto porque el test se puso rojo: no lo relajes — pasa
 * `session` como viewer (o, si la ruta no tiene sesión, muévela a `bot/`).
 */

const API = path.resolve(import.meta.dirname, "..", "..", "src", "app", "api");
const SIN_SESION = ["bot", "dev"].map((d) => path.join(API, d) + path.sep);

/** Posición (0-based) del argumento `viewer` en cada función. */
const VIEWER_ARG: Record<string, number> = {
  getConversation: 2,
  updateConversation: 3,
  listConversations: 1,
};

function archivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...archivosTs(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Argumentos de nivel superior de la llamada que abre en `open` (índice del `(`). */
function argsDe(code: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = open + 1; i < code.length; i++) {
    const ch = code[i] ?? "";
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    if (ch === ")" || ch === "}" || ch === "]") {
      if (depth === 0) {
        if (current.trim()) args.push(current.trim());
        return args;
      }
      depth--;
    }
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  return args;
}

/** Quita comentarios (los JSDoc citan llamadas abreviadas como `fn(..., x)`). */
function sinComentarios(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Llamadas `fn(` sin viewer en el código (no cuenta imports ni definiciones). */
function llamadasSinViewer(source: string): string[] {
  const code = sinComentarios(source);
  const out: string[] = [];
  for (const [fn, pos] of Object.entries(VIEWER_ARG)) {
    const re = new RegExp(`(?<![\\w.])${fn}\\s*\\(`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const before = code.slice(Math.max(0, m.index - 20), m.index);
      if (/function\s+$/.test(before)) continue;
      const args = argsDe(code, m.index + m[0].length - 1);
      const viewer = args[pos];
      if (!viewer || viewer === "undefined") out.push(`${fn}(${args.join(", ")})`);
    }
  }
  return out;
}

const RUTAS = archivosTs(API).filter(
  (f) => !SIN_SESION.some((d) => f.startsWith(d))
);

describe("guardarraíl: toda ruta de sesión lee conversaciones con viewer", () => {
  it("encuentra las rutas que leen conversaciones (sanidad del escaneo)", () => {
    const usan = RUTAS.filter((f) =>
      /getConversation\(|listConversations\(|updateConversation\(/.test(
        readFileSync(f, "utf8")
      )
    );
    expect(usan.length).toBeGreaterThanOrEqual(6);
  });

  it("ninguna llamada a getConversation/updateConversation/listConversations omite el viewer", () => {
    const infractores: string[] = [];
    for (const file of RUTAS) {
      const code = readFileSync(file, "utf8");
      for (const call of llamadasSinViewer(code)) {
        infractores.push(`${path.relative(API, file)}: ${call}`);
      }
    }
    expect(
      infractores,
      "Pasa `session` como viewer (09, RF-09-03):\n" +
        infractores.map((f) => `  · ${f}`).join("\n")
    ).toEqual([]);
  });

  it("los endpoints de envío pasan por la compuerta de asignación", () => {
    const ENVIOS = [
      ["conversations", "[id]", "messages", "route.ts"],
      ["conversations", "[id]", "messages", "media", "route.ts"],
      ["conversations", "[id]", "messages", "template", "route.ts"],
      ["contacts", "[id]", "start-conversation", "route.ts"],
    ].map((p) => path.join(API, ...p));
    const sinCompuerta = ENVIOS.filter(
      (f) => !/\b(gateSend|claimForSend)\(/.test(readFileSync(f, "utf8"))
    ).map((f) => path.relative(API, f));
    expect(sinCompuerta).toEqual([]);
  });

  it("/api/media filtra por visibilidad y excluye el Laboratorio (is_test)", () => {
    const code = sinComentarios(
      readFileSync(path.join(API, "media", "[assetId]", "route.ts"), "utf8")
    );
    expect(code).toMatch(/conversationVisibleTo\(session\)/);
    expect(code).toMatch(/eq\(schema\.conversation\.isTest,\s*false\)/);
  });

  it("el detector sí ve una llamada sin viewer (no quedó ciego)", () => {
    expect(llamadasSinViewer("await getConversation(session.organizationId, id);")).toHaveLength(1);
    expect(
      llamadasSinViewer("await getConversation(\n  session.organizationId,\n  id,\n  session\n);")
    ).toEqual([]);
    expect(llamadasSinViewer("updateConversation(org, id, { markRead: true })")).toHaveLength(1);
    expect(llamadasSinViewer("listConversations(org, session, { since })")).toEqual([]);
    expect(llamadasSinViewer("listConversations(org)")).toHaveLength(1);
  });
});
