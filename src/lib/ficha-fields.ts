import { z } from "zod";
import type { FichaValue } from "./types";

/**
 * 04 — Definición de los campos de la ficha y su procedencia.
 *
 * Compartido cliente/servidor: SIN imports de servidor. Lo usan la puerta
 * única (`src/server/bot/ficha.ts`), el agente (`src/server/ai/*`), las APIs
 * y la UI (Agente → "Campos de la ficha" y el panel de la Bandeja).
 *
 * La definición es por organización (`agent_profile.ficha_fields`); NULL = no
 * hay definición y todo se comporta como antes de 04 (RF-04-02): ficha libre
 * y el agente in-process no llena nada.
 *
 * La procedencia vive aparte, en `contact.ficha_meta`, para no tocar la forma
 * de `contact.ficha` (escalares planos, contrato publicado en
 * `/api/bot/context`).
 */

/* ============================================================
 * Definición de campos (RF-04-01)
 * ============================================================ */

export const FICHA_FIELD_TYPES = ["texto", "numero", "si_no", "opcion"] as const;
export type FichaFieldType = (typeof FICHA_FIELD_TYPES)[number];

export const FICHA_FIELD_TYPE_LABEL: Record<FichaFieldType, string> = {
  texto: "Texto",
  numero: "Número",
  si_no: "Sí / No",
  opcion: "Opción",
};

export const FICHA_LIMITS = {
  /** Campos definidos por organización. */
  maxFields: 25,
  /** Igual a `MAX_KEY_LEN` de la puerta (`server/bot/ficha.ts`). */
  maxKeyLen: 60,
  maxLabelLen: 60,
  maxHintLen: 200,
  minOptions: 2,
  maxOptions: 20,
  maxOptionLen: 60,
  /** Tope de un valor de texto escrito por el agente (RF-04-05). */
  maxAgentTextLen: 200,
} as const;

/** snake_case ASCII que empieza con letra. */
export const FICHA_KEY_RE = /^[a-z][a-z0-9_]*$/;

export type FichaFieldDef = {
  /** Clave en `contact.ficha` (snake_case ASCII, única). */
  key: string;
  /** Cómo se muestra en el panel y en el prompt. */
  label: string;
  type: FichaFieldType;
  /** Solo `opcion`: valores aceptados (2–20). */
  options?: string[];
  /** Solo `opcion`: si el valor no coincide, se guarda el texto tal cual. */
  allowOther?: boolean;
  /** Pista para el agente (va al prompt). */
  hint?: string;
  /** ¿El agente in-process llena este campo? */
  agentFills: boolean;
};

const optionText = z.string().trim().min(1).max(FICHA_LIMITS.maxOptionLen);

export const fichaFieldDefSchema: z.ZodType<FichaFieldDef, z.ZodTypeDef, unknown> = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(FICHA_LIMITS.maxKeyLen)
      .regex(FICHA_KEY_RE, "la clave debe ser snake_case ASCII (a-z, 0-9, _)"),
    label: z.string().trim().min(1).max(FICHA_LIMITS.maxLabelLen),
    type: z.enum(FICHA_FIELD_TYPES),
    options: z.array(optionText).max(FICHA_LIMITS.maxOptions).optional(),
    allowOther: z.boolean().optional(),
    hint: z
      .string()
      .trim()
      .max(FICHA_LIMITS.maxHintLen)
      .optional()
      .transform((h) => (h ? h : undefined)),
    agentFills: z.boolean(),
  })
  .superRefine((f, ctx) => {
    if (f.type !== "opcion") return;
    const opts = f.options ?? [];
    if (opts.length < FICHA_LIMITS.minOptions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: `un campo de opción necesita al menos ${FICHA_LIMITS.minOptions} opciones`,
      });
    }
    const seen = new Set<string>();
    for (const o of opts) {
      const n = normalizeText(o);
      if (seen.has(n)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: `opción repetida: ${o}`,
        });
      }
      seen.add(n);
    }
  })
  .transform((f): FichaFieldDef => {
    // Forma canónica: `options`/`allowOther` solo viajan en `opcion`.
    const out: FichaFieldDef = {
      key: f.key,
      label: f.label,
      type: f.type,
      agentFills: f.agentFills,
    };
    if (f.type === "opcion") {
      out.options = f.options ?? [];
      if (f.allowOther) out.allowOther = true;
    }
    if (f.hint) out.hint = f.hint;
    return out;
  });

