# E2E — "Por atender" que dice la verdad (026)

Guion de comportamiento observable. Automatizado por API en
`porAtenderChecks` de `scripts/e2e-selftest.mjs`; la pastilla, los
distintivos de la fila y el estado vacío, en `scripts/e2e-search-filters.mjs`
(ver [us-busqueda-filtros.md](us-busqueda-filtros.md)); el recorrido paginado
de `filter=human`, en `scripts/e2e-bandeja-paginacion.mjs`.

**Preparación**: app viva con `WA_MOCK_ENABLED=true`,
`META_GRAPH_BASE_URL` → wa-mock y `OPENROUTER_BASE_URL` → ai-mock, BD aislada
migrada (0027). El ai-mock escala cuando el cliente pide "un asesor".

**Definiciones** (spec 026): en manos de una persona = `handoffAt` no nulo o
`aiEnabled=false`. Esperando = en manos de una persona ∧ `awaitingSince` no
nulo; Atendida = en manos de una persona ∧ `awaitingSince` nulo. Atrasada =
esperando ∧ espera ≥ umbral (Ajustes → Bandeja, 60 min por defecto).

---

## US-1 — Saber de un vistazo si falta contestar

1. Un cliente nuevo escribe con la IA al mando.
   ✅ `awaitingSince` = la hora de su mensaje, pero NO está en
   `filter=human` (no está en manos de una persona).
2. **CA-4** Pide "un asesor" con el agente encendido: la IA escala (con o sin
   despedida).
   ✅ `handoffAt` no nulo y `awaitingSince` no nulo (espera a la persona).
3. **CA-1** Vuelve a escribir.
   ✅ Sigue esperando (la espera NO se mueve: cuenta desde el primer mensaje
   sin contestar), aparece en `filter=human` y `counts.human` sube en uno.
   ✅ En la fila: «Esperando · X» en ámbar, con la hora de inicio en el
   `title`; la etiqueta avanza sola (reloj de 1 min).
4. **CA-5** Camino infeliz: con el wa-mock en `fail-sends: error`, el operador
   intenta contestar.
   ✅ El envío falla y la espera sigue abierta (un saliente fallido no
   atiende). Un recordatorio de cita tampoco atiende (`sendTemplate`
   con `attends: false`, cubierto por unit).
5. **CA-2** El operador contesta desde el CRM.
   ✅ `awaitingSince: null`, la fila pasa a «Atendida» (neutra, con
   palomita) sin recargar, sale de `filter=human` y el contador vuelve al de
   antes. El escalamiento sigue abierto (contestar no lo cierra).
6. **CA-3** El cliente vuelve a escribir.
   ✅ `awaitingSince` = la hora de ESE mensaje; vuelve a «Esperando» y a la
   vista.
7. **CA-6** El dueño contesta desde el teléfono (eco del wa-mock).
   ✅ `awaitingSince: null` (el eco ES una respuesta humana); la IA sigue en
   pausa como hoy.

## US-2 — Cerrar un caso sin tener que escribir

8. **CA-7a** Con el cliente esperando, en el panel: «Marcar como atendida» →
   «Seguir atendiendo yo» (`PATCH { attended: true }`).
   ✅ Atendida, sin tarjeta «Escalada a una persona» (`handoff*` nulos), IA
   en pausa, fuera de la vista.
   ✅ `{ attended: true, reactivate: true }` → 422.
9. Con la IA en pausa (sin escalar), el cliente escribe.
   ✅ Vuelve a «Esperando» y a la vista.
10. **CA-7b** «Marcar como atendida» → «Devolver a la IA»
    (`{ attended: true, aiEnabled: true }`).
    ✅ Atendida, IA activa, fuera de la vista.
11. «Reactivar IA» (`{ reactivate: true }`) con el cliente esperando.
    ✅ También cierra la espera.
11b. Bot externo: `POST /api/bot/handoff` y LUEGO `POST /api/bot/messages`
    (despedida) sobre una conversación nueva.
    ✅ El envío responde 409 `ai_paused` (la puerta de la ruta); la espera
    sigue abierta con la misma hora y el chat sigue en «Por atender». Si la
    puerta se relajara, `closeAwaitingByAiSql` mantiene la espera abierta.

## US-3 — Umbral configurable

12. **CA-8** Ajustes → Bandeja (Propietario): «Marcar como atrasada tras N
    minutos» = 5 (`PUT /api/settings/inbox`).
    ✅ 200; 4, 1441 y 7.5 → 422; un cliente viejo sin el campo conserva el umbral guardado (029: PUT parcial).
    ✅ Un chat con 10 min de espera sale en rojo en la Bandeja (la página
    del servidor baja `overdueMinutes: 5` a la lista y al panel; el cambio se
    ve al recargar, sin SSE).
    ✅ Se restaura el umbral original.

## Migración

13. **CA-9** `drizzle/0027_por_atender_claro.sql` sobre una BD con datos
    (verificado a mano en una BD desechable del contenedor E2E):
    ✅ escalados abiertos sin respuesta humana posterior → esperando desde el
    primer entrante tras la última respuesta (o desde el escalamiento); los
    contestados → atendida; `manual_reply` → atendida; `is_test` → nulo.
    ✅ Re-ejecutarla no toca datos (no reabre las cerradas a mano).
