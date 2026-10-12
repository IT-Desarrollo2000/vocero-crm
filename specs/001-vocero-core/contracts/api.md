# Contrato: API interna (App Router route handlers)

Todas autenticadas por sesión Better Auth y scoped a la organización del usuario
(helpers de `lib/db/tenant`). Validación Zod en todo body/query. Errores:
`{ error: { code, message } }` con status apropiado; nunca stack traces ni secretos.

| Método y ruta | Propósito |
|---|---|
| `GET /api/health` | healthcheck deploy: `{ ok: true }` + check de BD |
| `GET /api/events` | SSE (ver sse.md) |
| `GET /api/conversations?limit=&cursor=&filter=&stage=&channel=&q=&assigned=` | lista bandeja (excluye `is_test`) de lo VISIBLE para quien pide (09: Vendedor = suyas + sin asignar) → `{ conversations, nextCursor }`. 06: keyset por `(coalesce(last_message_at, created_at), id) DESC`; `limit` [1, 200] (ilegible → 50); `cursor` = el `nextCursor` opaco anterior (basura → 1.ª página); `filter=all|unread|human|mine|unassigned|closing` (05: `closing` = «Ventana por cerrar», último entrante hace > 22 h y < 24 h por canal con ventana, cortes calculados en Node); `stage=<stageId>`; `channel=whatsapp|instagram|messenger`; `q` nombre sin acentos / teléfono por dígitos. Todo tolerante salvo `assigned=me|unassigned|all` (def. `all`; otro → 422 `invalid_query`). **Sin `limit` = lista completa con `nextCursor: null` (deprecado, D-06-1).** Modos sueltos, por precedencia: `ids=a,b` (máx. 50; solo visibilidad, ignora filtros: ausente = no visible) > `contact=<contactId>` (0 o 1) > `since=<ISO>` (compat, tope 500). Cada fila trae `assignedTo` / `assignedAt` / `sortAt` / `stageId` |
| `GET /api/conversations/counts?stage=&channel=&q=&assigned=` | 06 — `ConversationCounts` sobre lo visible: pastillas (`all/unread/human/mine/unassigned/closing` = base ∧ canal), `byChannel` (base, sin canal), `unreadConversations`/`unreadMessages` (solo visibilidad; badge = `unreadConversations`), `teamMode`. `assigned` inválido → 422 |
| `GET /api/conversations/:id` | 06 — `{ conversation }` con la visibilidad de quien pide; 404 si no existe, es `is_test` o no la ve |
| `POST /api/conversations/:id/assign` | 09 — tomar / liberar / asignar `{ userId \| null, expect? }` (ver dev-tasks/09 "Contrato 09-0") |
| `GET/POST /api/quick-replies`, `PATCH/DELETE /api/quick-replies/:id` | 09 — respuestas rápidas (GET cualquier rol; escritura Propietario) |
| `GET /api/conversations/:id/messages?since=` | hilo + catch-up — 404 si no es visible para quien pide (09) |
| `POST /api/conversations/:id/messages` | enviar texto `{ text }` — 409 si ventana cerrada; 404 si no es visible; Vendedor: "responder = tomar" (el reclamo atómico es la compuerta: si otro la tomó, 404 y no sale nada) |
| `POST /api/conversations/:id/messages/template` | enviar plantilla `{ templateId, variable }` — misma visibilidad y compuerta que el texto (también `messages/media`) |
| `PATCH /api/conversations/:id` | `{ aiEnabled? , reactivate?, markRead? }` (quita handoff) — 404 si no es visible (predicado en el WHERE del UPDATE) |
| `GET/POST /api/contacts`, `PATCH /api/contacts/:id` | lista/búsqueda `?q=`, paginada `?limit=` (def. 50, máx 200) `&offset=` → `{ contacts, total, nextOffset }`; notas, archivar |
| `GET/POST/PATCH/DELETE /api/pipeline/stages(/:id)` | etapas (DELETE exige `moveTo`) |
| `PATCH /api/pipeline/leads/:id` | `{ stageId, position }` (drag & drop) |
| `GET/PUT /api/agent/profile` | comportamiento + toggle global |
| `GET/POST/PATCH/DELETE /api/kb(/:id)` | knowledge base CRUD |
| `GET /api/kb/size` | tamaño estimado del KB (contador/aviso) |
| `POST /api/lab/runs` | lanzar corrida — 409 si hay una `running` |
| `GET /api/lab/runs` / `GET /api/lab/runs/:id` | historial con delta / detalle+progreso |
| `POST /api/lab/suggestions/apply` | `{ caseId, hallazgoIndex, pregunta, respuesta }` → crea kb_entry |
| `GET/POST /api/templates` | lista / crear+enviar a aprobación |
| `POST /api/templates/sync` | sincronizar estados por Graph (pull; cubre modo agencia) |
| `GET /api/pipeline/board` | etapas + tarjetas del kanban en una llamada |
| `GET/PUT /api/settings/whatsapp` | estado conexión / guardar credenciales |
| `POST /api/settings/whatsapp/test` | probar conexión (valida token↔número, NO guarda) |
| `GET /api/settings/webhook` | URL completa del webhook + estado firma |
| `GET/POST /api/settings/team` | miembros / crear cuenta (owner only) |
| `GET /api/reports/agent?range=` | 02 — métricas M1–M8 del agente (owner only; ver abajo) |
| `POST /api/seed/demo` | cargar demo (solo BD vacía de dominio; idempotente) |
| `POST /api/auth/[...all]` | Better Auth (registro gated por 1ª org / `ALLOW_SIGNUP`) |

