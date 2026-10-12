import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  LAB_AJUSTE_CAMPOS,
  LAB_HALLAZGO_TIPOS,
  LAB_PROFILE_FIELD_MAX,
  type LabAjuste,
  type LabAjusteCampo,
  type LabAppliedDto,
  type LabHallazgoDto,
  type LabSuggestionApplyInput,
  type LabSuggestionApplyResultDto,
} from "@/lib/lab";
import { LabError } from "@/server/lab/errors";

/**
 * 08 — Aplicar una sugerencia del juez (RF-08-12/13, «Contrato 08-0»).
 *
 * En UNA transacción: leer el caso con `scoped()` (404 si no es de la org),
 * validar `hallazgoIndex` (422 `hallazgo_not_found`) y que el hallazgo traiga
 * `sugerencia` (kb) o `ajuste` (profile) (422 `target_mismatch`); luego
 * `INSERT lab_suggestion_application … ON CONFLICT (test_case_id,
 * hallazgo_index) DO NOTHING RETURNING`. Sin fila → devolver la existente
 * con `result: "alreadyApplied"` sin crear nada. Con fila → efecto:
 *   - kb:      `kb_entry` `qa` (pregunta/respuesta del body o del juez).
 *   - profile: AGREGA el texto al campo (`concat_ws('\n', campo, texto)`,
 *              D-08-02); si ya está contenido, no lo duplica; si excede
 *              `LAB_PROFILE_FIELD_MAX` → `LabError("too_long")` y la
 *              transacción revierte (sin registro). Sin perfil → se crea.
 *
 * El INSERT del registro va ANTES del efecto: un segundo POST simultáneo se
 * bloquea en el índice UNIQUE hasta que el primero confirma, y entonces ve
 * la fila y responde `alreadyApplied` (una sola entrada en el KB).
 */

type ApplicationRow = typeof schema.labSuggestionApplication.$inferSelect;

/** Hallazgo tal como lo guardó el juez (jsonb sin tipar: se valida aquí). */
type StoredHallazgo = {
  tipo: (typeof LAB_HALLAZGO_TIPOS)[number];
  evidencia: string;
  sugerencia?: { pregunta: string; respuesta: string };
  ajuste?: LabAjuste;
};

const TIPOS: ReadonlySet<string> = new Set(LAB_HALLAZGO_TIPOS);
const CAMPOS: ReadonlySet<string> = new Set(LAB_AJUSTE_CAMPOS);

/** `agent_test_case.hallazgos` → hallazgos válidos, CONSERVANDO el índice. */
export function readHallazgos(raw: unknown): (StoredHallazgo | null)[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((h): StoredHallazgo | null => {
    if (typeof h !== "object" || h === null) return null;
    const o = h as Record<string, unknown>;
    if (typeof o.tipo !== "string" || !TIPOS.has(o.tipo)) return null;
    const out: StoredHallazgo = {
      tipo: o.tipo as StoredHallazgo["tipo"],
      evidencia: typeof o.evidencia === "string" ? o.evidencia : "",
    };
    const s = o.sugerencia as Record<string, unknown> | undefined;
    if (s && typeof s.pregunta === "string" && typeof s.respuesta === "string") {
      out.sugerencia = { pregunta: s.pregunta, respuesta: s.respuesta };
    }
    const a = o.ajuste as Record<string, unknown> | undefined;
    if (
      a &&
      typeof a.campo === "string" &&
      CAMPOS.has(a.campo) &&
      typeof a.texto === "string" &&
      a.texto.trim()
    ) {
      out.ajuste = { campo: a.campo as LabAjusteCampo, texto: a.texto.trim() };
    }
    return out;
  });
}

/**
 * D-08-02 — Agrega `text` al final del campo (puro). Ya contenido → sin
 * cambio; excede `max` → `LabError("too_long")`.
 */
export function appendToField(
  current: string | null,
  text: string,
  max: number
): { value: string | null; changed: boolean } {
  const t = text.trim();
  if (current && current.includes(t)) return { value: current, changed: false };
  const value = current ? `${current}\n${t}` : t;
  if (value.length > max) {
    throw new LabError(
      "too_long",
      `El campo quedaría con ${value.length} caracteres (máximo ${max}); edita el texto o el perfil`
    );
  }
  return { value, changed: true };
}

export function applicationToDto(row: ApplicationRow): LabAppliedDto {
  return {
    target: row.target,
    field: row.field ?? null,
    kbEntryId: row.kbEntryId ?? null,
    appliedText: row.appliedText,
    appliedAt: row.createdAt.toISOString(),
  };
}

