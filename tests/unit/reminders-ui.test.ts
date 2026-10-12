import { describe, expect, it } from "vitest";
import {
  BOOKING_REMINDER_SKIP_REASONS,
  REMINDER_INTERRUPTED_ERROR,
  type BookingReminderDto,
  type ReminderSettingsDto,
} from "@/lib/reminders";
import type { BookingReportDto } from "@/lib/reports";
import type { TemplateDto } from "@/lib/types";
import {
  REMINDER_OFFSET_HOURS_LIMITS,
  approvedTemplates,
  buildReminderInput,
  classifyReminderSave,
  formFromDto,
  hoursToMinutes,
  minutesToHours,
  reminderWarningMessage,
  resizeMapping,
  templateVariableCount,
  validateMapping,
  validateOffsetsHours,
} from "@/components/settings/reminder-settings-logic";
import {
  SKIP_REASON_LABEL,
  describeReminder,
  offsetLabel,
  reminderErrorLabel,
  retryErrorMessage,
} from "@/components/bookings/reminder-labels";
import {
  attendanceDetail,
  classifyBookingReportResponse,
  isBookingReportEmpty,
  offerDataSinceNote,
  offerDetail,
  pendingToMarkLabel,
} from "@/components/reports/bookings-report-format";

function template(over: Partial<TemplateDto> = {}): TemplateDto {
  return {
    id: "tpl_1",
    name: "recordatorio",
    language: "es_MX",
    category: "UTILITY",
    body: "Hola {{1}}, te esperamos el {{2}}.",
    status: "approved",
    rejectionReason: null,
    ...over,
  };
}

function settingsDto(over: Partial<ReminderSettingsDto> = {}): ReminderSettingsDto {
  return {
    enabled: false,
    enabledAt: null,
    templateId: null,
    template: null,
    offsetsMinutes: [1440],
    variables: [],
    warning: null,
    ...over,
  };
}

function reminder(over: Partial<BookingReminderDto> = {}): BookingReminderDto {
  return {
    id: "brm_1",
    offsetMinutes: 1440,
    scheduledFor: "2026-10-13T16:00:00.000Z",
    dueAt: "2026-10-12T16:00:00.000Z",
    status: "sent",
    reason: null,
    error: null,
    sentAt: "2026-10-12T16:00:05.000Z",
    attempts: 1,
    canRetry: false,
    delivery: null,
    deliveryError: null,
    ...over,
  };
}

describe("recordatorios — horas ↔ minutos y límites", () => {
  it("convierte horas a minutos enteros y de vuelta", () => {
    expect(hoursToMinutes(24)).toBe(1440);
    expect(hoursToMinutes(1.5)).toBe(90);
    expect(minutesToHours(1440)).toBe(24);
    expect(minutesToHours(90)).toBe(1.5);
  });

  it("los límites en horas salen del contrato (60..4320 min)", () => {
    expect(REMINDER_OFFSET_HOURS_LIMITS).toEqual({ min: 1, max: 72 });
  });

  it("valida 1 o 2 anticipaciones únicas dentro de 1..72 h", () => {
    expect(validateOffsetsHours([24])).toBeNull();
    expect(validateOffsetsHours([24, 2])).toBeNull();
    expect(validateOffsetsHours([1])).toBeNull();
    expect(validateOffsetsHours([72])).toBeNull();
    expect(validateOffsetsHours([])).toMatch(/al menos una/);
    expect(validateOffsetsHours([24, 2, 1])).toMatch(/máximo 2/);
    expect(validateOffsetsHours([0.5])).toMatch(/de 1 a 72 horas/);
    expect(validateOffsetsHours([73])).toMatch(/de 1 a 72 horas/);
    expect(validateOffsetsHours([Number.NaN])).toMatch(/Escribe/);
    expect(validateOffsetsHours([24, 24])).toMatch(/iguales/);
  });
});

