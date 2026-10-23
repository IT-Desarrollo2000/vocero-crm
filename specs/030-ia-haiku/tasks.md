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

## T5. Despliegue
- [ ] OK del dueño · variables en Coolify · deploy · smoke · registro aquí.
