# Guion E2E — Alertas en la Bandeja

> Automatizado en `scripts/e2e-alertas.mjs` (API + Playwright, app viva con
> wa-mock, ai-mock y `BOT_API_KEY`; BD aislada de `.env.e2e`, Postgres :5433).
> Spec: `dev-tasks/05-alertas-en-la-bandeja.md` (manda «Contrato 05/02-0»).
>
> `node --env-file=.env.e2e scripts/e2e-alertas.mjs`

## Cómo se observa una notificación

Headless no muestra notificaciones del sistema. El guion reemplaza
`window.Notification` con `addInitScript` por un registrador:

- `Notification.permission` sale de `localStorage` (sobrevive a la navegación);
  `requestPermission()` lo cambia al valor configurado (`granted`).
- Cada `new Notification(title, { body, tag, data })` se anota en
  `sessionStorage` de esa pestaña; el guion suma las anotaciones de TODAS las
  pestañas del mismo contexto (comparten Web Locks y `BroadcastChannel`).

## Pasos

| # | Acción | Resultado esperado |
|---|---|---|
| a | Owner entra y conecta WhatsApp (wa-mock); alta de un vendedor con `POST /api/settings/team` | 201 y sesión del vendedor |
| b | Owner abre `/inbox` con permiso `default` | Aviso «Activar avisos»; al pulsarlo se concede el permiso, el aviso desaparece y `vocero.alerts.v1.<userId>` queda con `notifications: true` |
| c | Dos pestañas (`/pipeline`, `/contacts`); entra un mensaje de «Ana» | **Una** notificación entre ambas, `tag = conv:<id>`, título «Ana…», clic → `/inbox?contact=<contactId>`; título de ambas con «(N) » (N = `counts.unreadConversations`); favicon `data:image/png` con punto |
| d | Una pestaña abre la conversación de Ana en la Bandeja; Ana escribe otra vez | 0 notificaciones (RF-05-04) |
| e | Entra «Beto» y el cerebro externo escala (`POST /api/bot/handoff`, `cliente`) | 1 notificación «Un cliente espera que lo atiendas» con el motivo en español |
| f | Entra «Caro» y el dueño contesta desde el teléfono (`/api/dev/wa-mock/echo`) | La conversación queda en pausa `manual_reply`, pero 0 notificaciones (RF-05-03) |
| g | El vendedor (otro navegador) activa sus avisos; el owner se asigna la de Ana y Ana escribe; luego entra «Dani» sin asignar | Vendedor: 0 por la de Ana (el SSE no se la entrega), 1 por la de Dani |
| h | SQL directo: `last_inbound_at` de Caro = hace 23 h y de Beto = hace 10 h | `filter=closing` trae a Caro y no a Beto; `counts.closing` = filas de la lista; pastilla «Ventana por cerrar» con ese número; el renglón de Caro dice «Cierra en 59m» (aprox.); a 360 px la fila de pastillas no se desborda |
| i | Permiso `denied` | «Mi cuenta» muestra «Bloqueaste las notificaciones…» con instrucciones; el título sigue con «(N)»; sin aviso en la Bandeja |
| i | `Notification` inexistente | El panel explica que el navegador no las permite; 0 errores de página |

Además, en todo el recorrido: 0 errores de página (`pageerror`).

## Fuera del guion automático

- Sonido (Web Audio): apagado por defecto; se prueba a mano con «Probar» en
  «Mi cuenta».
- Laboratorio: `markHandoff` no publica eventos para `is_test` (unit
  `handoff-event.test.ts`); el sandbox no publica `message.new`.
