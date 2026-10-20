/**
 * 023 — Reglas PURAS de la UI de citas (diálogo de agendar, lista de Citas).
 *
 * Sin React ni fetch: viven aparte para probarlas en `tests/unit/` (el
 * entorno de Vitest es node, sin DOM).
 */

/** Una cita con la que choca un horario (forma `conflictPayload` del servidor). */
export type SlotConflict = {
  bookingId: string;
  typeName: string | null;
  sellerName: string | null;
  startUtc: string;
  endUtc: string;
};

/** Un horario de `GET /api/calendar/availability` en modo staff. */
export type StaffSlot = {
  startUtc: string;
  endUtc: string;
  label: string;
  dayIso: string;
  dayLabel: string;
  time: string;
  conflicts: SlotConflict[];
};

export type SlotDay = {
  dayIso: string;
  dayLabel: string;
  slots: StaffSlot[];
  /** Hay al menos un horario sin ninguna otra cita. */
  hasFree: boolean;
};

/**
 * Agrupa los horarios por día del NEGOCIO (`dayIso` lo calcula el servidor en
 * su zona), conservando el orden de llegada (cronológico). Un día solo existe
 * si tiene horarios: "los próximos días con huecos".
 */
export function groupSlotsByDay(slots: readonly StaffSlot[]): SlotDay[] {
  const days: SlotDay[] = [];
  const byIso = new Map<string, SlotDay>();
  for (const slot of slots) {
    let day = byIso.get(slot.dayIso);
    if (!day) {
      day = { dayIso: slot.dayIso, dayLabel: slot.dayLabel, slots: [], hasFree: false };
      byIso.set(slot.dayIso, day);
      days.push(day);
    }
    day.slots.push(slot);
    if (slot.conflicts.length === 0) day.hasFree = true;
  }
  return days;
}

/** HH:MM de un instante UTC en la zona dada (o null si la zona no sirve). */
export function timeOf(iso: string, timeZone?: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("es-MX", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    }).format(d);
  } catch {
    return null;
  }
}

/**
 * "Servicio · Juan · 10:00": el detalle de una cita con la que se choca.
 * Sin vendedor ⇒ "Sin asignar"; sin tipo (bloqueo o cita de la 015) ⇒ "Cita".
 * `fallbackTime` se usa si la zona del negocio no se conoce en el cliente.
 */
export function conflictDetail(
  c: SlotConflict,
  timeZone?: string,
  fallbackTime?: string
): string {
  const type = c.typeName?.trim() || "Cita";
  const seller = c.sellerName?.trim() || "Sin asignar";
  const time = timeZone ? timeOf(c.startUtc, timeZone) : null;
  return [type, seller, time ?? fallbackTime].filter(Boolean).join(" · ");
}

/** El detalle de todos los choques de un horario, en un renglón por cita. */
export function conflictsTitle(
  conflicts: readonly SlotConflict[],
  timeZone?: string,
  fallbackTime?: string
): string {
  return conflicts.map((c) => conflictDetail(c, timeZone, fallbackTime)).join("\n");
}

/**
 * Respaldo del mensaje de advertencia si el servidor no mandó el suyo:
 * "A esa hora ya hay 1 cita (Servicio, con Juan). ¿Agendar de todos modos?".
 */
export function overlapMessage(conflicts: readonly SlotConflict[]): string {
  const n = conflicts.length;
  const parts = conflicts.map((c) => {
    const type = c.typeName?.trim() || "Cita";
    return c.sellerName?.trim() ? `${type}, con ${c.sellerName.trim()}` : `${type}, sin asignar`;
  });
  const detail = parts.length > 0 ? ` (${parts.join("; ")})` : "";
  return `A esa hora ya hay ${n} ${n === 1 ? "cita" : "citas"}${detail}. ¿Agendar de todos modos?`;
}

/** Lo que importa de la lista para el filtro "Mías". */
export type OwnedBooking = {
  assignedUser: { id: string } | null;
  createdByUserId: string | null;
};

/** "Mías" del Vendedor: asignadas a él o creadas por él (A3). */
export function isMine(b: OwnedBooking, userId: string): boolean {
  return b.assignedUser?.id === userId || b.createdByUserId === userId;
}

/**
 * Filtro de vendedor de la pantalla Citas. Propietario: `all` | `none` | id de
 * un vendedor. Vendedor: `all` | `mine` | `none`.
 */
export type SellerFilter = "all" | "mine" | "none" | (string & {});

/**
 * El `sellerId` que viaja a `GET /api/bookings`. "Mías" NO va al servidor
 * (allí `sellerId=yo` dejaría fuera las que el Vendedor creó para otro): se
 * filtra en el cliente con `isMine`.
 */
export function sellerFilterToQuery(filter: SellerFilter): string | null {
  if (filter === "all" || filter === "mine") return null;
  return filter;
}

/** Arma la query de `GET /api/bookings` con los filtros activos. */
export function bookingsQuery(filter: SellerFilter, typeId: string): string {
  const params = new URLSearchParams();
  const seller = sellerFilterToQuery(filter);
  if (seller) params.set("sellerId", seller);
  if (typeId && typeId !== "all") params.set("typeId", typeId);
  const qs = params.toString();
  return qs ? `/api/bookings?${qs}` : "/api/bookings";
}

/** Aplica la parte del filtro que vive en el cliente ("Mías"). */
export function applyClientFilter<T extends OwnedBooking>(
  bookings: readonly T[],
  filter: SellerFilter,
  userId: string
): T[] {
  return filter === "mine"
    ? bookings.filter((b) => isMine(b, userId))
    : [...bookings];
}

/** Respuesta de error de la API de citas, ya clasificada. */
export type BookingFailure =
  | { kind: "slot_taken"; message: string }
  | { kind: "overlap_warning"; message: string; conflicts: SlotConflict[] }
  | { kind: "error"; message: string };

const FALLBACK_SLOT_TAKEN = "Ese horario acaba de ocuparse. Elige otro.";

/**
 * Clasifica el cuerpo de un error de `POST /api/bookings` o `PATCH
 * /api/bookings/[id]`. El sobre es `{error:{code,message}}` con `slots` o
 * `conflicts` como HERMANOS (contrato de `server/agenda/http.ts`); un cuerpo
 * raro o vacío cae en el error genérico con `fallback`.
 */
export function parseBookingError(
  status: number,
  body: unknown,
  fallback = "No se pudo guardar la cita."
): BookingFailure {
  const obj = (body && typeof body === "object" ? body : {}) as {
    error?: { code?: unknown; message?: unknown };
    conflicts?: unknown;
  };
  const code = typeof obj.error?.code === "string" ? obj.error.code : null;
  const message =
    typeof obj.error?.message === "string" && obj.error.message.trim()
      ? obj.error.message
      : null;
  if (status === 409 && code === "overlap_warning") {
    const conflicts = Array.isArray(obj.conflicts)
      ? (obj.conflicts as SlotConflict[])
      : [];
    return {
      kind: "overlap_warning",
      message: message ?? overlapMessage(conflicts),
      conflicts,
    };
  }
  if (status === 409 && (code === "slot_taken" || code === "slot_not_offered")) {
    return { kind: "slot_taken", message: message ?? FALLBACK_SLOT_TAKEN };
  }
  return { kind: "error", message: message ?? fallback };
}
