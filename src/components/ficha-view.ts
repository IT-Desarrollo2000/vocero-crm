import {
  FICHA_LIMITS,
  fichaFieldsSchema,
  parseFichaNumber,
  slugifyFichaKey,
  type FichaCheck,
  type FichaFieldDef,
  type FichaFieldType,
  type FichaIgnoreReason,
  type FichaMeta,
  type FichaMetaEntry,
} from "@/lib/ficha-fields";
import { fichaEntries, fichaLabel, fichaValueText } from "@/lib/ficha";
import type { FichaDto, FichaEventDto, FichaValue } from "@/lib/types";

/**
 * 04 — Lógica pura de la ficha en la UI (panel de la Bandeja, cajón del
 * tablero y editor de campos del Agente). Sin React: se prueba en node.
 */

/* ============================================================
 * Panel: filas y procedencia
 * ============================================================ */

/**
 * Cómo se marca un valor:
 * - `ia`: lo llenó el agente in-process (chip "IA").
 * - `bot`: lo llenó el cerebro externo (chip "Bot").
 * - `humano`: lo editó el equipo (candado).
 * - `legado`: tiene valor pero no procedencia (anterior a 04). El agente no lo
 *   pisa, así que se pinta con candado y se puede desbloquear igual.
 * - `null`: sin valor, nada que marcar.
 */
export type FichaProvenance = "ia" | "bot" | "humano" | "legado" | null;

export function fichaProvenance(
  entry: FichaMetaEntry | undefined,
  hasValue: boolean
): FichaProvenance {
  if (!hasValue) return null;
  if (!entry) return "legado";
  return entry.by;
}

/** ¿Muestra candado (y la acción "Dejar que el agente lo actualice")? */
export function provenanceLocked(p: FichaProvenance): boolean {
  return p === "humano" || p === "legado";
}

/** Texto del tooltip del chip/candado. */
export function provenanceTitle(
  p: FichaProvenance,
  entry: FichaMetaEntry | undefined
): string {
  const cuando = entry?.at ? ` · ${formatFichaDate(entry.at)}` : "";
  switch (p) {
    case "ia":
      return `Lo llenó el agente${cuando}`;
    case "bot":
      return `Lo llenó tu bot${cuando}`;
    case "humano":
      return `Confirmado por el equipo${cuando}: el agente no lo cambia`;
    case "legado":
      return "Dato previo al agente: el agente no lo cambia";
    default:
      return "";
  }
}

export type FichaRow = {
  key: string;
  label: string;
  /** `undefined` = campo definido todavía vacío. */
  value: FichaValue | undefined;
  /** Definición del campo; `null` en las claves libres. */
  def: FichaFieldDef | null;
  meta: FichaMetaEntry | undefined;
  provenance: FichaProvenance;
};

/**
 * Orden del panel (RF-04-12): primero los campos definidos, en su orden y con
 * su `label`, incluidos los vacíos; luego las claves libres, alfabéticas como
 * siempre. Sin definición (`null`/`undefined`) → solo claves libres: es la
 * ficha de antes de 04.
 */
export function buildFichaRows(
  ficha: FichaDto,
  meta: FichaMeta | undefined,
  fields: readonly FichaFieldDef[] | null | undefined
): FichaRow[] {
  const m = meta ?? {};
  const rows: FichaRow[] = [];
  const definidas = new Set<string>();
  for (const def of fields ?? []) {
    definidas.add(def.key);
    const value = Object.prototype.hasOwnProperty.call(ficha, def.key)
      ? ficha[def.key]
      : undefined;
    rows.push({
      key: def.key,
      label: def.label,
      value,
      def,
      meta: m[def.key],
      provenance: fichaProvenance(m[def.key], value !== undefined),
    });
  }
  for (const [key, value] of fichaEntries(ficha)) {
    if (definidas.has(key)) continue;
    // Una clave libre sin meta no lleva candado: el agente no la escribe de
    // todos modos (`clave_desconocida`) y el bot sí puede. Marcarla "legado"
    // pondría candado a toda ficha anterior a 04.
    const p = fichaProvenance(m[key], true);
    rows.push({
      key,
      label: fichaLabel(key),
      value,
      def: null,
      meta: m[key],
      provenance: p === "legado" ? null : p,
    });
  }
  return rows;
}

