# Guion E2E — Reportes → Agente (métricas M1–M8)

> Automatizado en `scripts/e2e-metricas.mjs` (API + Playwright, app viva con
> wa-mock, ai-mock y `BOT_API_KEY`; BD aislada de `.env.e2e`, Postgres :5433).
> Spec: `dev-tasks/02-metricas-del-agente.md` (manda «Contrato 05/02-0»).
>
> `node --env-file=.env.e2e scripts/e2e-metricas.mjs`

## Cómo se aíslan los números

La BD de E2E trae datos de otros guiones. Por eso:

1. Se toma una **línea base** de `GET /api/reports/agent` antes de sembrar.
2. Lo sembrado (A–E y una conversación del Laboratorio) se **traslada por SQL**
   K días al pasado (120–359, al azar), conservando la hora: los tiempos de
   respuesta no cambian. Se consulta ese día con
   `range=custom&from=D-1&to=D+1` y se comparan **deltas**.
3. Lo esperado de M6/M7/M8 se calcula de los mensajes que de verdad quedaron
   (`GET /api/conversations/:id/messages`), no de supuestos.

M7 ignora lo de los últimos 15 min; al vivir en el pasado, los acuses de
A (leído) y B (entregado) sí se pueden verificar.

## Siembra

| | Cómo | Debe contar como |
|---|---|---|
| A | inbound con el agente encendido → responde ai-mock | Solo IA; sesión IA |
| B | inbound → IA responde → `POST /api/bot/handoff` `cliente` + nota → el operador contesta | IA + humano; M3 «El cliente pidió un humano» con la nota y el contacto; M5 atendido |
| C | inbound con el agente apagado → 2 salientes del operador; la 2ª `failed` por `wa-mock/status` | Solo humano; sesión humana; M6 +1 fallida |
| D | inbound sin respuesta + evento `opened` `modelo` **aproximado** (SQL, como la siembra de 0017) | Sin respuesta; M3 +1 `modelo`; aviso de datos aproximados; M5 NO |
| E | inbound → echo del teléfono (`wa-mock/echo`) → pausa `manual_reply` | Solo humano; «Pausas por respuesta manual» +1; fuera de M3 y M5 |
| Lab | conversación `is_test` con entrante y saliente fallida (SQL) | nada |
| Viejo | entrante de hace 40 días (SQL) | fuera de `30d`, dentro de `90d` (CA-02-04) |

## Checks por la API

- M1 +5 activas · M2: Solo IA +1, IA + humano +1, Solo humano +2, Sin respuesta +1
  (y `aiOnlyRate = 0.2` si el día estaba vacío).
- M3 +2 (`cliente`, `modelo`), nunca `manual_reply` en `byReason`; muestra con
  la nota de B, `contactName`, `conversationId`; `approximate = true`;
  `manualReplyPauses` +1.
- M4: sesiones IA +2, humanas +2, sin respuesta +1 (mediana IA < 60 s).
- M5: atendidos +1, no atendidos +0 (el aproximado y `manual_reply` no entran).
- M6: salientes y fallidas = las observadas; cortes por canal y origen; top de errores.
- M7: base / entregados / leídos = los observados sin `manual`; `channels = ["whatsapp"]`.
- M8: entrantes y salientes = los observados; 3 filas de WhatsApp (días en cero incluidos).
- 422 `invalid_range`: `from > to`, 400 días, `range=15d`, `2026-02-30`.
- Vendedor (alta por `POST /api/settings/team`): `GET /api/reports/agent` → 403 `forbidden`.

## Checks de UI (selectores de la pantalla 02-B)

- Menú «Reportes» (Propietario sí, Vendedor no); `/reports` → 404 al Vendedor.
- Títulos: «Reparto de atención», «Volumen por día y canal», «Escalamientos por
  motivo», «Tiempo a primera respuesta», «Salientes fallidas», «Entrega y lectura».
- KPIs `data-testid`: `kpi-active` (mismo número que la API), `kpi-ai-only`,
  `kpi-escalations`, `kpi-ai-p50`, `kpi-failed`.
- `[data-testid="manual-reply-pauses"]` dice «Pausas por respuesta manual: N».
- `[data-testid="approximate-notice"]` visible; tabla
  `[aria-label="Escalamientos por motivo"]` con la nota de B.
- `[role=group][aria-label="Rango del reporte"]` → «90 días» pone `range=90d`
  en la URL y `svg[data-testid="volume-chart"]` queda con `data-days="90"`.
