# E2E — 035 fase A: Recordatorios y Seguimiento › Pendientes

Guion de comportamiento observable. Spec:
[specs/035-recordatorios/spec.md](../../specs/035-recordatorios/spec.md) ·
plan: [specs/035-recordatorios/plan.md](../../specs/035-recordatorios/plan.md).

Automatizado en `scripts/e2e-pendientes.mjs` (Playwright; tres sesiones por
API: Propietario, Vera y Bruno). Siembra fechas viejas directo en la BD
AISLADA (`message.created_at`, `conversation.last_message_at`):

```bash
# BD aislada, app viva con .env.e2e (mocks, CATALOG_STORAGE=local).
CATALOG_STORAGE=local node --env-file=.env.e2e scripts/e2e-pendientes.mjs
```

Con `REVISAR_DIR=<dir>` deja capturas (Pendientes con las tres secciones, el
diálogo con un recordatorio previo, «Hecho» con nota y repetición, «Sin
contacto» abierto, 390 px). El self-test (`scripts/e2e-selftest.mjs`,
`pendientesChecks`) cubre la API.

---

1. **Crear**: en el chat de Laura, «Recordarme» → «En 3 días», Servicio, cada
   6 meses, nota → queda a las 10:00 hora del negocio. Al reabrir, abajo «Ya
   tienes 2 recordatorios de Laura» con «Ver en Pendientes». En Contactos
   (`?q=Ana`), «Recordarme» en la fila de Ana (sin chat) → mañana 09:30.
2. **Pendientes** (`/pipeline?vista=pendientes`): Vencidos (rojo) y Hoy
   completos; «Esta semana» y «Después» plegados. «Servicio · 1» deja solo a
   Laura. «Posponer ▾ → 1 semana» saca al vencido de Vencidos (hoy + 7, misma
   hora).
3. **Hecho**: «¿Qué pasó?» + «Se repite cada 6 meses: el siguiente queda para
   el …» → nace el siguiente a 6 meses del original; la nota sale en el cajón
   del trato (Tablero) bajo «Recordatorios». Marcarlo otra vez → 409.
4. **Sin contacto**: +30 días (13, el más antiguo primero), +90, +15, «Entre
   fechas» (hace 75 a 65 días → solo Kari) e «Incluir perdidos» (14). La fila
   con recordatorio dice «recordatorio el …» y no ofrece «Recordarme».
5. **Sin respuesta a tu plantilla**: +3 → Tere (leída, 5 d, con nombre) y Toño
   (entregada, 8 d); nunca la fallida ni la contestada; +7 → solo Toño.
6. **Ver los 13**: se desplaza dentro del recuadro (≤ ~8 filas) y «Sin
   respuesta…» sigue debajo; desplazar la lista no lo mueve.
7. **Número rojo** junto a «Seguimiento» = vencidos propios; baja al posponer.
8. **Bruno** no ve ni toca lo de Vera (API 404, UI sin sus filas, sin número).
9. **Propietario**: «Vendedor: Todos» (cada fila «De …») / Bruno / Vera.
10. **390 px**: Pendientes, el chat con «Recordarme» y el diálogo, sin scroll
    horizontal. Sin `title` (tooltips) en Pendientes.
