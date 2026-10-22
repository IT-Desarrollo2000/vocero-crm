# E2E — Bandeja por alcance: Buzón · Mis chats · Equipo (027)

Guion de comportamiento observable. Spec:
[specs/027-bandeja-por-alcance/spec.md](../../specs/027-bandeja-por-alcance/spec.md).

Automatizado:

- **API** — `bandejaAlcanceChecks` de `scripts/e2e-selftest.mjs`
  (`pnpm test:e2e`): `assigned=others`, partición exacta, `counts.scopes`,
  Vendedor sin Equipo, "Mis chats → Por atender", contestar desde el Buzón,
  "Devolver al buzón", `filter=mine` viejo, 422.
- **UI** — `scripts/e2e-bandeja-alcance.mjs` (Playwright, dueño + vendedor):

  ```bash
  # app viva con mocks (WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL → wa-mock)
  # y la BD aislada de .env.e2e; reinicia el server antes (limitador de login)
  node --env-file=.env.e2e scripts/e2e-bandeja-alcance.mjs
  ```

  Gasta 2 inicios de sesión (dueño, vendedor). Sin chromium de Playwright usa
  Edge (`PW_CHANNEL=msedge`). Deja capturas en `%TEMP%/e2e-shots-027`.

**Definiciones**: modo equipo (`teamMode`) = Vendedor, o Propietario con más
de un miembro o alguna conversación asignada. Buzón = sin responsable
(`assigned=unassigned`); Mis chats = asignadas a mí (`assigned=me`); Equipo =
asignadas a OTRO (`assigned=others`, solo Propietario). Los totales de las
pestañas excluyen archivadas y no dependen de la búsqueda ni de los filtros
(`counts.scopes`).

---

## US-1 — Alcance y estado en dos niveles

1. **CA-1** Un Vendedor con un chat propio y otros sin asignar abre la Bandeja.
   ✅ Encima de las vistas hay un control segmentado "Mis chats · Buzón"
   (sin "Equipo"), con "Mis chats" marcado y `scope=mine` en la URL. "Mis
   chats" trae solo los suyos; "Buzón", solo los sin asignar. El renglón de
   vistas ya no tiene "Mías" y el panel Filtros ya no tiene "Sin asignar".
2. **CA-2** El Propietario abre la Bandeja.
   ✅ "Buzón · Equipo · Mis chats", con "Buzón" marcado. Equipo trae los
   chats de sus vendedores con el nombre de quien atiende; Buzón y Mis chats
   no repiten la etiqueta de responsable. Por API, Buzón + Equipo + Mis chats
   = Todas, sin huecos ni repetidos.
3. **CA-3** "Mis chats" → "Por atender".
   ✅ Solo mis chats esperando respuesta; la lista coincide con el contador.
4. **CA-8** Instancia de un solo usuario (sin vendedores ni asignadas).
   ✅ No hay selector ni `scope=` en la URL: la Bandeja queda como antes.
   (Fijado por el unit de `effectiveFilters`; los guiones de un solo usuario
   lo recorren sin selector.)

## US-2 — Cada pestaña dice cuánto hay y si hay algo nuevo

5. El Vendedor está en "Buzón"; el dueño le asigna un chat con mensajes sin
   leer.
   ✅ Sin recargar, el total de "Mis chats" sube en uno y la pestaña lleva un
   punto de acento (tiene no leídas y no es la activa). La pestaña activa
   nunca lleva punto.

## US-3 — El chat se muda solo, sin perder el hilo

6. **CA-4** Desde "Buzón", el Vendedor abre un chat y contesta.
   ✅ El chat se le asigna; la fila sale del Buzón (Buzón −1, Mis chats +1);
   el hilo SIGUE abierto con la barra "Este chat ahora está en **Mis chats**
   · Ir". "Ir" cambia a "Mis chats" con el chat seleccionado y la barra se va.
7. El Propietario deja sin asignar (selector Responsable) un chat que tiene
   abierto en "Equipo".
   ✅ "Este chat ahora está en **Buzón** · Ir".
8. En móvil (390 px) el Vendedor toma un chat del Buzón desde el hilo.
   ✅ La barra se ve en el hilo, sin scroll horizontal.

## US-4 — Devolver al buzón

9. **CA-5** En un chat suyo, el Vendedor pulsa "Devolver al buzón" (antes
   "Liberar conversación").
   ✅ El chat vuelve al Buzón ("ahora está en Buzón · Ir"); ya no existe el
   botón "Liberar conversación".

## US-5 — Recordar el alcance

10. Primera vez: Vendedor → "Mis chats"; Propietario → "Buzón".
11. El Vendedor elige "Buzón" y vuelve a `/inbox` sin `scope=`.
    ✅ Abre en "Buzón" (último usado, por usuario y navegador). Lo mismo con
    "Mis chats".
12. **CA-7** Enlaces viejos.
    ✅ `/inbox?filter=mine` → Mis chats (la URL queda `scope=mine`, sin
    `filter=mine`); `/inbox?filter=unassigned` y `/inbox?unassigned=1` →
    Buzón (sin `unassigned=1` en la URL). `scope=team` para un Vendedor →
    Mis chats.
13. Enlace `/inbox?contact=<id>` de un chat que vive en otro alcance.
    ✅ La Bandeja cambia a ese alcance (p. ej. Equipo) y deja la fila
    seleccionada, sin barra de aviso.

## US-6 — Recordatorio del Buzón

14. **CA-10** Un Vendedor recién dado de alta (sin chats propios) abre la
    Bandeja.
    ✅ La lista de "Mis chats" dice "Aún no tienes chats." con el botón
    "Ir al Buzón (N)" (N = chats en el Buzón); sin conversación abierta, el
    panel derecho dice "Hay N chats esperando en el Buzón" con "Ver el
    Buzón". Ambos botones cambian al Buzón. Con el Buzón vacío, la lista dice
    "El Buzón también está vacío por ahora." sin botón y el panel derecho no
    muestra el recordatorio. En "Buzón" o "Equipo", el panel derecho no
    cambia.

## Búsqueda

15. **CA-6** Con texto en la búsqueda.
    ✅ Aviso "Buscando en todos tus chats" (Vendedor) / "Buscando en todos
    los chats" (Propietario); aparecen chats de cualquier alcance (con su
    etiqueta de responsable), nunca chats ajenos para el Vendedor.

## API

16. **CA-9** `assigned` fuera del catálogo → 422 en lista y contadores (el
    mensaje nombra `others`); `assigned=others` para un Vendedor → lista
    vacía y `counts.scopes.team = 0`.
17. `counts.scopes.X.all` = `counts(assigned=X).all` y `.unread` = su vista
    "No leídas"; los tres suman `counts.all`.

## Móvil

18. 390 px: el selector ocupa el ancho de la columna y ningún
    `button[aria-pressed]` sale de la pantalla (también lo mide
    `scripts/e2e-alertas.mjs` a 360 px); sin scroll horizontal.
