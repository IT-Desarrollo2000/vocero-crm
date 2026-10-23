# 029 — Plan

Spec: [spec.md](spec.md). Rama `029-pedidos-ventas` desde main 10005ae.

## A. Respuestas rápidas del equipo
- **Migración 0028** (`drizzle/0028_respuestas_equipo.sql`, re-ejecutable):
  `inbox_settings.sellers_create_quick_replies boolean NOT NULL DEFAULT true`.
  Sin fila = `true` (defaults en `src/lib/inbox-settings.ts`).
- **Política pura** `src/lib/quick-reply-policy.ts`:
  `canCreateQuickReply(viewer, settings)`,
  `canEditQuickReply(viewer, row, settings)` (Propietario: siempre; Vendedor:
  interruptor encendido ∧ `createdByUserId === viewer.userId` ∧ sin
  `productId`), y validación de campos prohibidos al Vendedor
  (`productId`, `attach`, `position`). Unit tests.
- **Store** `src/server/quick-replies.ts`: create/update/delete reciben el
  `viewer` y aplican la política (403 `forbidden`); update/delete del Vendedor
  filtran por `created_by_user_id` en el mismo WHERE (sin leer-y-luego-
  escribir). `list` agrega `createdByName` (join a `user`).
- **Rutas** `POST /api/quick-replies`, `PATCH|DELETE /api/quick-replies/[id]`:
  pasan de `{ role: "owner" }` a cualquier miembro; `permissions.ts` "any".
  `GET` agrega `canCreate` sin romper consumidores existentes (revisar forma
  actual de la respuesta y `use-quick-replies.ts`).
- **Ajustes**: `PATCH /api/settings/inbox` acepta el interruptor (solo
  Propietario, como hoy). Página de respuestas rápidas sale de `(owner)` (o se
  duplica la ruta fuera) y la pestaña se muestra al Vendedor; el interruptor
  se pinta solo al Propietario; acciones por fila según `canEditQuickReply`;
  columna Autor.
- **Compositor**: `QuickReplyDialog` compartido (atajo/título/cuerpo) abierto
  desde «+ Nueva respuesta rápida» en el `QuickReplyPicker` y desde
  «Guardar como respuesta rápida»; tras crear, refresca `useQuickReplies`.

## B. Cliente en la cita
- **Servidor** `src/server/agenda/client-card.ts`:
  `getBookingClientCard(org, viewer, bookingId)` → 404 si la cita no existe o
  `!canViewBooking`; `null` si es bloqueo. Resuelve conversación
  (`booking.conversationId` ?? más reciente no-prueba del contacto) y su
  visibilidad con `canSeeConversation`.
  `restricted = Vendedor ∧ cita asignada a otro ∧ !veoElChat`
  (spec, decisión 4); `canOpenChat = veoElChat`. Respuesta:
  `{ name, phone, restricted, conversation: { contactId, assignedUserName } | null,
     channel?, tags?, referral? }` — con `restricted` NO se incluyen
  `channel/tags/referral` (la omisión es en servidor). Todo por `scoped()`.
- **Ruta** `GET /api/bookings/[id]/client` (`withAuth`, cualquier miembro, 404
  sin `AGENDA` como el resto de la superficie) + clasificación en
  `permissions.ts`.
- **UI** `src/components/bookings/booking-client-card.tsx`: carga al montar,
  estados cargando/error+reintentar, copiar teléfono, `AnuncioOrigen`,
  botón «Abrir conversación» (`/inbox?contact=`) o deshabilitado «Chat
  asignado a X». Montado en `booking-detail-panel.tsx` y en la fila de la
  vista Lista (expandible para no alargar la lista).

## C. Botones
- `booking-actions.tsx`: grupos con etiqueta (Resultado / Cambios), variantes
  locales: Realizada `default`; resto `outline` con `border-strong` y texto
  `foreground`; Cancelar/Quitar bloqueo separado, `outline` rojo
  (`border-destructive text-destructive`) + confirmación (diálogo existente
  del repo si lo hay, si no, confirmación en línea de dos pasos). Sin tocar
  `button.tsx`.

## Verificación
- Gate: `pnpm typecheck && pnpm lint && pnpm build && pnpm test`.
- E2E en BD aislada (:5433/.env.e2e, `CATALOG_STORAGE=local` explícito):
  extender `scripts/e2e-respuestas-rapidas.mjs` (CA-1..3) y
  `scripts/e2e-agenda-calendario.mjs` o nuevo `scripts/e2e-cita-cliente.mjs`
  (CA-4..7, con Propietario y Vendedor). Regresión: `e2e-roles`,
  `e2e-catalogo`, `e2e-agenda-presencial(-ui)`, selftest.

## Ajustes tras la revisión de Fable (23-oct)
1. Interruptor: `PUT /api/settings/inbox` (no PATCH). `saveInboxSettings`
   (`src/server/inbox/archive.ts:189-205`) hace upsert del objeto completo y la
   pestaña Bandeja no manda el campo nuevo → el campo va `.optional()` y solo
   entra a `values`/`set` si viene definido (lo mismo para `overdueMinutes`).
   El Vendedor no lee `/api/settings/inbox` (owner): `canCreate` viaja en
   `GET /api/quick-replies` (aditivo a `{ quickReplies }`).
2. «Etiquetas» del contacto no existen: se muestran **etapa + prioridad +
   fuente** (lo que la Bandeja pinta como chips).
3. Política: 403 solo a `productId`/`attach` **no nulos** y a cualquier
   `position` (el cliente de ajustes manda `productId: null` siempre).
   `QuickReplyError` gana `"forbidden"`; update/delete leen primero (la
   existencia no es secreta: el GET lista todo) y repiten el filtro en el WHERE.
   Filas con `created_by_user_id` null = solo Propietario.
4. Privacidad: `GET /api/contacts/[id]` ya es "any" sin filtro (decisión D4:
   Contactos lo ven todos los roles). El endpoint nuevo omite canal/anuncio
   en `restricted`, pero eso es coherencia de UI, no una barrera. Se reporta
   al dueño; no se amplía el alcance a `/api/contacts`.
5. Tests que cambian: `tests/unit/role-nav.test.ts` (Vendedor ve también
   Respuestas rápidas) y `scripts/e2e-respuestas-rapidas.mjs:218-232` (hoy
   exige 403/404 al Vendedor). Mover la página fuera de `(owner)` no cambia
   la URL. Toda ruta nueva va en `ROUTE_POLICY` con `withAuth(`.
6. Botones: `outline` ya usa `--border-strong`; destructivo = `--danger`.
   «Cancelar» → «Cancelar cita» con confirmación inline de dos pasos (patrón
   `confirmingId` de `quick-replies-client.tsx`). No tocar el texto
   «Reprogramar» ni los `data-testid` de reasignar (los leen los E2E).
7. Endpoint de cita: usar `getVisibleBooking` (`queries.ts:87-107`) para el
   404; conversación más reciente con `is_test=false`; reutilizar
   `serializeContact` y `anuncioDelContacto` (`attribution/store.ts:127`).
