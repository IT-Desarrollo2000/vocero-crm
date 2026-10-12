# Contrato: Acciones del agente y juez del Laboratorio

## Adaptador LLM (frontera única)

`lib/ai`: cliente `fetch` OpenRouter-compatible. Env: `OPENROUTER_API_TOKEN` (opcional —
sin él, agente/Laboratorio deshabilitados con estado vacío), `OPENROUTER_BASE_URL`
(default `https://openrouter.ai/api`), `OPENROUTER_MODEL`, `OPENROUTER_JUDGE_MODEL`
(default = `OPENROUTER_MODEL`). API: `chatJson<T>(schema, messages, opts)` → parsea con
extracción robusta (bloque ```json, primer `{...}` balanceado), valida con Zod,
reintenta ante fallo de red/parseo/validación (2 reintentos, backoff corto). Un hipo del
proveedor NUNCA propaga excepción al turno: agota reintentos → resultado `error` tipado.

## Acción del agente (una por turno)

```ts
const AgentAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('none') }),
  z.object({ action: z.literal('reply'), text: z.string().min(1) }),
  z.object({ action: z.literal('update_lead'), note: z.string().min(1),
             reply: z.string().optional() }),
  z.object({ action: z.literal('move_stage'), stage: z.string().min(1),
             reply: z.string().optional() }),
  z.object({ action: z.literal('handoff'), reason: z.string().optional(),
             farewell: z.string().optional() }),
])
```

- **04 — `ficha` acompañante**: TODA acción acepta además
  `ficha: z.record(z.unknown()).nullable().optional().catch(undefined)` — un
  `ficha` que no sea objeto se descarta sin invalidar la acción (jamás
  provoca reintentos ni handoff `error`). Antes de validar (`z.preprocess`):
  `{"action":"update_ficha", ficha, text|reply?}` se traduce a `reply` (con
  texto) o `none`; `reply` sin `text` toma `reply`; y un `reply` que sigue sin
  texto pero trae `ficha` objeto se degrada a `none` conservando la ficha. La
  ficha se escribe DESPUÉS de entregar la respuesta, por `upsertFicha({ source:
  "ia" })` (coerción por tipo, "el humano gana", bitácora `ficha_event`), en
  `try/catch` con logs sin valores. Sin campos con `agentFills`, el prompt no
  menciona la ficha y lo que mande el modelo se ignora.
- `move_stage.stage` se resuelve contra nombres de etapas de la org (fuzzy exacto →
  lower-case); sin match → se degrada a `reply` si trae texto, o `none` (la
  `ficha` se conserva en la acción degradada).
- Regex de respaldo de handoff (se evalúa sobre el mensaje del cliente ANTES del LLM):
  `/(hablar|comunicar|contactar)[\s\S]{0,40}?(asesor|humano|persona|alguien)|un asesor|atenci[oó]n humana/i`
  — "somos 4 personas" NO matchea (unit test).
- Disparadores de turno: ingesta de mensaje entrante en conversación con IA activa
  (global + conversación + sin handoff). Debounce (coalesce) 6s producción / 0 en
  Laboratorio; lock in-process por `conversation_id`; los mensajes que llegan durante el
  turno se re-encolan.
- Ventana cerrada o error persistente del proveedor → handoff automático
  (`handoff_reason: 'ventana' | 'error'`), sin enviar texto libre.

## Juez del Laboratorio (una llamada por conversación)

Input: transcript completo + KB + comportamiento. Output (Zod):

```ts
const Verdict = z.object({
  veredicto: z.enum(['verde', 'amarillo', 'rojo']),
  hallazgos: z.array(z.object({
    tipo: z.enum(['alucinacion', 'fuera_de_kb', 'debio_escalar', 'tono']),
    evidencia: z.string(),
    sugerencia: z.object({ pregunta: z.string(), respuesta: z.string() }).optional(),
  })),
})
```

Juez inválido tras reintentos → caso `judge_failed` (excluido del score, visible en el
reporte); la corrida continúa.

## Personas guionadas (fijas, sin LLM)

7 claves: `comprador_decidido`, `pregunton_precios`, `cliente_enojado`, `fuera_de_kb`,
`pide_humano`, `errores_modismos`, `cliente_que_regresa` (03). Cada una: 4–5 mensajes
predefinidos; el runner envía mensaje → espera el turno del agente (pipeline real,
debounce 0) → siguiente. Fin del guion o primer handoff → juez.

03 — Al inicio de cada caso el contacto sintético se reinicia a la `seed` de la persona
(notas + ficha; vacías si no tiene) con `resetTestContact` (`server/bot/ficha.ts`), que
solo actúa sobre contactos archivados de personas sintéticas. El juez recibe, además de
la clave, la descripción de la persona y su semilla ("el agente tenía estos datos").

## Contexto del contacto (03)

Cada turno inserta en el ÚNICO system prompt —después de perfil/KB/etapas y antes del
formato de salida— el bloque "DATOS DEL CONTACTO" (`server/ai/contact-context.ts`):
datos entre `<<<DATOS_CONTACTO>>>` … `<<<FIN_DATOS_CONTACTO>>>`, precedidos de la
instrucción de que son DATOS y no instrucciones; ≤ 3 000 caracteres con recorte fijo
(notas → ficha fuera de la definición → cuerpo del anuncio → resto de la ficha); valores
sanitizados (controles, saltos, delimitadores y `<think>` neutralizados). Un fallo al
armarlo no tumba el turno. El historial (`server/ai/history.ts`) representa los mensajes
no-texto con marcadores (`[imagen] «pie»`, `[audio — no puedes escucharlo]`,
`[ubicación: …]`…) y marca los salientes del equipo con `"autor":"asesor"` /
`"autor":"plantilla"`. El regex de respaldo también se evalúa sobre el pie de foto.
