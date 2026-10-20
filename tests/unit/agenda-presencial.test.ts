import { describe, expect, it } from "vitest";
import { expandWorkingDayToUtc } from "@/lib/time/slots";
import {
  buildCandidateSlots,
  classifySlots,
} from "@/server/agenda/availability";
import { STRICT, type BusyItem } from "@/server/agenda/conflicts";
import { bookingErrorResponse } from "@/server/agenda/http";
import { canViewBooking } from "@/server/agenda/queries";
import { BookingError } from "@/server/agenda/service";
import {
  DEFAULT_CALENDAR_SETTINGS,
  type CalendarSettings,
} from "@/server/agenda/settings";

/**
 * 023 — Agenda presencial, piezas puras: rejilla vs. duración del tipo,
 * clasificación de huecos, visibilidad por vendedor y el sobre del 409
 * `overlap_warning`.
 */

const MX = "America/Mexico_City";

function settings(over: Partial<CalendarSettings> = {}): CalendarSettings {
  return { ...DEFAULT_CALENDAR_SETTINGS, ...over };
}

describe("expandWorkingDayToUtc con stepMinutes", () => {
  it("la rejilla avanza el paso y cada slot dura lo pedido", () => {
    // Rejilla de 30, citas de 60, franja 09:00-11:00.
    const slots = expandWorkingDayToUtc(
      "2026-08-05",
      [{ start: "09:00", end: "11:00" }],
      MX,
      60,
      0,
      30
    );
    expect(slots.map((s) => s.startUtc.slice(11, 16))).toEqual([
      "15:00",
      "15:30",
      "16:00", // 10:00 + 60 = 11:00, cabe justo; 10:30 ya no cabe
    ]);
    expect(slots[0]!.endUtc).toBe("2026-08-05T16:00:00.000Z");
  });

  it("sin stepMinutes, idéntico a la 015", () => {
    const a = expandWorkingDayToUtc(
      "2026-08-05",
      [{ start: "09:00", end: "11:00" }],
      MX,
      30,
      15
    );
    const b = expandWorkingDayToUtc(
      "2026-08-05",
      [{ start: "09:00", end: "11:00" }],
      MX,
      30,
      15,
      45
    );
    expect(a).toEqual(b);
  });
});

describe("buildCandidateSlots con la duración del tipo", () => {
  it("rejilla = slotMinutes + buffer; largo = duración del tipo", () => {
    const s = settings({ slotMinutes: 30, bufferMinutes: 0 });
    const prueba = buildCandidateSlots(s, "2026-08-05", "2026-08-05", 60);
    // 09:00-18:00 cada 30 con citas de 60 ⇒ 09:00…17:00 = 17 huecos.
    expect(prueba).toHaveLength(17);
    expect(
      Date.parse(prueba[0]!.endUtc) - Date.parse(prueba[0]!.startUtc)
    ).toBe(60 * 60_000);
    expect(Date.parse(prueba[1]!.startUtc) - Date.parse(prueba[0]!.startUtc)).toBe(
      30 * 60_000
    );
  });

  it("sin duración, idéntico a la 015", () => {
    const s = settings();
    expect(buildCandidateSlots(s, "2026-08-05", "2026-08-05")).toEqual(
      buildCandidateSlots(s, "2026-08-05", "2026-08-05", s.slotMinutes)
    );
  });
});

describe("classifySlots", () => {
  const candidates = buildCandidateSlots(settings(), "2026-08-05", "2026-08-05");
  const now = new Date("2026-08-05T00:00:00.000Z");
  const otra: BusyItem = {
    id: "bk_1",
    kind: "session",
    startUtc: "2026-08-05T16:00:00.000Z",
    endUtc: "2026-08-05T16:30:00.000Z",
    typeId: "apt_serv",
    exclusive: false,
    assignedUserId: "u_juan",
    typeName: "Servicio",
    sellerName: "Juan",
  };
  const base = { now, minNoticeHours: 0, timezone: MX, bufferMinutes: 0 };

  it("strict descarta el hueco ocupado y nunca devuelve conflictos", () => {
    const slots = classifySlots(candidates, [otra], { ...base, ctx: STRICT });
    expect(slots.map((s) => s.startUtc)).not.toContain(otra.startUtc);
    expect(slots.every((s) => s.conflicts.length === 0)).toBe(true);
  });

  it("staff conserva el hueco con la cita compatible como conflicto", () => {
    const slots = classifySlots(candidates, [otra], {
      ...base,
      ctx: {
        mode: "staff",
        typeId: "apt_serv",
        typeExclusive: false,
        sellerId: "u_ana",
      },
    });
    const ocupado = slots.find((s) => s.startUtc === otra.startUtc);
    expect(ocupado?.conflicts.map((c) => c.id)).toEqual(["bk_1"]);
    expect(slots).toHaveLength(candidates.length);
  });
});

describe("visibilidad por vendedor (A3)", () => {
  const owner = { userId: "u_owner", role: "owner" as const };
  const ana = { userId: "u_ana", role: "member" as const };

  it("el Propietario ve todo", () => {
    expect(
      canViewBooking({ assignedUserId: "u_juan", createdByUserId: "u_juan" }, owner)
    ).toBe(true);
  });

  it("el Vendedor ve las suyas, las que creó y las sin asignar", () => {
    expect(canViewBooking({ assignedUserId: "u_ana", createdByUserId: null }, ana)).toBe(
      true
    );
    expect(
      canViewBooking({ assignedUserId: "u_juan", createdByUserId: "u_ana" }, ana)
    ).toBe(true);
    expect(canViewBooking({ assignedUserId: null, createdByUserId: null }, ana)).toBe(
      true
    );
  });

  it("no ve la cita de otro vendedor", () => {
    expect(
      canViewBooking({ assignedUserId: "u_juan", createdByUserId: "u_juan" }, ana)
    ).toBe(false);
  });
});

describe("contrato del 409 overlap_warning", () => {
  it("sobre anidado con `conflicts` como hermano, sin datos del contacto", async () => {
    const conflict: BusyItem = {
      id: "bk_9",
      kind: "session",
      startUtc: "2026-08-05T15:00:00.000Z",
      endUtc: "2026-08-05T15:30:00.000Z",
      typeId: "apt_serv",
      exclusive: false,
      assignedUserId: "u_juan",
      typeName: "Servicio",
      sellerName: "Juan",
    };
    const res = bookingErrorResponse(
      new BookingError(
        "overlap_warning",
        "A esa hora ya hay 1 cita (Servicio, con Juan).",
        [],
        [conflict]
      )
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "overlap_warning",
        message: "A esa hora ya hay 1 cita (Servicio, con Juan).",
      },
      conflicts: [
        {
          bookingId: "bk_9",
          typeName: "Servicio",
          sellerName: "Juan",
          startUtc: "2026-08-05T15:00:00.000Z",
          endUtc: "2026-08-05T15:30:00.000Z",
        },
      ],
    });
  });

  it("slot_taken conserva su forma (sin `conflicts` si no hay detalle)", async () => {
    const res = bookingErrorResponse(new BookingError("slot_taken", "ocupado"));
    expect(await res.json()).toEqual({
      error: { code: "slot_taken", message: "ocupado" },
      slots: [],
    });
  });
});