/** Lista completa (orden = orden del panel), claves únicas, máx. 25. */
export const fichaFieldsSchema = z
  .array(fichaFieldDefSchema)
  .max(FICHA_LIMITS.maxFields)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    fields.forEach((f, i) => {
      if (seen.has(f.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "key"],
          message: `clave repetida: ${f.key}`,
        });
      }
      seen.add(f.key);
    });
  });

/* ============================================================
 * Plantilla "Agencia de autos eléctricos" (RF-04-03)
 * Constante en código, no seed: no toda instancia es una agencia de autos.
 * ============================================================ */

export const FICHA_TEMPLATE_AUTOS_ELECTRICOS: readonly FichaFieldDef[] = [
  {
    key: "modelo_interes",
    label: "Modelo de interés",
    type: "texto",
    hint: "modelo exacto que mencione el cliente",
    agentFills: true,
  },
  {
    key: "presupuesto",
    label: "Presupuesto (MXN)",
    type: "numero",
    hint: "monto total que dice poder pagar; no el enganche",
    agentFills: true,
  },
  {
    key: "forma_pago",
    label: "Forma de pago",
    type: "opcion",
    options: ["contado", "financiamiento", "arrendamiento", "por definir"],
    agentFills: true,
  },
  {
    key: "plazo_compra",
    label: "Plazo de compra",
    type: "opcion",
    options: [
      "esta semana",
      "este mes",
      "1 a 3 meses",
      "más de 3 meses",
      "solo explorando",
    ],
    agentFills: true,
  },
  { key: "ciudad", label: "Ciudad", type: "texto", agentFills: true },
  {
    key: "uso",
    label: "Uso principal",
    type: "opcion",
    options: [
      "traslado diario en ciudad",
      "carretera",
      "negocio / flotilla",
      "reparto",
    ],
    allowOther: true,
    agentFills: true,
  },
];

/* ============================================================
 * Procedencia por campo (RF-04-06 / RF-04-07)
 * ============================================================ */

/** Quién escribió un valor: el agente in-process, una persona o el cerebro externo. */
export const FICHA_SOURCES = ["ia", "humano", "bot"] as const;
export type FichaSource = (typeof FICHA_SOURCES)[number];

/**
 * Procedencia de UNA clave en `contact.ficha_meta`.
 *
 * - No hay bandera `locked`: el candado se DERIVA de `by === "humano"`.
 * - No hay valor "legado": un dato anterior a 04 es una clave con valor y SIN
 *   entrada de meta. Ver `fichaWriteBlocked`.
 */
export type FichaMetaEntry = {
  by: FichaSource;
  /** ISO 8601, tal cual se guarda en el jsonb. */
  at: string;
  /** Solo `by = "humano"`: quién lo editó. */
  userId?: string;
};

export type FichaMeta = Record<string, FichaMetaEntry>;

/** ¿Este campo está "confirmado por el equipo"? */
export function isFichaLocked(entry: FichaMetaEntry | undefined): boolean {
  return entry?.by === "humano";
}

/** Resultado de un intento de escritura por clave en la bitácora (RF-04-09). */
export const FICHA_OUTCOMES = ["aplicado", "ignorado_humano", "invalido"] as const;
export type FichaOutcome = (typeof FICHA_OUTCOMES)[number];

/**
 * Por qué se ignoró una clave. Lo comparten `ficha_event.reason` y el
 * `ignored[].reason` de `PUT /api/bot/ficha`. Nunca lleva el valor (PII).
 *
 * - `candado_humano` → outcome `ignorado_humano`.
 * - el resto → outcome `invalido`.
 */
export const FICHA_IGNORE_REASONS = [
  "candado_humano",
  "clave_desconocida",
  "no_la_llena_el_agente",
  "tipo",
  "opcion",
  "tope",
] as const;
export type FichaIgnoreReason = (typeof FICHA_IGNORE_REASONS)[number];

