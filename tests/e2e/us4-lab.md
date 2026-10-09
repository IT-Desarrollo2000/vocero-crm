# Guion E2E — US4: Laboratorio (SIEMPRE contra ai-mock, determinista)

> Conducido con Playwright (MCP) contra `pnpm dev` con ai-mock. El KB inicial
> NO cubre garantías/devoluciones (hueco intencional del guion).

## Preparación

1. `DELETE /api/dev/wa-mock/outbox` — el outbox debe seguir VACÍO al final.
2. Agente configurado (US3) y proveedor de IA (mock) activo.

## Corrida 1

3. En `/lab`: pulsar "Correr evaluación".
   ✅ La UI muestra el subtítulo permanente "Sandbox interno — no envía
   mensajes reales", progreso en vivo (n/6) sin bloquear la navegación.
4. Al terminar:
   ✅ Reporte con score global (5 verdes + 1 rojo ≈ 83), tarjeta de la persona
   "Pregunta fuera del conocimiento" con hallazgo `fuera_de_kb`, evidencia y
   sugerencia; transcript visible por persona.
   ✅ La persona "Pide un humano" terminó en handoff (guion cortado).
   ✅ `GET /api/dev/wa-mock/outbox` → VACÍO (ningún mensaje salió a WhatsApp).
   ✅ Las conversaciones de prueba NO aparecen en la bandeja.

## Cerrar el loop

5. En el hallazgo: "Agregar al conocimiento" → editar/confirmar → guardado en
   el KB (visible en `/agent`).
6. Re-correr la evaluación.
   ✅ El historial muestra 2 corridas; la nueva con score 100 y delta +17.

## Caminos infelices

7. Con una corrida en curso, `POST /api/lab/runs` → 409 `run_in_progress`.
8. Corridas huérfanas: cubierto por `src/instrumentation.ts` al boot
   (verificación en el checkpoint de compose, donde el server se reinicia).

## Eliminar una evaluación

> Automatizado en `scripts/e2e-selftest.mjs` (`labChecks`, sección
> "Laboratorio: eliminar evaluación").

9. `POST /api/lab/runs` → 202 `{ runId }` e INMEDIATAMENTE
   `DELETE /api/lab/runs/{runId}`.
   ✅ 409 `run_in_progress` ("No se puede eliminar una evaluación en curso").
   En la UI, la fila de una corrida en curso no muestra el botón de eliminar.
10. Esperar a que la corrida termine (`GET /api/lab/runs/{runId}` con status
    `done`/`failed`) y anotar los `conversationId` de sus casos.
    ✅ `GET /api/conversations/{conversationId}/messages` → 200 para cada una.
11. En `/lab`: icono de papelera de la fila ("Eliminar evaluación") →
    "¿Eliminar?" → "Sí, eliminar" (o `DELETE /api/lab/runs/{runId}`).
    ✅ 200; la fila desaparece del historial; si era la seleccionada, se
    selecciona la siguiente (o el estado vacío si no queda ninguna).
    ✅ `GET /api/lab/runs/{runId}` → 404 y la lista ya no la incluye.
    ✅ `GET /api/conversations/{conversationId}/messages` → 404 para cada
    conversación de prueba (se borraron junto con sus mensajes y citas de
    prueba). Los contactos sintéticos del Laboratorio se conservan.
12. `DELETE` repetido o de un id inexistente / de otra organización → 404.
13. "Cancelar" en la confirmación no borra nada; un error del servidor se
    muestra en la fila sin cerrar la confirmación.

## Eliminar una evaluación — UI

> Automatizado en `scripts/e2e-lab-eliminar.mjs`
> (`node --env-file=.env.e2e scripts/e2e-lab-eliminar.mjs`, app viva con
> ai-mock). Capturas en `scratch/lab/`. El id de la corrida no se pinta: lo
> que muestra el reporte se comprueba por el `GET /api/lab/runs/{id}` que lo
> alimenta.

14. Sin corridas en curso, lanzar una (`POST /api/lab/runs`) y abrir `/lab`.
    ✅ La primera fila del historial muestra "En curso…" y NO tiene el botón
    "Eliminar evaluación".
15. Esperar a que termine y lanzar una segunda (≥2 corridas terminadas);
    recargar `/lab`.
    ✅ Una fila por corrida, la más reciente primero.
16. En la primera fila: "Eliminar evaluación" → "¿Eliminar?" + "Sí, eliminar"
    → "Cancelar".
    ✅ La confirmación se cierra y vuelve la papelera; el nº de filas no
    cambia; no se llamó a `DELETE`; `GET /api/lab/runs/{runId}` → 200.
17. Elegir la corrida anterior y luego la más reciente.
    ✅ El reporte carga cada una (`GET /api/lab/runs/{id}` → 200) y la fila
    elegida queda resaltada.
18. Con la más reciente seleccionada: "Eliminar evaluación" → "Sí, eliminar".
    ✅ `DELETE` → 200; la fila desaparece (nº de filas −1);
    `GET /api/lab/runs/{runId}` → 404 y la lista ya no la incluye.
    ✅ El reporte pasa solo a la siguiente corrida (se pide su detalle y su
    fila queda resaltada); el panel no cae al estado vacío.
    ✅ Sin errores de página (`pageerror`).
