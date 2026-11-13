/**
 * 036 — Importar los leads del Excel de un evento al CRM.
 * Guía: docs/importar-leads-evento.md · Spec: specs/036-importar-leads-evento/spec.md
 *
 * Uso (lo corre el administrador en su máquina, no va en la imagen Docker):
 *
 *   INTAKE_API_KEY=… node scripts/importar-leads.mjs <archivo.xlsx|.csv> \
 *     --evento "Expo Autos Mérida 2026" [--url https://crm…] [--hoja Hoja1] [--enviar]
 *
 *   (o `pnpm import:leads -- <archivo> --evento "…"`)
 *
 * - Por defecto es un ENSAYO: lee, valida y escribe `<archivo>.resultado.csv`
 *   sin mandar nada. Con `--enviar` manda cada fila a `POST /api/intake/lead`
 *   (origen `evento`, contrato de la 011).
 * - La clave es la de Ajustes → Leads externos y SOLO se lee de la variable
 *   de entorno `INTAKE_API_KEY` (nunca de un argumento: quedaría en el
 *   historial de la terminal). Jamás se imprime.
 * - La URL sale de `--url` o de `APP_BASE_URL`.
 * - Re-importar el mismo archivo es seguro: el `lead_id` sale del evento + el
 *   WhatsApp, así que lo ya enviado vuelve como «duplicado» sin otra tarjeta.
 *   Si se corrigió la columna Vendedor, el duplicado sí asigna lo que siga
 *   libre (nunca le quita un chat a quien ya lo tiene).
 *
 * Ritmo: el endpoint cuenta TODAS las peticiones autenticadas en un cupo
 * GLOBAL de 120 por minuto (src/server/intake/auth.ts), compartido con el ERP
 * que entrega el formulario web y FastApp. Este script manda una a la vez con
 * una pausa de PAUSE_MS (~100/min) para dejarle aire al ERP, y ante 429, 5xx
 * o un fallo de red reintenta con espera creciente (hasta 4 intentos).
 *
 * Teléfonos en consola: solo los últimos 4 dígitos. El CSV de resultado sí
 * lleva el número completo (es el archivo del propio negocio).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  cellText,
  csvLine,
  findHeaderRow,
  parseCsv,
  planRows,
  resultPathFor,
} from "./lib/importar-leads-core.mjs";

const PAUSE_MS = 600;
const MAX_TRIES = 4;

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error(
    'Uso: INTAKE_API_KEY=… node scripts/importar-leads.mjs <archivo.xlsx|.csv> --evento "Nombre del evento" [--url https://crm…] [--hoja Hoja] [--enviar]'
  );
  process.exit(2);
}

function parseArgs(argv) {
  const out = { file: null, evento: null, url: null, hoja: null, enviar: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) usage(`${a} necesita un valor`);
      return v;
    };
    if (a === "--evento") out.evento = val();
    else if (a === "--url") out.url = val();
    else if (a === "--hoja") out.hoja = val();
    else if (a === "--enviar") out.enviar = true;
    else if (a === "--key" || a === "--api-key" || a.startsWith("--key=")) {
      usage("la clave va SOLO en la variable de entorno INTAKE_API_KEY");
    } else if (a === "--") continue;
    else if (a.startsWith("--")) usage(`opción desconocida ${a}`);
    else if (!out.file) out.file = a;
    else usage(`argumento de más: ${a}`);
  }
  return out;
}

const last4 = (p) => `··${String(p ?? "").slice(-4)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Filas del archivo como arreglos de valores de celda (índice 0 = columna A). */
async function readRows(file, hoja) {
  if (/\.csv$/i.test(file)) return parseCsv(readFileSync(file, "utf8"));
  if (!/\.xlsx$/i.test(file)) usage("el archivo debe ser .xlsx o .csv");
  let ExcelJS;
  try {
    ExcelJS = (await import("exceljs")).default;
  } catch {
    usage("falta la dependencia exceljs: corre `pnpm install` en el repo");
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = hoja ? wb.getWorksheet(hoja) : wb.worksheets.find((w) => w.actualRowCount > 0);
  if (!ws) {
    const names = wb.worksheets.map((w) => w.name).join(", ");
    usage(hoja ? `no existe la hoja «${hoja}» (hay: ${names})` : "el libro no tiene hojas con datos");
  }
  const rows = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    // row.values es 1-based (índice 0 vacío).
    const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
    rows[n - 1] = vals;
  });
  for (let i = 0; i < rows.length; i++) rows[i] ??= [];
  return rows;
}

