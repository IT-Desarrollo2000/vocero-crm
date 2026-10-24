# 030 — tareas

Plan: [plan.md](plan.md). `[x]` hecho y verificado · `[ ]` pendiente.

## T1. Cuerpo extra por rol
- [x] `env.ts`: `OPENROUTER_EXTRA_BODY` / `OPENROUTER_JUDGE_EXTRA_BODY` validadas
  (JSON objeto, sin `model`/`messages`; vacía = no definida).
- [x] `ai/index.ts`: extra por ROL; `model`/`messages` siempre ganan.
- [x] `.env.example` con el ejemplo de Anthropic directo.
- [x] Unit (`ai-extra-body.test.ts`, 15).

## T2. Historial que termina en saliente
- [x] `ensureEndsWithUser` + `ENDS_WITH_OUTBOUND_NOTICE` en `history.ts`; uso
  en `pipeline.ts`. El aviso evita «asesor»/«humano» (el ai-mock y el regex
  de handoff las leen como petición del cliente).
- [x] Unit (`agent-history`, `agent-ficha-pipeline`). `none` está en el
  esquema con y sin agenda (`baseActions`).

## T3. El juez ve el pase a humano
- [x] `runConversation` → `handoff`; `judgeCase` → `buildJudgePrompt` (bloque
  RESULTADO DE LA CONVERSACIÓN tras el transcript; motivo con etiqueta de
  `HANDOFF_LABELS` + clave, p. ej. `[error]`).
- [x] Unit (`judge-schema`, `judge`, `lab-timeout`, `lab-ai-mock-judge`).

## T4. Verificación
- [x] Gate: typecheck, lint, 2353 unit (171 archivos), build.
- [x] E2E en BD aislada (reseteada): selftest 641/641, lab-personas 86/86.
- [x] Sondas al endpoint compatible: reintento con `system` al final → 200.
- [x] Laboratorio real (BD `vocero_lab`, config de prod, juez Sonnet 5.5,
  juez nuevo): Haiku CON razonamiento 64/64 (0 reintentos, p50 2.2 s / p95
  3.4 s); SIN razonamiento 50/50 (6 reintentos, 2 handoff `error` por texto
  plano en los 3 intentos, p50 1.1 s). `pide_humano` pasa de rojo a verde en
  las 4 corridas. **Decisión: producción SIN `OPENROUTER_EXTRA_BODY`** (la
  variable queda disponible). Calificaciones no comparables con las previas.

## T4b. Aviso al cliente que pide un humano (US-4, 24-oct)
- [x] `handoffAckText` (tú/usted) en `handoff.ts`; el patrón de respaldo lo
  envía con `deliverReply` antes de `applyHandoff("cliente")`, de mejor
  esfuerzo (si falla, log sin datos y handoff igual).
- [x] Unit (2360 pasan): orden aviso→handoff, tú/usted, envío fallido, y que
  modelo/error/ventana no avisan.
- [x] E2E: `e2e-contexto-agente` sección 7 ahora exige UN saliente con el
  aviso (21/21); selftest 641/641; lab-personas 86/86. Guiones `.md`
  (`us-contexto-agente`, `us3-agent`) al día. Lint, typecheck y build verdes.

## T5. Despliegue
- [x] OK del dueño (23-oct: «continúa con la implementación… te autorizo»).
- [x] Merge a `main` local (18c183e).
- [x] Push a GitHub (24-oct; el 23-oct lo bloqueó Git Credential Manager
  con el dueño ausente).
- [x] Variables runtime en Coolify (app `yjvvp6eudu2s36gsjfps9tkw`, 24-oct):
  `OPENROUTER_BASE_URL=https://api.anthropic.com`, `OPENROUTER_API_TOKEN`
  (llave de Anthropic, termina en `sgAA`), `OPENROUTER_MODEL=claude-haiku-5-5`,
  nueva `OPENROUTER_JUDGE_MODEL=claude-sonnet-5-5` (copia preview borrada); sin
  `OPENROUTER_EXTRA_BODY`.
- [x] Deploy e9cfd4c (deployment `igvjwcrhswn2yh0lz7tbsp39`, 17:24–17:29Z,
  ~5 min, finished, running:healthy; `/api/health` commit e9cfd4c; logs
  limpios: 0 fallo del proveedor/429/401/403/EMAXCONNSESSION).
- [x] Verificado con tráfico real: entrante 17:29:08Z → respuesta de Haiku
  17:29:20Z (frase de escalado del negocio + handoff `modelo`), 0 handoff
  `error`.
- Reversa: restaurar `OPENROUTER_BASE_URL=https://api.minimax.io`,
  `OPENROUTER_MODEL=MiniMax-M3`, `OPENROUTER_API_TOKEN` = `MINIMAX_API_KEY`
  de `.env.coolify-api` (termina en `89ug`), borrar `OPENROUTER_JUDGE_MODEL`
  y reiniciar. El código de 030 funciona igual con MiniMax; redeploy de
  `9de653e` solo si fallara el código.
