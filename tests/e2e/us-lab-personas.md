# Guion E2E — 08: Laboratorio por cliente (SIEMPRE contra ai-mock)

> Automatizado en `scripts/e2e-lab-personas.mjs`
> (`node --env-file=.env.e2e scripts/e2e-lab-personas.mjs`, app viva con
> `WA_MOCK_ENABLED=true`, `META_GRAPH_BASE_URL` → wa-mock y
> `OPENROUTER_BASE_URL` → ai-mock; BD aislada con `0019` aplicada).
> Spec: `dev-tasks/08-laboratorio-por-cliente.md` («Contrato 08-0»).
>
> El juez simulado (`src/server/dev/ai-mock.ts`) despacha por la CLAVE de la
> persona (`PERSONA SIMULADA: <key> — …`): solo `fuera_de_kb` sale rojo
> mientras el KB no cubra garantías. Una persona con `[e2e-tono]` en su
> objetivo sale **amarillo** con un hallazgo `tono` + `ajuste` al tono
> ("Cierra cada respuesta ofreciendo ayuda adicional.") y un hallazgo
> `fuera_de_kb` con sugerencia P/R ("¿Atienden en fin de semana?"); con ese
> texto ya en el comportamiento, **verde**.

## Preparación

1. Owner (`e2e@vocero.test`) con sesión; ninguna corrida en curso. Anotar el
   tamaño de `GET /api/dev/wa-mock/outbox` y el `tone` de
   `GET /api/agent/profile`.
2. `GET /api/lab/personas` → 200 `{ personas, runInProgress }`.
   ✅ ≥ 7 personas (siembra perezosa: set neutro si la org es nueva, autos si
   ya tenía corridas); todas con teléfono `52100000` + 5 dígitos.
3. `POST /api/lab/personas/restore-defaults {"set":"autos"}` → 200 `set:
   "autos"`; repetirlo → `restored: []` (idempotente).

## Persona propia

4. `POST /api/lab/personas` con nombre "Tono E2E <s>", objetivo con
   `[e2e-tono]`, guion de 2 mensajes ("Hola, buenas tardes", "¿Abren en fin
   de semana?"), criterios, y además `key`/`phone` en el cuerpo.
   ✅ 201; `key = tono_e2e_<s>` (slug del nombre; la del cuerpo se ignora);
   `phone` sintético generado por el servidor; `seedSet: null`.
   En la UI: "Personas" → "Nueva persona"; el teléfono no es editable.
5. Guion de 9 mensajes → 422 `invalid_body`. `PATCH` con `rasgos` y `key` →
   200, la key no cambia. `PATCH` de un id inexistente → 404.

## Correr solo esa persona

6. `POST /api/lab/runs {"personaKeys":["tono_e2e_<s>"]}` → 202; esperar `done`.
   ✅ `run.personaKeys = [key]`; 1 caso con `personaSnapshot` (nombre, guion
   de 2, teléfono) y `personaLabel` = nombre; el transcript tiene los 2
   mensajes del cliente; veredicto amarillo; hallazgo 0 `tono` con
   `ajuste.campo = "tone"`, hallazgo 1 con `sugerencia`; `aplicada: null`.
7. Camino infeliz: clave inexistente → 422 `unknown_persona`; `[]` → 422;
   11 claves → 422.

## Conjunto distinto

8. Correr `[key, "pide_humano"]`.
   ✅ En el historial, esa corrida trae `delta: null` y
   `deltaNote: "conjunto distinto"` (la UI lo muestra en lugar del delta).
9. Sobre su caso: aplicar el ajuste al perfil con un texto de 600 caracteres
   → 422 `too_long`, y el hallazgo sigue `aplicada: null` (rollback). Índice
   99 → 422 `hallazgo_not_found`; `target: "kb"` sobre el hallazgo de tono →
   422 `target_mismatch`; caso inexistente → 404.

## Aplicar sugerencias (idempotente)

10. Dos `POST /api/lab/suggestions/apply {testCaseId, hallazgoIndex: 1,
    target: "kb"}` A LA VEZ (doble clic).
    ✅ Ambos 200: uno `result: "applied"`, otro `"alreadyApplied"`; el KB
    tiene UNA entrada nueva con esa pregunta. Un tercero → `alreadyApplied`
    con el mismo `kbEntryId`.
11. Aplicar el ajuste (`hallazgoIndex: 0, target: "profile"`).
    ✅ `applied`, `field: "tone"`; el tono del perfil TERMINA con el texto
    (se agrega, no se reemplaza). Repetir → `alreadyApplied`, el texto aparece
    una sola vez.
12. `GET /api/lab/runs/{corrida 1}`: el hallazgo 0 trae `aplicada.target =
    "profile"` y el 1 `aplicada.kbEntryId`. En la UI, tras recargar:
    "Aplicada al perfil" / "Agregada al conocimiento", botones deshabilitados.

## Re-correr, "qué cambió" y tendencia

13. Correr otra vez solo `[key]`.
    ✅ Verde; en el historial `delta: +50` con `deltaAgainst` = corrida 1.
14. `GET /api/lab/runs/{corrida 3}/diff?against={corrida 1}`.
    ✅ `available: true`; `profile.tone` antes/después (el después termina
    con el ajuste); `kb.added` incluye la entrada con su pregunta; personas
    sin cambios. Sin `against` → compara con la corrida 2 (la `done`
    anterior con snapshot) y lista `pide_humano` en `personas.removed`.
    `against` inexistente → 404.
15. `GET /api/lab/trends?limit=5`.
    ✅ La corrida 3 primero (sin hallazgos de tono, persona en verde); la
    corrida 1 con `tono: 1`, `fuera_de_kb: 1` y la persona en amarillo.

## Archivar y restaurar

16. `DELETE /api/lab/personas/{id}` → 200 con `archivedAt`, `active: false`;
    repetir → misma fecha. Ya no sale en la lista; sí con `?archived=1`.
    ✅ `GET /api/lab/runs/{corrida 1}` sigue mostrando su nombre y guion de
    entonces (`personaSnapshot`). Correrla → 422 `unknown_persona`.
17. Archivar `errores_modismos` y `POST /api/lab/personas/restore-defaults`
    sin cuerpo → `set: "autos"`, `restored` la incluye, vuelve activa; la
    personalizada archivada NO revive.

## Sandbox y permisos

18. ✅ El outbox del wa-mock no creció en todo el guion; las conversaciones
    de prueba no aparecen en la Bandeja.
19. Vendedor dado de alta por `POST /api/settings/team`: 403 `forbidden` en
    `GET/POST /api/lab/personas`, `PATCH/DELETE /api/lab/personas/[id]`,
    `POST /api/lab/personas/restore-defaults`, `GET/POST /api/lab/runs`,
    `GET/DELETE /api/lab/runs/[id]`, `GET /api/lab/runs/[id]/diff`,
    `GET /api/lab/trends` y `POST /api/lab/suggestions/apply`; nada cambió.

## Limpieza

20. Restaurar el tono del perfil (`PUT /api/agent/profile`) y borrar la
    entrada de KB del guion (`DELETE /api/kb/{id}`), para no alterar el
    resultado de us4 en la BD compartida.