describe("recordatorios — mapeo de variables", () => {
  it("cuenta las variables de la plantilla", () => {
    expect(templateVariableCount(template())).toBe(2);
    expect(templateVariableCount(template({ body: "Sin variables" }))).toBe(0);
    expect(templateVariableCount(null)).toBe(0);
  });

  it("solo ofrece plantillas aprobadas", () => {
    const list = [
      template({ id: "a" }),
      template({ id: "b", status: "pending" }),
      template({ id: "c", status: "rejected" }),
    ];
    expect(approvedTemplates(list).map((t) => t.id)).toEqual(["a"]);
  });

  it("ajusta el mapeo al número de variables conservando lo elegido", () => {
    expect(resizeMapping(["contact_name"], 3)).toEqual(["contact_name", "", ""]);
    expect(resizeMapping(["contact_name", "booking_datetime", "meeting_link"], 1)).toEqual([
      "contact_name",
    ]);
  });

  it("exige un campo del catálogo por cada {{n}}", () => {
    expect(validateMapping(["contact_name", "booking_datetime"], 2)).toBeNull();
    expect(validateMapping(["contact_name"], 2)).toMatch(/faltan 1/);
    expect(validateMapping(["contact_name", ""], 2)).toMatch(/\{\{2\}\}/);
    expect(validateMapping([], 0)).toBeNull();
  });

  it("arma el PUT en minutos solo con campos de recordatorio", () => {
    const check = buildReminderInput(
      {
        enabled: true,
        templateId: "tpl_1",
        offsetsHours: [24, 2],
        variables: ["contact_name", "booking_datetime"],
      },
      template()
    );
    expect(check).toEqual({
      ok: true,
      input: {
        reminderEnabled: true,
        reminderTemplateId: "tpl_1",
        reminderOffsetsMinutes: [1440, 120],
        reminderVariables: ["contact_name", "booking_datetime"],
      },
    });
  });

  it("encendido sin plantilla, no aprobada o con mapeo incompleto → no se manda", () => {
    const base = {
      enabled: true,
      templateId: "tpl_1",
      offsetsHours: [24],
      variables: ["contact_name", "booking_datetime"] as const,
    };
    expect(buildReminderInput({ ...base, variables: [...base.variables], templateId: null }, null).ok).toBe(
      false
    );
    expect(
      buildReminderInput(
        { ...base, variables: [...base.variables] },
        template({ status: "rejected" })
      ).ok
    ).toBe(false);
    const incomplete = buildReminderInput(
      { ...base, variables: ["contact_name", ""] },
      template()
    );
    expect(incomplete).toEqual({ ok: false, message: "Elige qué va en {{2}}." });
  });

  it("apagado guarda aunque falte el mapeo, sin huecos en las posiciones", () => {
    const check = buildReminderInput(
      {
        enabled: false,
        templateId: "tpl_1",
        offsetsHours: [24],
        variables: ["contact_name", "", "meeting_link"],
      },
      template({ body: "{{1}} {{2}} {{3}}" })
    );
    expect(check.ok && check.input.reminderVariables).toEqual(["contact_name"]);
  });

  it("parte del DTO del servidor en horas", () => {
    const form = formFromDto(
      settingsDto({ enabled: true, offsetsMinutes: [1440, 90], variables: ["contact_name"] })
    );
    expect(form.offsetsHours).toEqual([24, 1.5]);
    expect(form.variables).toEqual(["contact_name"]);
  });

  it("explica los avisos de plantilla del DTO", () => {
    expect(reminderWarningMessage("template_missing")).toMatch(/ya no existe/);
    expect(reminderWarningMessage("template_not_approved")).toMatch(/ya no está aprobada/);
    expect(reminderWarningMessage(null)).toBeNull();
  });

  it("interpreta la respuesta del guardado (501 → disponible pronto, 422 → mensaje)", () => {
    expect(classifyReminderSave(501, null)).toEqual({ kind: "soon" });
    expect(
      classifyReminderSave(422, { error: { code: "invalid_body", message: "Plantilla no aprobada" } })
    ).toEqual({ kind: "error", message: "Plantilla no aprobada" });
    expect(classifyReminderSave(403, null).kind).toBe("error");
    const dto = settingsDto({ enabled: true });
    expect(classifyReminderSave(200, { settings: {}, reminders: dto })).toEqual({
      kind: "ok",
      reminders: dto,
    });
    expect(classifyReminderSave(200, {}).kind).toBe("error");
  });
});