export type FichaIgnored = { key: string; reason: FichaIgnoreReason };

/**
 * Regla "el humano gana" (RF-04-07, D-04-4 y ajuste de legado), pura.
 *
 * | quién escribe | meta `humano` | con valor y SIN meta (legado) | meta `ia`/`bot` o vacío |
 * |---|---|---|---|
 * | `humano`      | escribe       | escribe                       | escribe                 |
 * | `bot`         | IGNORADO      | escribe                       | escribe                 |
 * | `ia`          | IGNORADO      | IGNORADO                      | escribe                 |
 *
 * El legado se protege solo contra el agente in-process: el cerebro externo
 * es quien llenaba esas claves antes de 04 y debe poder seguir haciéndolo.
 *
 * @param hasValue si la clave tiene hoy un valor en `contact.ficha`.
 * @returns la razón si la escritura se ignora; `null` si procede.
 */
export function fichaWriteBlocked(
  source: FichaSource,
  entry: FichaMetaEntry | undefined,
  hasValue: boolean
): FichaIgnoreReason | null {
  if (source === "humano") return null;
  if (entry?.by === "humano") return "candado_humano";
  if (source === "ia" && hasValue && !entry) return "candado_humano";
  return null;
}

/* ============================================================
 * Coerción de lo que manda el agente (RF-04-05)
 * Solo aplica a `source = "ia"`: la persona edita con controles por tipo y el
 * cerebro externo conserva su contrato de claves libres.
 * ============================================================ */

/** Minúsculas, sin acentos, espacios colapsados. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** "Modelo de interés" → "modelo_de_interes". Sirve para autogenerar la clave. */
export function slugifyFichaKey(label: string): string {
  return normalizeText(label)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[0-9_]+/, "")
    .slice(0, FICHA_LIMITS.maxKeyLen);
}

/**
 * Resuelve la clave que mandó el modelo contra la definición: exacta → sin
 * acentos/mayúsculas (y `-`/espacios como `_`) → contra el `label` en
 * snake_case. `null` si no corresponde a ningún campo.
 */
export function resolveFichaKey(
  raw: string,
  fields: readonly FichaFieldDef[]
): FichaFieldDef | null {
  const exact = fields.find((f) => f.key === raw);
  if (exact) return exact;
  const slug = slugifyFichaKey(raw.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
  if (!slug) return null;
  return (
    fields.find((f) => f.key === slug) ??
    fields.find((f) => slugifyFichaKey(f.label) === slug) ??
    null
  );
}

const SI = new Set(["si", "true", "1", "yes", "y", "s"]);
const NO = new Set(["no", "false", "0", "n"]);

const MULTIPLIERS: Record<string, number> = {
  k: 1e3,
  mil: 1e3,
  miles: 1e3,
  m: 1e6,
  mdp: 1e6,
  millon: 1e6,
  millones: 1e6,
};

/** Parte numérica con separadores mexicanos ("1,200,000.50", "1.2", "1,5"). */
function parseNumberPart(s: string): number | null {
  let t = s;
  if (t.includes(",") && t.includes(".")) {
    t = t.replace(/,/g, "");
  } else if (t.includes(",")) {
    t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3}){2,}$/.test(t)) {
    // "1.200.000": puntos como miles. Un solo punto es decimal ("1.2").
    t = t.replace(/\./g, "");
  }
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * "$350,000" · "350 mil" · "350k" · "1.2 millones" · 350000 → número.
 * `null` si no se entiende ("mucho").
 */
export function parseFichaNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const t = normalizeText(raw)
    .replace(/\$/g, "")
    .replace(/\b(de )?(pesos|mxn|mn)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const m = /^(-?[\d.,]+)\s*([a-z]+)?$/.exec(t);
  if (!m) return null;
  const base = parseNumberPart(m[1] ?? "");
  if (base === null) return null;
  const unit = m[2];
  if (!unit) return base;
  const mult = MULTIPLIERS[unit];
  if (!mult) return null;
  return Math.round(base * mult * 100) / 100;
}

