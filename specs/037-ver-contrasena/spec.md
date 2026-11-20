# 037 — Ver contraseña + pendientes que respetan «Atendida»

**Estado**: diseño aprobado por el dueño (20-nov-2026); implementación en la
rama `fix/037-ver-contrasena-y-pendientes`.
**Diseño**: https://claude.ai/artifact/VNDzBnwD42nFsPDNvNYWGr (copia en
`diseno/*.dc.html`).

## Origen

Comentarios de los usuarios:

1. En el Login no hay forma de ver la contraseña que se escribió.
2. (Descartado: «Marcar como atendida» sí funciona; fue error humano.) Al
   revisarlo salieron dos huecos reales que se arreglan aquí.

## Alcance

### A. Ojo para ver la contraseña

- Componente único `PasswordInput` (`src/components/ui/password-input.tsx`)
  sobre el `Input` actual: botón de ojo a la derecha, dentro del campo, del
  alto del campo (36 px).
- Ojo = mostrar; ojo tachado = se está viendo. `aria-label` «Mostrar
  contraseña» / «Ocultar contraseña» + `aria-pressed`. Sin `title` (regla sin
  tooltips).
- El botón es `type="button"`: no envía el formulario, no roba el foco del
  campo ni mueve el cursor.
- Al enviar el formulario, la contraseña vuelve a ocultarse.
- Se usa en: Login, Registro y Ajustes › Cuenta (actual, nueva, repetir; cada
  campo con su propio ojo).
- NO se usa en tokens y secretos (WhatsApp, Instagram, Messenger, conectores):
  la regla de no exponer secretos sigue igual.

### B. Aviso si falla «Marcar como atendida»

`patchConversation` de la Bandeja no avisaba si el guardado fallaba. Ahora usa
el aviso no bloqueante que ya existe (como `setAi`):

- Sin respuesta del servidor → «Sin conexión con el servidor.»
- Error al marcar como atendida → «No se pudo marcar como atendida. Vuelve a
  intentarlo.»
- Error al reactivar la IA → «No se pudo reactivar la IA.»
- 404 → se mantiene el cierre por pérdida de acceso (sin aviso doble).

### C. Pendientes del Resumen respetan «Atendida»

`pendCte` (`src/server/reports/summary.ts`) exige además
`conversation.awaiting_since IS NOT NULL`: un chat marcado como atendido (o
devuelto a la IA) sale de pendientes del Resumen, Equipo y Vendedores hasta su
próximo entrante. Así coincide con la Bandeja para esos dos casos (un chat escalado con despedida de la IA sigue esperando en la Bandeja y no cuenta en el Resumen, como antes). Textos de ayuda de los dos reportes
actualizados.

## Verificación

- Unit: `tests/unit/summary-report.test.ts` (037), `tests/unit/password-input.test.ts`.
- E2E: `scripts/e2e-selftest.mjs` (Resumen: atendida sale de pendientes y un
  entrante la devuelve) + `scripts/e2e-ver-contrasena.mjs` (ojo en Login y
  Cuenta; aviso con PATCH interceptado en 500).