describe("recordatorios — etiquetas en Citas", () => {
  const fmt = () => "12 oct, 10:00";

  it("anticipación legible", () => {
    expect(offsetLabel(1440)).toBe("24 h");
    expect(offsetLabel(120)).toBe("2 h");
    expect(offsetLabel(90)).toBe("1 h 30 min");
    expect(offsetLabel(45)).toBe("45 min");
  });

  it("pendiente con su hora de envío", () => {
    expect(describeReminder(reminder({ id: null, status: "pending", sentAt: null }), fmt)).toEqual({
      text: "Recordatorio 24 h: pendiente (sale el 12 oct, 10:00)",
      tone: "secondary",
    });
  });

  it("enviando, enviado y su entrega", () => {
    expect(describeReminder(reminder({ status: "sending" }), fmt).text).toBe(
      "Recordatorio 24 h: enviando…"
    );
    expect(describeReminder(reminder(), fmt).text).toBe("Recordatorio 24 h: enviado");
    expect(describeReminder(reminder({ delivery: "delivered" }), fmt).text).toBe(
      "Recordatorio 24 h: enviado · entregado"
    );
    expect(describeReminder(reminder({ delivery: "read" }), fmt)).toEqual({
      text: "Recordatorio 24 h: enviado · leído",
      tone: "success",
    });
    expect(
      describeReminder(reminder({ delivery: "failed", deliveryError: "Número inválido" }), fmt)
    ).toEqual({ text: "Recordatorio 24 h: enviado · no entregado: Número inválido", tone: "destructive" });
  });

  it("fallido con error legible (también el interrumpido)", () => {
    expect(
      describeReminder(reminder({ status: "failed", error: "Meta rechazó el envío" }), fmt).text
    ).toBe("Recordatorio 24 h: falló: Meta rechazó el envío");
    expect(reminderErrorLabel(REMINDER_INTERRUPTED_ERROR)).toMatch(/se interrumpió/);
    expect(reminderErrorLabel(null)).toBe("error desconocido");
  });

  it("omitido con motivo legible para cada motivo del catálogo", () => {
    for (const reason of BOOKING_REMINDER_SKIP_REASONS) {
      expect(SKIP_REASON_LABEL[reason]).toBeTruthy();
      const view = describeReminder(reminder({ status: "skipped", reason, offsetMinutes: 120 }), fmt);
      expect(view.text).toBe(`Recordatorio 2 h: omitido: ${SKIP_REASON_LABEL[reason]}`);
      expect(view.tone).toBe("warning");
    }
  });

  it("mensajes del reintento por código (409) y 501", () => {
    expect(retryErrorMessage(200, { ok: true })).toBeNull();
    expect(retryErrorMessage(409, { error: { code: "not_retryable", message: "x" } })).toMatch(
      /ya no está fallido/
    );
    expect(retryErrorMessage(409, { error: { code: "retry_exhausted", message: "x" } })).toMatch(
      /Ya se usó el reintento/
    );
    expect(retryErrorMessage(409, { error: { code: "booking_not_active", message: "x" } })).toMatch(
      /ya no está agendada/
    );
    expect(retryErrorMessage(501, { error: { code: "not_implemented", message: "x" } })).toMatch(
      /Disponible pronto/
    );
    expect(retryErrorMessage(500, { error: { code: "boom", message: "Algo raro" } })).toBe(
      "Algo raro"
    );
    expect(retryErrorMessage(500, null)).toBe("No se pudo reintentar el recordatorio.");
  });
});

