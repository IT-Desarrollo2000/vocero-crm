/**
 * 08-B — Lógica pura de la UI del Laboratorio por cliente (sin React, para
 * probarla en unit): formulario de persona y sus reglas de ficha, selección
 * de personas por corrida, delta del historial, "Qué cambió", "Tendencias" y
 * cómo se leen los errores de `/api/lab/*` (501 = "Disponible pronto").
 *
 * Los límites salen de `@/lib/lab` y la validación replica la de
 * `src/server/lab/schemas.ts` (trim antes de medir), para que el formulario
 * diga lo mismo que diría el 422 del servidor.
 */

import {
  LAB_DELTA_NOTE_DIFFERENT_SET,
  LAB_HALLAZGO_TIPOS,
  LAB_MAX_PERSONAS_PER_RUN,
  LAB_MAX_SCRIPT_MESSAGES,
  LAB_PERSONA_CRITERIOS_MAX,
  LAB_PERSONA_NAME_MAX,
  LAB_PERSONA_OBJETIVO_MAX,
  LAB_PERSONA_RASGOS_MAX,
  LAB_PROFILE_FIELD_MAX,
  LAB_SCRIPT_MESSAGE_MAX,
  type LabAjusteCampo,
  type LabHallazgoTipo,
  type LabKbSnapshotEntry,
  type LabPersonaCreateInput,
  type LabPersonaDto,
  type LabPersonaSeedData,
  type LabRunCreateInput,
  type LabRunDiffDto,
  type LabRunSummaryDto,
  type LabTrendsDto,
  type LabVeredicto,
} from "@/lib/lab";

// ── Etiquetas ────────────────────────────────────────────────────────────

export const TIPO_LABELS: Record<LabHallazgoTipo, string> = {
  alucinacion: "Alucinación",
  fuera_de_kb: "Fuera del conocimiento",
  debio_escalar: "Debió escalar",
  tono: "Tono",
};

export const PROFILE_FIELD_LABELS: Record<LabAjusteCampo, string> = {
  tone: "Tono",
  escalationRules: "Reglas de escalamiento",
  instructions: "Instrucciones",
};

const DIFF_PROFILE_LABELS: Record<
  "name" | "tone" | "instructions" | "escalationRules" | "greeting",
  string
> = {
  name: "Nombre del agente",
  tone: "Tono",
  instructions: "Instrucciones",
  escalationRules: "Reglas de escalamiento",
  greeting: "Saludo",
};

export const VEREDICTO_LABELS: Record<LabVeredicto | "sin_veredicto", string> = {
  verde: "Verde",
  amarillo: "Amarillo",
  rojo: "Rojo",
  sin_veredicto: "Sin veredicto",
};

export const SEED_SET_LABELS = {
  autos: "Agencia de autos eléctricos",
  neutro: "Genérico (cualquier negocio)",
} as const;

/** Lo que muestra la UI cuando el servidor aún responde 501. */
export const NOT_IMPLEMENTED_MESSAGE = "Disponible pronto";

// ── Errores de /api/lab/* ────────────────────────────────────────────────

export type LabErrorOutcome =
  | { kind: "not_implemented"; message: string }
  | { kind: "conflict"; code: string | null; message: string }
  | { kind: "too_long"; message: string }
  | { kind: "invalid"; code: string | null; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "error"; message: string };

function errorField(body: unknown, key: "code" | "message"): string | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== "object") return null;
  const v = (err as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v : null;
}

/** `status` HTTP (no-ok) + cuerpo parseado (o null) → qué mostrar. */
export function classifyLabError(
  status: number,
  body: unknown,
  fallback = "No se pudo completar la acción"
): LabErrorOutcome {
  const code = errorField(body, "code");
  const message = errorField(body, "message");
  if (status === 501) return { kind: "not_implemented", message: NOT_IMPLEMENTED_MESSAGE };
  if (status === 409) return { kind: "conflict", code, message: message ?? fallback };
  if (status === 422 && code === "too_long") {
    return { kind: "too_long", message: message ?? "El texto es demasiado largo" };
  }
  if (status === 422) return { kind: "invalid", code, message: message ?? fallback };
  if (status === 404) return { kind: "not_found", message: message ?? "Ya no existe" };
  return { kind: "error", message: message ?? fallback };
}

/** Mensaje claro del 422 `too_long` al aplicar al perfil. */
export function tooLongMessage(field: LabAjusteCampo): string {
  return `No cabe en "${PROFILE_FIELD_LABELS[field]}": el campo quedaría en más de ${LAB_PROFILE_FIELD_MAX[field]} caracteres. Recorta el texto o edita el perfil del agente.`;
}

