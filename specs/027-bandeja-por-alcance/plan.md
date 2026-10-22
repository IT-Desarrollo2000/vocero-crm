# 027 — plan

Spec: [spec.md](spec.md). Sin migración.

## Servidor

- `src/lib/types.ts`: `AssignedFilter` += `"others"`. `ConversationCounts` +=
  `scopes: { mine: ScopeCount; inbox: ScopeCount; team: ScopeCount }` con
  `ScopeCount = { all: number; unread: number }` (no archivadas; `unread` =
  conversaciones con `unread_count > 0`). Mismas capas que
  `unreadConversations` (solo visibilidad ∧ no archivada): números estables,
  no dependen de búsqueda/filtros.
- `src/server/inbox/list-query.ts`: `ASSIGNED_FILTERS` += `others`.
- `src/server/inbox/queries.ts`:
  - `assignedCondition(viewer, "others")` → Propietario:
    `assigned_user_id IS NOT NULL AND assigned_user_id <> me`; Vendedor:
    `sql\`false\`` (su visibilidad ya lo vacía; explícito).
  - `countConversations`: añadir los 6 agregados de `scopes` AL FINAL del
    SELECT (los tests indexan los segmentos por posición: no reordenar).
    Para el Vendedor, `team` = 0 sin consultar.
- La API sigue aceptando `filter=mine` / `unassigned=1` (compat de clientes
  y guiones); `counts.mine` / `counts.unassigned` se conservan.

## Cliente

- `list-state.ts`: `InboxFilters.scope: "mine" | "inbox" | "team"`.
  - `VIEWS` sin `mine` (ajustar `tests/unit/inbox-views-parity.test.ts`: el
    servidor sigue aceptando `mine` como valor legado; la paridad pasa a ser
    VIEWS ⊆ INBOX_VIEWS o se quita `mine` de INBOX_VIEWS manteniendo el
    parseo legado, lo que sea más limpio).
  - `effectiveFilters`: sin `teamMode` → sin alcance (equivale a hoy). Con
    texto en `q` → sin alcance (busca en todos). Vendedor con `team` → `mine`.
  - `buildListQuery`/`buildCountsQuery`: `assigned=me|unassigned|others`
    según el alcance efectivo; ya no mandan `unassigned=1` (el panel pierde
    ese toggle en modo equipo).
  - URL: `scope=` (`inbox`/`team`; se omite si es el default del rol).
    Legado: `filter=mine` → `scope=mine`; `filter=unassigned` o
    `unassigned=1` → `scope=inbox`.
  - `matchesFilters`/`visibleConversations`/`countsFromLoaded`: espejo del
    alcance (incluye `others`: asignada y no a mí).
  - Default del alcance: localStorage `vocero.inboxScope` (try/catch) →
    rol (Vendedor `mine`, Propietario `inbox`). El rol llega al cliente por
    la prop/sesión que ya usa la Bandeja (`viewer`).
- `helpers.ts` `filterConversations`: capa de alcance en la capa 2.
- `conversation-list.tsx`:
  - Selector de alcance (segmented control, ancho completo en móvil) encima
    del renglón de vistas, solo con `teamMode`; cada pestaña con total y
    punto de acento si `unread > 0` y no está activa. Accesible
    (`role="tablist"`/`aria-selected` o botones con `aria-pressed`, como el
    renglón de vistas actual).
  - Renglón de vistas sin "Mías"; panel Filtros sin "Sin asignar".
  - Aviso "Buscando en todos los chats" cuando hay `q` en modo equipo.
  - Vacíos: Mis chats "Aún no tienes chats. Toma uno del Buzón o contesta
    uno y se vendrá aquí."; Buzón "No hay chats sin asignar."; Equipo "Nadie
    del equipo tiene chats asignados."
- `inbox-client.tsx`: si la conversación ABIERTA está en `present` pero no
  cumple el alcance activo, mostrar aviso "Este chat ahora está en
  <alcance> · Ir" (en la cabecera del hilo o sobre la lista). "Ir" cambia el
  alcance y mantiene la selección. Se calcula del DTO (`assignedTo`), no de
  eventos.
- `assignment-control.tsx`: "Liberar conversación" → "Devolver al buzón".

## Pruebas
- Unit: `assignedCondition others` (owner/vendedor), counts `scopes`,
  list-state (scope en URL, legado, default por rol, `q` ignora alcance,
  espejo), helpers, parity.
