import type {
  LabSuggestionApplyInput,
  LabSuggestionApplyResultDto,
} from "@/lib/lab";
import { labNotImplemented } from "@/server/lab/errors";

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
 */
export async function applySuggestion(
  organizationId: string,
  actorUserId: string | null,
  input: LabSuggestionApplyInput
): Promise<LabSuggestionApplyResultDto> {
  void organizationId;
  void actorUserId;
  void input;
  return labNotImplemented("applySuggestion");
}