// ── Formulario de persona ────────────────────────────────────────────────

export type ExpectRuleDraft = { key: string; pattern: string; flags: string };

export type PersonaDraft = {
  name: string;
  objetivo: string;
  rasgos: string;
  guion: string[];
  criteriosExito: string;
  contactName: string;
  /** Semilla opcional: notas del contacto. */
  seedNotes: string;
  /** Semilla opcional de la ficha: una línea `clave: valor` por campo. */
  seedFicha: string;
  /** Nombre precargado de la semilla (no editable aquí; se conserva). */
  seedName: string | null;
  expectFicha: ExpectRuleDraft[];
  active: boolean;
  position: string;
};

export const EXPECT_FICHA_MAX_RULES = 20;
const EXPECT_KEY_MAX = 64;
const EXPECT_PATTERN_MAX = 200;
const CONTACT_NAME_MAX = 120;
const SEED_NOTES_MAX = 2000;
const SEED_VALUE_MAX = 500;
const POSITION_MAX = 10_000;

export function emptyPersonaDraft(position = 0): PersonaDraft {
  return {
    name: "",
    objetivo: "",
    rasgos: "",
    guion: [""],
    criteriosExito: "",
    contactName: "",
    seedNotes: "",
    seedFicha: "",
    seedName: null,
    expectFicha: [],
    active: true,
    position: String(position),
  };
}

export function personaToDraft(p: LabPersonaDto): PersonaDraft {
  const ficha = p.seed?.ficha ?? {};
  return {
    name: p.name,
    objetivo: p.objetivo,
    rasgos: p.rasgos ?? "",
    guion: p.guion.length > 0 ? [...p.guion] : [""],
    criteriosExito: p.criteriosExito ?? "",
    contactName: p.contactName,
    seedNotes: p.seed?.notes ?? "",
    seedFicha: Object.entries(ficha)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join("\n"),
    seedName: p.seed?.name ?? null,
    expectFicha: p.expectFicha.map((r) => ({ ...r })),
    active: p.active,
    position: String(p.position),
  };
}

/** Valida un patrón de regla de ficha como lo hará el runtime. */
export function validateExpectRule(rule: ExpectRuleDraft): string | null {
  const key = rule.key.trim();
  if (!key) return "Falta la clave del campo";
  if (key.length > EXPECT_KEY_MAX) return `La clave admite hasta ${EXPECT_KEY_MAX} caracteres`;
  if (!rule.pattern) return "Falta el patrón";
  if (rule.pattern.length > EXPECT_PATTERN_MAX) {
    return `El patrón admite hasta ${EXPECT_PATTERN_MAX} caracteres`;
  }
  if (!/^[gimsuy]*$/.test(rule.flags) || rule.flags.length > 6) {
    return "Banderas válidas: g, i, m, s, u, y";
  }
  try {
    new RegExp(rule.pattern, rule.flags);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "";
    return `Expresión regular inválida${detail ? `: ${detail}` : ""}`;
  }
  return null;
}

/** `clave: valor` por línea → ficha de la semilla (null si vacía). */
export function parseSeedFicha(
  text: string
): { ok: true; ficha: Record<string, string> | null } | { ok: false; error: string } {
  const ficha: Record<string, string> = {};
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const sep = line.indexOf(":");
    if (sep <= 0) return { ok: false, error: `Línea ${i + 1}: usa el formato "clave: valor"` };
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (!key) return { ok: false, error: `Línea ${i + 1}: falta la clave` };
    if (value.length > SEED_VALUE_MAX) {
      return { ok: false, error: `Línea ${i + 1}: el valor admite hasta ${SEED_VALUE_MAX} caracteres` };
    }
    ficha[key] = value;
  }
  return { ok: true, ficha: Object.keys(ficha).length > 0 ? ficha : null };
}

export type PersonaDraftErrors = Partial<Record<string, string>>;

export type PersonaDraftResult =
  | { ok: true; input: LabPersonaCreateInput }
  | { ok: false; errors: PersonaDraftErrors };

function tooLong(label: string, max: number): string {
  return `${label} admite hasta ${max} caracteres`;
}

/**
 * Formulario → cuerpo de `POST /api/lab/personas` (también sirve de PATCH:
 * todos los campos editables). Errores por campo: `name`, `objetivo`,
 * `rasgos`, `criteriosExito`, `contactName`, `position`, `seedFicha`,
 * `seedNotes`, `guion` (conteo) y `guion.<i>`, `expectFicha` y `expect.<i>`.
 */
