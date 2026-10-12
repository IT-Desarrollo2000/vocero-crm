/**
 * 08 — Laboratorio por cliente: contrato compartido cliente/servidor
 * (dev-tasks/08-laboratorio-por-cliente.md, «Contrato 08-0»).
 *
 * Catálogos, límites y DTOs. Sin dependencias de servidor: lo importan el
 * esquema (`lib/db/schema.ts`, para tipar los jsonb), el servidor
 * (`src/server/lab/*`) y la UI del Laboratorio.
 */

// ── Límites (D-08-03) ────────────────────────────────────────────────────

/** Máximo de personas por corrida (`POST /api/lab/runs`). */
export const LAB_MAX_PERSONAS_PER_RUN = 10;
/** Mensajes por guion: 1..8 (el primero es el mensaje inicial). */
export const LAB_MAX_SCRIPT_MESSAGES = 8;
/** Largo de cada mensaje del guion: 1..500. */
export const LAB_SCRIPT_MESSAGE_MAX = 500;
export const LAB_PERSONA_NAME_MAX = 80;
export const LAB_PERSONA_OBJETIVO_MAX = 1000;
export const LAB_PERSONA_RASGOS_MAX = 1000;
export const LAB_PERSONA_CRITERIOS_MAX = 1000;
/** Ventana de la tendencia (`GET /api/lab/trends?limit=`): default 10, máx. 50. */
export const LAB_TRENDS_DEFAULT_LIMIT = 10;
export const LAB_TRENDS_MAX_LIMIT = 50;

/**
 * Teléfono sintético de las personas: `52100000` + secuencia de 5 dígitos
 * (13 dígitos en total). Las 7 de semilla son `5210000000001..7`; las nuevas
 * toman la siguiente libre de la organización. Lo genera SIEMPRE el servidor.
 */
export const LAB_SYNTHETIC_PHONE_PREFIX = "52100000";

/**
 * D-08-04 — Por encima de esto (bytes del JSON de las entradas del KB) el
 * snapshot guarda solo `id` + hash por entrada y el diff degrada a "editada"
 * sin texto.
 */
export const LAB_SNAPSHOT_KB_MAX_BYTES = 1_000_000;

// ── Catálogos ────────────────────────────────────────────────────────────

/**
 * Set de semilla (D-08-01): `autos` = las personas actuales (agencia de autos
 * eléctricos) para orgs con alguna corrida previa; `neutro` = set genérico
 * para orgs nuevas. Mismas claves en los dos.
 */
export const LAB_SEED_SETS = ["autos", "neutro"] as const;
export type LabSeedSet = (typeof LAB_SEED_SETS)[number];

export const LAB_HALLAZGO_TIPOS = [
  "alucinacion",
  "fuera_de_kb",
  "debio_escalar",
  "tono",
] as const;
export type LabHallazgoTipo = (typeof LAB_HALLAZGO_TIPOS)[number];

export type LabVeredicto = "verde" | "amarillo" | "rojo";

/** Campos del perfil del agente que un `ajuste` del juez puede tocar. */
export const LAB_AJUSTE_CAMPOS = ["tone", "escalationRules", "instructions"] as const;
export type LabAjusteCampo = (typeof LAB_AJUSTE_CAMPOS)[number];

/** Límites del PUT del perfil (`src/app/api/agent/profile/route.ts`). */
export const LAB_PROFILE_FIELD_MAX: Readonly<Record<LabAjusteCampo, number>> = {
  tone: 500,
  instructions: 8000,
  escalationRules: 4000,
};

export const LAB_SUGGESTION_TARGETS = ["kb", "profile"] as const;
export type LabSuggestionTarget = (typeof LAB_SUGGESTION_TARGETS)[number];

/** Nota del historial cuando la corrida anterior no es comparable (RF-08-17). */
export const LAB_DELTA_NOTE_DIFFERENT_SET = "conjunto distinto";

// ── Piezas guardadas en jsonb ────────────────────────────────────────────

/** Estado inicial del contacto sintético (tarea 03). */
export type LabPersonaSeedData = {
  ficha?: Record<string, string | number | boolean>;
  notes?: string;
  name?: string;
};

/**
 * `lab_persona.expect_ficha` (tarea 04): una regla por clave de la ficha. Se
 * compila a `RegExp` en runtime (`compileExpectFicha`); una regla inválida se
 * descarta sola, sin tumbar el caso.
 */
