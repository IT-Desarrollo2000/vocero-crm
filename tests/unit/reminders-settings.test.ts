import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReminderOrgConfig } from "@/server/agenda/reminder-store";

/**
 * 10 — Ajustes de recordatorio (RF-10-02) y variables del catálogo cerrado
 * (RF-10-03): encender exige plantilla aprobada y un campo por CADA `{{n}}`;
 * `reminder_enabled_at` = reloj de JS en cada transición apagado → encendido;
 * nunca un parámetro vacío.
 */

let current: ReminderOrgConfig | null = null;
const templates: Record<string, { id: string; status: string; body: string }> = {};

vi.mock("@/server/agenda/reminder-store", async (orig) => {
  const real = await orig<typeof import("@/server/agenda/reminder-store")>();
  return {
    ...real,
    getReminderOrgConfig: async () => current,
    getReminderTemplate: async (_org: string, id: string) => templates[id] ?? null,
  };
});

const { planReminderSettings, renderReminderVariables } = await import(
  "@/server/agenda/reminders"
);
const { CalendarSettingsError } = await import("@/server/agenda/settings");

const NOW = new Date("2026-10-12T18:00:00.000Z");

beforeEach(() => {
  current = null;
  templates.tpl_ok = { id: "tpl_ok", status: "approved", body: "Hola {{1}}, tu cita: {{2}}" };
  templates.tpl_pend = { id: "tpl_pend", status: "pending", body: "Hola {{1}}" };
});

describe("planReminderSettings", () => {
  it("encender con plantilla aprobada y mapeo completo: enabledAt = now", async () => {
    const plan = await planReminderSettings(
      "org_1",
      {
        reminderEnabled: true,
        reminderTemplateId: "tpl_ok",
        reminderVariables: ["contact_name", "booking_datetime"],
      },
      NOW
    );
    expect(plan).toMatchObject({ enabled: true, enabledAt: NOW, offsetsMinutes: [1440] });
  });

  it("seguir encendido NO reescribe enabledAt; apagar tampoco lo borra", async () => {
    const before = new Date("2026-10-01T00:00:00.000Z");
    current = {
      organizationId: "org_1",
      enabled: true,
      enabledAt: before,
      templateId: "tpl_ok",
      offsetsMinutes: [1440],
      variables: ["contact_name", "booking_datetime"],
      timezone: "America/Mexico_City",
    };
    expect((await planReminderSettings("org_1", { reminderOffsetsMinutes: [1440, 120] }, NOW)).enabledAt).toBe(before);
    expect((await planReminderSettings("org_1", { reminderEnabled: false }, NOW)).enabledAt).toBe(before);
    current = { ...current, enabled: false };
    expect((await planReminderSettings("org_1", { reminderEnabled: true }, NOW)).enabledAt).toBe(NOW);
  });

  it("plantilla no aprobada → 422 con mensaje", async () => {
    await expect(
      planReminderSettings(
        "org_1",
        { reminderEnabled: true, reminderTemplateId: "tpl_pend", reminderVariables: ["contact_name"] },
        NOW
      )
    ).rejects.toThrow(/no está aprobada/);
  });

  it("mapeo incompleto (o sobrante) → 422", async () => {
    await expect(
      planReminderSettings(
        "org_1",
        { reminderEnabled: true, reminderTemplateId: "tpl_ok", reminderVariables: ["contact_name"] },
        NOW
      )
    ).rejects.toBeInstanceOf(CalendarSettingsError);
    await expect(
      planReminderSettings(
        "org_1",
        {
          reminderEnabled: true,
          reminderTemplateId: "tpl_ok",
          reminderVariables: ["contact_name", "booking_datetime", "meeting_link"],
        },
        NOW
      )
    ).rejects.toThrow(/2 variable/);
  });

  it("sin plantilla o con una inexistente → 422; apagado sin plantilla se guarda", async () => {
    await expect(planReminderSettings("org_1", { reminderEnabled: true }, NOW)).rejects.toThrow(
      /elige una plantilla/
    );
    await expect(
      planReminderSettings("org_1", { reminderTemplateId: "tpl_otra_org" }, NOW)
    ).rejects.toThrow(/no existe/);
    const off = await planReminderSettings("org_1", { reminderOffsetsMinutes: [120] }, NOW);
    expect(off).toMatchObject({ enabled: false, enabledAt: null, offsetsMinutes: [120] });
  });
});

describe("renderReminderVariables", () => {
  const ctx = {
    contactName: "Ana",
    scheduledAt: new Date("2026-10-20T16:00:00.000Z"),
    timezone: "America/Mexico_City",
    meetingLink: null,
    businessName: "Clínica Sol",
  };

  it("cada campo del catálogo, con la fecha en la zona del negocio", () => {
    const out = renderReminderVariables(
      ["contact_name", "booking_datetime", "meeting_link", "business_name"],
      ctx
    );
    expect(out[0]).toBe("Ana");
    expect(out[1]).toMatch(/20 oct, 10:00$/);
    expect(out[2]).toBe("te lo compartimos por este medio");
    expect(out[3]).toBe("Clínica Sol");
  });

  it("nunca un parámetro vacío", () => {
    const out = renderReminderVariables(["contact_name", "business_name", "meeting_link"], {
      ...ctx,
      contactName: "  ",
      businessName: "",
      meetingLink: "",
    });
    expect(out.every((v) => v.trim().length > 0)).toBe(true);
  });
});

describe("023 — variables de agenda presencial (A8)", () => {
  const base = {
    contactName: "Ana",
    scheduledAt: new Date("2026-10-20T16:00:00.000Z"),
    timezone: "America/Mexico_City",
    meetingLink: null,
    businessName: "Autos Sol",
  };

  it("tipo de cita y dirección del negocio", () => {
    const out = renderReminderVariables(["appointment_type", "address"], {
      ...base,
      appointmentType: "Prueba de manejo",
      address: "Av. Juárez 100, Centro",
    });
    expect(out).toEqual(["Prueba de manejo", "Av. Juárez 100, Centro"]);
  });

  it("con respaldo no vacío: «tu cita» y «nuestra sucursal»", () => {
    const out = renderReminderVariables(["appointment_type", "address"], {
      ...base,
      appointmentType: "  ",
      address: null,
    });
    expect(out).toEqual(["tu cita", "nuestra sucursal"]);
    // Sin los campos en el contexto (llamadores de la 015), igual.
    expect(renderReminderVariables(["appointment_type", "address"], base)).toEqual([
      "tu cita",
      "nuestra sucursal",
    ]);
  });

  it("forman parte del catálogo cerrado, con etiqueta", async () => {
    const { REMINDER_FIELDS, REMINDER_FIELD_LABEL } = await import("@/lib/reminders");
    expect(REMINDER_FIELDS).toContain("appointment_type");
    expect(REMINDER_FIELDS).toContain("address");
    expect(REMINDER_FIELD_LABEL.appointment_type).toBe("Tipo de cita");
    expect(REMINDER_FIELD_LABEL.address).toBe("Dirección del negocio");
    const { normalizeVariables } = await import("@/server/agenda/reminder-store");
    expect(normalizeVariables(["contact_name", "appointment_type", "address"])).toEqual([
      "contact_name",
      "appointment_type",
      "address",
    ]);
  });
});