/* ============================================================
 * Panel: edición por tipo
 * ============================================================ */

export type TypedParse = { ok: true; value: FichaValue } | { ok: false; error: string };

/**
 * Lo que el equipo escribe en un campo DEFINIDO, al tipo del campo. El
 * servidor no convierte lo humano: si aquí mandamos "350000" como texto a un
 * campo `numero`, así se queda.
 */
export function parseTypedFichaValue(def: FichaFieldDef, text: string): TypedParse {
  const t = text.trim();
  if (!t) return { ok: false, error: "Escribe un valor" };
  switch (def.type) {
    case "numero": {
      const n = parseFichaNumber(t);
      return n === null
        ? { ok: false, error: "Escribe un número (ej. 350000 o 350 mil)" }
        : { ok: true, value: n };
    }
    case "si_no": {
      const s = t.toLowerCase();
      if (["si", "sí", "true", "1"].includes(s)) return { ok: true, value: true };
      if (["no", "false", "0"].includes(s)) return { ok: true, value: false };
      return { ok: false, error: "Elige Sí o No" };
    }
    case "opcion":
    case "texto":
      return { ok: true, value: t };
  }
}

/** Opciones del selector: las definidas + el valor actual si no está en la lista. */
export function selectOptions(def: FichaFieldDef, current: FichaValue | undefined): string[] {
  const opts = [...(def.options ?? [])];
  if (current !== undefined) {
    const txt = fichaValueText(current);
    if (txt && !opts.includes(txt)) opts.push(txt);
  }
  return opts;
}

/* ============================================================
 * Historial
 * ============================================================ */

const REASON_TEXT: Record<FichaIgnoreReason, string> = {
  candado_humano: "ignorado: lo confirmó el equipo",
  clave_desconocida: "ignorado: campo que no existe en la ficha",
  no_la_llena_el_agente: "ignorado: el agente no llena este campo",
  tipo: "ignorado: dato con formato inválido",
  opcion: "ignorado: no es una de las opciones",
  tope: "ignorado: la ficha ya no tiene espacio",
};