export type LabExpectFichaRule = { key: string; pattern: string; flags: string };

/**
 * `agent_test_case.persona_snapshot`: la persona TAL COMO corrió. Las
 * corridas pasadas se leen de aquí (aunque la persona se edite o archive).
 */
export type LabPersonaSnapshot = {
  /** `lab_persona.id`; `null` si vino del set en código. */
  id: string | null;
  key: string;
  name: string;
  objetivo: string;
  rasgos: string | null;
  guion: string[];
  criteriosExito: string | null;
  contactName: string;
  phone: string;
  seed: LabPersonaSeedData | null;
  expectFicha: LabExpectFichaRule[];
  /** sha256 de lo que cambia la evaluación (guion, objetivo, rasgos, criterios, semilla). */
  hash: string;
};

/** Entrada del KB en el snapshot: completa, o solo hash si el KB es enorme. */
export type LabKbSnapshotEntry =
  | {
      id: string;
      kind: "qa" | "block";
      question: string | null;
      answer: string | null;
      content: string | null;
      updatedAt: string;
    }
  | { id: string; kind: "qa" | "block"; hash: string; updatedAt: string };

/** `agent_test_run.config_snapshot` (RF-08-15). Nunca secretos. */
export type LabConfigSnapshot = {
  version: 1;
  takenAt: string;
  profile: {
    name: string;
    tone: string | null;
    instructions: string | null;
    escalationRules: string | null;
    greeting: string | null;
  } | null;
  kb: { mode: "full" | "hashed"; entries: LabKbSnapshotEntry[] };
  personas: { id: string | null; key: string; name: string; hash: string }[];
  models: { agent: string | null; judge: string | null };
};

/** Ajuste del perfil que propone el juez (opcional, RF-08-11). */
export type LabAjuste = { campo: LabAjusteCampo; texto: string };

// ── DTOs: personas ───────────────────────────────────────────────────────

