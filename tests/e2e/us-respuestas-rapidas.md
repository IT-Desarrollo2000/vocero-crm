# Guion E2E — Respuestas rápidas

> Tarea `dev-tasks/09-equipo-asignacion-y-respuestas-rapidas.md` (parte b).
> Automatizado en `scripts/e2e-respuestas-rapidas.mjs` (HTTP real +
> Playwright con las cookies del jar):
>
> ```bash
> # app viva con mocks (WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL → wa-mock)
> # y BD migrada (0015 incluida); en local, la BD aislada de .env.e2e
> node --env-file=.env.e2e scripts/e2e-respuestas-rapidas.mjs
> ```
>
> Gasta 2 inicios de sesión (owner y vendedora con sufijo aleatorio). Antes de
> empezar borra las respuestas con atajo `hor…` de corridas previas.
>
> Selectores de UI que asume: campo del compositor con placeholder
> "Escribe una respuesta…"; selector `role="listbox"` con aria-label
> "Respuestas rápidas" y cada respuesta como `role="option"` (texto con
> `/atajo` y título); enlace directo `/inbox?contact=<id>`; página
> `/settings/quick-replies`.

## a) El Propietario gestiona el catálogo

1. Crear `/Horario` (con espacios y mayúscula) con
   `Hola {{nombre}}, abrimos de 9 a 6. — {{vendedor}}`.
   ✅ 201; se guarda como `horario` y el cuerpo sin renderizar.
2. Crear una con `{{telefono}}` → 422 `unknown_variable` y el mensaje nombra
   `{{telefono}}`. Crear `HORARIO` otra vez → 409 `duplicate_shortcut`. Atajo
   con espacios → 422 `invalid_body`.
3. Crear "Ubicación" → queda al final; moverla a `position: 0` → 200 y el GET
   la lista primero. PATCH con `{{direccion}}` → 422; a un atajo ocupado → 409;
   vacío → 422; inexistente → 404.
4. Borrarla → 200 `{ ok: true }`; borrarla otra vez → 404.

## b) El Vendedor solo las usa

5. ✅ `GET /api/quick-replies` → 200; `POST`/`PATCH`/`DELETE` → 403
   `forbidden`; `/settings/quick-replies` → 404 (el owner → 200).

## c) Atajo `/` en el compositor

6. Llega un mensaje de "María López …" (ventana abierta; IA apagada en esa
   conversación para que el outbox solo tenga lo de la vendedora).
7. La vendedora abre la conversación y escribe `/hor`.
   ✅ Se abre el selector "Respuestas rápidas" con `/horario`.
8. Pulsa Enter.
   ✅ El campo queda con `Hola María, abrimos de 9 a 6. — <su nombre>`, el
   selector se cierra y NO se envió nada (outbox del wa-mock sin el texto).
9. Pulsa Enter otra vez.
   ✅ Sale el texto renderizado y la conversación queda asignada a ella
   (responder = tomar).
10. Escribe `1/2 kilo`.
    ✅ El selector no se abre.

## d) Ventana de 24 h cerrada

11. Llega un mensaje con fecha de hace 48 h.
    ✅ La conversación tiene `windowOpen: false` y la vendedora solo ve el
    selector de plantillas: no hay campo de texto ni selector de respuestas
    rápidas.
12. Un `POST .../messages` con el texto de la respuesta rápida → 409
    `window_closed` (la regla de la ventana no se evade).
