# 031 — Tareas

Rama `031-guia-vendedores`.

## Rebanada 1 — Regreso tras el login
- [x] T1 `src/lib/safe-next.ts` + `tests/unit/safe-next.test.ts`
- [x] T2 `src/middleware.ts` (cabecera `x-vocero-path`) + layout `(app)` con `?next=`
- [x] T3 login lee `next` (Suspense) y vuelve ahí

## Rebanada 2 — Página Ayuda
- [x] T4 `src/lib/help/topics.ts` desde `contenido.md` + `visibleTopics` + tests
- [x] T5 `src/app/(app)/ayuda/page.tsx` (índice + temas + capturas opcionales)
- [x] T6 Enlace «Ayuda» en el menú junto a «Ajustes»

## Rebanada 3 — Ayudas «?»
- [x] ~~T7 `src/components/help-hint.tsx`
- [x] ~~T8 Montarla en los 5 lugares (composer ×3, template-sender, scope-tabs)

## Rebanada 4 — Pantallas que se explican solas (reemplaza T7/T8; diseño aprobado)
- [x] T13 Quitar `help-hint.tsx`, sus 5 montajes y `HELP_HINTS`
- [x] T14 Composer: tiempo restante, respuestas rápidas rotuladas, menú «Adjuntar» por tipo
- [x] T15 Ventana cerrada en 3 pasos + estado sin plantillas (+ cerrado IG/Messenger)
- [x] T16 Franja «quién responde» + «Atender yo» + pregunta al escribir con la IA encendida
- [x] T17 Pestañas con descripción, «Tomar» por fila en el Buzón, etiqueta «Responde la IA»
- [x] T18 Sin chat abierto: «lo que te toca ahora» (contadores existentes)
- [x] T19 Página Ayuda con el estilo del diseño + textos al día con la nueva UI
- Lógica pura con tests: `src/lib/template-fill.ts`, `who-answers.ts`, `reply-window.ts`, `attach-kinds.ts`, `inbox-summary.ts`. E2E ajustados a la UI nueva: `e2e-adjuntos-ui` (ubicación/contacto en el menú «Adjuntar»), `e2e-bandeja-alcance` (acceso «N chats en el Buzón sin tomar»), `e2e-leads-externos` (texto de la ventana cerrada).

## Verificación
- [x] T9 Gate `typecheck && lint && build && test`
- [x] T10 `scripts/ayuda-capturas.mjs` → `public/ayuda/*.png` (BD aislada) — 9 PNG con datos ficticios («Mueblería Demo», vendedora Daniela Ortiz), recortadas a la zona del tema (≤ 120 KB c/u); `--revisar <dir>` deja /ayuda por tramos y 3 pantallas en oscuro para revisarlas a ojo. La página pinta cada captura a su tamaño real (lee el IHDR), sin estirarla.
- [x] T11 `scripts/e2e-ayuda.mjs` verde (+ `tests/e2e/us-ayuda.md`) — sin el paso «?» del plan (retirado); en su lugar, los estados (a)–(f) de US-3. 82/82 (AGENDA=on) + 8/8 (`--off`, AGENDA=off CHANNELS=whatsapp). Destapó y quedó corregido: la franja «quién responde» compartía `key` con el Composer y se acumulaba al cambiar de chat.
- [ ] T12 Deploy a prod y link para WhatsApp
