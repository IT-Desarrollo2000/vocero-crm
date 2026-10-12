# 08 — Laboratorio por cliente

> Estado: contrato 08-0 fijado (migración `0019`); pendientes 08-A (servidor) y 08-B (UI) · Prioridad: media-baja · Esfuerzo: L · Migración: sí · Bandera: no aplica (el Laboratorio es núcleo; solo Propietario)

> **Manda la sección [«Contrato 08-0»](#contrato-08-0)** (al final) sobre la
> especificación y el plan técnico donde difieran: nombres de columnas y
> campos (`name`/`objetivo`/`rasgos`/`guion`/`criteriosExito`, no
> `label`/`objective`/`traits`/`script`), rutas (`restore-defaults`,
> `?against=`), cuerpos (`personaKeys`, `testCaseId` + `target`), sin siembra
> SQL, `persona_keys` en vez de `persona_set`, y que hoy son **7** personas.

## 1. Especificación

### Problema / objetivo

Las 7 personas del Laboratorio están **fijas en código**
(`src/server/lab/personas.ts`). En `c1c79c4` se reescribieron para una
agencia de autos eléctricos (antes eran de ferretería): en un producto que la
agencia despliega para varios clientes, cada cliente nuevo obliga a tocar
código, hacer commit y desplegar solo para cambiar los guiones de prueba.
Además:

- el juez recibe solo la clave de la persona (`PERSONA SIMULADA: ${key}`,
  `src/server/ai/prompts.ts:102`): no sabe qué se esperaba de ella;
- el historial solo muestra score y delta (`src/app/api/lab/runs/route.ts:11-38`),
  sin explicar **qué cambió** entre corridas ni cómo evolucionan los hallazgos;
- aplicar una sugerencia solo crea una entrada `qa` en el KB
  (`src/app/api/lab/suggestions/apply/route.ts:40-50`), ignora `hallazgoIndex`
  (`:17`), no marca la sugerencia como aplicada (se puede duplicar; el
  "✓ agregado" es estado local del navegador,
  `src/components/lab/lab-client.tsx:532,559-561`) y no hay forma de corregir
  **tono** o **reglas de escalamiento** del perfil del agente.

Objetivo: que el Propietario adapte el Laboratorio a su negocio desde la UI y
pueda entender y cerrar el ciclo "evaluar → corregir → re-evaluar" sin código,
manteniendo el sandbox intacto.

### Alcance (incluye) / Fuera de alcance

**Incluye**
- (a) Personas editables por organización (`lab_persona`, nuevo): nombre,
  objetivo, rasgos, guion (mensaje inicial + siguientes), criterios de éxito,
  activa, orden. Semilla de 7 personas conservando sus claves. Elegir qué
  personas corre una evaluación.
- (b) Tendencia de hallazgos por `tipo` (y veredicto por persona) entre corridas.
- (c) Sugerencias aplicables también al **perfil del agente** (tono, reglas de
  escalamiento, instrucciones), con marca de "aplicada" persistente e
  idempotente usando `hallazgoIndex`.
- (d) Snapshot de perfil + KB + personas por corrida, y vista "Qué cambió"
  entre dos corridas para explicar el delta.

**Fuera de alcance**
- Cliente simulado con LLM (personas generativas). FR-030 exige guiones fijos
  sin LLM del lado del cliente (`specs/001-vocero-core/spec.md:440-443`) por
  determinismo y costo; se mantiene.
- Importar/exportar personas entre instancias (archivo JSON) — posible fase 2.
- Gráficas elaboradas: la tendencia se muestra como tabla compacta con mini
  barras CSS (FR-033 decía "sin gráficas en v1").
- Que el Vendedor vea o use el Laboratorio.
- Correr evaluaciones programadas/automáticas.

### Historias de usuario

- Como **Propietario** quiero escribir los guiones de prueba con los productos y
  objeciones de MI negocio, para evaluar al agente con casos reales sin pedirle
  cambios de código a la agencia.
- Como **Propietario** quiero decir qué se considera éxito en cada persona (p. ej.
  "debe escalar", "no debe dar precio sin enganche"), para que el juez evalúe
  contra mis criterios.
- Como **Propietario** quiero correr solo algunas personas, para validar rápido
  un cambio puntual.
- Como **Propietario** quiero ver si los hallazgos de "alucinación" o "tono"
  bajan corrida tras corrida, para saber si mis ajustes funcionan.
- Como **Propietario** quiero aplicar una sugerencia de tono o de escalamiento
  directamente al perfil del agente y ver que quedó aplicada, para no copiar y
  pegar ni aplicarla dos veces.
- Como **Propietario** quiero ver qué cambió en el perfil y el conocimiento entre
  dos corridas, para entender por qué subió o bajó el score.

### Requisitos funcionales

- **RF-08-01** Tabla `lab_persona` por organización con: `key` (slug estable,
  único por org), `label`, `objective`, `traits`, `script` (1–8 mensajes; el
  primero es el "mensaje inicial"; cada uno 1–500 caracteres),
  `success_criteria` (≤ 1000), `active`, `position`, `archived_at`.
- **RF-08-02** Semilla: cada organización sin personas recibe 7 personas con
  las claves fijas (`comprador_decidido`, `pregunton_precios`, `cliente_enojado`,
  `fuera_de_kb`, `pide_humano`, `errores_modismos`, `cliente_que_regresa`); el **contenido** de los
  guiones depende de D-08-01 (orgs existentes conservan los guiones actuales de
  `personas.ts`). La semilla es idempotente
  (`ON CONFLICT (organization_id, key) DO NOTHING`) y corre (1) en la migración
  para orgs existentes y (2) perezosamente al primer `GET /api/lab/personas` o
  `POST /api/lab/runs` para orgs nuevas.
- **RF-08-03** "Restaurar predeterminadas": re-inserta las de semilla que falten
  o estén archivadas sin tocar las personalizadas (confirmación en UI).
- **RF-08-04** El teléfono/identidad sintética del contacto de prueba **lo
  genera el servidor** (no es editable): `52100000` + secuencia por persona, o
  la de semilla para las 6 originales. Jamás un número capturado por el usuario.
- **RF-08-05** Borrar una persona = archivarla (`archived_at`); las corridas
  pasadas siguen legibles porque cada caso guarda `persona_snapshot`.
- **RF-08-06** `POST /api/lab/runs` acepta `{ personaIds?: string[] }`
  (default: todas las activas; mínimo 1; máximo 10). Sin personas activas →
  422 `no_personas`.
- **RF-08-07** El runner usa las personas de BD (no `PERSONAS`): crea un caso por
  persona elegida con `persona` = key y `persona_snapshot` = {label, objective,
  traits, script, successCriteria}; el total de progreso = nº de casos (hoy
  `failRun` usa `PERSONAS.length`, `src/server/lab/runner.ts:406`).
- **RF-08-08** El juez recibe en el prompt: key, nombre, objetivo, rasgos y
  criterios de éxito de la persona, conservando la línea
  `PERSONA SIMULADA: <key> — <nombre>` (el ai-mock despacha por la key,
  `src/server/dev/ai-mock.ts:26`).
- **RF-08-09** Sandbox intacto: toda persona (semilla o personalizada) corre en
  conversación `is_test=true` con contacto archivado; el sender lanza si algo
  intenta salir (FR-031). Las citas que agende el agente en la corrida son
  `is_test` y se borran con la corrida (`src/server/lab/delete.ts:82-103`).
- **RF-08-10** Tendencia: `GET /api/lab/trends?limit=10` devuelve, por corrida
  `done` (más reciente primero): fecha, score, conteo de hallazgos por `tipo`
  (`alucinacion`, `fuera_de_kb`, `debio_escalar`, `tono`) y veredicto por key de
  persona.
- **RF-08-11** El veredicto del juez admite, además de `sugerencia` (P/R para el
  KB, sin cambios), un campo opcional `ajuste: { campo: "tone" |
  "escalationRules" | "instructions", texto }`. Un veredicto sin `ajuste` sigue
  siendo válido (compatibilidad con corridas viejas y con el mock).
- **RF-08-12** Aplicar sugerencia: `POST /api/lab/suggestions/apply` con
  `{ caseId, hallazgoIndex, destino: "kb" | "perfil", … }`. Valida que
  `hallazgos[hallazgoIndex]` exista y tenga la sugerencia/ajuste del destino
  pedido (si no, 422). `kb` → crea `kb_entry` `qa`; `perfil` → **agrega** el
  texto (editable antes de guardar) al campo indicado de `agent_profile`
  respetando los límites del PUT del perfil (`tone` 500, `instructions` 8000,
  `escalationRules` 4000, `src/app/api/agent/profile/route.ts:31-38`); si
  excede → 422.
- **RF-08-13** Idempotencia: una sugerencia (`caseId`, `hallazgoIndex`) se
  aplica **una sola vez**. El registro (`lab_suggestion_application`, nuevo)
  y el efecto (KB o perfil) se escriben en la **misma transacción**; un segundo
  POST devuelve 200 con `alreadyApplied: true` y el registro existente, sin
  crear nada.
- **RF-08-14** `GET /api/lab/runs/[id]` devuelve por hallazgo `aplicada`
  (`null` o `{destino, appliedAt, kbEntryId?, campo?}`); la UI lo muestra al
  recargar.
- **RF-08-15** Al crear una corrida se guarda `config_snapshot` (jsonb) en
  `agent_test_run`: perfil (name, tone, instructions, escalationRules,
  greeting), entradas KB (id, kind, question, answer, content, updatedAt),
  personas usadas (id, key, label, hash del guion+criterios), modelo del agente
  y del juez (`OPENROUTER_MODEL`, `OPENROUTER_JUDGE_MODEL`). Nunca secretos.
- **RF-08-16** `GET /api/lab/runs/[id]/diff?vs=<runId>` (default: la corrida
  `done` anterior) devuelve: campos del perfil cambiados (antes/después), KB
  agregadas/eliminadas/editadas, personas agregadas/quitadas/editadas, cambio de
  modelo. Corridas sin snapshot (anteriores a 08) → `{ available: false }`.
- **RF-08-17** El delta del historial solo se calcula contra la corrida `done`
  anterior **con el mismo conjunto de personas** (mismas keys y mismo hash de
  guion); si no hay, `delta: null` y `deltaNote: "conjunto distinto"`.
- **RF-08-18** Todo `/api/lab/*` y `/lab` son solo Propietario (403 / redirect
  para Vendedor) y toda query va por `scoped()`.

### Permisos por rol

| Superficie | Propietario ver | Propietario editar | Vendedor ver | Vendedor editar |
|---|---|---|---|---|
| Laboratorio (`/lab`, corridas, reporte, historial, tendencia, "qué cambió") | sí | sí (correr, borrar) | no | no |
| Personas del Laboratorio | sí | sí | no | no |
| Aplicar sugerencias (KB y perfil del agente) | sí | sí | no | no |
| Perfil del agente / KB (efecto de aplicar) | sí | sí | no | no |

El guard de rol es **(nuevo)** y lo aporta la tarea 00. Hoy `withAuth`
(`src/lib/api.ts:17-37`) no distingue roles; `session.role` ya existe
(`src/lib/auth/session.ts:5-9`; `owner` al registrarse,
`src/server/auth/on-signup.ts:43`; Vendedor = `member`). El ítem de menú
"Laboratorio" (`src/components/app-nav.tsx:40`) se oculta al Vendedor.

### Criterios de aceptación

1. **Dado** una instancia existente con corridas, **cuando** se aplica la
   migración y abre el Laboratorio, **entonces** su organización tiene 7 personas activas con las
   mismas keys y guiones que `personas.ts` hoy (set `autos`), y una corrida nueva da el mismo
   resultado que antes con ai-mock (6 verdes + 1 rojo ≈ 86; `tests/e2e/us4-lab.md:17` aún dice 83, de cuando eran 6).
2. **Dado** el Propietario en `/lab`, **cuando** crea la persona "Pregunta por
   garantía extendida" con 3 mensajes y criterio "no inventar plazos", **entonces**
   aparece en la lista, se puede elegir para correr y el juez recibe su objetivo
   y criterios.
3. **Dado** 7 personas activas, **cuando** corre una evaluación eligiendo 2,
   **entonces** se crean 2 casos, el progreso es n/2 y el historial muestra
   "conjunto distinto" en lugar de delta.
4. **Dado** una persona archivada que se usó en una corrida pasada, **cuando** se
   abre esa corrida, **entonces** se ve con su nombre y guion de entonces.
5. **Dado** un hallazgo `tono` con `ajuste` sobre `tone`, **cuando** el
   Propietario lo edita y lo aplica, **entonces** el tono del perfil termina con
   ese texto agregado, el hallazgo muestra "Aplicada al perfil" tras recargar y
   un segundo POST no vuelve a agregarlo.
6. **Dado** dos clics simultáneos en "Agregar al conocimiento" del mismo
   hallazgo, **cuando** llegan ambos POST, **entonces** existe una sola entrada
   nueva en el KB.
7. **Dado** dos corridas donde entre medio se agregó una entrada al KB y se
   cambió el tono, **cuando** el Propietario abre "Qué cambió", **entonces** ve
   "+1 entrada de conocimiento" con su pregunta y el tono antes/después.
8. **Dado** 5 corridas, **cuando** abre la tendencia, **entonces** ve por corrida
   los conteos de hallazgos por tipo y el veredicto de cada persona.
9. **Dado** cualquier corrida con personas personalizadas, **cuando** termina,
   **entonces** `GET /api/dev/wa-mock/outbox` sigue vacío y sus conversaciones no
   aparecen en la Bandeja.
10. **Dado** un Vendedor, **cuando** llama `/api/lab/personas` o
    `/api/lab/runs`, **entonces** recibe 403.

### Casos borde y degradación

- **Sin personas activas** → botón "Correr evaluación" deshabilitado con
  explicación; API 422.
- **Persona editada mientras corre una evaluación**: el runner usa el
  `persona_snapshot` del caso, no la fila viva.
- **Perfil o KB editados a mitad de corrida**: el agente lee perfil y KB
  **vivos** en cada turno (`src/server/ai/pipeline.ts:115-116,153-156`, antes de
  `buildAgentSystemPrompt` en `:167`), mientras juez y diff usan el snapshot.
  Se acepta la divergencia (la corrida dura minutos) y la UI avisa "hay una
  evaluación en curso" en `/agent`; bloquear la edición queda como alternativa
  (D-08-06).
- **Key de persona nueva que choca con una archivada** (el UNIQUE
  `(organization_id, key)` sigue vigente): `createPersona` agrega sufijo
  numérico (`garantia_extendida_2`).
- **Muchas personas / guiones largos** vs timeout global (`LAB_RUN_TIMEOUT_MS`,
  10 min por defecto, `src/server/lab/runner.ts:27,37-46`): tope de 10 personas
  × 8 mensajes; la UI estima duración y advierte.
- **Juez devuelve `ajuste` con `campo` inválido** → se descarta solo el ajuste
  (Zod `catch`), el hallazgo se conserva; no tumba el caso.
- **Juez falla** → caso `judge_failed` como hoy (`src/server/lab/judge.ts:50-58`),
  excluido del score.
- **Aplicar al perfil cuando el texto ya está contenido** en el campo → se marca
  aplicada sin duplicar el texto.
- **Aplicar tras borrar la corrida**: el caso ya no existe → 404 (los registros
  de aplicación caen en cascada; la entrada del KB / el texto del perfil se
  quedan, son del negocio).
- **KB muy grande en snapshot**: se guarda completo (es lo que vio el agente);
  si supera ~1 MB se guarda solo id + hash por entrada y el diff degrada a
  "editada" sin texto.
- **Corridas anteriores a 08** (sin snapshot, sin `persona_snapshot`): se
  muestran con `PERSONA_LABELS` de semilla como respaldo; diff "no disponible".
- **Persona con key `fuera_de_kb` editada**: el ai-mock seguirá tratándola por
  key; en producción el juez real evalúa con los criterios nuevos.

## 2. Plan técnico

### Estado actual (qué existe hoy, con rutas:línea)

- Personas fijas: tipo `Persona` y array `PERSONAS` (**7**) en
  `src/server/lab/personas.ts`, cada una con `phone` sintético
  (`5210000000001..7`), `contactName`, `script`, `seed` opcional
  (ficha/notas/nombre del contacto, tarea 03) y `expectFicha` opcional
  (`Record<clave, RegExp>`, tarea 04); la 7.ª es `cliente_que_regresa` (con
  semilla). `PERSONA_LABELS` al final del archivo. `resetTestContact`
  (`src/server/bot/ficha.ts`) reinicia el contacto sintético con la semilla;
  desde 08-0 su guarda es por prefijo (`isSyntheticLabPhone`).
  (Los números de línea de esta sección son de antes de 03/04/10: orientativos.)
- Runner: inserta un caso por `PERSONAS` `src/server/lab/runner.ts:67-75`;
  arma `kbText` y `behaviorText` `:184-205`; busca la persona por key `:213`;
  conversación `is_test` `:291-297`; contacto sintético archivado por teléfono
  `:356-394`; `failRun` con `PERSONAS.length` `:396-407`; lock UNIQUE parcial
  `schema.ts:654-656`; timeout cooperativo `:86-131`.
- Juez: schema `Verdict` con `sugerencia {pregunta,respuesta}`
  `src/server/lab/judge.ts:6-17`; `judgeCase` `:30-59`; `computeScore` `:65-78`.
- Prompt del juez: `buildJudgePrompt` `src/server/ai/prompts.ts:81-110` (solo la
  key de persona en `:102`; formato de salida `:90-92`).
- ai-mock del juez: dispatch por `fuera_de_kb` en el prompt y por "garant|devoluc"
  en el KB `src/server/dev/ai-mock.ts:20-44`.
- Tablas: `agent_test_run` `src/lib/db/schema.ts:637-659` (sin snapshot);
  `agent_test_case` `:858-883` (`persona` text, `hallazgos` jsonb).
- API: `GET/POST /api/lab/runs` `src/app/api/lab/runs/route.ts:11-61` (delta vs
  corrida `done` anterior `:20-35`); `GET/DELETE /api/lab/runs/[id]`
  `src/app/api/lab/runs/[id]/route.ts:12-77` (label por `PERSONA_LABELS` `:53`);
  `POST /api/lab/suggestions/apply` `src/app/api/lab/suggestions/apply/route.ts:15-51`.
- Borrado de corridas: `src/server/lab/delete.ts:24-107`.
- Limpieza de huérfanas al arranque: `src/instrumentation-node.ts:8-29`.
- Perfil del agente: tabla `schema.ts:571-588`; API `src/app/api/agent/profile/route.ts:9-52`.
- UI: `src/components/lab/lab-client.tsx` — tipos `:25-56`, `HistoryList`
  `:248`, `HistoryRow` (delta) `:281-340`, `Report` `:401`, `CaseCard` `:454`,
  `HallazgoCard` (aplicar, estado local) `:518-602`.
- Pruebas existentes: `tests/unit/judge.test.ts`, `lab-sandbox.test.ts`,
  `lab-timeout.test.ts`, `lab-delete.test.ts`; E2E `labChecks` en
  `scripts/e2e-selftest.mjs:2104+` y guion `tests/e2e/us4-lab.md`.

### Cambios de datos

Migración **`0019_laboratorio_por_cliente`** (numeración oficial de
`dev-tasks/README.md`). Aditiva y re-ejecutable. **Lo que sigue es la
propuesta original; el esquema real está en «Contrato 08-0».**

1. `lab_persona` **(nuevo)**, prefijo `lpe`:
   - `id text PK`, `organization_id text NOT NULL → organization ON DELETE CASCADE`
   - `key text NOT NULL`, `label text NOT NULL`, `objective text NOT NULL DEFAULT ''`,
     `traits text NULL`, `script jsonb NOT NULL` (string[]),
     `success_criteria text NULL`, `phone text NOT NULL` (sintético),
     `active boolean NOT NULL DEFAULT true`, `position integer NOT NULL DEFAULT 0`,
     `is_seed boolean NOT NULL DEFAULT false`, `archived_at timestamp NULL`,
     `created_at`, `updated_at`
   - `UNIQUE (organization_id, key)`, `INDEX (organization_id, position)`
   - Semilla SQL en la misma migración: `INSERT INTO lab_persona … SELECT … FROM
     organization ON CONFLICT (organization_id, key) DO NOTHING` con los 6
     guiones actuales (re-ejecutable).
2. `agent_test_run` (columnas nuevas):
   - `config_snapshot jsonb NULL`
   - `persona_set text NULL` (hash ordenado de keys + hash de guiones; para el
     delta comparable)
3. `agent_test_case` (columnas nuevas):
   - `persona_id text NULL → lab_persona ON DELETE SET NULL`
   - `persona_snapshot jsonb NULL`
4. `lab_suggestion_application` **(nuevo)**, prefijo `lsa`:
   - `id text PK`, `organization_id text NOT NULL → organization ON DELETE CASCADE`
   - `case_id text NOT NULL → agent_test_case ON DELETE CASCADE`
   - `hallazgo_index integer NOT NULL`, `destino text NOT NULL` ∈ `kb|perfil`
   - `kb_entry_id text NULL → kb_entry ON DELETE SET NULL`, `campo text NULL`,
     `applied_text text NOT NULL`, `applied_at timestamp NOT NULL DEFAULT now()`
   - `UNIQUE (case_id, hallazgo_index)`
5. `src/lib/db/ids.ts`: prefijos `labPersona: "lpe"`, `labSuggestionApplication: "lsa"`.

La tendencia (b) **no necesita migración**: se agrega sobre
`agent_test_case.hallazgos` (`jsonb_array_elements`) agrupando por `run_id`.

### Servidor

- `src/server/lab/personas.ts`: `PERSONAS` pasa a `SEED_PERSONAS` (fuente de la
  semilla y del respaldo de labels); nuevo `src/server/lab/persona-store.ts`
  **(nuevo)** con `ensureSeedPersonas(orgId)`, `listPersonas`, `createPersona`
  (genera key slug única y teléfono sintético), `updatePersona`,
  `archivePersona`, `restoreSeeds`; Zod para guion (1–8 × 1–500) y criterios.
- `src/server/lab/runner.ts`:
  - `startRun(orgId, personaIds?)`: `ensureSeedPersonas`, resolver personas
    activas/elegidas (422 tipado si 0), construir `config_snapshot` y
    `persona_set` **antes** de insertar el run (reutilizando la lectura de
    perfil/KB que hoy está en `:184-205`, movida a un helper
    `loadAgentConfig(orgId)`), insertar casos con `persona_id` +
    `persona_snapshot`.
  - `runAllCases`: la persona sale del `persona_snapshot` del caso (no de
    `PERSONAS.find`, `:213`); `behaviorText`/`kbText` del snapshot para que juez
    y diff vean lo mismo.
  - `failRun`: total = nº de casos del run (no `PERSONAS.length`, `:406`).
  - `upsertTestContact` usa `persona.phone` del snapshot (sin cambios de lógica).
- `src/server/lab/judge.ts`: `Verdict` con `ajuste` opcional
  (`z.object({campo: z.enum([...]), texto: z.string()}).optional().catch(undefined)`);
  `judgeCase` recibe la persona completa (label, objective, traits,
  successCriteria).
- `src/server/ai/prompts.ts` `buildJudgePrompt`: línea
  `PERSONA SIMULADA: ${key} — ${label}` + bloques `OBJETIVO`, `RASGOS`,
  `CRITERIOS DE ÉXITO`; en el system, explicar cuándo emitir `ajuste` (hallazgos
  `tono` y `debio_escalar`) y el esquema extendido (`:90-92`).
- `src/server/lab/suggestions.ts` **(nuevo)**: `applySuggestion(orgId, input)` en
  transacción: leer caso `scoped`, validar índice/destino, `INSERT
  lab_suggestion_application … ON CONFLICT (case_id, hallazgo_index) DO NOTHING
  RETURNING`; si no insertó → devolver existente (`alreadyApplied`); si insertó →
  crear `kb_entry` o `UPDATE agent_profile SET <campo> = concat_ws('\n', campo,
  texto)` con chequeo de longitud (si excede, lanza error tipado y la
  transacción revierte). Errores de dominio tipados (patrón `TemplateError`),
  nunca 500 genérico (`withAuth` convierte excepciones en 500, `src/lib/api.ts:30-35`).
- `src/server/lab/history.ts` **(nuevo)**: `runTrends(orgId, limit)` y
  `diffRuns(orgId, runId, vsId?)` (diff puro testeable sobre dos snapshots).
- Rutas:
  - `GET/POST /api/lab/personas`, `PATCH/DELETE /api/lab/personas/[id]`,
    `POST /api/lab/personas/restore` **(nuevas)**.
  - `POST /api/lab/runs`: body opcional `{ personaIds }`; `GET` calcula delta
    con `persona_set` (RF-08-17).
  - `GET /api/lab/runs/[id]`: `personaLabel` desde `persona_snapshot` (respaldo
    `PERSONA_LABELS`), y `aplicada` por hallazgo (join a
    `lab_suggestion_application`).
  - `GET /api/lab/runs/[id]/diff` y `GET /api/lab/trends` **(nuevas)**.
  - `POST /api/lab/suggestions/apply`: delega en `applySuggestion`; acepta
    `destino` + `campo`/`texto` además de `pregunta`/`respuesta`.
  - Todas con guard de Propietario (00) y `scoped()`.
- `src/server/dev/ai-mock.ts`: si el prompt del juez contiene el marcador
  `[e2e-tono]` (lo pone solo el E2E en el objetivo de una persona creada),
  devolver `amarillo` con hallazgo `tono` + `ajuste {campo:"tone", texto:"…"}`,
  y `verde` si el comportamiento ya contiene ese texto. No altera el resultado
  de las 6 personas de semilla (us4 sigue en ≈ 83 → 100).

### UI

- `src/components/lab/lab-client.tsx` (o dividir en `src/components/lab/*`):
  - Pestaña/sección **"Personas"**: lista ordenable con switch "activa", editar
    (nombre, objetivo, rasgos, mensaje inicial + siguientes, criterios),
    crear, archivar, "Restaurar predeterminadas". Aviso fijo: "Sandbox: estas
    conversaciones nunca se envían por WhatsApp".
  - Botón "Correr evaluación" abre selector de personas (todas marcadas por
    defecto) con estimación de duración.
  - `HistoryRow` (`:281-340`): delta o etiqueta "conjunto distinto"; enlace
    "Qué cambió".
  - Panel **"Qué cambió"**: perfil antes/después por campo, KB +/−/editadas,
    personas, modelo.
  - Bloque **"Tendencia"**: tabla corridas × tipo de hallazgo con mini barras y
    fila de veredictos por persona (puntos verde/amarillo/rojo).
  - `HallazgoCard` (`:518-602`): botón "Agregar al conocimiento" (si hay
    `sugerencia`) y "Aplicar al perfil (Tono/Escalamiento/Instrucciones)" (si hay
    `ajuste`), ambos editables antes de guardar; estado "Aplicada ✓" desde el
    servidor (`aplicada`), botones deshabilitados si ya se aplicó.
- `src/components/app-nav.tsx:39-40`: ocultar Agente y Laboratorio al Vendedor
  (lo hace 00; aquí solo se verifica).

### Tareas ordenadas

- [x] T-08-00 Contrato 08-0: DTOs (`src/lib/lab.ts`), validación
      (`src/server/lab/schemas.ts`), errores (`src/server/lab/errors.ts`),
      firmas (`persona-store.ts`, `history.ts`, `suggestions.ts`), rutas con
      guarda definitiva y cuerpo 501, `ROUTE_POLICY`, guarda por prefijo de
      `resetTestContact`. Ver «Contrato 08-0» abajo.
- [x] T-08-01 Schema + migración `0019` (`lab_persona` SIN semilla SQL — va en
      código —, columnas en `agent_test_run`/`agent_test_case`,
      `lab_suggestion_application`) + prefijos en `ids.ts`.
- [ ] T-08-02 `persona-store.ts` + rutas `/api/lab/personas*` (Propietario).
- [ ] T-08-03 Runner: personas de BD, `persona_snapshot`, selección, total de
      casos en `failRun`, `config_snapshot` + `persona_set`.
- [ ] T-08-04 Juez: prompt con objetivo/criterios conservando la key; `ajuste`
      opcional en `Verdict`; ai-mock con marcador `[e2e-tono]`.
- [ ] T-08-05 `suggestions.ts` + `apply` idempotente (KB y perfil) + `aplicada`
      en `GET /api/lab/runs/[id]`.
- [ ] T-08-06 `history.ts`: tendencia y diff; rutas `trends` y `diff`; delta
      comparable en `GET /api/lab/runs`.
- [x] T-08-07 UI Personas + selector de corrida.
- [x] T-08-08 UI tendencia, "Qué cambió", `HallazgoCard` con perfil y estado
      persistente.
- [x] T-08-09 Unit tests (UI: `tests/unit/lab-ui.test.ts`; los de servidor
      van con 08-A).
- [ ] T-08-10 E2E: extender `labChecks` o nuevo `scripts/e2e-lab-personas.mjs` +
      guion `tests/e2e/us-lab-por-cliente.md`; actualizar `tests/e2e/us4-lab.md`.
- [ ] T-08-11 Actualizar `specs/001-vocero-core/spec.md` FR-030/FR-032/FR-033
      (personas por organización, juez con criterios, sugerencias al perfil) y la
      guía de "Mapa del código" en `CLAUDE.md` (personas ya no se cambian en
      `src/server/lab/personas.ts`).

### Pruebas

**Unit (`tests/unit/`)**
- `lab-personas.test.ts`: validación de guion (1–8, longitudes), key slug única,
  teléfono generado por servidor (no aceptado del body), archivado, semilla
  idempotente (dos `ensureSeedPersonas` → 6 filas).
- `judge.test.ts` (extender): `Verdict` con y sin `ajuste`; `ajuste` con campo
  inválido se descarta sin invalidar el veredicto; el prompt contiene
  `PERSONA SIMULADA: fuera_de_kb —` y los criterios.
- `lab-suggestions.test.ts`: aplicar KB dos veces → 1 entrada; aplicar perfil →
  append; texto ya contenido → no duplica; excede límite → error y sin registro;
  índice inexistente → 422; caso de otra org → 404 (`scoped`).
- `lab-diff.test.ts`: diff de perfil/KB/personas; snapshot ausente →
  `available:false`.
- `lab-delta.test.ts`: delta solo contra mismo `persona_set`.
- `lab-sandbox.test.ts` (extender): persona personalizada → conversación
  `is_test`, sender lanza ante envío real.
- `lab-timeout.test.ts` (extender): `failRun` reporta total = casos del run.

**E2E** (BD aislada `.env.e2e`, `WA_MOCK_ENABLED=true`, `OPENROUTER_BASE_URL` →
ai-mock), `scripts/e2e-lab-personas.mjs` + `tests/e2e/us-lab-por-cliente.md`:
1. `GET /api/lab/personas` → 6 de semilla con sus keys.
2. Corrida completa → ≈ 83 como hoy; `DELETE` outbox antes y outbox vacío
   después.
3. Crear persona con objetivo `[e2e-tono]`, desactivar 5 de semilla, correr solo
   esa + `fuera_de_kb` → 2 casos; historial con "conjunto distinto".
4. Aplicar el `ajuste` de tono al perfil → `GET /api/agent/profile` contiene el
   texto; repetir POST → `alreadyApplied:true`, texto no duplicado; recargar UI
   (Playwright) → "Aplicada ✓".
5. Aplicar sugerencia KB de `fuera_de_kb` dos veces en paralelo → 1 entrada nueva.
6. Re-correr el mismo conjunto → mejora de score con delta numérico; "Qué
   cambió" lista +1 KB y el tono antes/después; tendencia muestra menos
   hallazgos `tono`/`fuera_de_kb`.
7. Archivar la persona creada → la corrida vieja la muestra con su nombre.
8. **Camino infeliz**: `POST /api/lab/runs` con `personaIds: []` o todas inactivas
   → 422; apply con `hallazgoIndex` fuera de rango → 422; guion de 9 mensajes →
   422; Vendedor → 403 en `/api/lab/*` (cuando 00 exista).

### Riesgos y decisiones abiertas

- **D-08-01 Semilla por defecto para clientes nuevos**: las 6 actuales son de
  autos eléctricos (Futura). Opciones: (a) semilla = las actuales para todos
  (simple, pero un cliente nuevo arranca con autos), (b) migración siembra las
  actuales en las orgs existentes y las orgs nuevas reciben el set genérico
  previo a `c1c79c4` (ferretería, `git show c1c79c4^:src/server/lab/personas.ts`)
  o un set neutro nuevo, (c) orgs nuevas sin personas + asistente de "crear
  desde plantilla". Propuesta: (b) con set neutro.
- **D-08-02 Aplicar al perfil = agregar (append)** con edición previa
  (propuesta) vs reemplazar el campo completo. Append es más seguro pero puede
  crecer; ¿mostrar el campo completo para editar antes de guardar?
- **D-08-03 Límites**: máx. 10 personas por corrida y 8 mensajes por guion con
  timeout de 10 min. ¿Subir `LAB_RUN_TIMEOUT_MS` por defecto o escalarlo con el
  nº de personas?
- **D-08-04 Snapshot completo del KB** en cada corrida (propuesta, máx. 50
  corridas visibles) vs solo hashes (más liviano, diff sin texto).
- **D-08-05 Exportar/importar personas** entre instancias de la agencia: fuera
  ahora; ¿se quiere en fase 2?
- **D-08-06 Edición de perfil/KB durante una corrida**: aceptar la divergencia
  con aviso (propuesta) vs bloquear la edición mientras haya una corrida
  `running`.
- **Riesgo**: cambiar el prompt del juez altera veredictos del modelo real; los
  scores antes/después de 08 no son estrictamente comparables (el diff lo
  marca como "cambio de evaluación").
- **Riesgo**: el ai-mock depende de la key `fuera_de_kb` en el prompt; si el
  Propietario la archiva, el self-test por defecto cambia — el E2E siempre
  restaura semillas antes de correr.
- **Riesgo réplicas** (no de esta tarea): `cleanupOrphanRuns` marca `failed`
  todas las corridas `running` al arrancar cualquier réplica.

## 3. Dependencias con otras tareas

- **00 — Roles y permisos** (bloqueante): guard de Propietario para `/api/lab/*`,
  `/lab`, `/agent` y el KB; ocultar menú al Vendedor.
- **02 — Métricas del agente** (blanda): la tendencia del Laboratorio puede
  enlazarse desde Reportes, pero no depende de ella.
- **03 / 04** (blanda): si 03 agrega contexto del contacto al prompt del agente
  y 04 nuevas acciones, el snapshot debe incluir esas piezas para que "Qué
  cambió" las explique (ampliar `loadAgentConfig`).
- **10 — Recordatorios**: comparte numeración de migración; ambos mantienen la
  regla de que las citas de prueba (`is_test`) no tocan conectores ni WhatsApp.

## Contrato 08-0

Fijado para que servidor (08-A) y UI (08-B) avancen en paralelo. **Manda sobre
la especificación y el plan técnico** donde difieran (nombres de columnas y
campos, rutas, cuerpos, siembra en código, `persona_keys`).

### Decisiones cerradas

| # | Decisión |
|---|---|
| D-08-01 | Siembra perezosa en código (`ensureSeedPersonas`), no en SQL. Org sin ninguna persona: con alguna fila en `agent_test_run` → set **`autos`** (las 7 de `PERSONAS`); sin corridas → set **`neutro`** (`PERSONAS_NEUTRO`). Mismas 7 claves y teléfonos en los dos sets. `POST /api/lab/runs` la llama ANTES de insertar la corrida. |
| D-08-02 | Aplicar al perfil **agrega** el texto (`concat_ws('\n', campo, texto)`), editable antes de guardar; si ya está contenido no se duplica. |
| D-08-03 | Tope **10 personas × 8 mensajes** por corrida. Timeout: `LAB_RUN_TIMEOUT_MS` si es válido; si no, `max(10 min, casos × (mensajes_max × 15 s + 30 s))` (`runTimeoutMsFor`, `src/server/lab/runner.ts`): 7 personas actuales ≤ 5 mensajes ⇒ 12 min 15 s; tope 10 × 8 ⇒ 25 min. 08-A lo cablea en `executeRun`. |
| D-08-04 | Snapshot completo de perfil + KB por corrida; si el JSON de las entradas del KB supera `LAB_SNAPSHOT_KB_MAX_BYTES` (1 MB) → `kb.mode = "hashed"` (solo `id`, `kind`, `hash`, `updatedAt`) y el diff degrada a "editada" sin texto. |
| D-08-05 | Exportar/importar personas: **fase 2, fuera**. |
| D-08-06 | Editar perfil/KB/personas durante una corrida: **aviso, no bloqueo** (`runInProgress` en `GET /api/lab/personas`; la UI de `/agent` avisa). El runner usa `persona_snapshot` del caso; el agente lee perfil/KB vivos. |

### Datos — migración `0019_laboratorio_por_cliente.sql`

- `lab_persona` (prefijo `lpe`): `id`, `organization_id` (FK cascade),
  `key` (slug estable), `name`, `objetivo` (default `''`), `rasgos` NULL,
  `guion jsonb` (string[], 1..8; el primero es el mensaje inicial),
  `criterios_exito` NULL, `contact_name`, `phone` (sintético), `seed jsonb`
  NULL (`{ ficha?, notes?, name? }`), `expect_ficha jsonb NOT NULL DEFAULT
  '[]'` (`[{ key, pattern, flags }]`, se compila a RegExp en runtime con
  `compileExpectFicha`; una regla inválida se descarta), `seed_set` NULL
  (`autos`|`neutro` si nació de la semilla, NULL = personalizada), `active`
  (default true), `position` (default 0), `archived_at`, `created_at`,
  `updated_at`. `UNIQUE lab_persona_org_key_uq (organization_id, key)` (vigente
  aun archivada) e índice `(organization_id, position)`.
- `lab_suggestion_application` (prefijo `lsa`): `id`, `organization_id` (FK
  cascade), `test_case_id` (FK → `agent_test_case` cascade), `hallazgo_index`,
  `target` (`kb`|`profile`), `field` NULL (`tone`|`escalationRules`|
  `instructions`, solo `profile`), `kb_entry_id` NULL (FK → `kb_entry` set
  null), `applied_text`, `actor_user_id` NULL (FK → `user` set null),
  `created_at`. `UNIQUE lab_suggestion_case_hallazgo_uq (test_case_id,
  hallazgo_index)` = candado de idempotencia.
- `agent_test_run` + `config_snapshot jsonb` NULL (`LabConfigSnapshot`) y
  `persona_keys jsonb` NULL (claves de la corrida, en orden de corrida).
- `agent_test_case` + `persona_snapshot jsonb` NULL (`LabPersonaSnapshot`).
- Sin siembra SQL (los guiones llevan apóstrofes y emoji, y el set depende de
  D-08-01). Columnas nuevas NULL: corridas anteriores siguen legibles.

### Reglas (08-A)

1. **Teléfono sintético**: `52100000` + 5 dígitos (`syntheticLabPhone(n)`,
   `isSyntheticLabPhone`). Semillas `5210000000001..7`; nuevas = máx.
   secuencia de la org (incluye archivadas) + 1. Jamás del cliente (el esquema
   descarta `phone` y `key`).
2. **Key**: slug del nombre (`[a-z0-9_]`), único en la org con sufijo `_2`,
   `_3`… si choca con otra (aunque esté archivada) o con una clave de semilla.
   Inmutable.
3. **Guarda de `resetTestContact`** (hecha en 08-0): contacto ARCHIVADO cuya
   `wa_identity` o `phone` cumple `isSyntheticLabPhone`. No lee la BD ni el
   set en código: vale para personalizadas y archivadas.
4. **Runner**: `startRun(orgId, personaKeys?)` → `ensureSeedPersonas` →
   `loadRunPersonas(orgId, keys?)` (activas y sin archivar, por `position`,
   `key`; 422 `no_personas` / `unknown_persona`) → `config_snapshot` +
   `persona_keys` en el INSERT del run → un caso por persona con
   `persona = key` y `persona_snapshot = personaSnapshot(p)`. `runAllCases`
   lee la persona del `persona_snapshot` (no de `PERSONAS`); `behaviorText` y
   `kbText` del snapshot. **`failRun` publica `total` = nº de casos del run,
   no `PERSONAS.length`.**
5. **Juez**: `judgeCase({ …, persona: { name, objetivo, rasgos, criteriosExito } })`
   → `buildJudgePrompt` con `personaDetail`. Se conservan EXACTOS la primera
   línea `PERSONA SIMULADA: <key> — <nombre>` y los encabezados
   `CONOCIMIENTO CONFIGURADO:` / `TRANSCRIPT COMPLETO:` (el ai-mock despacha
   por ellos, `src/server/dev/ai-mock.ts`). Bloques nuevos: `OBJETIVO DE LA
   PERSONA:`, `RASGOS DE LA PERSONA:`, `CRITERIOS DE ÉXITO (evalúa contra
   estos):`. `Verdict` ya admite `ajuste?: { campo: "tone"|"escalationRules"|
   "instructions", texto }` (inválido → se descarta solo el ajuste); 08-A
   añade al system del juez cuándo emitirlo (hallazgos `tono` y
   `debio_escalar`). Ojo: el ai-mock marca rojo cualquier prompt que contenga
   `fuera_de_kb` (también en objetivo/criterios de una persona personalizada).
6. **Delta** (RF-08-17, `samePersonaSet`, ya usado en `GET /api/lab/runs`):
   solo contra la corrida `done` anterior con el MISMO conjunto (mismas claves
   sin importar el orden y, si ambas tienen snapshot, mismo hash por clave). Si
   hay anteriores pero ninguna comparable → `delta: null`, `deltaNote:
   "conjunto distinto"`. Corridas anteriores a 08 (`persona_keys` NULL) solo
   se comparan entre sí. 08-A añade los hashes leyendo
   `config_snapshot -> 'personas'` sin traer el snapshot completo.
7. **Listados ligeros**: `GET /api/lab/runs` y `GET /api/lab/runs/[id]`
   seleccionan columnas explícitas (ya en 08-0); `config_snapshot` solo lo lee
   el diff.
8. **Aplicar sugerencia** (`applySuggestion`): una transacción; `INSERT …
   ON CONFLICT (test_case_id, hallazgo_index) DO NOTHING RETURNING`; sin fila
   → `alreadyApplied` con la existente, sin efecto. Efecto `kb` → `kb_entry`
   `qa`; `profile` → append con límites `tone` 500 · `instructions` 8000 ·
   `escalationRules` 4000 (`LAB_PROFILE_FIELD_MAX`); exceder → 422 `too_long`
   y rollback (sin registro). Sin perfil → se crea. Borrar la corrida borra los
   registros (cascada); la entrada del KB y el texto del perfil se quedan.
9. **Sandbox intacto**: toda persona corre en conversación `is_test` con
   contacto archivado; nada de esto toca el sender.
10. **E2E**: una BD limpia crea orgs sin corridas ⇒ set `neutro` (sin
    `expectFicha`). Los guiones que esperan el set de autos (ficha T03 /
    Villahermosa, `e2e-ficha-agente`) deben llamar antes
    `POST /api/lab/personas/restore-defaults { "set": "autos" }`.

### Firmas

```ts
// src/server/lab/personas.ts (puro, sin BD — lo importa bot/ficha.ts)
isSyntheticLabPhone(v: string | null | undefined): boolean        // real
syntheticLabPhone(n: number): string                               // real
type LabPersona = { id: string|null; key; name; objetivo; rasgos: string|null;
  guion: string[]; criteriosExito: string|null; contactName; phone;
  seed?: PersonaSeed; expectFicha?: Record<string, RegExp>; active; position }
fromCodePersona(p: Persona, position?): LabPersona                 // real
personaSnapshot(p: LabPersona): LabPersonaSnapshot                 // real (hash sha256)
personaHash(p) · serializeExpectFicha(rec) · compileExpectFicha(rules) // reales
PERSONAS_AUTOS (= PERSONAS) · PERSONAS_NEUTRO · seedPersonas(set)
chooseSeedSet(hasRuns): LabSeedSet · legacyPersonaLabel(key)       // reales

// src/server/lab/persona-store.ts
ensureSeedPersonas(orgId): Promise<LabSeedSet | null>   // real, idempotente (D-08-01)
loadRunPersonas(orgId, keys?): Promise<LabPersona[]>    // real; LabError no_personas/unknown_persona
seedRow · rowToLabPersona · rowToLabPersonaDto          // reales
listPersonas(orgId, { includeArchived? })               // stub 501
createPersona(orgId, LabPersonaCreateInput)             // stub 501
updatePersona(orgId, id, LabPersonaPatchInput)          // stub 501
archivePersona(orgId, id)                               // stub 501
restoreDefaultPersonas(orgId, set?)                     // stub 501

// src/server/lab/history.ts
samePersonaSet(a, b): boolean                           // real
runTrends(orgId, limit): Promise<LabTrendsDto>          // stub 501
diffRuns(orgId, runId, againstId?): Promise<LabRunDiffDto> // stub 501

// src/server/lab/suggestions.ts
applySuggestion(orgId, actorUserId, LabSuggestionApplyInput): Promise<LabSuggestionApplyResultDto> // stub 501

// src/server/lab/runner.ts
runTimeoutMsFor(raw, { cases, maxMessages }): number    // real, sin cablear

// src/server/lab/errors.ts
LabNotImplementedError → 501 · LabError(code) → labErrorStatus · labErrorResponse(err)

// src/server/ai/prompts.ts
buildJudgePrompt({ persona, personaDescription?, personaDetail?: JudgePersona, … })
```

### Rutas (todas `withAuth(..., { role: "owner" })`: 403 `forbidden` al Vendedor)

| Ruta | Cuerpo / query | 200 | Errores |
|---|---|---|---|
| `GET /api/lab/personas` | `?archived=1` incluye archivadas | `LabPersonasResponse` `{ personas, runInProgress }` (08-A: siembra perezosa antes; el stub NO siembra) | hoy 501 |
| `POST /api/lab/personas` | `LabPersonaCreateInput` (`name`, `guion` 1..8 × 1..500, `objetivo?` ≤ 1000, `rasgos?`, `criteriosExito?` ≤ 1000, `contactName?`, `seed?`, `expectFicha?` ≤ 20, `active?`, `position?`) | 201 `{ persona: LabPersonaDto }` | 422 `invalid_body` · hoy 501 |
| `PATCH /api/lab/personas/[id]` | `LabPersonaPatchInput` (≥ 1 campo; `key`/`phone` se ignoran) | `{ persona }` | 404 `not_found` · 422 · hoy 501 |
| `DELETE /api/lab/personas/[id]` | — (= archivar, idempotente) | `{ persona }` con `archivedAt` | 404 · hoy 501 |
| `POST /api/lab/personas/restore-defaults` | opcional `{ set?: "autos"\|"neutro" }` (default: el de la org, o D-08-01) | `LabRestoreDefaultsResponse` `{ set, restored, personas }` | 422 · hoy 501 |
| `POST /api/lab/runs` | opcional `{ personaKeys?: string[] }` (1..10 únicas; sin cuerpo = todas las activas) | 202 `{ runId }` | 409 `ai_not_configured` · 409 `run_in_progress` · 422 `invalid_body` · 422 `no_personas` · 422 `unknown_persona` · **hoy 501 si llega `personaKeys`**; sin cuerpo, igual que antes |
| `GET /api/lab/runs` | — | `{ runs: LabRunSummaryDto[], aiConfigured }`; aditivo: `personaKeys`, `deltaAgainst`, `deltaNote` | — (**ya implementado**, sin `config_snapshot`) |
| `GET /api/lab/runs/[id]` | — | `{ run (+ personaKeys), cases: LabRunCaseDto[] }`; aditivo: `personaSnapshot` y `personaLabel` del snapshot; 08-A añade `aplicada` por hallazgo | 404 |
| `GET /api/lab/runs/[id]/diff` | `?against=<runId>` (default: `done` anterior con snapshot) | `LabRunDiffDto` (`{ available: false, reason: "no_snapshot"\|"no_previous" }` si no aplica) | 404 `not_found` · hoy 501 |
| `GET /api/lab/trends` | `?limit=` 1..50 (inválido → 10) | `LabTrendsDto` (corridas `done`, recientes primero; `hallazgosPorTipo` con los 4 tipos; `veredictos` por key, `"sin_veredicto"` = judge_failed) | hoy 501 |
| `POST /api/lab/suggestions/apply` | `LabSuggestionApplyInput` `{ testCaseId, hallazgoIndex, target: "kb"\|"profile", field?, pregunta?, respuesta?, text? }` (texto editable; si falta, el del juez) | `LabSuggestionApplyResultDto` `{ result: "applied"\|"alreadyApplied", application: LabAppliedDto }` | 404 `not_found` · 422 `invalid_body` · 422 `hallazgo_not_found` · 422 `target_mismatch` · 422 `too_long` · hoy 501. **Forma vieja** `{ caseId, hallazgoIndex, pregunta, respuesta }` → 201 `{ entry }` tal cual hasta que 08-B migre la UI; luego se retira |

### DTOs (`src/lib/lab.ts`, re-exportados en `src/lib/types.ts`)

`LabPersonaDto`, `LabPersonasResponse`, `LabPersonaCreateInput`,
`LabPersonaPatchInput`, `LabRestoreDefaultsInput/Response`,
`LabRunCreateInput`, `LabRunSummaryDto`, `LabRunCaseDto`, `LabHallazgoDto`
(`aplicada: LabAppliedDto | null`), `LabAppliedDto { target, field,
kbEntryId, appliedText, appliedAt }`, `LabTrendsDto`, `LabRunDiffDto`,
`LabFieldChange`, `LabSuggestionApplyInput`, `LabSuggestionApplyResultDto`,
`LabConfigSnapshot { version: 1, takenAt, profile, kb: { mode, entries },
personas: { id, key, name, hash }[], models: { agent, judge } }` (nunca
secretos), `LabPersonaSnapshot`, `LabKbSnapshotEntry`, `LabAjuste`.
Catálogos y límites: `LAB_MAX_PERSONAS_PER_RUN` (10),
`LAB_MAX_SCRIPT_MESSAGES` (8), `LAB_SCRIPT_MESSAGE_MAX` (500),
`LAB_PERSONA_*_MAX`, `LAB_SYNTHETIC_PHONE_PREFIX`, `LAB_SNAPSHOT_KB_MAX_BYTES`,
`LAB_SEED_SETS`, `LAB_HALLAZGO_TIPOS`, `LAB_AJUSTE_CAMPOS`,
`LAB_PROFILE_FIELD_MAX`, `LAB_SUGGESTION_TARGETS`,
`LAB_DELTA_NOTE_DIFFERENT_SET`, `LAB_TRENDS_*_LIMIT`. Validación de entrada:
`src/server/lab/schemas.ts`.

### Pruebas del contrato

`tests/unit/lab-contract.test.ts` (teléfono sintético, sets de semilla,
`expectFicha` en jsonb, `personaSnapshot`/hash, `samePersonaSet`, `Verdict`
con/sin `ajuste`, encabezados del juez, `runTimeoutMsFor`, esquemas) y
`tests/unit/lab-reset-contact.test.ts` (guarda por prefijo, persona fuera del
set en código), `tests/unit/lab-persona-store.test.ts` (`ensureSeedPersonas`
y `loadRunPersonas` con BD simulada; 08-A debe cubrirlas además contra la BD
aislada). `role-matrix` cubre las rutas nuevas.

### Decisiones de 08-0 por ratificar

- Columna `seed_set` y `{ set? }` en `restore-defaults` (no estaban en la
  lista original): sin ellas, "restaurar" no sabría qué set tiene la org.
- `parseOptionalBody` en `src/lib/api.ts` (POST con cuerpo opcional).
- La forma vieja de `apply` sigue viva (unión Zod) porque la UI actual
  (`lab-client.tsx`) y los E2E la usan.
- `GET /api/lab/runs` ya aplica "conjunto distinto" por claves (hashes: 08-A).
- Contenido de `PERSONAS_NEUTRO` (7, mismas claves y teléfonos, sin
  `expectFicha`).
- Constantes del timeout (15 s por mensaje + 30 s por caso).
- Ojo producto: `src/server/seed/demo.ts` inserta una `agent_test_run`, así
  que una org con datos demo (ferretería) recibe el set `autos` por D-08-01.
