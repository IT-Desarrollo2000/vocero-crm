# 034 — Tareas

- [x] T0 Diagnosticar el check «el texto llega al outbox del wa-mock» de `e2e-ayuda.mjs` — no se reprodujo (127/127 con BD reseteada; sin reset solo fallan los 2 checks conocidos de plantillas sobrantes). El log muestra `next dev` compilando en frío dentro de la espera de 20 s. Arnés endurecido: calienta el outbox en el setup, espera a que «Enviar» se habilite tras escribir (compositor hidratado) y espera hasta 45 s, con diagnóstico si falla.
- [x] T1 Contrato de almacenamiento: espacios `catalog|capacitacion`, `stat`, `getRange` (local + Azure) y suite ampliada (verde en local y contra Azurite 3.34)
- [x] T2 Tabla `training_asset` + migración 0029 re-ejecutable + prefijo `tra_`
- [x] T3 `src/lib/training.ts`: tipos, topes, Zod (tema como `z.enum`), DTO, `parseByteRange`
- [x] T4 `src/server/training/store.ts`: subir, reemplazar, editar, reordenar, quitar, servir
- [x] T5 Rutas `/api/training*` + matriz de permisos
- [x] T6 Ayuda: recuadro «Capacitación del equipo», diálogo del video, «Con video», «Imagen | Video», imagen propia
- [x] T7 Ajustes › Material de capacitación (pestaña + página del Propietario)
- [x] T8 Unit tests (`training.test.ts`, `training-file-route.test.ts`, contrato ampliado, pestañas)
- [x] T9 Fixtures `tests/fixtures/capacitacion/` + `scripts/e2e-ayuda-material.mjs` + sección 034 del self-test + guion `tests/e2e/us-ayuda-material.md`
- [x] T10 Gate (`typecheck`, `lint`, `build`, `test`) y E2E en la BD aislada; capturas. El E2E encontró que el velo del diálogo no cubría la franja superior (top 14 px). Causa: `space-y-3.5` del recuadro le daba `margin-top` al velo `fixed` (ningún ancestro cambia el bloque contenedor). El diálogo va en un portal a `document.body`.