export function validatePersonaDraft(d: PersonaDraft): PersonaDraftResult {
  const errors: PersonaDraftErrors = {};
  const name = d.name.trim();
  if (!name) errors.name = "Ponle un nombre";
  else if (name.length > LAB_PERSONA_NAME_MAX) errors.name = tooLong("El nombre", LAB_PERSONA_NAME_MAX);

  const objetivo = d.objetivo.trim();
  if (objetivo.length > LAB_PERSONA_OBJETIVO_MAX) {
    errors.objetivo = tooLong("El objetivo", LAB_PERSONA_OBJETIVO_MAX);
  }
  const rasgos = d.rasgos.trim();
  if (rasgos.length > LAB_PERSONA_RASGOS_MAX) errors.rasgos = tooLong("Los rasgos", LAB_PERSONA_RASGOS_MAX);
  const criterios = d.criteriosExito.trim();
  if (criterios.length > LAB_PERSONA_CRITERIOS_MAX) {
    errors.criteriosExito = tooLong("Los criterios", LAB_PERSONA_CRITERIOS_MAX);
  }
  const contactName = d.contactName.trim();
  if (contactName.length > CONTACT_NAME_MAX) {
    errors.contactName = tooLong("El nombre del contacto", CONTACT_NAME_MAX);
  }

  const guion = d.guion.map((m) => m.trim());
  if (guion.length < 1) errors.guion = "El guion necesita al menos el mensaje inicial";
  else if (guion.length > LAB_MAX_SCRIPT_MESSAGES) {
    errors.guion = `El guion admite hasta ${LAB_MAX_SCRIPT_MESSAGES} mensajes`;
  }
  guion.forEach((m, i) => {
    if (!m) errors[`guion.${i}`] = "El mensaje no puede ir vacío";
    else if (m.length > LAB_SCRIPT_MESSAGE_MAX) {
      errors[`guion.${i}`] = tooLong("Cada mensaje", LAB_SCRIPT_MESSAGE_MAX);
    }
  });

  if (d.expectFicha.length > EXPECT_FICHA_MAX_RULES) {
    errors.expectFicha = `Hasta ${EXPECT_FICHA_MAX_RULES} reglas`;
  }
  const expectFicha = d.expectFicha.map((r) => ({
    key: r.key.trim(),
    pattern: r.pattern,
    flags: r.flags.trim(),
  }));
  expectFicha.forEach((r, i) => {
    const err = validateExpectRule(r);
    if (err) errors[`expect.${i}`] = err;
  });

  const seedFicha = parseSeedFicha(d.seedFicha);
  if (!seedFicha.ok) errors.seedFicha = seedFicha.error;
  const seedNotes = d.seedNotes.trim();
  if (seedNotes.length > SEED_NOTES_MAX) errors.seedNotes = tooLong("Las notas", SEED_NOTES_MAX);

  const position = d.position.trim() === "" ? 0 : Number(d.position);
  if (!Number.isInteger(position) || position < 0 || position > POSITION_MAX) {
    errors.position = `Usa un número entero entre 0 y ${POSITION_MAX}`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  let seed: LabPersonaSeedData | null = null;
  if ((seedFicha.ok && seedFicha.ficha) || seedNotes || d.seedName) {
    seed = {};
    if (seedFicha.ok && seedFicha.ficha) seed.ficha = seedFicha.ficha;
    if (seedNotes) seed.notes = seedNotes;
    if (d.seedName) seed.name = d.seedName;
  }

  const input: LabPersonaCreateInput = {
    name,
    objetivo,
    rasgos: rasgos || null,
    guion,
    criteriosExito: criterios || null,
    seed,
    expectFicha,
    active: d.active,
    position,
  };
  // Sin nombre de contacto, el servidor usa `[Prueba] <name>`.
  if (contactName) input.contactName = contactName;
  return { ok: true, input };
}

// ── Personas: listas y selección por corrida ─────────────────────────────

function byPosition(a: LabPersonaDto, b: LabPersonaDto): number {
  return a.position - b.position || a.key.localeCompare(b.key);
}

export function splitPersonas(personas: LabPersonaDto[]): {
  live: LabPersonaDto[];
  archived: LabPersonaDto[];
} {
  const sorted = [...personas].sort(byPosition);
  return {
    live: sorted.filter((p) => !p.archivedAt),
    archived: sorted.filter((p) => !!p.archivedAt),
  };
}

/** Elegibles para correr: activas y sin archivar, por `position`. */
export function runnablePersonas(personas: LabPersonaDto[]): LabPersonaDto[] {
  return splitPersonas(personas).live.filter((p) => p.active);
}

/** Selección por defecto: las activas, hasta el tope por corrida. */
export function defaultSelection(
  personas: LabPersonaDto[],
  max = LAB_MAX_PERSONAS_PER_RUN
): { keys: string[]; capped: boolean } {
  const runnable = runnablePersonas(personas).map((p) => p.key);
  return { keys: runnable.slice(0, max), capped: runnable.length > max };
}

/** Marca/desmarca; al llegar al tope no agrega y lo avisa (`limited`). */
export function toggleSelection(
  selected: string[],
  key: string,
  max = LAB_MAX_PERSONAS_PER_RUN
): { keys: string[]; limited: boolean } {
  if (selected.includes(key)) return { keys: selected.filter((k) => k !== key), limited: false };
  if (selected.length >= max) return { keys: selected, limited: true };
  return { keys: [...selected, key], limited: false };
}

/** Quita de la selección lo que ya no es elegible (archivada, inactiva). */
export function pruneSelection(selected: string[], personas: LabPersonaDto[]): string[] {
  const ok = new Set(runnablePersonas(personas).map((p) => p.key));
  return selected.filter((k) => ok.has(k));
}

/**
 * Cuerpo de `POST /api/lab/runs`. Sin lista de personas (aún 501) o con la
 * selección igual a "todas las activas", va SIN cuerpo (= todas las
 * activas): el mismo camino que antes de 08. Si no, `personaKeys` en el
 * orden de las personas.
 */
export function runCreateBody(
  selected: string[],
  personas: LabPersonaDto[] | null
): LabRunCreateInput | null {
  if (!personas) return null;
  const runnable = runnablePersonas(personas).map((p) => p.key);
  const chosen = runnable.filter((k) => selected.includes(k));
  const all =
    chosen.length === runnable.length && runnable.length <= LAB_MAX_PERSONAS_PER_RUN;
  if (all) return null;
  return { personaKeys: chosen };
}

/** Estimación aproximada de la duración (≈ 10 s por mensaje + 20 s por caso). */
export function estimateRunMinutes(personas: Pick<LabPersonaDto, "guion">[]): number {
  if (personas.length === 0) return 0;
  const seconds = personas.reduce((acc, p) => acc + p.guion.length * 10 + 20, 0);
  return Math.max(1, Math.ceil(seconds / 60));
}

// ── Historial: delta ─────────────────────────────────────────────────────

export type DeltaView =
  | { kind: "up" | "down"; label: string; title: string }
  | { kind: "note"; label: string; title: string }
  | null;

export function deltaView(
  run: Pick<LabRunSummaryDto, "delta" | "deltaNote">
): DeltaView {
  if (run.delta !== null && run.delta !== 0) {
    return run.delta > 0
      ? { kind: "up", label: `+${run.delta}`, title: "Contra la corrida anterior con las mismas personas" }
      : { kind: "down", label: String(run.delta), title: "Contra la corrida anterior con las mismas personas" };
  }
  if (run.delta === null && run.deltaNote === LAB_DELTA_NOTE_DIFFERENT_SET) {
    return {
      kind: "note",
      label: LAB_DELTA_NOTE_DIFFERENT_SET,
      title: "No hay corrida anterior con las mismas personas para comparar el score",
    };
  }
  return null;
}

// ── "Qué cambió" ─────────────────────────────────────────────────────────

const SNIPPET_MAX = 120;

function snippet(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > SNIPPET_MAX ? `${t.slice(0, SNIPPET_MAX - 1)}…` : t;
}

/** Texto corto de una entrada del KB del snapshot (o aviso si es solo hash). */
export function kbEntryLabel(e: LabKbSnapshotEntry | null): string {
  if (!e || "hash" in e) return "(sin texto: el conocimiento era muy grande para guardarlo)";
  if (e.kind === "qa") return snippet(e.question ?? e.answer ?? "(pregunta vacía)");
  return snippet(e.content ?? "(bloque vacío)");
}

export function countLabel(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export type DiffSummary =
  | { available: false; message: string }
  | {
      available: true;
      againstId: string;
      empty: boolean;
      headline: string[];
      profile: { field: string; label: string; before: string | null; after: string | null }[];
      kb: {
        added: string[];
        removed: string[];
        edited: { before: string; after: string }[];
      };
      personas: { added: string[]; removed: string[]; edited: string[] };
      models: { label: string; before: string | null; after: string | null }[];
    };

export function summarizeDiff(diff: LabRunDiffDto): DiffSummary {
  if (!diff.available) {
    return {
      available: false,
      message:
        diff.reason === "no_snapshot"
          ? "No disponible: esta corrida (o la anterior) es de antes de que el Laboratorio guardara la configuración."
          : "No hay una corrida anterior terminada con qué comparar.",
    };
  }
  const profile = (
    Object.keys(DIFF_PROFILE_LABELS) as (keyof typeof DIFF_PROFILE_LABELS)[]
  )
    .filter((k) => diff.profile[k])
    .map((k) => ({
      field: k,
      label: DIFF_PROFILE_LABELS[k],
      before: diff.profile[k]?.before ?? null,
      after: diff.profile[k]?.after ?? null,
    }));
  const kb = {
    added: diff.kb.added.map(kbEntryLabel),
    removed: diff.kb.removed.map(kbEntryLabel),
    edited: diff.kb.edited.map((e) => ({
      before: kbEntryLabel(e.before),
      after: kbEntryLabel(e.after),
    })),
  };
  const models: { label: string; before: string | null; after: string | null }[] = [];
  if (diff.models.agent) models.push({ label: "Modelo del agente", ...diff.models.agent });
  if (diff.models.judge) models.push({ label: "Modelo del juez", ...diff.models.judge });

  const headline: string[] = [];
  if (kb.added.length) {
    headline.push(`+${countLabel(kb.added.length, "entrada de conocimiento", "entradas de conocimiento")}`);
  }
  if (kb.removed.length) {
    headline.push(`−${countLabel(kb.removed.length, "entrada de conocimiento", "entradas de conocimiento")}`);
  }
  if (kb.edited.length) {
    headline.push(countLabel(kb.edited.length, "entrada editada", "entradas editadas"));
  }
  for (const p of profile) headline.push(`${p.label} cambió`);
  if (diff.personas.added.length) {
    headline.push(`+${countLabel(diff.personas.added.length, "persona", "personas")}`);
  }
  if (diff.personas.removed.length) {
    headline.push(`−${countLabel(diff.personas.removed.length, "persona", "personas")}`);
  }
  if (diff.personas.edited.length) {
    headline.push(countLabel(diff.personas.edited.length, "persona editada", "personas editadas"));
  }
  for (const m of models) headline.push(`${m.label} cambió`);

  return {
    available: true,
    againstId: diff.againstId,
    empty: headline.length === 0,
    headline,
    profile,
    kb,
    personas: diff.personas,
    models,
  };
}

/** URL del diff: contra la corrida del delta si la hay; si no, la del servidor. */
export function diffUrl(runId: string, againstId: string | null): string {
  const base = `/api/lab/runs/${encodeURIComponent(runId)}/diff`;
  return againstId ? `${base}?against=${encodeURIComponent(againstId)}` : base;
}

// ── "Tendencias" ─────────────────────────────────────────────────────────

export type TrendCell = LabVeredicto | "sin_veredicto" | null;

export type TrendsTable = {
  tipos: readonly LabHallazgoTipo[];
  personaKeys: string[];
  /** Máximo de un tipo en una corrida (escala de las barras); ≥ 1. */
  maxCount: number;
  rows: {
    id: string;
    startedAt: string;
    score: number | null;
    counts: Record<LabHallazgoTipo, number>;
    total: number;
    veredictos: Record<string, TrendCell>;
  }[];
};

/** DTO → tabla accesible: una fila por corrida (recientes primero). */
export function buildTrendsTable(dto: LabTrendsDto): TrendsTable {
  const personaKeys: string[] = [];
  for (const run of dto.runs) {
    for (const k of [...(run.personaKeys ?? []), ...Object.keys(run.veredictos)]) {
      if (!personaKeys.includes(k)) personaKeys.push(k);
    }
  }
  let maxCount = 1;
  const rows = dto.runs.map((run) => {
    const counts = Object.fromEntries(
      LAB_HALLAZGO_TIPOS.map((t) => [t, run.hallazgosPorTipo[t] ?? 0])
    ) as Record<LabHallazgoTipo, number>;
    const total = LAB_HALLAZGO_TIPOS.reduce((acc, t) => acc + counts[t], 0);
    for (const t of LAB_HALLAZGO_TIPOS) maxCount = Math.max(maxCount, counts[t]);
    const veredictos = Object.fromEntries(
      personaKeys.map((k) => [k, run.veredictos[k] ?? null])
    ) as Record<string, TrendCell>;
    return { id: run.id, startedAt: run.startedAt, score: run.score, counts, total, veredictos };
  });
  return { tipos: LAB_HALLAZGO_TIPOS, personaKeys, maxCount, rows };
}

/** Ancho en % de una barra (0 → 0; resto proporcional a `max`). */
export function barWidth(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.round((Math.min(count, max) / max) * 100);
}
