# E2E — 033 «Plantilla enviada» y candado contra duplicados

Guion de comportamiento observable. Spec:
[specs/033-plantilla-enviada/spec.md](../../specs/033-plantilla-enviada/spec.md)
(H1, H2).

Automatizado en `scripts/e2e-plantilla-enviada.mjs` (Playwright; Propietario
por API, un solo inicio de sesión):

```bash
# BD aislada, app viva con .env.e2e (mocks, CATALOG_STORAGE=local).
CATALOG_STORAGE=local node --env-file=.env.e2e scripts/e2e-plantilla-enviada.mjs
```

Con `REVISAR_DIR=<dir>` deja capturas de la tarjeta, el aviso de duplicado y
el aviso de envío fallido. El self-test (`scripts/e2e-selftest.mjs`, 021b)
comprueba además el 409 por la API.

Datos: tres chats de WhatsApp con la ventana cerrada (30 h) — Rosa (Bandeja),
Paco (API) y Tere (envío fallido) — y un alta a mano que nunca escribió
(Ceci). Dos plantillas aprobadas. wa-mock no confirma entregas solo: los
estados `sent`/`delivered`/`read`/`failed` se inyectan con
`POST /api/dev/wa-mock/status`.

---

## a) API: candado de 10 minutos

1. Plantilla a Paco → 200.
2. La misma (mismo texto) otra vez → **409 `template_recently_sent`**:
   «Ya le enviaste este mensaje a Paco hace menos de 1 min.». wa-mock no
   recibió un segundo envío.
3. Con `force: true` → 200.
4. Otro valor en el espacio (otro texto) → 200: el candado es por texto.
5. A Tere: enviar, marcarla `failed`, enviar la misma → 200 (un envío
   fallido no cuenta).

## b) Bandeja: la tarjeta

1. Abrir a Rosa → pasos «Para escribirle a Rosa, usa un mensaje aprobado».
2. Elegir la plantilla (el espacio 1 trae «Rosa») → «Enviar plantilla».
3. En lugar de los pasos: **«Plantilla enviada a Rosa · HH:MM»** (la misma
   hora que la burbuja), «Retomar cotizacion …» entre comillas, chip
   «Enviando…» y «Cuando Rosa te conteste, podrás escribirle normal. No hace
   falta enviarla otra vez.». Botón «Enviar otra plantilla».
4. wa-mock `sent` → recargar → «Enviada»; `delivered` → «Entregada»;
   `read` → «Leída». La tarjeta sigue tras cada recarga.
5. A 390 px: la tarjeta sin desborde horizontal.

## c) «Enviar otra plantilla» y el aviso

1. «Enviar otra plantilla» → los pasos con «Enviar otra plantilla a Rosa».
2. La misma plantilla → en «Revisa y envía», en lugar del botón: aviso
   (`role="alert"`) «Ya le enviaste este mensaje a Rosa hace menos de 1 min.»
   + «Si lo mandas otra vez, le llegará repetido. Mientras Rosa no conteste,
   no hace falta reenviarlo.». Nada salió a Meta.
3. «Cancelar» → vuelve el botón. Enviar otra vez → el aviso.
4. «Enviar de todos modos» → vuelve la tarjeta («Enviando…») y el hilo tiene
   **2 burbujas** de esa plantilla.

## d) Último envío fallido

Abrir a Tere (su última plantilla `failed`) → los pasos, con arriba
(`role="alert"`) «La plantilla de las HH:MM no le llegó a Tere.» + el motivo
del mensaje + «Revísala abajo y vuelve a enviarla.». Sin tarjeta.

## e) Contactos «Escribir primero» con la lista vieja

1. Abrir Contactos y buscar a Ceci → «Escribir primero».
2. Mientras tanto, otra pestaña le manda la plantilla (API → 200; repetida →
   409).
3. En la pestaña vieja: «Escribir primero» → elegir la misma → «Enviar y abrir
   el chat» → el aviso de duplicado **dentro del diálogo**, sin el botón.
4. «Enviar de todos modos» → abre `/inbox?contact=<id>` con la tarjeta
   «Plantilla enviada a Ceci» y 2 burbujas.

## f) Sin tooltips

Ni la tarjeta ni el aviso llevan `title` ni ícono ⓘ.
