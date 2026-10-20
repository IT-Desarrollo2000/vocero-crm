/**
 * 023 — Tipos de cita: límites, siembra y reglas PURAS (sin BD).
 *
 * Sin dependencias de servidor: lo importan también los componentes cliente
 * (Ajustes → Agenda) para validar igual que el servidor.
 */

export const APPOINTMENT_TYPE_LIMITS = {
  durationMinutes: { min: 10, max: 480 },
  name: { min: 1, max: 60 },
} as const;

export type AppointmentTypeSeed = {
  seedKey: string;
  name: string;
  durationMinutes: number;
  exclusive: boolean;
  position: number;
};

/**
 * Lo que recibe una organización sin tipos al primer uso (decisión 2 del
 * dueño). La Prueba de manejo es EXCLUSIVA: hay un solo auto demo.
 */
export const APPOINTMENT_TYPE_SEED: readonly AppointmentTypeSeed[] = [
  {
    seedKey: "prueba_manejo",
    name: "Prueba de manejo",
    durationMinutes: 60,
    exclusive: true,
    position: 0,
  },
  {
    seedKey: "servicio",
    name: "Servicio",
    durationMinutes: 30,
    exclusive: false,
    position: 1,
  },
  {
    seedKey: "garantia",
    name: "Garantía",
    durationMinutes: 30,
    exclusive: false,
    position: 2,
  },
  {
    seedKey: "otro",
    name: "Otro",
    durationMinutes: 30,
    exclusive: false,
    position: 3,
  },
];

/** Lo mínimo que necesitan las reglas puras de abajo. */
export type AppointmentTypeLike = {
  id: string;
  name: string;
  exclusive: boolean;
  position: number;
  active: boolean;
};

/** Minúsculas, sin acentos y con espacios colapsados: "  GARANTÍA " → "garantia". */
export function normalizeTypeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resuelve el tipo que pidió el modelo (o el bot) por nombre, solo entre los
 * ACTIVOS: exacto normalizado; si no, prefijo SOLO si es único ("prueba" →
 * "Prueba de manejo"). Ambiguo o desconocido ⇒ null: quien conduce la
 * conversación pregunta en vez de adivinar (A10).
 */
export function matchTypeByName<T extends AppointmentTypeLike>(
  types: readonly T[],
  name: string
): T | null {
  const wanted = normalizeTypeName(name);
  if (!wanted) return null;
  const active = types.filter((t) => t.active);
  const exact = active.find((t) => normalizeTypeName(t.name) === wanted);
  if (exact) return exact;
  const prefixed = active.filter((t) =>
    normalizeTypeName(t.name).startsWith(wanted)
  );
  return prefixed.length === 1 ? prefixed[0]! : null;
}

/**
 * Tipo por omisión para el bot sin `type` y las ofertas legacy sin tipo (A2):
 * el único activo; si hay varios, el primer activo NO exclusivo por
 * `position`. Nunca cae en un exclusivo por omisión si hay más de uno.
 */
export function pickFallbackType<T extends AppointmentTypeLike>(
  types: readonly T[]
): T | null {
  const active = types
    .filter((t) => t.active)
    .sort((a, b) => a.position - b.position);
  if (active.length === 1) return active[0]!;
  return active.find((t) => !t.exclusive) ?? null;
}

export type AppointmentTypeInput = {
  name?: string;
  durationMinutes?: number;
  exclusive?: boolean;
  active?: boolean;
  position?: number;
};

export type AppointmentTypeValidation =
  | { ok: true; value: AppointmentTypeInput }
  | { ok: false; message: string };

/**
 * Valida (y normaliza) un alta o edición. A diferencia de los ajustes de la
 * agenda aquí se RECHAZA en vez de recortar: una duración fuera de rango es
 * casi siempre un error de dedo que el Propietario debe ver.
 */
export function validateTypeInput(
  input: AppointmentTypeInput
): AppointmentTypeValidation {
  const value: AppointmentTypeInput = {};
  if (input.name !== undefined) {
    const name = input.name.replace(/\s+/g, " ").trim();
    const { min, max } = APPOINTMENT_TYPE_LIMITS.name;
    if (name.length < min || name.length > max) {
      return {
        ok: false,
        message: `El nombre debe tener entre ${min} y ${max} caracteres`,
      };
    }
    value.name = name;
  }
  if (input.durationMinutes !== undefined) {
    const d = input.durationMinutes;
    const { min, max } = APPOINTMENT_TYPE_LIMITS.durationMinutes;
    if (!Number.isInteger(d) || d < min || d > max) {
      return {
        ok: false,
        message: `La duración debe ser un entero entre ${min} y ${max} minutos`,
      };
    }
    value.durationMinutes = d;
  }
  if (input.position !== undefined) {
    if (!Number.isInteger(input.position) || input.position < 0) {
      return { ok: false, message: "El orden debe ser un entero ≥ 0" };
    }
    value.position = input.position;
  }
  if (input.exclusive !== undefined) value.exclusive = input.exclusive;
  if (input.active !== undefined) value.active = input.active;
  return { ok: true, value };
}
