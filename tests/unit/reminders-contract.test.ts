import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOOKING_REMINDER_STATUSES,
  REMINDER_MAX_GRACE_MS,
  REMINDER_MIN_LEAD_MS,
  REMINDER_STUCK_AFTER_MS,
  reminderDueAt,
  reminderGraceMs,
  reminderTiming,
} from "@/lib/reminders";
import { getWaMockState, resetWaMockState } from "@/server/dev/wa-mock-state";

/**
 * 10 — Contrato 10-0 de los recordatorios de cita: la regla de RELOJ que
 * comparten ticker y UI, las constantes, y que la migración 0018 sea
 * re-ejecutable. Las pruebas de comportamiento (claim, envío, retry) llegan
 * con 10-A.
 */

const MIN = 60_000;
const H = 60 * MIN;

const scheduledAt = new Date("2026-10-20T16:00:00.000Z");
const base = {
  scheduledAt,
  bookingCreatedAt: new Date("2026-10-15T12:00:00.000Z"),
  offsetMinutes: 1440,
  enabledAt: new Date("2026-10-01T00:00:00.000Z"),
};
const due = reminderDueAt(scheduledAt, 1440);

describe("constantes del reloj", () => {
  it("interrumpido a los 10 min, nunca a < 15 min de la cita, gracia ≤ 6 h", () => {
    expect(REMINDER_STUCK_AFTER_MS).toBe(10 * MIN);
    expect(REMINDER_MIN_LEAD_MS).toBe(15 * MIN);
    expect(REMINDER_MAX_GRACE_MS).toBe(6 * H);
  });

  it("gracia = min(offset/4, 6 h): 24 h → 6 h, 2 h → 30 min", () => {
    expect(reminderGraceMs(1440)).toBe(6 * H);
    expect(reminderGraceMs(120)).toBe(30 * MIN);
    expect(reminderGraceMs(4320)).toBe(6 * H);
  });

  it("los estados del catálogo son los del contrato", () => {
    expect([...BOOKING_REMINDER_STATUSES]).toEqual([
      "pending",
      "sending",
      "sent",
      "failed",
      "skipped",
    ]);
  });
});

describe("reminderTiming (RF-10-04 + reminder_enabled_at)", () => {
  it("toca justo al vencer y dentro de la gracia", () => {
    expect(due.toISOString()).toBe("2026-10-19T16:00:00.000Z");
    expect(reminderTiming(base, due)).toBeNull();
    expect(reminderTiming(base, new Date(due.getTime() + 6 * H))).toBeNull();
  });

  it("antes de vencer no toca; pasada la gracia tampoco", () => {
    expect(reminderTiming(base, new Date(due.getTime() - MIN))).toBe("not_due");
    expect(reminderTiming(base, new Date(due.getTime() + 6 * H + MIN))).toBe(
      "grace_expired"
    );
  });

  it("a menos de 15 min de la cita no sale (aunque esté en gracia)", () => {
    // Con las anticipaciones permitidas (≥ 60 min) la gracia ya lo impide;
    // la regla es la red de seguridad si los límites cambian.
    const o = { ...base, offsetMinutes: 16 }; // gracia 4 min
    const d = reminderDueAt(scheduledAt, 16);
    expect(reminderTiming(o, new Date(d.getTime() + MIN))).toBeNull();
    expect(reminderTiming(o, new Date(d.getTime() + 2 * MIN))).toBe("too_close");
  });

  it("cita creada dentro de la ventana: no aplica", () => {
    const late = { ...base, bookingCreatedAt: new Date(due.getTime() + MIN) };
    expect(reminderTiming(late, new Date(due.getTime() + 2 * MIN))).toBe(
      "before_created"
    );
  });

  it("encender no dispara ráfaga: vencimientos previos a enabledAt no salen", () => {
    const on = { ...base, enabledAt: new Date(due.getTime() + MIN) };
    expect(reminderTiming(on, new Date(due.getTime() + 2 * MIN))).toBe(
      "before_enabled"
    );
    expect(reminderTiming({ ...base, enabledAt: null }, due)).toBe("not_enabled");
  });

  it("reprogramar cambia el vencimiento (clave nueva)", () => {
    const moved = new Date(scheduledAt.getTime() + 3 * 24 * H);
    expect(reminderDueAt(moved, 1440).getTime()).toBe(due.getTime() + 3 * 24 * H);
  });
});

describe("wa-mock: falla conmutable de envíos", () => {
  it("arranca apagada y el reset total la apaga", () => {
    resetWaMockState();
    expect(getWaMockState().failSends).toBe("off");
    getWaMockState().failSends = "error";
    resetWaMockState();
    expect(getWaMockState().failSends).toBe("off");
  });
});

describe("migración 0018", () => {
  const sql = readFileSync(
    path.resolve(import.meta.dirname, "..", "..", "drizzle", "0018_recordatorios_citas.sql"),
    "utf8"
  );
  const statements = sql
    .split("--> statement-breakpoint")
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);

  it("cada sentencia es re-ejecutable", () => {
    for (const st of statements) {
      const ok =
        /^CREATE TABLE IF NOT EXISTS/.test(st) ||
        /^ALTER TABLE "\w+" ADD COLUMN IF NOT EXISTS/.test(st) ||
        /^CREATE (UNIQUE )?INDEX IF NOT EXISTS/.test(st) ||
        /^DO \$\$ BEGIN[\s\S]*EXCEPTION WHEN duplicate_object THEN null; END \$\$;?$/.test(st);
      expect(ok, st.slice(0, 120)).toBe(true);
    }
  });

  it("claim atómico: UNIQUE (booking_id, offset_minutes, scheduled_for)", () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "booking_reminder_claim_uq" ON "booking_reminder" USING btree ("booking_id","offset_minutes","scheduled_for")'
    );
  });

  it("claimed_at sin default: lo pone JS", () => {
    expect(sql).toMatch(/"claimed_at" timestamp NOT NULL,/);
  });
});