export function formatFichaDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("es-MX", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export type FichaEventView = {
  id: string;
  quien: string;
  campo: string;
  /** "antes → después", o lo que se intentó. */
  cambio: string;
  resultado: string;
  /** Ignorados e inválidos se pintan en gris. */
  aplicado: boolean;
  cuando: string;
};

/** Una fila de la bitácora, en texto para la gente. */
export function formatFichaEvent(
  e: FichaEventDto,
  labelFor: (key: string) => string
): FichaEventView {
  const quien =
    e.source === "ia"
      ? "Agente"
      : e.source === "bot"
        ? "Bot"
        : (e.actor?.name ?? "Alguien del equipo");
  const antes = e.oldValue === null ? "—" : fichaValueText(e.oldValue);
  const despues = e.newValue === null ? "—" : fichaValueText(e.newValue);
  const aplicado = e.outcome === "aplicado";
  let cambio: string;
  if (aplicado) {
    cambio = e.newValue === null ? `${antes} → borrado` : `${antes} → ${despues}`;
  } else {
    cambio = e.newValue === null ? "" : `intentó: ${despues}`;
  }
  const resultado = aplicado
    ? "aplicado"
    : e.reason
      ? REASON_TEXT[e.reason]
      : e.outcome === "ignorado_humano"
        ? REASON_TEXT.candado_humano
        : "ignorado: dato inválido";
  return {
    id: e.id,
    quien,
    campo: labelFor(e.key),
    cambio,
    resultado,
    aplicado,
    cuando: formatFichaDate(e.createdAt),
  };
}

/* ============================================================
 * Editor de campos (Agente → Campos de la ficha)
 * ============================================================ */

/** Fila editable: opciones como texto separado por comas mientras se escribe. */
export type FieldDraft = {
  /** Id local estable para `key` de React (no se guarda). */
  uid: string;
  key: string;
  /** ¿El Propietario tocó la clave? Si no, se deriva de la etiqueta. */
  keyTouched: boolean;
  label: string;
  type: FichaFieldType;
  options: string;
  allowOther: boolean;
  hint: string;
  agentFills: boolean;
};

let uidSeq = 0;
function nextUid(): string {
  uidSeq += 1;
  return `fd_${uidSeq}`;
}

export function emptyDraft(): FieldDraft {
  return {
    uid: nextUid(),
    key: "",
    keyTouched: false,
    label: "",
    type: "texto",
    options: "",
    allowOther: false,
    hint: "",
    agentFills: true,
  };
}

export function defToDraft(def: FichaFieldDef): FieldDraft {
  return {
    uid: nextUid(),
    key: def.key,
    keyTouched: true,
    label: def.label,
    type: def.type,
    options: (def.options ?? []).join(", "),
    allowOther: Boolean(def.allowOther),
    hint: def.hint ?? "",
    agentFills: def.agentFills,
  };
}

/** Cambiar la etiqueta regenera la clave mientras nadie la haya tocado. */
export function withLabel(d: FieldDraft, label: string): FieldDraft {
  return d.keyTouched ? { ...d, label } : { ...d, label, key: slugifyFichaKey(label) };
}

export function splitOptions(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((o) => o.trim())
    .filter(Boolean);
}

/** Borrador → forma que entiende `fichaFieldsSchema` (sin canonizar). */
export function draftToRaw(d: FieldDraft): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    key: d.key,
    label: d.label,
    type: d.type,
    agentFills: d.agentFills,
  };
  if (d.type === "opcion") {
    raw.options = splitOptions(d.options);
    if (d.allowOther) raw.allowOther = true;
  }
  if (d.hint.trim()) raw.hint = d.hint;
  return raw;
}

/** Errores por fila y por campo de la fila, más los generales (p. ej. tope). */
export type FieldErrors = {
  rows: Record<number, Record<string, string>>;
  general: string[];
};

const FIELD_NAMES: Record<string, string> = {
  key: "clave",
  label: "etiqueta",
  type: "tipo",
  options: "opciones",
  hint: "pista",
};

function addError(out: FieldErrors, path: (string | number)[], message: string) {
  const [i, field] = path;
  if (typeof i === "number") {
    const name = typeof field === "string" ? field : "_";
    const row = (out.rows[i] ??= {});
    // Primer error por campo: el más útil suele ser el primero.
    row[name] ??= message;
  } else {
    out.general.push(message);
  }
}

/**
 * Valida en cliente con el MISMO esquema del servidor. Devuelve la lista
 * canónica o los errores ubicados en su fila.
 */
export function validateDrafts(
  drafts: FieldDraft[]
): { ok: true; fields: FichaFieldDef[] } | { ok: false; errors: FieldErrors } {
  const r = fichaFieldsSchema.safeParse(drafts.map(draftToRaw));
  if (r.success) return { ok: true, fields: r.data };
  const errors: FieldErrors = { rows: {}, general: [] };
  for (const issue of r.error.issues) {
    let msg = issue.message;
    if (issue.code === "too_big" && issue.path.length === 0) {
      msg = `Máximo ${FICHA_LIMITS.maxFields} campos`;
    } else if (issue.code === "too_small" && issue.path[1] === "label") {
      msg = "Ponle una etiqueta";
    } else if (issue.code === "too_small" && issue.path[1] === "key") {
      msg = "Falta la clave";
    } else if (issue.code === "too_big" && typeof issue.path[1] === "string") {
      msg = `La ${FIELD_NAMES[issue.path[1]] ?? issue.path[1]} es demasiado larga`;
    }
    addError(errors, issue.path, msg);
  }
  // Zod no llega a la regla de claves únicas si otra fila ya falló: se
  // repite aquí para mostrar todos los errores de una vez.
  const vistas = new Set<string>();
  drafts.forEach((d, i) => {
    const k = d.key.trim();
    if (k && vistas.has(k)) addError(errors, [i, "key"], `clave repetida: ${k}`);
    vistas.add(k);
  });
  return { ok: false, errors };
}

