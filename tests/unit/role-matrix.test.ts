import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OWNER_ROUTE_PREFIXES,
  ROUTE_POLICY,
  type RoutePolicy,
} from "@/lib/permissions";

/**
 * Guardarraíl de la matriz de permisos (dev-tasks/00, RF-00-03).
 *
 * Recorre `src/app/api/**\/route.ts`, extrae cada método exportado y exige:
 *   1. que esté clasificado en `ROUTE_POLICY` (`src/lib/permissions.ts`);
 *   2. que su código aplique la guarda de su política.
 * Y además que las páginas de Propietario vivan tras `requireOwnerPage()`.
 *
 * Si estás leyendo esto porque el test se puso rojo: no lo relajes —
 * clasifica la ruta nueva en `ROUTE_POLICY` y ponle su guarda.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const API = path.join(ROOT, "src", "app", "api");
const APP = path.join(ROOT, "src", "app", "(app)");

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

/** `src/app/api/kb/[id]/route.ts` → `/api/kb/[id]` (separadores POSIX). */
function routePath(file: string): string {
  const rel = path.relative(API, path.dirname(file)).split(path.sep).join("/");
  return rel ? `/api/${rel}` : "/api";
}

type Handler = {
  key: string;
  method: string;
  /** Código del export (hasta el siguiente export) o del archivo re-exportado. */
  block: string;
  /** Archivo completo donde vive el handler. */
  file: string;
};

/** Métodos exportados con su bloque de código. Sigue re-exports relativos. */
function handlersOf(file: string, route: string): Handler[] {
  const code = readFileSync(file, "utf8");
  const out: Handler[] = [];

  // `export { dynamic, POST } from "../../v1/chat/completions/route";`
  const reExport = /export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = reExport.exec(code)) !== null) {
    const names = (m[1] ?? "").split(",").map((n) => n.trim().split(/\s+as\s+/).pop() ?? "");
    const target = path.resolve(path.dirname(file), `${m[2]}.ts`);
    const targetCode = readFileSync(target, "utf8");
    for (const name of names) {
      if (!METHODS.includes(name)) continue;
      out.push({ key: `${name} ${route}`, method: name, block: targetCode, file: target });
    }
  }

  // `export const GET = …` / `export async function POST(` / `export function`
  const decl = /^export\s+(?:const\s+([A-Z]+)\s*=|(?:async\s+)?function\s+([A-Z]+)\s*\()/gm;
  const starts: { method: string; index: number }[] = [];
  while ((m = decl.exec(code)) !== null) {
    const method = m[1] ?? m[2] ?? "";
    if (METHODS.includes(method)) starts.push({ method, index: m.index });
  }
  for (const { method, index } of starts) {
    const rest = code.slice(index + 1);
    const next = rest.search(/^export\s/m);
    const block = next === -1 ? code.slice(index) : code.slice(index, index + 1 + next);
    out.push({ key: `${method} ${route}`, method, block, file });
  }
  return out;
}

const HANDLERS: Handler[] = routeFiles(API).flatMap((f) => handlersOf(f, routePath(f)));

/** Rutas públicas aceptadas a sabiendas (cada una con su propia defensa). */
const PUBLIC_WHITELIST = new Set([
  "GET /api/auth/[...all]",
  "POST /api/auth/[...all]",
  "GET /api/health",
  "POST /api/meta/data-deletion",
  // 018: URL firmada (HMAC, 10 min) para que Instagram descargue un saliente.
  "GET /api/media/out/[token]",
  "GET /api/webhooks/wa/[webhookToken]",
  "POST /api/webhooks/wa/[webhookToken]",
  "GET /api/webhooks/ig/[webhookToken]",
  "POST /api/webhooks/ig/[webhookToken]",
  "GET /api/webhooks/fb/[webhookToken]",
  "POST /api/webhooks/fb/[webhookToken]",
  "GET /api/settings/branding",
  "GET /api/branding/favicon",
]);