- Actualizar tests existentes que dependan de "Mías"/"Sin asignar" en la UI.
- E2E: `bandejaAlcanceChecks` en `scripts/e2e-selftest.mjs` (API: partición
  owner, vendedor sin `others`, counts.scopes, 422) + guion Playwright
  `scripts/e2e-bandeja-alcance.mjs` (owner + vendedor: pestañas, contestar
  desde Buzón → mudanza con aviso → Ir, Devolver al buzón, búsqueda global,
  enlaces viejos, móvil 390 px) + `tests/e2e/us-bandeja-alcance.md`.
- Re-correr guiones de UI que abren `/inbox` (default de alcance cambia):
  e2e-search-filters, e2e-bandeja-paginacion, e2e-archivo-ui, e2e-alertas,
  e2e-responsive, e2e-roles, e2e-send-failure, e2e-envio-instantaneo,
  e2e-asignacion (+ los que sean pertinentes) y ajustarlos.

## Ajustes tras la revisión Fable del plan (22-oct) — MANDAN sobre lo anterior

1. **Vacíos**: en `teamMode` con alcance, los vacíos por alcance van ANTES de
   `EmptyState`; `EmptyState` (demo) solo si los tres `scopes.*.all` suman 0
   y quien mira es el Propietario (E2E 22-oct: el Vendedor no ve Equipo, su
   suma puede ser 0 con el negocio lleno y debe ver el vacío de CA-10).
   El vacío de Mis chats lleva botón "Ver el Buzón (N)" que cambia el alcance.
2. **`teamMode` inicial**: `src/app/(app)/inbox/page.tsx` calcula
   `initialTeamMode` (Vendedor → true; Propietario → `count(member) > 1` o
   alguna conversación asignada) y lo pasa a `InboxClient` como
   `localTeamMode` inicial: sin doble fetch ni parpadeo.
3. **`?contact=`**: en el efecto de `inbox-client.tsx` (~300-330), al
   encontrar el DTO, si `teamMode` y sin `q`, cambiar el alcance al del DTO
   (`assignedTo` null → inbox; yo → mine; otro → team) ANTES de `select`.
4. **Aviso "Este chat ahora está en X · Ir"**: barra inline DERIVADA de
   `selected.assignedTo` vs `active.scope` (patrón de la nota de archivada,
   `inbox-client.tsx` ~757-776), no `notice` (que se autocierra). Sin
   `teamMode` o con `q`: sin aviso. "Ir" = `setFilters({ scope })`
   conservando la selección.
5. **Paridad de vistas**: quitar `mine` simétricamente de `InboxView`,
   `INBOX_VIEWS` y `VIEWS`; `parseView` traduce `filter=mine` →
   `{ view: "all", mine: true }` aplicado en `panelFilters` como
   `assignedCondition(viewer, "me")` (igual que `unassigned`/`closing`).
   `InboxFilter` conserva `mine` (`counts.mine` sigue). Parity test exacto.

Recomendaciones adoptadas:
- Rol en el cliente vía `useViewer()`; `effectiveFilters` recibe el rol.
- Default determinista por rol en SSR; localStorage
  (`vocero.inboxScope.<userId>`) leído SOLO en `useEffect` tras montar y
  solo si la URL no trae `scope`.
- `scope=` SIEMPRE en la URL en `teamMode`.
- Quitar `unassigned` del estado cliente (toggle, chips, contador del panel);
  el servidor conserva el parámetro (compat).
- `AssigneeTag` oculto en Buzón y Mis chats (el alcance ya lo dice); visible
  en Equipo y sin `teamMode`.
- Agregados `scopes` DESPUÉS de `unreadConversations`, misma forma de SELECT
  para ambos roles (`team` con `sql\`false\`` para el Vendedor); actualizar
  mocks posicionales de `tests/unit/inbox-list.test.ts`.
- Mensajes 422 de `assigned` incluyen `others`.
- Aviso de búsqueda: Propietario "Buscando en todos los chats"; Vendedor
  "Buscando en todos tus chats".
- Propietario: orden "Buzón · Equipo · Mis chats"; `title` del Buzón "Sin
  responsable; incluye los que contestas sin asignarte".
- Guiones E2E adicionales a revisar: e2e-agenda-presencial-ui (~305),
  e2e-archivo-ui (~284), e2e-respuestas-rapidas, e2e-catalogo, e2e-adjuntos-ui,
  e2e-leads-externos, e2e-alertas (overflow de `button[aria-pressed]` a 360
  px: el selector debe caber). `tests/e2e/us-asignacion.md` actualizar textos.

## Riesgos
- Guiones E2E del Propietario que esperaban ver chats asignados a otros en
  la vista por defecto: ahora están en "Equipo".
- El Propietario contesta sin asignarse (regla 09): sus chats siguen en el
  Buzón. Documentado en la spec.
