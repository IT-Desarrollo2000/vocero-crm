/**
 * Reglas puras de la superficie de Better Auth (tarea 00). Sin BD ni env: las
 * consume `src/lib/auth/index.ts` y se prueban sin arrancar Better Auth.
 */

/**
 * RF-00-10: el plugin `organization` expone `/organization/*` (crear org,
 * cambiar roles, borrar la org, invitar…). Vocero gestiona el equipo con sus
 * propias rutas (`/api/settings/team/*`), así que TODO ese árbol se bloquea
 * con 404 en el hook `before`. Las opciones del plugin
 * (`allowUserToCreateOrganization: false`, `disableOrganizationDeletion`) son
 * solo defensa en profundidad.
 */
export function isBlockedAuthPath(path: string | undefined | null): boolean {
  if (!path) return false;
  return path === "/organization" || path.startsWith("/organization/");
}

export const SIGN_UP_PATH = "/sign-up/email";

/** Mensaje del 403 al iniciar sesión con una cuenta dada de baja (RF-00-13). */
export const REMOVED_ACCOUNT_MESSAGE =
  "Tu acceso fue dado de baja; pide al Propietario que te reactive";

export type SessionCreationInput = {
  /** El usuario tiene membresía en alguna organización. */
  hasMembership: boolean;
  /** `context.path` del endpoint que crea la sesión (null fuera de endpoint). */
  path: string | null | undefined;
  /** Dentro de `runInternalSignup` (alta de equipo server-side). */
  internalSignup: boolean;
  /**
   * Existe al menos una organización en la instancia. Función perezosa: solo
   * se consulta cuando las reglas baratas no deciden.
   */
  organizationExists: () => Promise<boolean>;
};

/**
 * RF-00-13: ¿se permite crear la sesión? Bloquea el inicio de sesión de una
 * cuenta sin membresía (dada de baja), sin romper los dos casos en que la
 * membresía AÚN no existe cuando Better Auth crea la sesión:
 *
 * - En better-auth 1.6.x `/sign-up/email` corre en `runWithTransaction` y el
 *   `user.create.after` (que crea la org + membresía owner en el primer
 *   registro) se encola hasta el COMMIT, o sea DESPUÉS de `createSession`.
 *   El alta de equipo inserta su `member` aún más tarde, tras `signUpEmail`.
 *   Todo sign-up que llegó a crear sesión ya pasó el gate de registro cerrado
 *   (`hooks.before`) o es `runInternalSignup`, así que se deja pasar.
 * - Instancia sin organizaciones: nada que proteger todavía.
 *
 * Orden: lo barato primero; la consulta de organizaciones solo si hace falta.
 */
export async function shouldAllowSessionCreation(
  input: SessionCreationInput
): Promise<boolean> {
  if (input.hasMembership) return true;
  if (input.path === SIGN_UP_PATH) return true;
  if (input.internalSignup) return true;
  if (!(await input.organizationExists())) return true;
  return false;
}
