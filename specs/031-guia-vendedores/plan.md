# 031 — Plan técnico

Sin migración, sin API nueva, sin dependencia nueva (no hay librería de
popover en el repo y no hace falta).

## Rebanada 1 — Regreso tras el login (US-1)
- `src/lib/safe-next.ts` (puro): `safeNextPath(raw)` → devuelve `raw` solo si
  empieza con una sola `/`, sin `//`, sin `\`, sin caracteres de control, y no
  apunta a `/login` ni a `/api`; si no, `/inbox`. Test unitario con los casos
  de redirección abierta.
- `src/middleware.ts` mínimo: copia `pathname + search` a la cabecera de
  petición `x-vocero-path`. Matcher que excluye `api`, `_next`, archivos
  estáticos y `(auth)`/`(public)`. No decide nada de sesión: la guarda real
  sigue en el layout.
- `src/app/(app)/layout.tsx`: `redirect("/login?next=" + encodeURIComponent(safeNextPath(path)))`
  (si la ruta es `/inbox`, basta `/login`).
- `src/app/(auth)/login/page.tsx`: lee `next` con `useSearchParams` (envuelto
  en `<Suspense>` para el build) y hace `router.push(safeNextPath(next))`.

## Rebanada 2 — Página Ayuda (US-2)
- `src/lib/help/topics.ts` (puro, fuente única de textos para página y «?»):
  temas `{ id, titulo, situacion, pasos[], siNo[], captura?, requiere? }` y
  ayudas `{ id, texto, tema }`. `requiere`: `"agenda" | "instagram" | "messenger"`.
  `{negocio}` se reemplaza por `branding.name`. Función pura
  `visibleTopics({ agenda, channels })`.
- `src/app/(app)/ayuda/page.tsx` (server): sesión ya exigida por el layout;
  lee `getBranding`, `agendaEnabled()`, `enabledChannels()`. Índice arriba
  (tarjetas con ancla), luego cada tema. Ancho de lectura cómodo, tipografía
  grande, capturas con `next/image` desde `public/ayuda/`.
- Menú: enlace «Ayuda» (ícono `LifeBuoy` o `CircleHelp`) junto a «Ajustes» en
  `src/components/app-nav.tsx`, visible para todos los roles. NO como pestaña
  de Ajustes (rompe `role-nav.test.ts`).
- Textos: ver [contenido.md](contenido.md).

## Rebanada 3 — Ayudas en pantalla (US-3)
- `src/components/help-hint.tsx` (cliente): botón «?» (`CircleHelp` 14–16 px,
  `aria-label="Ayuda: <tema>"`, `aria-expanded`), popover absoluto hecho a
  mano (patrón de los modales del repo), Esc / clic fuera cierran, enlace
  «Ver más en la guía» → `/ayuda#<tema>` con `target="_blank" rel="noopener"`.
- Ubicaciones (5):
  1. Aviso de ventana cerrada — `composer.tsx` (~560-577) → `ventana-24h`.
  2. «Aún no hay plantillas aprobadas…» — `template-sender.tsx` (~54-71) → `plantillas`.
  3. Botón del clip — `composer.tsx` (~827-841) → `archivos`.
  4. Pie del composer junto a «Ventana abierta · quedan…» (~984): «Escribe /
     para tus respuestas rápidas» → `respuestas-rapidas`.
  5. Pestañas de alcance — `scope-tabs.tsx` → `mis-chats` (cubre Tomar, Por
     atender y Marcar como atendida).

## Rebanada 4 — Pantallas que se explican solas (reemplaza la 3)
- Sin «?»: `help-hint.tsx`, `HELP_HINTS` y `filesHintText` retirados.
- Lógica pura (con tests): `src/lib/template-fill.ts` (nombre legible,
  contexto de cada espacio, nombre prellenado tras un saludo, vista previa),
  `who-answers.ts` (franja A/B/C), `reply-window.ts` (barra de tiempo),
  `attach-kinds.ts` (menú «Adjuntar» desde `outbound-files.ts`),
  `inbox-summary.ts` («lo que te toca» con `human`/`closing`/
  `scopes.inbox.all` de `/counts`).
- UI: `composer.tsx` + `attach-menu.tsx`, `template-sender.tsx`,
  `who-answers-strip.tsx`, `inbox-summary.tsx`, `conversation-list.tsx`
  (descripción de la pestaña, «Tomar» por fila, «Responde la IA»),
  `scope-tabs.tsx` (`scopeDescription`), página Ayuda.
- Estado del agente (`GET /api/agent/profile`, ya existente): sin agente
  configurado y encendido no hay franja A/B ni «Responde la IA».
- «Atender yo»: asigna solo si nadie tiene el chat (`expect: "unassigned"`)
  y luego `aiEnabled=false`; el de otro miembro no se reasigna.

## Capturas (CA-5)
- `scripts/ayuda-capturas.mjs`: contra la app viva con `.env.e2e` (BD aislada
  :5433, puerto 3100, mocks, `CATALOG_STORAGE=local` explícito). Siembra datos
  ficticios (clientes «Laura Gómez», «Carlos Ruiz»…, teléfonos 55 0000 00xx),
  plantilla aprobada vía wa-mock, respuestas rápidas, un producto del catálogo;
  toma PNG a 1366×768 de cada estado y los deja en `public/ayuda/`.
- Las capturas son públicas como cualquier archivo de `public/`: por eso solo
  datos ficticios.

## Verificación
- Unit: `safeNextPath`, `visibleTopics` (banderas), sustitución de `{negocio}`.
- `scripts/e2e-ayuda.mjs`: (a) sin sesión `/ayuda` → login → `/ayuda`;
  (b) `next=//evil.com` → `/inbox`; (c) Vendedor ve los temas e índice;
  (d) con `AGENDA=off` no hay tema de citas; (e) el «?» del clip abre y su
  enlace es `/ayuda#archivos`; (f) captura a 1366×768 sin desbordes.
- Gate: `pnpm typecheck && pnpm lint && pnpm build && pnpm test`.