describe("Reportes → Citas — interpretación y formato", () => {
  function report(over: Partial<BookingReportDto> = {}): BookingReportDto {
    return {
      range: {
        preset: "30d",
        from: "2026-09-13",
        to: "2026-10-12",
        days: [],
        tz: "America/Mexico_City",
        fromUtc: "2026-09-13T06:00:00.000Z",
        toUtc: "2026-10-13T06:00:00.000Z",
      },
      offers: {
        ok: true,
        data: { conversationsWithOffer: 10, converted: 4, rate: 0.4, offerRounds: 14, dataSince: null },
      },
      attendance: {
        ok: true,
        data: { realizada: 3, noShow: 1, rate: 0.75, pendingToMark: 2, cancelada: 1 },
      },
      byReminder: {
        ok: true,
        data: {
          withReminder: { realizada: 3, noShow: 0, rate: 1 },
          withoutReminder: { realizada: 0, noShow: 1, rate: 0 },
        },
      },
      ...over,
    };
  }

  it("clasifica la respuesta (501 → disponible pronto)", () => {
    expect(classifyBookingReportResponse(501, null)).toEqual({ kind: "soon" });
    expect(classifyBookingReportResponse(503, null)).toEqual({ kind: "timeout" });
    expect(classifyBookingReportResponse(422, { error: { message: "Máximo 366 días" } })).toEqual({
      kind: "invalid",
      message: "Máximo 366 días",
    });
    expect(classifyBookingReportResponse(401, null).kind).toBe("unauthorized");
    expect(classifyBookingReportResponse(403, null).kind).toBe("forbidden");
    expect(classifyBookingReportResponse(200, { range: {} }).kind).toBe("error");
    expect(classifyBookingReportResponse(200, report()).kind).toBe("ok");
  });

  it("vacío solo si los bloques llegaron y no hay nada", () => {
    expect(isBookingReportEmpty(report())).toBe(false);
    const empty = report({
      offers: {
        ok: true,
        data: { conversationsWithOffer: 0, converted: 0, rate: null, offerRounds: 0, dataSince: null },
      },
      attendance: {
        ok: true,
        data: { realizada: 0, noShow: 0, rate: null, pendingToMark: 0, cancelada: 0 },
      },
    });
    expect(isBookingReportEmpty(empty)).toBe(true);
    expect(isBookingReportEmpty({ ...empty, offers: { ok: false, error: "timeout" } })).toBe(false);
  });

  it("detalles legibles", () => {
    const r = report();
    if (!r.offers.ok || !r.attendance.ok) throw new Error("fixture");
    expect(offerDetail(r.offers.data)).toBe("4 de 10 conversaciones");
    expect(attendanceDetail(r.attendance.data)).toBe("3 de 4 citas marcadas");
    expect(attendanceDetail({ realizada: 0, noShow: 0, rate: null })).toBe("Ninguna cita marcada");
    expect(attendanceDetail({ realizada: 1, noShow: 0, rate: 1 })).toBe("1 de 1 cita marcada");
    expect(pendingToMarkLabel(r.attendance.data)).toBe("2 citas pasadas sin marcar");
    expect(pendingToMarkLabel({ ...r.attendance.data, pendingToMark: 0 })).toBe(
      "Nada pendiente de marcar"
    );
  });

  it("aviso del registro de ofertas en la zona del negocio", () => {
    expect(offerDataSinceNote(null, "America/Mexico_City")).toMatch(/todavía no hay ninguna/);
    // 03:00 UTC del 13 = 21:00 del 12 en Ciudad de México.
    expect(offerDataSinceNote("2026-10-13T03:00:00.000Z", "America/Mexico_City")).toBe(
      "Ofertas registradas desde el 12 oct 2026: antes de esa fecha no hay datos."
    );
  });
});
