# Guion E2E — US7: Multi-usuario mínimo

> Conducido con Playwright (MCP) contra `pnpm dev` (org ya creada). Los roles
> Propietario / Vendedor y la gestión de equipo (tarea 00) tienen su guion
> propio: [us-roles.md](us-roles.md), automatizado en `scripts/e2e-roles.mjs`.

1. **Registro cerrado (FR-060)**: POST público a sign-up con otra cuenta.
   ✅ 403 con mensaje claro (la UI lo muestra en /register).
2. **Escape**: `ALLOW_SIGNUP=true` reabre el registro (unit test
   registration.test.ts; requiere reinicio con la variable).
3. **Cuenta de equipo (FR-061)**: el owner crea una cuenta desde
   Configuración → Equipo (email + contraseña temporal mostrada una vez).
   ✅ El nuevo miembro entra como **Vendedor**, inicia sesión y ve la bandeja
   de la organización.
   ✅ Un Vendedor NO puede crear cuentas ni ver el equipo (403 `forbidden` en
   `GET`/`POST /api/settings/team`).
4. **Gestión de equipo (tarea 00)**: desde Equipo el Propietario cambia el
   rol (Propietario ↔ Vendedor), restablece la contraseña (temporal mostrada
   una vez) y da de baja.
   ✅ Nunca queda la organización sin Propietario (409 `self_change` /
   `last_owner`); la baja corta la sesión abierta (401) y bloquea el login
   (403 "dado de baja"); re-dar de alta el mismo correo lo re-vincula.
   Detalle en [us-roles.md](us-roles.md).
5. **Rate limit (FR-062)**: >10 logins fallidos desde la misma IP en 10 min.
   ✅ 429 "Demasiados intentos".
