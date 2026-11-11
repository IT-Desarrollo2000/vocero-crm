# 033 — «Plantilla enviada» y candado contra duplicados

**Origen**: capacitación de ventas (11-nov-2026). Petición del equipo:

> Cuando se envía una plantilla a un usuario, la zona donde se rellena la
> plantilla se mantiene en pantalla y como no existe algún elemento visual que
> diga que ya se envió, suelen darle más de una vez al botón de enviar.

Claude Design: https://claude.ai/artifact/4V3V7ELqh6LmJyGXTjFySi (3 pantallas: enviada, duplicado, fallo). **Aprobado por el dueño el 11-nov-2026.**

**Causa** (`src/components/inbox/template-sender.tsx`): tras enviar, `TemplateSteps`
solo limpia la selección y sigue en pantalla. El chat continúa en modo
plantilla (la ventana de 24 h no se abre hasta que el cliente contesta), así que
nada indica que el envío salió. Cada plantilla repetida cuesta (0.16 MXN
utilidad / 0.73 marketing) y molesta al cliente.

## Historias

### H1 — Ver que la plantilla ya salió (P1)
Como vendedor, después de enviar una plantilla quiero ver claramente que salió
y si ya le llegó, para no volver a enviarla.

- Tras enviar, en lugar del formulario aparece una tarjeta: «Plantilla enviada
  a {nombre} · {hora}» con su estado de entrega (enviada / entregada / leída /
  falló) y «Cuando {nombre} te conteste, podrás escribirle normal».
- La tarjeta se **deriva de los datos del servidor**: el último mensaje del
  hilo es saliente, de origen `template`, y no hay entrante posterior. Sigue
  ahí al recargar y la ve cualquier usuario que abra el chat.
- Botón secundario «Enviar otra plantilla» que vuelve a mostrar los tres pasos.
- Si el último envío falló, la tarjeta lo dice y ofrece reintentar (se muestra
  el formulario).

### H2 — Candado contra duplicados (P1)
Como negocio, no quiero que la misma plantilla salga dos veces por error.

- Si en la misma conversación ya salió el **mismo texto de plantilla** (texto
  renderizado, `origin='template'`, `status != 'failed'`) en los últimos
  **10 minutos** (constante `TEMPLATE_DUPLICATE_WINDOW_MIN`), el servidor
  responde 409 `template_recently_sent`: «Ya le enviaste este mensaje a
  {nombre} hace {n} min.».
- El formulario muestra ese aviso con «Enviar de todos modos» (reenvía con
  `force: true`) y «Cancelar».
- Aplica SOLO a los envíos humanos: `POST /api/conversations/[id]/messages/template`
  y `POST /api/contacts/[id]/start-conversation`. Los envíos automáticos
  (recordatorios de cita, leads externos) llaman a `sendTemplate` sin candado.
- El manejo del 409 vive en `TemplateSteps`, compartido por la Bandeja y por
  «Escribir primero» en Contactos.

## Fuera de alcance
- Columna `template_id` en `message` (la llave es el texto renderizado; sin migración).
- Candado transaccional contra dos pestañas simultáneas (el botón ya se
  deshabilita durante el envío; v1 acepta la carrera).

## Criterio de hecho
Gate técnico + E2E nuevo `scripts/e2e-plantilla-enviada.mjs` conectado al
self-test: enviar → tarjeta → recargar → tarjeta → «Enviar otra plantilla» →
mismo envío → aviso 409 → «Enviar de todos modos» → segunda burbuja. Todo el
`pnpm test:e2e` en verde (BD aislada :5433). Diseño aprobado por el dueño en el
lienzo antes de publicar.
