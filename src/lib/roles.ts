/**
 * Roles efectivos de Vocero (dev-tasks/00). Exactamente dos: Propietario
 * (`owner`) y Vendedor (`member` en BD — se conserva el valor nativo del plugin
 * `organization` de Better Auth y se etiqueta "Vendedor" en la UI).
 *
 * Sin dependencias de servidor: se importa también desde componentes cliente.
 */

export type Role = "owner" | "member";

/** Nombres semánticos: el código habla de `ROLE.seller`, nunca del literal. */
export const ROLE = { owner: "owner", seller: "member" } as const satisfies Record<
  string,
  Role
>;

export const ROLE_LABELS: Record<Role, "Propietario" | "Vendedor"> = {
  owner: "Propietario",
  member: "Vendedor",
};

// Un aviso por valor raro y por proceso: suficiente para detectarlo en logs
// sin inundarlos en cada petición.
const warnedRoles = new Set<string>();

/**
 * Normaliza el rol crudo de BD. Solo el literal exacto `"owner"` es
 * Propietario; cualquier otra cosa (`"admin"`, `""`, `"OWNER"`, null…) es
 * Vendedor — un valor desconocido nunca otorga más permisos.
 */
export function normalizeRole(raw: unknown): Role {
  if (raw === ROLE.owner) return ROLE.owner;
  if (raw !== ROLE.seller) {
    const key = String(raw);
    if (!warnedRoles.has(key)) {
      warnedRoles.add(key);
      console.warn(`[roles] rol desconocido "${key}": se trata como Vendedor`);
    }
  }
  return ROLE.seller;
}

/** ¿Es Propietario? Acepta el rol o cualquier objeto con `role`. */
export function isOwner(subject: Role | { role: Role }): boolean {
  const role = typeof subject === "string" ? subject : subject.role;
  return role === ROLE.owner;
}

/** Etiqueta de UI del rol ("Propietario" / "Vendedor"). */
export function roleLabel(role: Role): "Propietario" | "Vendedor" {
  return ROLE_LABELS[role];
}
