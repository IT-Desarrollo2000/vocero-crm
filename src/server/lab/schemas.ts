import { z } from "zod";
import {
  LAB_AJUSTE_CAMPOS,
  LAB_MAX_PERSONAS_PER_RUN,
  LAB_MAX_SCRIPT_MESSAGES,
  LAB_PERSONA_CRITERIOS_MAX,
  LAB_PERSONA_NAME_MAX,
  LAB_PERSONA_OBJETIVO_MAX,
  LAB_PERSONA_RASGOS_MAX,
  LAB_SCRIPT_MESSAGE_MAX,
  LAB_SEED_SETS,
  LAB_SUGGESTION_TARGETS,
  LAB_TRENDS_DEFAULT_LIMIT,
  LAB_TRENDS_MAX_LIMIT,
} from "@/lib/lab";

/**
 * 08 — Validación de entrada del Laboratorio por cliente («Contrato 08-0»).
 * Inválido → 422 `invalid_body` (`parseBody`). `key` y `phone` NO se aceptan
 * del cliente: el esquema los descarta (los genera el servidor).
 */

const scriptLine = z.string().trim().min(1).max(LAB_SCRIPT_MESSAGE_MAX);

const seedSchema = z
  .object({
    ficha: z
      .record(z.union([z.string().max(500), z.number(), z.boolean()]))
      .optional(),
    notes: z.string().max(2000).optional(),
    name: z.string().trim().max(120).optional(),
  })
  .strip();

const expectFichaRule = z
  .object({
    key: z.string().trim().min(1).max(64),
    pattern: z.string().min(1).max(200),
    flags: z.string().regex(/^[gimsuy]*$/).max(6).default("i"),
  })
  .refine(
    (r) => {
      try {
        new RegExp(r.pattern, r.flags);
        return true;
      } catch {
        return false;
      }
    },
    { message: "patrón inválido" }
  );

const personaFields = {
  name: z.string().trim().min(1).max(LAB_PERSONA_NAME_MAX),
  objetivo: z.string().trim().max(LAB_PERSONA_OBJETIVO_MAX),
  rasgos: z.string().trim().max(LAB_PERSONA_RASGOS_MAX).nullable(),
  guion: z.array(scriptLine).min(1).max(LAB_MAX_SCRIPT_MESSAGES),
  criteriosExito: z.string().trim().max(LAB_PERSONA_CRITERIOS_MAX).nullable(),
  contactName: z.string().trim().min(1).max(120),
  seed: seedSchema.nullable(),
  expectFicha: z.array(expectFichaRule).max(20),
  active: z.boolean(),
  position: z.number().int().min(0).max(10_000),
};

/** `POST /api/lab/personas`. */
export const personaCreateSchema = z
  .object({
    name: personaFields.name,
    guion: personaFields.guion,
    objetivo: personaFields.objetivo.optional(),
    rasgos: personaFields.rasgos.optional(),
    criteriosExito: personaFields.criteriosExito.optional(),
    contactName: personaFields.contactName.optional(),
    seed: personaFields.seed.optional(),
    expectFicha: personaFields.expectFicha.optional(),
    active: personaFields.active.optional(),
    position: personaFields.position.optional(),
  })
  .strip();

/** `PATCH /api/lab/personas/[id]`: al menos un campo. */
export const personaPatchSchema = z
  .object({
    name: personaFields.name.optional(),
    guion: personaFields.guion.optional(),
    objetivo: personaFields.objetivo.optional(),
    rasgos: personaFields.rasgos.optional(),
    criteriosExito: personaFields.criteriosExito.optional(),
    contactName: personaFields.contactName.optional(),
    seed: personaFields.seed.optional(),
    expectFicha: personaFields.expectFicha.optional(),
    active: personaFields.active.optional(),
    position: personaFields.position.optional(),
  })
  .strip()
  .refine((v) => Object.keys(v).length > 0, { message: "sin cambios" });

/** `POST /api/lab/personas/restore-defaults` (cuerpo opcional). */
export const restoreDefaultsSchema = z
  .object({ set: z.enum(LAB_SEED_SETS).optional() })
  .strip();

/** `POST /api/lab/runs` (cuerpo opcional). */
export const runCreateSchema = z
  .object({
    personaKeys: z
      .array(z.string().trim().min(1).max(64))
      .min(1)
      .max(LAB_MAX_PERSONAS_PER_RUN)
      .refine((keys) => new Set(keys).size === keys.length, {
        message: "claves repetidas",
      })
      .optional(),
  })
  .strip();

/** `GET /api/lab/trends?limit=`. */
export function parseTrendsLimit(raw: string | null): number {
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isInteger(n) || n < 1) return LAB_TRENDS_DEFAULT_LIMIT;
  return Math.min(n, LAB_TRENDS_MAX_LIMIT);
}

/** `POST /api/lab/suggestions/apply` (forma 08). */
export const suggestionApplySchema = z
  .object({
    testCaseId: z.string().min(1),
    hallazgoIndex: z.number().int().min(0),
    target: z.enum(LAB_SUGGESTION_TARGETS),
    field: z.enum(LAB_AJUSTE_CAMPOS).optional(),
    pregunta: z.string().trim().min(1).max(500).optional(),
    respuesta: z.string().trim().min(1).max(4000).optional(),
    text: z.string().trim().min(1).max(8000).optional(),
  })
  .strip();

/**
 * Forma anterior a 08 (la UI y los E2E de hoy): `{ caseId, hallazgoIndex,
 * pregunta, respuesta }` → crea la entrada del KB y responde 201 `{ entry }`.
 * Se conserva TAL CUAL (sin idempotencia) hasta que 08-B migre la UI a la
 * forma 08; entonces se retira.
 */
export const legacySuggestionApplySchema = z.object({
  caseId: z.string().min(1),
  hallazgoIndex: z.number().int().min(0),
  pregunta: z.string().trim().min(1).max(500),
  respuesta: z.string().trim().min(1).max(4000),
});
