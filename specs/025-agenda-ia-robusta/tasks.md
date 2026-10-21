# 025 — tareas

Plan: [plan.md](plan.md). `[x]` hecho y verificado · `[ ]` pendiente.

## T1. Migración 0026
- [x] `agent_profile.formality`, `message.agent_action`; SQL re-ejecutable (`drizzle/0026_agenda_ia_robusta.sql`).

## T2. Motor + agente
- [x] `copy.ts` tú/usted; `isTypeQuestion` ambas variantes.
- [x] `offerSlots` con date/part/fallback; `bookSlot` con `slot` local (A1, sin option) contra el array del turno (A2); re-oferta por día en `slot_not_offered` y `slot_taken` (A7).
- [x] `actions.ts`, `prompts.ts` (fecha, calendario, ofertas, reglas, trato).
- [x] `pipeline.ts` (ofertas, formality, agent_action, barrera `src/server/ai/slot-barrier.ts`) + `history.ts`.
- [x] Recordatorios con trato. Perfil (API + UI) con trato. Lab: snapshot + juez con trato (A9).
- [x] Unit + gate (`pnpm typecheck && pnpm lint && pnpm test`: 161 archivos, 2105 pruebas).

## T3. Verificación
- [x] ai-mock sin ISO + E2E CA-1…CA-7: e2e-agenda-presencial 198 on / 22 off, UI 64, selftest 559 on / 329 off, recordatorios 75; build verde.
- [x] Revisión Fable (plan + implementación): B1 reply de book_slot perdido y R1–R4 corregidos.

## T4. Despliegue
- [ ] Merge + push + deploy; ajustes de agenda y trato en prod.
