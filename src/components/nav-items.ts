import { isOwner, type Role } from "@/lib/roles";

/**
 * Filtrado del menú lateral por rol (dev-tasks/00, RF-00-05). Lógica pura y
 * genérica (sin iconos ni React) para poder probarla en unit.
 */
export type RoleGated = { ownerOnly?: boolean };

export function filterNavForRole<T extends RoleGated>(
  items: readonly T[],
  role: Role
): T[] {
  return isOwner(role) ? [...items] : items.filter((i) => !i.ownerOnly);
}