async function postLead(base, key, payload) {
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const res = await fetch(`${base}/api/intake/lead`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify(payload),
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* sin cuerpo */
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        if (attempt < MAX_TRIES) {
          // 429: el cupo es por minuto → esperas largas; 5xx: cortas.
          await sleep(res.status === 429 ? 15_000 * attempt : 2_000 * 2 ** (attempt - 1));
          continue;
        }
      }
      return { status: res.status, json, error: res.ok ? null : lastErr || `HTTP ${res.status}` };
    } catch (err) {
      lastErr = `red: ${err instanceof Error ? err.message : "desconocido"}`;
      if (attempt < MAX_TRIES) await sleep(2_000 * 2 ** (attempt - 1));
    }
  }
  return { status: 0, json: null, error: lastErr };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) usage("falta el archivo");
  if (!args.evento || !args.evento.trim()) usage("falta --evento \"Nombre del evento\"");
  if (!existsSync(args.file)) usage(`no existe ${args.file}`);
  const key = process.env.INTAKE_API_KEY?.trim();
  const base = (args.url ?? process.env.APP_BASE_URL ?? "").replace(/\/+$/, "");
  if (args.enviar) {
    if (!key) usage("falta la variable de entorno INTAKE_API_KEY (Ajustes → Leads externos)");
    if (!/^https?:\/\//.test(base)) usage("falta --url (o APP_BASE_URL) con la dirección del CRM");
  }

  const rows = await readRows(args.file, args.hoja);
  const header = findHeaderRow(rows);
  if (!header) {
    usage("no encontré la fila de encabezados (en las 5 primeras filas debe haber «Nombre» y «WhatsApp»)");
  }
  const plan = planRows(rows, header, args.evento);

  console.log(`Archivo: ${path.basename(args.file)} · evento «${args.evento.trim()}»`);
  console.log(`Encabezados en la fila ${header.index + 1}. Columnas: ${Object.keys(header.columns).join(", ")}`);
  if (header.unknown.length) {
    console.log(`Columnas ignoradas (no reconocidas): ${header.unknown.map((u) => `«${u}»`).join(", ")}`);
  }
  console.log(args.enviar ? `Modo ENVIAR → ${base}\n` : "Modo ENSAYO: no se manda nada (agrega --enviar para mandar)\n");

  const results = [];
  const listos = plan.filter((p) => p.estado === "listo");
  let i = 0;
  for (const p of plan) {
    if (p.estado !== "listo" || !args.enviar) {
      results.push({ ...p, asignacion: "" });
      continue;
    }
    if (i++ > 0) await sleep(PAUSE_MS);
    const r = await postLead(base, key, p.payload);
    if (r.status === 401 || r.status === 404) {
      console.error(
        r.status === 401
          ? "\nLa clave no es válida (401). Revisa INTAKE_API_KEY en Ajustes → Leads externos. Se detuvo el envío."
          : "\nEl CRM respondió 404: la entrada de leads externos (LEADS_EXTERNOS) está apagada, o la URL no es la del CRM. Se detuvo el envío."
      );
      results.push({ ...p, estado: "error", motivo: `HTTP ${r.status}`, asignacion: "" });
      for (const rest of plan.slice(plan.indexOf(p) + 1)) {
        results.push(rest.estado === "listo" ? { ...rest, estado: "no enviado", motivo: "envío detenido", asignacion: "" } : { ...rest, asignacion: "" });
      }
      break;
    }
    if (r.status === 201 || r.status === 200) {
      results.push({
        ...p,
        estado: r.status === 201 ? "nuevo" : "duplicado",
        motivo: r.status === 201 ? (r.json?.created ? "contacto nuevo" : "contacto existente") : "ya se había importado",
        asignacion: r.json?.assignment ?? "",
      });
    } else {
      const msg = r.json?.error?.message ?? r.error ?? `HTTP ${r.status}`;
      results.push({ ...p, estado: "error", motivo: msg, asignacion: "" });
    }
    process.stdout.write(`  fila ${p.fila} ${last4(p.phone)} → ${results.at(-1).estado}\r\n`);
  }

  // Resultado por fila, junto al archivo (nunca sobre él).
  const out = resultPathFor(args.file);
  const lines = [
    csvLine(["fila", "estado", "detalle", "nombre", "whatsapp", "vendedor", "asignacion", "lead_id"]),
    ...results.map((r) =>
      csvLine([r.fila, r.estado, r.motivo, r.name, r.phone ?? r.rawPhone, r.seller, r.asignacion, r.leadId ?? ""])
    ),
  ];
  writeFileSync(out, `﻿${lines.join("\r\n")}\r\n`, "utf8");

  // Resumen.
  const count = (estado) => results.filter((r) => r.estado === estado).length;
  console.log("\nResumen");
  console.log(`  Válidos: ${listos.length}`);
  const invalid = results.filter((r) => r.estado === "inválido");
  console.log(`  Inválidos: ${invalid.length}`);
  for (const r of invalid) console.log(`    fila ${r.fila} · ${r.name || "(sin nombre)"} · ${r.rawPhone ? last4(r.rawPhone) : "(sin WhatsApp)"} · ${r.motivo}`);
  const rep = results.filter((r) => r.estado === "repetido");
  console.log(`  Repetidos en el archivo: ${rep.length}`);
  for (const r of rep) console.log(`    fila ${r.fila} · ${r.name} · ${last4(r.phone)} · ${r.motivo}`);
  if (args.enviar) {
    console.log(`  Nuevos: ${count("nuevo")} · Ya importados (duplicados): ${count("duplicado")} · Errores: ${count("error")} · No enviados: ${count("no enviado")}`);
    for (const r of results.filter((x) => x.estado === "error")) console.log(`    fila ${r.fila} · ${r.name} · ${last4(r.phone)} · ${r.motivo}`);
    const byAssign = {};
    for (const r of results) if (r.asignacion) byAssign[r.asignacion] = (byAssign[r.asignacion] ?? 0) + 1;
    const sinVendedor = results.filter((r) => (r.estado === "nuevo" || r.estado === "duplicado") && !r.seller).length;
    console.log(`  Asignación: ${Object.entries(byAssign).map(([k, n]) => `${k} ${n}`).join(" · ") || "—"}${sinVendedor ? ` · sin vendedor en el Excel ${sinVendedor}` : ""}`);
    const missing = {};
    for (const r of results) {
      if (r.asignacion === "vendedor_no_encontrado" || r.asignacion === "ambiguo") {
        const k = `${r.seller} (${r.asignacion === "ambiguo" ? "más de una persona" : "nadie con ese nombre"})`;
        missing[k] = (missing[k] ?? 0) + 1;
      }
    }
    if (Object.keys(missing).length) {
      console.log("  Vendedores sin coincidencia (corrige el nombre en el Excel y vuelve a importar):");
      for (const [k, n] of Object.entries(missing)) console.log(`    ${k}: ${n} fila(s)`);
    }
  } else {
    const sellers = [...new Set(listos.map((r) => r.seller).filter(Boolean))];
    if (sellers.length) console.log(`  Vendedores en el archivo: ${sellers.map((s) => `«${cellText(s)}»`).join(", ")}`);
  }
  console.log(`\nResultado por fila: ${out}`);
  process.exit(args.enviar && (count("error") > 0 || count("no enviado") > 0) ? 1 : 0);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