export async function applySuggestion(
  organizationId: string,
  actorUserId: string | null,
  input: LabSuggestionApplyInput
): Promise<LabSuggestionApplyResultDto> {
  return getDb().transaction(async (tx) => {
    const cases = await tx
      .select({ id: schema.agentTestCase.id, hallazgos: schema.agentTestCase.hallazgos })
      .from(schema.agentTestCase)
      .where(
        scoped(
          schema.agentTestCase.organizationId,
          organizationId,
          eq(schema.agentTestCase.id, input.testCaseId)
        )
      )
      .limit(1);
    const testCase = cases[0];
    if (!testCase) throw new LabError("not_found", "Caso no encontrado");

    const hallazgo = readHallazgos(testCase.hallazgos)[input.hallazgoIndex];
    if (!hallazgo) {
      throw new LabError("hallazgo_not_found", "Ese hallazgo no existe en el caso");
    }

    // Qué se aplicaría (texto editable del body o el del juez).
    let effect:
      | { target: "kb"; pregunta: string; respuesta: string }
      | { target: "profile"; field: LabAjusteCampo; text: string };
    if (input.target === "kb") {
      if (!hallazgo.sugerencia) {
        throw new LabError("target_mismatch", "El hallazgo no trae sugerencia para el conocimiento");
      }
      effect = {
        target: "kb",
        pregunta: input.pregunta ?? hallazgo.sugerencia.pregunta,
        respuesta: input.respuesta ?? hallazgo.sugerencia.respuesta,
      };
    } else {
      if (!hallazgo.ajuste) {
        throw new LabError("target_mismatch", "El hallazgo no trae ajuste para el perfil");
      }
      effect = {
        target: "profile",
        field: input.field ?? hallazgo.ajuste.campo,
        text: (input.text ?? hallazgo.ajuste.texto).trim(),
      };
    }

    // Candado de idempotencia: primero el registro.
    const inserted = await tx
      .insert(schema.labSuggestionApplication)
      .values({
        id: newId("labSuggestionApplication"),
        organizationId,
        testCaseId: testCase.id,
        hallazgoIndex: input.hallazgoIndex,
        target: effect.target,
        field: effect.target === "profile" ? effect.field : null,
        appliedText: effect.target === "kb" ? effect.respuesta : effect.text,
        actorUserId,
      })
      .onConflictDoNothing({
        target: [
          schema.labSuggestionApplication.testCaseId,
          schema.labSuggestionApplication.hallazgoIndex,
        ],
      })
      .returning();
    const application = inserted[0];
    if (!application) {
      const existing = await tx
        .select()
        .from(schema.labSuggestionApplication)
        .where(
          scoped(
            schema.labSuggestionApplication.organizationId,
            organizationId,
            eq(schema.labSuggestionApplication.testCaseId, testCase.id),
            eq(schema.labSuggestionApplication.hallazgoIndex, input.hallazgoIndex)
          )
        )
        .limit(1);
      if (!existing[0]) throw new LabError("not_found", "Caso no encontrado");
      return { result: "alreadyApplied", application: applicationToDto(existing[0]) };
    }

    if (effect.target === "kb") {
      const entry = await tx
        .insert(schema.kbEntry)
        .values({
          id: newId("kbEntry"),
          organizationId,
          kind: "qa",
          question: effect.pregunta,
          answer: effect.respuesta,
        })
        .returning({ id: schema.kbEntry.id });
      const updated = await tx
        .update(schema.labSuggestionApplication)
        .set({ kbEntryId: entry[0]!.id })
        .where(eq(schema.labSuggestionApplication.id, application.id))
        .returning();
      return { result: "applied", application: applicationToDto(updated[0] ?? application) };
    }

    const field = effect.field;
    const lockProfile = () =>
      tx
        .select()
        .from(schema.agentProfile)
        .where(scoped(schema.agentProfile.organizationId, organizationId))
        .limit(1)
        .for("update");
    let profile = (await lockProfile())[0];
    if (!profile) {
      await tx
        .insert(schema.agentProfile)
        .values({ id: newId("agentProfile"), organizationId })
        .onConflictDoNothing({ target: schema.agentProfile.organizationId });
      profile = (await lockProfile())[0];
    }
    const next = appendToField(
      profile?.[field] ?? null,
      effect.text,
      LAB_PROFILE_FIELD_MAX[field]
    );
    if (next.changed) {
      await tx
        .update(schema.agentProfile)
        .set({ [field]: next.value, updatedAt: new Date() })
        .where(scoped(schema.agentProfile.organizationId, organizationId));
    }
    return { result: "applied", application: applicationToDto(application) };
  });
}

/**
 * RF-08-14 — Hallazgos del detalle con su marca `aplicada` (o `null`).
 * Una sola consulta para todos los casos de la corrida.
 */
export async function loadApplications(
  organizationId: string,
  caseIds: readonly string[]
): Promise<Map<string, LabAppliedDto>> {
  const out = new Map<string, LabAppliedDto>();
  if (caseIds.length === 0) return out;
  const rows = await getDb()
    .select()
    .from(schema.labSuggestionApplication)
    .where(
      scoped(
        schema.labSuggestionApplication.organizationId,
        organizationId,
        inArray(schema.labSuggestionApplication.testCaseId, [...caseIds])
      )
    );
  for (const r of rows) out.set(`${r.testCaseId}:${r.hallazgoIndex}`, applicationToDto(r));
  return out;
}

/**
 * Hallazgos del caso → DTO con `aplicada`. No se omite ninguno: el índice
 * del arreglo es el `hallazgoIndex` con el que la UI aplica.
 */
export function hallazgosDto(
  caseId: string,
  raw: unknown,
  applied: ReadonlyMap<string, LabAppliedDto>
): LabHallazgoDto[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(
    (h, i) =>
      ({
        ...(typeof h === "object" && h !== null ? h : {}),
        aplicada: applied.get(`${caseId}:${i}`) ?? null,
      }) as LabHallazgoDto
  );
}
