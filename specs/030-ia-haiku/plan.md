# 030 — Plan

Spec: [spec.md](spec.md). Rama `030-ia-haiku` desde main 1ce3cd0.

## A. Cuerpo extra por rol (US-1)
- `src/lib/env.ts`: `OPENROUTER_EXTRA_BODY` y `OPENROUTER_JUDGE_EXTRA_BODY`
  opcionales; se parsean como JSON y deben ser objeto plano sin las claves
  `model` ni `messages`. `isAiConfigured()` no cambia.
- `src/lib/ai/index.ts`: `callProvider` recibe el extra del rol y arma
  `{ ...extra, model, messages }` (model/messages siempre ganan). Juez: su
  extra; si no hay `OPENROUTER_JUDGE_MODEL`, el del agente. `opts.model`
  explícito usa el del agente salvo `judge:true`.
- `.env.example`: bloque de IA con el ejemplo de Anthropic directo
  (`OPENROUTER_BASE_URL=https://api.anthropic.com`, `claude-haiku-5-5`,
  `{"thinking":{"type":"disabled"}}`) y la advertencia de Sonnet 5.5.

## B. Historial que termina en saliente (US-2)
- `src/server/ai/history.ts`: helper puro `ensureEndsWithUser(messages)` que,
  si el último es `assistant`, agrega el aviso del sistema como `user`.
  Exportar el texto del aviso como constante para los tests.
- `src/server/ai/pipeline.ts`: aplicarlo a `chatHistory` antes de armar
  `messages`. `lastInboundText` no se toca.
- Verificar que `none` existe en `agentActionSchema` con y sin agenda.

## C. El juez ve el pase a humano (US-3)
- `src/server/lab/runner.ts`: `runConversation` devuelve también
  `handoff: { reason, note } | null` (de `conversation`), y `runAllCases` lo
  pasa a `judgeCase`.
- `src/server/lab/judge.ts`: `judgeCase` acepta `handoff?` y lo reenvía.
- `src/server/ai/prompts.ts` `buildJudgePrompt`: bloque `RESULTADO DE LA
  CONVERSACIÓN` tras el transcript + dos reglas en el system. La línea de la
  persona sigue PRIMERA del `user` y `JUDGE_MARKER` al inicio del system
  (`ai-mock.ts` depende de ambos). Etiqueta legible del motivo desde el
  catálogo `HANDOFF_REASONS`.

## D. Verificación
- Unit: env (válido/ inválido/ claves prohibidas), adaptador (cuerpo con y
  sin extra, por rol), `ensureEndsWithUser`, `buildJudgePrompt` con/sin
  handoff y con motivo `error`.
- Gate: `pnpm typecheck && pnpm lint && pnpm build && pnpm test`.
- E2E con mocks en BD aislada: `e2e-lab-personas.mjs`, `e2e-selftest.mjs`.
- Real (BD `vocero_lab`, config de prod copiada): 2 corridas de Haiku con
  `{"thinking":{"type":"disabled"}}`, juez Sonnet 5.5; comparar contra
  Haiku con razonamiento (58/58/75 sin `pide_humano`). Si la calidad cae,
  se despliega sin el cuerpo extra.

## E. Despliegue (con OK explícito del dueño)
- Variables runtime en Coolify: `OPENROUTER_BASE_URL`, `OPENROUTER_API_TOKEN`,
  `OPENROUTER_MODEL=claude-haiku-5-5`, `OPENROUTER_JUDGE_MODEL`,
  `OPENROUTER_EXTRA_BODY`. Reversa: restaurar las de MiniMax y reiniciar.
