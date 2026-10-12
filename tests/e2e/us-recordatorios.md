# Guion E2E — Recordatorios de cita y reporte de citas

> Tarea `dev-tasks/10-recordatorio-de-citas-y-no-shows.md` («Contrato 10-0»).
> Automatizado en `scripts/e2e-recordatorios.mjs` (HTTP real, dos cookie jars,
> wa-mock y reloj SIMULADO del ticker):
>
> ```bash
> # app viva con mocks (WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL → wa-mock,
> # OPENROUTER_BASE_URL → ai-mock), AGENDA=on, AGENDA_REMINDER_TICK_MS=0 y BD
> # migrada (0018 incluida); en local, la BD aislada de .env.e2e
> node --env-file=.env.e2e scripts/e2e-recordatorios.mjs
> ```
>
> Gasta hasta 3 POST de inicio de sesión (alta del owner ya existente, su
> inicio de sesión y el Vendedor). Requiere el ai-mock para la corrida del
> Laboratorio del paso g). El reloj real del ticker va
> apagado (`AGENDA_REMINDER_TICK_MS=0`): cada vuelta la fuerza
> `POST /api/dev/reminders/tick { now }`, que llama `runReminderTick` DIRECTO
> (sin el candado del proceso), así dos POST en paralelo ejercitan el UNIQUE.
> Los envíos se comprueban por TELÉFONO en el outbox: la org del self-test
> puede tener citas de corridas anteriores. El paso j) espera ≤ 2 min reales.
> `pnpm test:e2e` cubre además la bandera y que las superficies respondan.

## a) Bandera

1. Con `AGENDA` apagada: `POST /api/dev/reminders/tick` y
   `GET /api/reports/bookings` → 404 sin cuerpo. El guion termina limpio.

## b) Preparación

2. El owner conecta WhatsApp (wa-mock), da de alta a un Vendedor
   (`POST /api/settings/team`) y abre la agenda 24/7, 7 días, sin aviso mínimo.

## c) Ajustes de recordatorio (solo Propietario)

3. Crea la plantilla «Hola {{1}}, te recordamos tu cita el {{2}}.», el
   wa-mock la aprueba (`/api/dev/wa-mock/template-status`) y se sincroniza.
4. Activar con una plantilla pendiente → 422 con mensaje; con mapeo
   incompleto → 422.
5. Apagar y activar con la aprobada, 24 h y `[contact_name, booking_datetime]`
   → 200 con `reminders.enabled`, `enabledAt` y sin `warning`.
6. El Vendedor intenta tocar los recordatorios → 403.

## d) Un solo envío aunque corran dos ticks

7. Cita A a ~40 h (`POST /api/bookings`). La cita muestra el recordatorio
   `pending` con su `dueAt`.
8. Tick con `now = vencimiento − 5 min` → ninguna plantilla.
9. Dos ticks EN PARALELO con `now = vencimiento + 1 min` → UNA plantilla al
   teléfono de A, con el nombre y la fecha en la zona del negocio; la cita
   muestra `sent` (también para el Vendedor).
10. Webhook de estado `delivered` (`/api/dev/wa-mock/status`) → la cita
    muestra entregado.

## e) Reprogramar

11. Reprogramar A → el recordatorio vigente vuelve a `pending` para la hora
    nueva; tick en la ventana nueva → segunda plantilla; el anterior queda de
    historial (no se muestra).

## f) Cancelar y gracia

12. Cita B cancelada → tick en su ventana → nada y sin recordatorios.
13. Cita D: tick con `now` más allá de la gracia (6 h) → nada, sin fila.

## g) Laboratorio

14. Corrida del Laboratorio; cita creada con la conversación de un caso
    (`is_test`) → tick en su ventana → la cita es de prueba, sin
    recordatorios y sin plantilla en el outbox.

## h) Camino infeliz

15. `POST /api/dev/wa-mock/fail-sends { mode: "error" }`, D reprogramada al
    hueco siguiente, tick → `failed` con motivo y `canRetry`; la cita sigue
    `agendada`.
16. Con el mock sano, el VENDEDOR reintenta
    (`POST /api/bookings/:id/reminders/:reminderId/retry`) → 200 `sent`,
    `attempts: 2`; segundo reintento → 409; con otra cita → 404.

## i) Reporte de citas

17. Owner: `GET /api/reports/bookings?range=custom&from=hoy&to=hoy+7` → 200
    con `offers`, `attendance` y `byReminder`.
18. Marcar A `realizada` y D `no_show` → `realizada` +1, `noShow` +1, tasa =
    realizada / (realizada + no_show), ambas en «con recordatorio».
19. Vendedor → 403.

## j) Encender hoy no avisa lo que venció antes

20. Anticipaciones `[24 h, k]` con `k` a la medida para que la cita E venza
    en 1–2 min; crear E; esperar a que venza; apagar → encender (reescribe
    `enabledAt` > vencimiento); tick en la gracia → nada para E.
21. Se restauran las anticipaciones a `[24 h]`.