Rate limiting in-process por IP en endpoints de auth (login/registro): ventana
deslizante, 10 intentos / 10 min → 429.

## `GET /api/reports/agent` (02 — Reportes → Agente)

Solo Propietario (`withAuth(..., { role: "owner" })`): el Vendedor recibe 403
`forbidden`. Tipos en `src/lib/reports.ts` (`AgentReportDto`), compartidos con
la UI. Siempre excluye el Laboratorio (`is_test`).

Query (días calendario en la zona del negocio: `calendar_settings.timezone` si
existe, si no `America/Mexico_City`):

- `range=7d|30d|90d` — N días locales que terminan hoy (sin parámetros → `30d`).
- `range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD` — `to` inclusive, máx. 366 días.
- Compatibilidad: `range=7|30|90` y `from`/`to` sin `range` (mandan sobre un preset).

Respuestas:

- 200 `{ range, attention, escalations, responseTimes, afterHandoff, failures, delivery, volume }`,
  `Cache-Control: private, max-age=60`. `range` = `{ preset, from, to, days[], tz, fromUtc, toUtc }`
  (límites UTC `[fromUtc, toUtc)`). Cada otro campo es un bloque
  `{ ok: true, data } | { ok: false, error: "timeout" | "unavailable" }` que
  degrada por separado. Proporciones 0..1, `null` sin denominador.
  - `attention` (M1+M2): `{ active, aiOnly, aiAndHuman, humanOnly, noReply, aiOnlyRate }`
  - `escalations` (M3): `{ total, byReason: [{ reason, label, count, samples: [{ conversationId, contactId, contactName, note, occurredAt }] }], manualReplyPauses, approximate: boolean }` — `manual_reply` NO entra en `total`/`byReason`: va en `manualReplyPauses` («Pausas por respuesta manual»); los eventos sembrados por 0017 (`approximate`) cuentan para totales.
  - `responseTimes` (M4): `{ ai: { sessions, p50Seconds, p90Seconds }, human: {…}, unanswered }`
  - `afterHandoff` (M5, solo eventos exactos y sin `manual_reply`): `{ attended, unattended, p50Seconds, p90Seconds }`
  - `failures` (M6): `{ total, failed, rate, byOrigin: [{ origin, total, failed }], byChannel: [{ channel, total, failed }], topErrors: [{ error, count }] }`
  - `delivery` (M7, canales con `deliveryReceipts`, sin `manual`, sin los últimos 15 min): `{ channels, base, delivered, read, unconfirmed, deliveryRate, readRate }`
  - `volume` (M8): `{ rows: [{ day, channel, inbound, outbound }] }` — una fila por día del rango × canal (WhatsApp siempre + los presentes), ceros incluidos.
- 422 `invalid_range` — fecha ilegible o inexistente, `from > to`, > 366 días, preset desconocido, `custom` sin `from` + `to`.
- 503 `report_timeout` («Prueba un rango más corto») — todos los bloques fallaron y al menos uno por tiempo.

Ejecución: cada bloque en su transacción `READ ONLY` con
`statement_timeout = 15 s`, de 2 en 2 (el pool es `max: 10` y compite con el
webhook), presupuesto total 30 s.