export type LabPersonaDto = {
  id: string;
  key: string;
  name: string;
  objetivo: string;
  rasgos: string | null;
  guion: string[];
  criteriosExito: string | null;
  contactName: string;
  /** Solo lectura: lo generó el servidor. */
  phone: string;
  seed: LabPersonaSeedData | null;
  expectFicha: LabExpectFichaRule[];
  active: boolean;
  position: number;
  /** `autos`/`neutro` si nació de la semilla; `null` = personalizada. */
  seedSet: LabSeedSet | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** `GET /api/lab/personas[?archived=1]`. */
export type LabPersonasResponse = {
  personas: LabPersonaDto[];
  /** Hay una corrida `running` (D-08-06: la UI avisa, no bloquea). */
  runInProgress: boolean;
};

/**
 * `POST /api/lab/personas`. La `key` sale del nombre (slug único en la org,
 * con sufijo `_2`, `_3`… si choca, también con archivadas y con las claves de
 * semilla); `phone` lo genera el servidor (si llega en el body, se ignora).
 */
export type LabPersonaCreateInput = {
  name: string;
  objetivo?: string;
  rasgos?: string | null;
  /** 1..8 mensajes de 1..500 caracteres. */
  guion: string[];
  criteriosExito?: string | null;
  /** Default: `[Prueba] <name>`. */
  contactName?: string;
  seed?: LabPersonaSeedData | null;
  expectFicha?: LabExpectFichaRule[];
  active?: boolean;
  position?: number;
};

/** `PATCH /api/lab/personas/[id]`: todo opcional; `key` y `phone` no se editan. */
export type LabPersonaPatchInput = Partial<LabPersonaCreateInput>;

/** `POST /api/lab/personas/restore-defaults` (cuerpo opcional). */
export type LabRestoreDefaultsInput = {
  /** Default: el set de semilla que ya tiene la org (o D-08-01 si no tiene). */
  set?: LabSeedSet;
};

export type LabRestoreDefaultsResponse = {
  set: LabSeedSet;
  /** Claves insertadas, desarchivadas o reescritas por cambio de set. */
  restored: string[];
  personas: LabPersonaDto[];
};

// ── DTOs: corridas ───────────────────────────────────────────────────────

/** `POST /api/lab/runs` (cuerpo opcional; vacío = todas las activas). */
export type LabRunCreateInput = {
  /** 1..10 claves únicas de personas activas. */
  personaKeys?: string[];
};

/** Fila de `GET /api/lab/runs` (sin `config_snapshot`). */
export type LabRunSummaryDto = {
  id: string;
  status: "running" | "done" | "failed";
  score: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Conjunto de la corrida; `null` = corrida anterior a 08. */
  personaKeys: string[] | null;
  /** Solo contra la corrida `done` anterior con el MISMO conjunto. */
  delta: number | null;
  /** Corrida contra la que se calculó `delta`. */
  deltaAgainst: string | null;
  /** `"conjunto distinto"` si hay corrida `done` anterior pero ninguna comparable. */
  deltaNote: typeof LAB_DELTA_NOTE_DIFFERENT_SET | null;
};

/** Marca persistente de sugerencia aplicada (RF-08-14). */
export type LabAppliedDto = {
  target: LabSuggestionTarget;
  /** Solo `profile`. */
  field: LabAjusteCampo | null;
  kbEntryId: string | null;
  appliedText: string;
  appliedAt: string;
};

export type LabHallazgoDto = {
  tipo: LabHallazgoTipo;
  evidencia: string;
  sugerencia?: { pregunta: string; respuesta: string };
  ajuste?: LabAjuste;
  aplicada: LabAppliedDto | null;
};

export type LabRunCaseDto = {
  id: string;
  persona: string;
  /** De `persona_snapshot.name`; respaldo: etiqueta de la semilla o la key. */
  personaLabel: string;
  /** `null` en corridas anteriores a 08. */
  personaSnapshot: LabPersonaSnapshot | null;
  status: "pending" | "running" | "done" | "judge_failed";
  veredicto: LabVeredicto | null;
  hallazgos: LabHallazgoDto[];
  transcript: { role: "cliente" | "agente"; text: string }[];
  conversationId: string | null;
  fichaCheck: unknown;
};

// ── DTOs: tendencia y "qué cambió" ───────────────────────────────────────

/** `GET /api/lab/trends?limit=10`: corridas `done`, más reciente primero. */
export type LabTrendsDto = {
  runs: {
    id: string;
    startedAt: string;
    finishedAt: string | null;
    score: number | null;
    personaKeys: string[] | null;
    hallazgosPorTipo: Record<LabHallazgoTipo, number>;
    /** key → veredicto; `"sin_veredicto"` = judge_failed. */
    veredictos: Record<string, LabVeredicto | "sin_veredicto">;
  }[];
};

export type LabFieldChange = { before: string | null; after: string | null };

/** `GET /api/lab/runs/[id]/diff?against=<runId>`. */
export type LabRunDiffDto =
  | {
      available: false;
      reason: "no_snapshot" | "no_previous";
      runId: string;
      againstId: string | null;
    }
  | {
      available: true;
      runId: string;
      againstId: string;
      profile: Partial<
        Record<"name" | "tone" | "instructions" | "escalationRules" | "greeting", LabFieldChange>
      >;
      kb: {
        added: LabKbSnapshotEntry[];
        removed: LabKbSnapshotEntry[];
        /** `before`/`after` = null si alguno de los dos snapshots es solo hash. */
        edited: { id: string; before: LabKbSnapshotEntry | null; after: LabKbSnapshotEntry | null }[];
      };
      personas: { added: string[]; removed: string[]; edited: string[] };
      models: { agent: LabFieldChange | null; judge: LabFieldChange | null };
    };

// ── DTOs: aplicar sugerencia ─────────────────────────────────────────────

/**
 * `POST /api/lab/suggestions/apply`. El texto es editable antes de guardar
 * (D-08-02): si no llega, se usa el del juez.
 */
export type LabSuggestionApplyInput = {
  testCaseId: string;
  hallazgoIndex: number;
  target: LabSuggestionTarget;
  /** `profile`: default `ajuste.campo` del hallazgo. */
  field?: LabAjusteCampo;
  /** `kb`: default `sugerencia.pregunta` / `sugerencia.respuesta`. */
  pregunta?: string;
  respuesta?: string;
  /** `profile`: default `ajuste.texto`. Se AGREGA al campo, nunca lo reemplaza. */
  text?: string;
};

export type LabSuggestionApplyResultDto = {
  result: "applied" | "alreadyApplied";
  application: LabAppliedDto;
};