const OWNER_GUARD = /\{\s*role:\s*["']owner["']\s*\}|requireOwner\(/;

/** ¿El handler aplica la guarda de su política? Devuelve el motivo si no. */
function guardProblem(h: Handler, policy: RoutePolicy): string | null {
  switch (policy) {
    case "owner":
      return OWNER_GUARD.test(h.block) ? null : "sin { role: \"owner\" } ni requireOwner(";
    case "any":
    case "any*":
      // `events` resuelve la sesión a mano (SSE): `requireSession(` cuenta.
      return /withAuth\(|requireSession\(/.test(h.block) ? null : "sin withAuth( ni requireSession(";
    case "bot":
      // La guarda puede vivir en un helper del archivo: se mira el archivo.
      return /requireBotKey\(/.test(readFileSync(h.file, "utf8")) ? null : "sin requireBotKey(";
    case "dev":
      return /mockGuard\(/.test(readFileSync(h.file, "utf8")) ? null : "sin mockGuard(";
    case "public":
      return PUBLIC_WHITELIST.has(h.key) ? null : "public fuera de la lista blanca";
  }
}

describe("guardarraíl: matriz de permisos por rol", () => {
  it("encuentra los handlers del árbol (sanidad del extractor)", () => {
    expect(HANDLERS.length).toBeGreaterThan(100);
    const keys = HANDLERS.map((h) => h.key);
    expect(keys).toContain("POST /api/dev/ai-mock/chat/completions"); // re-export
    expect(keys).toContain("GET /api/bot/media/[mediaId]"); // firma multilínea
    expect(keys).toContain("GET /api/events");
  });

  it("todo handler exportado está clasificado en ROUTE_POLICY", () => {
    const sinClasificar = HANDLERS.filter((h) => !(h.key in ROUTE_POLICY)).map((h) => h.key);
    expect(sinClasificar, "Clasifica estas rutas en src/lib/permissions.ts").toEqual([]);
  });

  it("cada handler aplica la guarda de su política", () => {
    const infractores: string[] = [];
    for (const h of HANDLERS) {
      const policy = ROUTE_POLICY[h.key];
      if (!policy) continue; // lo reporta el test anterior
      const problem = guardProblem(h, policy);
      if (problem) infractores.push(`${h.key} [${policy}]: ${problem}`);
    }
    expect(infractores).toEqual([]);
  });

  it("las rutas reservadas al Propietario (reportes, métricas) son owner", () => {
    const malas = Object.entries(ROUTE_POLICY)
      .filter(([key]) => {
        const route = key.split(" ")[1] ?? "";
        return OWNER_ROUTE_PREFIXES.some((p) => route === p || route.startsWith(`${p}/`));
      })
      .filter(([, policy]) => policy !== "owner")
      .map(([key]) => key);
    const sinClasificar = HANDLERS.filter((h) => {
      const route = h.key.split(" ")[1] ?? "";
      return OWNER_ROUTE_PREFIXES.some((p) => route === p || route.startsWith(`${p}/`));
    }).filter((h) => ROUTE_POLICY[h.key] !== "owner");
    expect([...malas, ...sinClasificar.map((h) => h.key)]).toEqual([]);
  });

  it("la lista blanca pública coincide con lo marcado public", () => {
    const publicas = Object.entries(ROUTE_POLICY)
      .filter(([, p]) => p === "public")
      .map(([k]) => k)
      .sort();
    expect(publicas).toEqual([...PUBLIC_WHITELIST].sort());
  });
});

/**
 * Páginas del Propietario (RF-00-04): viven en un grupo `(owner)` cuyo layout
 * llama `requireOwnerPage()` (404 al Vendedor), o la página la llama ella
 * misma (alternativa del plan).
 */
const OWNER_PAGES: { base: string; segment: string }[] = [
  ...["agent", "lab"].map((segment) => ({ base: APP, segment })),
  ...["whatsapp", "instagram", "messenger", "branding", "templates", "team", "calendar", "ads"].map(
    (segment) => ({ base: path.join(APP, "settings"), segment })
  ),
];

function callsOwnerGuard(file: string): boolean {
  return existsSync(file) && /requireOwnerPage\(/.test(readFileSync(file, "utf8"));
}

describe("guardarraíl: páginas del Propietario", () => {
  it("cada layout de un grupo (owner) llama requireOwnerPage()", () => {
    for (const base of [APP, path.join(APP, "settings")]) {
      const group = path.join(base, "(owner)");
      if (!existsSync(group)) continue;
      expect(callsOwnerGuard(path.join(group, "layout.tsx")), group).toBe(true);
    }
  });

  it("cada página de Propietario queda tras requireOwnerPage()", () => {
    const desprotegidas: string[] = [];
    for (const { base, segment } of OWNER_PAGES) {
      const inGroup = path.join(base, "(owner)", segment, "page.tsx");
      const loose = path.join(base, segment, "page.tsx");
      if (existsSync(inGroup)) {
        if (!callsOwnerGuard(path.join(base, "(owner)", "layout.tsx")) && !callsOwnerGuard(inGroup)) {
          desprotegidas.push(path.relative(ROOT, inGroup));
        }
      }
      if (existsSync(loose) && !callsOwnerGuard(loose)) {
        desprotegidas.push(path.relative(ROOT, loose));
      }
      if (!existsSync(inGroup) && !existsSync(loose)) {
        desprotegidas.push(`${path.relative(ROOT, loose)} (no encontrada: ¿se movió?)`);
      }
    }
    expect(desprotegidas).toEqual([]);
  });
});