export type FichaCoerceResult =
  | { ok: true; value: FichaValue }
  | { ok: false; reason: Extract<FichaIgnoreReason, "tipo" | "opcion"> };

/**
 * Convierte UN valor del agente al tipo del campo. El llamador ya descartó
 * `null`/`""` (el agente no borra).
 */
export function coerceFichaValue(def: FichaFieldDef, raw: unknown): FichaCoerceResult {
  switch (def.type) {
    case "numero": {
      const n = parseFichaNumber(raw);
      return n === null ? { ok: false, reason: "tipo" } : { ok: true, value: n };
    }
    case "si_no": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (typeof raw === "number") {
        if (raw === 1) return { ok: true, value: true };
        if (raw === 0) return { ok: true, value: false };
        return { ok: false, reason: "tipo" };
      }
      if (typeof raw !== "string") return { ok: false, reason: "tipo" };
      const t = normalizeText(raw).replace(/[.!]+$/, "");
      if (SI.has(t)) return { ok: true, value: true };
      if (NO.has(t)) return { ok: true, value: false };
      return { ok: false, reason: "tipo" };
    }
    case "opcion": {
      if (typeof raw !== "string" && typeof raw !== "number") {
        return { ok: false, reason: "tipo" };
      }
      const text = String(raw).trim();
      const n = normalizeText(text);
      const match = (def.options ?? []).find((o) => normalizeText(o) === n);
      if (match) return { ok: true, value: match };
      if (def.allowOther && text) {
        return { ok: true, value: text.slice(0, FICHA_LIMITS.maxAgentTextLen) };
      }
      return { ok: false, reason: "opcion" };
    }
    case "texto": {
      if (typeof raw === "string") {
        const t = raw.trim();
        return t
          ? { ok: true, value: t.slice(0, FICHA_LIMITS.maxAgentTextLen) }
          : { ok: false, reason: "tipo" };
      }
      if (typeof raw === "number" && Number.isFinite(raw)) {
        return { ok: true, value: String(raw) };
      }
      return { ok: false, reason: "tipo" };
    }
  }
}

/**
 * Parche del agente → valores guardables + rechazos (sin valores en el motivo).
 *
 * - `raw` que no sea objeto plano → parche vacío, sin rechazos.
 * - `null`/`undefined`/`""` → se ignoran sin rechazo (el agente no borra).
 * - clave fuera de la definición → `clave_desconocida`; con
 *   `agentFills=false` → `no_la_llena_el_agente`.
 * - dos claves crudas que resuelven al mismo campo: gana la primera.
 *
 * NO aplica la regla de procedencia ni el tope de 40: eso es de la puerta
 * (`upsertFicha`), que ve la ficha y la meta actuales dentro de la transacción.
 */
export function coerceFichaPatch(
  raw: unknown,
  fields: readonly FichaFieldDef[]
): { patch: Record<string, FichaValue>; rejected: FichaIgnored[] } {
  const patch: Record<string, FichaValue> = {};
  const rejected: FichaIgnored[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { patch, rejected };
  }
  for (const [rawKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    const key = rawKey.trim().slice(0, FICHA_LIMITS.maxKeyLen);
    if (!key) continue;
    const def = resolveFichaKey(key, fields);
    if (!def) {
      rejected.push({ key, reason: "clave_desconocida" });
      continue;
    }
    if (!def.agentFills) {
      rejected.push({ key: def.key, reason: "no_la_llena_el_agente" });
      continue;
    }
    if (def.key in patch) continue;
    const r = coerceFichaValue(def, value);
    if (r.ok) patch[def.key] = r.value;
    else rejected.push({ key: def.key, reason: r.reason });
  }
  return { patch, rejected };
}

/* ============================================================
 * Laboratorio (`agent_test_case.ficha_check`)
 * Informativo, determinista y fuera del score del juez.
 * ============================================================ */

export type FichaCheck = {
  /** Claves que la persona debía dejar llenas. */
  esperados: string[];
  /** Valores con los que quedó la ficha del contacto sintético. */
  llenados: Record<string, FichaValue>;
  /** Subconjunto de `esperados` cuyo valor coincidió con su patrón. */
  cumplidos: string[];
};
