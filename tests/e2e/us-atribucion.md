# E2E — Atribución de anuncios y Conversions API (016)

Guion de comportamiento observable. Automatizado en la sección `016` de
`scripts/e2e-selftest.mjs`: con la app viva y los mocks encendidos,
`pnpm test:e2e` lo conduce y sale distinto de cero si algo falla.

**Preparación**: app en `localhost` con `WA_MOCK_ENABLED=true`,
`META_GRAPH_BASE_URL` → wa-mock, `BOT_API_KEY` y la BD migrada. La bandera
`ATRIBUCION` decide qué mitad del guion corre: **las dos se ejercitan**, porque
una feature opcional que solo se prueba encendida no está probada.

Nada de esto toca Meta. No es comodidad: Meta valida el `ctwa_clid` contra un
clic real y rechaza cualquier valor inventado (`code 100 / error_subcode
2804087`), así que un evento sintético contra la API real es imposible por
diseño. El mock imita las tres cosas que importan: el catálogo cerrado, la
exigencia del clid, y el **200 que descarta el evento**.

---

## US1 — La instancia decide si esto existe

Con `ATRIBUCION` ausente:

1. `GET`/`PUT`/`DELETE /api/settings/capi` y `GET /api/settings/capi/events`
   responden **404** (no 403: aquí ese endpoint no existe).
2. La pantalla `/settings/ads` responde 404 y Ajustes no la menciona.
3. Un mensaje que **sí** viene de un anuncio se atiende como cualquier otro: la
   conversación se crea y el mensaje se ve. Desde 020 el **anuncio de origen**
   se guarda igual (es dato del negocio), pero **sin `ctwa_clid`**, ni en la
   columna ni en el `raw` — ver [us-origen-leads.md](us-origen-leads.md).

Con `ATRIBUCION=on`, las mismas rutas responden con normalidad.

## US2 — Conectar el dataset

1. Sin configurar, `GET /api/settings/capi` responde **200 con `capi: null`**:
   no es un error, es una instancia que aún no conectó.
2. Guardar **sin token** reusa el de la conexión de WhatsApp; el `GET` posterior
   muestra solo los **últimos 4** y el token completo no aparece por ningún lado.
3. Una `qualifiedStageId` que no es de este negocio se rechaza con
   **`422 etapa_invalida`**.
4. Desconectar borra la configuración pero **no** los eventos ya reportados: eso
   ya se le dijo a Meta y sigue siendo cierto.

## US3 — Capturar el anuncio

1. Un inbound con `referral` deja el origen guardado junto a la conversación.
2. Un segundo mensaje del mismo contacto con **otro** `ctwa_clid` no lo
   sobreescribe: **el primer referral gana**, y se comprueba mirando con qué
   clid salió el evento después.

## US4 — El lead calificado

1. Mover el lead a la etapa marcada como calificada reporta `QualifiedLead`, y
   la actividad lo muestra **enviado** con su `fbtrace_id`.
2. El payload que recibió Meta lleva el `ctwa_clid` correcto y
   `custom_data.lead_stage = "qualified"` — sin ese parámetro, ninguna
   conversión personalizada de Meta podría casar jamás.
3. La fila de actividad dice **de qué anuncio** vino (su titular).
4. Sacar el lead de esa etapa y volverlo a meter **no** reporta dos veces.

## US5 — La venta

1. Mover el trato a la etapa ganada con monto reporta `Purchase` con
   `value: 450.5` y su moneda — **unidades, no centavos**.
2. Re-ganar el mismo trato no manda una segunda compra.

## Caminos infelices (los que de verdad importan)

1. **Lead sin anuncio**: la fila queda **omitida** con el motivo escrito
   (`sin ctwa_clid…`) y nada falla.
2. **Meta rechazando** (dataset `-fail`, que responde 200 con
   `events_received: 0`): el lead **se mueve igual** y se queda en su etapa
   nueva; la fila queda **fallida** con lo que dijo Meta. Ninguna conversión
   vale un movimiento de lead bloqueado.
