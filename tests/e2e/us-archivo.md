# US — Archivar conversaciones inactivas (022)

Automatizado: `scripts/e2e-archivo.mjs` (API, 66 checks) y
`scripts/e2e-archivo-ui.mjs` (Playwright, 46 checks). Con la app viva y los
mocks (`.env.e2e`, BD aislada :5433):

```bash
node --env-file=.env.e2e scripts/e2e-archivo.mjs
node --env-file=.env.e2e scripts/e2e-archivo-ui.mjs
```

## Manual (Vendedor y Propietario)
1. Abre una conversación → **Archivar** en la cabecera.
   - Sale de Todas / No leídas / Mías / Requiere humano y de sus contadores.
   - El hilo sigue abierto con el aviso "Conversación archivada…" y **Desarchivar**.
2. Pastilla **Archivadas** → la fila aparece con la etiqueta *Archivada*.
3. **Desarchivar** desde el aviso → vuelve a Todas.
4. En escritorio, al pasar el cursor por una fila → icono archivar.
5. Escribe desde el cliente (wa-mock) a una archivada → vuelve sola a Todas (SSE).
6. Envía un mensaje a una archivada → se desarchiva.
7. Busca una archivada por nombre o teléfono → aparece con *Archivada*.
8. Vendedor: solo archiva lo que ve; una ajena → 404.

## Limpiar inactivas (solo Propietario)
1. Ajustes → **Bandeja** → "Limpiar inactivas ahora", 14 días → **Calcular**
   → "Se archivarán N conversaciones." (no archiva nada todavía).
2. **Archivar N conversaciones** → "Se archivaron N". Motivo `bulk`.
3. No se archivan: cita futura agendada, lead en etapa con **No archivar**
   (Seguimiento → Gestionar etapas), traspaso a humano en los últimos N días.
4. Vendedor: sin pestaña ni acceso; la API responde 403.

## Auto-archivo (Propietario)
1. Interruptor apagado por defecto (14 días). Apagado, el tick no archiva nada.
2. Encendido + Guardar → el ticker (`INBOX_AUTO_ARCHIVE_TICK_MS`, 1 h por
   defecto) archiva con motivo `auto`, con las mismas excepciones.
3. Tick manual en dev: `POST /api/dev/inbox/auto-archive {"advanceDays"?: n}`.

## Camino infeliz
- `archived` no booleano, `days` 0 o > 365, `advanceDays` negativo → 4xx sin cambios.
- Fallo de red al archivar → aviso "No se pudo archivar la conversación." y la
  fila sigue donde estaba.
- Limitación aceptada: un envío de WhatsApp que falla DESPUÉS (webhook
  `failed`) deja la conversación desarchivada.
