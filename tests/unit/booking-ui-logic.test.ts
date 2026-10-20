import { describe, expect, it } from "vitest";
import {
  applyClientFilter,
  bookingsQuery,
  conflictDetail,
  conflictsTitle,
  groupSlotsByDay,
  isMine,
  overlapMessage,
  parseBookingError,
  sellerFilterToQuery,
  type SlotConflict,
  type StaffSlot,
} from "@/components/bookings/booking-logic";

/** 023 — Reglas puras de la UI de citas (diálogo de agendar y lista). */

function slot(
  dayIso: string,
  time: string,
  conflicts: SlotConflict[] = []
): StaffSlot {
  const startUtc = `${dayIso}T${time}:00.000Z`;
  return {
    startUtc,
    endUtc: startUtc,
    label: `${dayIso} ${time}`,
    dayIso,
    dayLabel: `Día ${dayIso}`,
    time,
    conflicts,
  };
}

const servicioJuan: SlotConflict = {
  bookingId: "bk_1",
  typeName: "Servicio",
  sellerName: "Juan",
  startUtc: "2026-10-21T16:00:00.000Z",
  endUtc: "2026-10-21T16:30:00.000Z",
};

describe("groupSlotsByDay", () => {
  it("agrupa por dayIso conservando el orden y marca días sin huecos libres", () => {
    const days = groupSlotsByDay([
      slot("2026-10-21", "10:00"),
      slot("2026-10-21", "10:30", [servicioJuan]),
      slot("2026-10-22", "09:00", [servicioJuan]),
    ]);
    expect(days.map((d) => d.dayIso)).toEqual(["2026-10-21", "2026-10-22"]);
    expect(days[0]?.slots.map((s) => s.time)).toEqual(["10:00", "10:30"]);
    expect(days[0]?.hasFree).toBe(true);
    expect(days[1]?.hasFree).toBe(false);
    expect(days[1]?.dayLabel).toBe("Día 2026-10-22");
  });

  it("sin horarios no hay días", () => {
    expect(groupSlotsByDay([])).toEqual([]);
  });
});

describe("detalle de choques", () => {
  it("arma 'Servicio · Juan · 10:00' en la zona del negocio", () => {
    expect(conflictDetail(servicioJuan, "America/Mexico_City")).toBe(
      "Servicio · Juan · 10:00"
    );
  });

  it("sin zona usa la hora de respaldo; sin tipo ni vendedor, rótulos neutros", () => {
    expect(
      conflictDetail(
        { ...servicioJuan, typeName: null, sellerName: null },
        undefined,
        "10:00"
      )
    ).toBe("Cita · Sin asignar · 10:00");
  });

  it("una zona inválida no rompe: cae en la hora de respaldo", () => {
    expect(conflictDetail(servicioJuan, "Zona/Inexistente", "10:00")).toBe(
      "Servicio · Juan · 10:00"
    );
  });

  it("varios choques van en renglones", () => {
    const otro = { ...servicioJuan, bookingId: "bk_2", sellerName: "Ana" };
    expect(conflictsTitle([servicioJuan, otro], undefined, "10:00")).toBe(
      "Servicio · Juan · 10:00\nServicio · Ana · 10:00"
    );
  });

  it("mensaje de advertencia de respaldo en singular y plural", () => {
    expect(overlapMessage([servicioJuan])).toBe(
      "A esa hora ya hay 1 cita (Servicio, con Juan). ¿Agendar de todos modos?"
    );
    expect(
      overlapMessage([servicioJuan, { ...servicioJuan, sellerName: null }])
    ).toBe(
      "A esa hora ya hay 2 citas (Servicio, con Juan; Servicio, sin asignar). ¿Agendar de todos modos?"
    );
  });
});

describe("filtro 'Mías' y query de la lista", () => {
  const me = "usr_me";
  const asignada = { id: "a", assignedUser: { id: me }, createdByUserId: null };
  const creada = { id: "b", assignedUser: { id: "usr_otro" }, createdByUserId: me };
  const sinAsignar = { id: "c", assignedUser: null, createdByUserId: null };
  const ajena = { id: "d", assignedUser: { id: "usr_otro" }, createdByUserId: "usr_otro" };

  it("Mías = asignadas a mí o creadas por mí", () => {
    expect(isMine(asignada, me)).toBe(true);
    expect(isMine(creada, me)).toBe(true);
    expect(isMine(sinAsignar, me)).toBe(false);
    expect(isMine(ajena, me)).toBe(false);
    expect(
      applyClientFilter([asignada, creada, sinAsignar, ajena], "mine", me).map(
        (b) => b.id
      )
    ).toEqual(["a", "b"]);
  });

  it("los demás filtros no filtran en el cliente", () => {
    expect(applyClientFilter([asignada, sinAsignar], "all", me)).toHaveLength(2);
    expect(applyClientFilter([asignada, sinAsignar], "none", me)).toHaveLength(2);
  });

  it("'Mías' y 'Todas' no viajan al servidor; 'Sin asignar' y un id sí", () => {
    expect(sellerFilterToQuery("all")).toBeNull();
    expect(sellerFilterToQuery("mine")).toBeNull();
    expect(sellerFilterToQuery("none")).toBe("none");
    expect(sellerFilterToQuery("usr_x")).toBe("usr_x");
    expect(bookingsQuery("all", "all")).toBe("/api/bookings");
    expect(bookingsQuery("mine", "at_1")).toBe("/api/bookings?typeId=at_1");
    expect(bookingsQuery("none", "at_1")).toBe(
      "/api/bookings?sellerId=none&typeId=at_1"
    );
  });
});

describe("parseBookingError", () => {
  it("overlap_warning trae los conflictos y el mensaje del servidor", () => {
    const f = parseBookingError(409, {
      error: { code: "overlap_warning", message: "A esa hora ya hay 1 cita" },
      conflicts: [servicioJuan],
    });
    expect(f).toEqual({
      kind: "overlap_warning",
      message: "A esa hora ya hay 1 cita",
      conflicts: [servicioJuan],
    });
  });

  it("overlap_warning sin mensaje arma el de respaldo", () => {
    const f = parseBookingError(409, {
      error: { code: "overlap_warning" },
      conflicts: [servicioJuan],
    });
    expect(f.kind).toBe("overlap_warning");
    expect(f.message).toContain("¿Agendar de todos modos?");
  });

  it("slot_taken se distingue para recargar la rejilla", () => {
    const f = parseBookingError(409, {
      error: { code: "slot_taken", message: "Ese horario ya no está libre" },
      slots: [],
    });
    expect(f).toEqual({ kind: "slot_taken", message: "Ese horario ya no está libre" });
  });

  it("un cuerpo raro o vacío cae en el error genérico", () => {
    expect(parseBookingError(500, null, "Falló")).toEqual({
      kind: "error",
      message: "Falló",
    });
    expect(parseBookingError(422, "texto", "Falló").kind).toBe("error");
    expect(
      parseBookingError(403, { error: { code: "forbidden", message: "No" } })
    ).toEqual({ kind: "error", message: "No" });
  });
});
