# 033 — Tareas

Spec: [spec.md](spec.md). Sin migraciones (la llave del candado es el texto
renderizado).

## Servidor (H2)
- [x] T1 `src/lib/template-sent.ts` (puro): `TEMPLATE_DUPLICATE_WINDOW_MIN = 10`
  (ventana acordada con el dueño), `TEMPLATE_DUPLICATE_CODE`, `minutesSince`,
  `duplicateMessage` («hace menos de 1 min» con n = 0).
- [x] T2 `findRecentDuplicate()` en `src/server/whatsapp/templates.ts`
  (`scoped()` por organización; `out` + `template` + `status != failed` +
  mismo texto + últimos 10 min).
- [x] T3 `sendTemplate({ guardDuplicates })` opcional: comprueba tras las
  validaciones y antes de Meta; lanza `TemplateError("template_recently_sent")`
  → 409. Los recordatorios no lo pasan (sin candado).
- [x] T4 Rutas humanas aceptan `force?: boolean` (Zod) y piden el candado sin
  `force`: `POST /api/conversations/[id]/messages/template` y
  `POST /api/contacts/[id]/start-conversation`. Sin rutas nuevas.

## Cliente
- [x] T5 `TemplateSendResult` con `{ ok: false, duplicate: true, message }`,
  `templateSendFailure()` (por código, no por status) y `send(…, { force })`
  en la Bandeja y en «Escribir primero».
- [x] T6 Aviso de duplicado en «Revisa y envía» en lugar del botón
  (`template-duplicate-warning`): «Cancelar» / «Enviar de todos modos». Se
  limpia al cambiar de plantilla o de valor.
- [x] T7 `lastTemplateSent(messages)` (regla pura) → `inbox-client` →
  `Composer` → `TemplateSender` (`lastTemplate`).
- [x] T8 Tarjeta «Plantilla enviada» (`template-sent-card`) con la hora de la
  burbuja (`bubbleTime` movido a `helpers.ts`), nombre de la plantilla
  reconocido por el texto (`matchTemplateByText`, se omite si no se reconoce),
  chip de estado y «Enviar otra plantilla» (estado local por id del último
  envío; se reinicia al cambiar de chat por la `key` del Composer).
- [x] T9 «Enviar otra plantilla a {nombre}» como encabezado de los pasos.
- [x] T10 Último envío `failed`: pasos + aviso `template-last-failed`.

## Pruebas
- [x] T11 `tests/unit/template-sent.test.ts`: regla de la tarjeta, textos,
  reconocimiento de plantilla, `findRecentDuplicate` (con `scoped`) y el
  candado de `sendTemplate` (con/sin `guardDuplicates`).
- [x] T12 `scripts/e2e-plantilla-enviada.mjs` + `tests/e2e/us-plantilla-enviada.md`;
  check del 409 en `scripts/e2e-selftest.mjs` (021b).
- [x] T13 Revisión de E2E existentes: ninguno manda la misma plantilla dos
  veces a la misma conversación en < 10 min por las rutas humanas en una
  corrida (multivar usa textos distintos; asignación usa ids falsos).
- [x] T14 Gate: typecheck + lint + build + test.
- [x] T15 E2E en la BD aislada (:5433, `.env.e2e`, `CATALOG_STORAGE=local`).
- [x] T16 Diseño aprobado por el dueño en el lienzo (11-nov).
- [x] T17 Sin parpadeo: `messagesFor` en `inbox-client` → `threadReady`; con el hilo sin cargar, encabezado + «Cargando…» (ni pasos ni tarjeta). E2E: los pasos nunca se asoman antes de la tarjeta.
- [x] T18 Aviso de fallo: punto tras el motivo si no termina en «.», «!» o «?».
