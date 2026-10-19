# US — Renombrar contactos y conservar el nick (022)

Automatizado en `scripts/e2e-archivo.mjs` (sección b) y
`scripts/e2e-archivo-ui.mjs` (sección a).

1. Entra un mensaje de WhatsApp con perfil "Dios es amor" → el contacto se
   llama así y `profileName` = "Dios es amor".
2. Bandeja → panel **Detalles** → lápiz (**Editar nombre**) → escribe
   "María del Carmen" → Enter.
   - La fila, la cabecera y el panel muestran el nombre nuevo sin recargar;
     otros usuarios conectados también (SSE `conversation.updated`).
   - Debajo, en gris: *WhatsApp: «Dios es amor»*.
3. Esc cancela; vacío → "El nombre no puede quedar vacío." sin cerrar el
   campo; más de 120 caracteres → error.
4. Un nuevo mensaje del cliente NO revierte el nombre; si cambió su nick,
   se actualiza la línea gris.
5. Buscar "Dios es amor" o "maria del carmen" (sin acentos) encuentra el contacto.
6. Contactos → la misma línea gris bajo el nombre.
7. Instagram/Messenger (Meta): el nick se guarda cuando ya se consulta a Graph
   (alta o nombre de relleno), sin llamadas extra por mensaje.