/**
 * El 422 del servidor (`fields.2.key: clave repetida: ciudad; …`) ubicado en
 * su fila. Lo que no se puede ubicar va a `general`.
 */
export function parseServerFieldErrors(message: string): FieldErrors {
  const out: FieldErrors = { rows: {}, general: [] };
  for (const part of message.split(/;\s*/)) {
    const p = part.trim();
    if (!p) continue;
    const m = /^fields\.(\d+)(?:\.([A-Za-z]+))?(?:\.\d+)?:\s*(.+)$/.exec(p);
    if (m && m[1] !== undefined && m[3] !== undefined) {
      addError(out, [Number(m[1]), m[2] ?? "_"], m[3]);
    } else {
      out.general.push(p);
    }
  }
  return out;
}

/* ============================================================
 * Optimismo del panel: lo que el servidor va a dejar tras el PATCH
 * ============================================================ */

/**
 * Parche humano aplicado en local: lo escrito queda con candado (`humano`) y
 * lo borrado pierde su meta (vuelve a estar libre para el agente).
 */
export function applyHumanPatch(
  ficha: FichaDto,
  meta: FichaMeta,
  patch: Record<string, FichaValue | null>,
  at: string
): { ficha: FichaDto; meta: FichaMeta } {
  const f = { ...ficha };
  const m = { ...meta };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete f[k];
      delete m[k];
    } else {
      f[k] = v;
      m[k] = { by: "humano", at };
    }
  }
  return { ficha: f, meta: m };
}

/** "Dejar que el agente lo actualice": `by` pasa a `ia` solo si hay valor. */
export function applyUnlock(
  ficha: FichaDto,
  meta: FichaMeta,
  keys: string[],
  at: string
): FichaMeta {
  const m = { ...meta };
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(ficha, k)) continue;
    const e = m[k];
    if (!e || e.by === "humano") m[k] = { by: "ia", at };
  }
  return m;
}

/* ============================================================
 * Laboratorio: "Ficha N/M"
 * ============================================================ */

export type FichaCheckView = {
  resumen: string;
  completo: boolean;
  filas: { key: string; label: string; valor: string; cumplido: boolean }[];
};

/** Esperado vs llenado de un caso. Tolera un `fichaCheck` a medio formar. */
export function fichaCheckView(check: FichaCheck): FichaCheckView {
  const esperados = Array.isArray(check.esperados) ? check.esperados : [];
  const cumplidos = new Set(Array.isArray(check.cumplidos) ? check.cumplidos : []);
  const llenados = check.llenados ?? {};
  const filas = esperados.map((key) => {
    const v = Object.prototype.hasOwnProperty.call(llenados, key) ? llenados[key] : undefined;
    return {
      key,
      label: fichaLabel(key),
      valor: v === undefined ? "—" : fichaValueText(v),
      cumplido: cumplidos.has(key),
    };
  });
  const n = filas.filter((f) => f.cumplido).length;
  return { resumen: `Ficha ${n}/${filas.length}`, completo: n === filas.length, filas };
}

/** Mueve una fila arriba (-1) o abajo (+1). Fuera de rango: sin cambios. */
export function moveDraft<T>(list: readonly T[], index: number, dir: -1 | 1): T[] {
  const j = index + dir;
  if (index < 0 || index >= list.length || j < 0 || j >= list.length) return [...list];
  const next = [...list];
  const a = next[index];
  const b = next[j];
  if (a === undefined || b === undefined) return next;
  next[index] = b;
  next[j] = a;
  return next;
}
