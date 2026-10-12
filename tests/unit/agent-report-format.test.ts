import { describe, expect, it } from "vitest";
import { formatDuration, formatPercent, ratio } from "@/lib/reports";
import {
  NO_REASON,
  shapeAfterHandoff,
  shapeAttention,
  shapeDelivery,
  shapeEscalations,
  shapeFailures,
  shapeResponseTimes,
  shapeVolume,
} from "@/server/reports/agent";

/**
 * 02 — De filas crudas al DTO. Las filas imitan al driver real: con drizzle
 * sobre postgres-js los `count` pueden llegar como texto y las fechas sin `Z`.
 */

describe("ratio / formatos (RF-02-05)", () => {
  it("denominador 0 → null, nunca NaN", () => {
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(3, 0)).toBeNull();
    expect(ratio(1, 4)).toBe(0.25);
    expect(ratio(Number.NaN, 4)).toBeNull();
  });
  it("porcentaje", () => {
    expect(formatPercent(0.25)).toBe("25 %");
    expect(formatPercent(0.8)).toBe("80 %");
    expect(formatPercent(1 / 3)).toBe("33.3 %");
    expect(formatPercent(null)).toBe("—");
  });
  it("duraciones", () => {
    expect(formatDuration(4)).toBe("4 s");
    expect(formatDuration(59.6)).toBe("1 min");
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(3900)).toBe("1 h 5 min");
    expect(formatDuration(7200)).toBe("2 h");
    expect(formatDuration(97200)).toBe("1 d 3 h");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
  });
});

describe("M1 + M2", () => {
  it("CA-02-01: 4 activas, Solo IA 25 %", () => {
    const dto = shapeAttention([
      { active: "4", ai_only: "1", ai_and_human: "1", human_only: "1", unanswered: "1" },
    ]);
    expect(dto).toEqual({
      active: 4,
      aiOnly: 1,
      aiAndHuman: 1,
      humanOnly: 1,
      noReply: 1,
      aiOnlyRate: 0.25,
    });
  });
  it("CA-02-07: sin datos → ceros y aiOnlyRate null", () => {
    expect(shapeAttention([]).aiOnlyRate).toBeNull();
    expect(shapeAttention([{ active: 0 }]).active).toBe(0);
  });
});

describe("M3 — regla de manual_reply y approximate", () => {
  const counts = [
    { reason: "cliente", n: "2", approx: "1" },
    { reason: "manual_reply", n: "3", approx: "1" },
    { reason: "modelo", n: 1, approx: 0 },
    { reason: null, n: 1, approx: 1 },
  ];
  const samples = [
    {
      reason: "cliente",
      conversation_id: "cv_b",
      contact_id: "ct_b",
      contact_name: "B",
      note: "Quiere hablar con alguien",
      occurred_at: "2026-10-10T15:00:00.000Z",
    },
    // Defensa: aunque el SQL ya las filtra, una muestra de manual_reply no se cuela.
    { reason: "manual_reply", conversation_id: "cv_x", contact_id: "ct_x", contact_name: "X", note: "n", occurred_at: "x" },
  ];
  const dto = shapeEscalations(counts, samples);

  it("manual_reply fuera de byReason y de total; aparte como pausas", () => {
    expect(dto.byReason.map((r) => r.reason)).not.toContain("manual_reply");
    expect(dto.manualReplyPauses).toBe(3);
    expect(dto.total).toBe(4); // 2 cliente + 1 modelo + 1 sin motivo
  });
  it("aproximados cuentan en totales y encienden el aviso", () => {
    expect(dto.byReason.find((r) => r.reason === "cliente")?.count).toBe(2);
    expect(dto.approximate).toBe(true);
    expect(shapeEscalations([{ reason: "cliente", n: 1, approx: 0 }], []).approximate).toBe(false);
  });
  it("etiquetas en español, orden por cantidad y muestras con contacto", () => {
    expect(dto.byReason[0]).toEqual({
      reason: "cliente",
      label: "El cliente pidió un humano",
      count: 2,
      samples: [
        {
          conversationId: "cv_b",
          contactId: "ct_b",
          contactName: "B",
          note: "Quiere hablar con alguien",
          occurredAt: "2026-10-10T15:00:00.000Z",
        },
      ],
    });
    const sin = dto.byReason.find((r) => r.reason === NO_REASON);
    expect(sin?.label).toMatch(/pausa/i);
  });
  it("sin eventos → total 0, sin aviso", () => {
    expect(shapeEscalations([], [])).toEqual({
      total: 0,
      byReason: [],
      manualReplyPauses: 0,
      approximate: false,
    });
  });
});

describe("M4 / M5", () => {
  it("CA-02-02: IA ≈ 4 s, humano ≈ 10 min, D sin respuesta", () => {
    const dto = shapeResponseTimes([
      { quien: "ia", sesiones: "1", p50_s: 4, p90_s: 4 },
      { quien: "humano", sesiones: "1", p50_s: "600", p90_s: "600" },
      { quien: "sin_respuesta", sesiones: "1", p50_s: null, p90_s: null },
    ]);
    expect(dto).toEqual({
      ai: { sessions: 1, p50Seconds: 4, p90Seconds: 4 },
      human: { sessions: 1, p50Seconds: 600, p90Seconds: 600 },
      unanswered: 1,
    });
  });
  it("sin sesiones → percentiles null", () => {
    expect(shapeResponseTimes([]).ai).toEqual({ sessions: 0, p50Seconds: null, p90Seconds: null });
  });
  it("M5: atendidos / no atendidos", () => {
    expect(shapeAfterHandoff([{ escalations: "3", answered: "2", p50_s: 120, p90_s: 300 }])).toEqual({
      attended: 2,
      unattended: 1,
      p50Seconds: 120,
      p90Seconds: 300,
    });
    expect(shapeAfterHandoff([]).p50Seconds).toBeNull();
  });
});

describe("M6 / M7", () => {
  it("CA-02-03: fallidas 10 % en WhatsApp; Instagram suma a fallidas", () => {
    const dto = shapeFailures(
      [
        { channel: "whatsapp", origin: "ai", total: "6", failed: "1" },
        { channel: "whatsapp", origin: "operator", total: "4", failed: "0" },
        { channel: "instagram", origin: "ai", total: "2", failed: "1" },
      ],
      [{ error: "Número inválido", n: "2" }]
    );
    expect(dto.total).toBe(12);
    expect(dto.failed).toBe(2);
    expect(dto.byChannel).toEqual([
      { channel: "whatsapp", total: 10, failed: 1 },
      { channel: "instagram", total: 2, failed: 1 },
    ]);
    expect(dto.byOrigin).toEqual([
      { origin: "ai", total: 8, failed: 2 },
      { origin: "operator", total: 4, failed: 0 },
    ]);
    expect(dto.topErrors).toEqual([{ error: "Número inválido", count: 2 }]);
    expect(shapeFailures([], []).rate).toBeNull();
  });
  it("CA-02-03: entrega 80 %, lectura 75 %", () => {
    // 6 leídas, 2 entregadas, 1 enviada, 1 fallida.
    const dto = shapeDelivery([{ delivered: "8", read: "6", base: "10", unconfirmed: "0" }], ["whatsapp"]);
    expect(dto.deliveryRate).toBe(0.8);
    expect(dto.readRate).toBe(0.75);
    expect(dto.channels).toEqual(["whatsapp"]);
    const empty = shapeDelivery([], ["whatsapp"]);
    expect(empty.deliveryRate).toBeNull();
    expect(empty.readRate).toBeNull();
  });
});

describe("M8 — relleno de días vacíos (RF-02-07)", () => {
  const days = ["2026-10-01", "2026-10-02", "2026-10-03"];
  it("una fila por día × canal, también en cero", () => {
    const dto = shapeVolume(
      [
        { dia: "2026-10-02", channel: "whatsapp", direction: "in", n: "3" },
        { dia: "2026-10-02", channel: "whatsapp", direction: "out", n: "2" },
        { dia: "2026-10-03", channel: "instagram", direction: "in", n: 1 },
        // Fuera del rango o basura: se ignora.
        { dia: "2026-09-30", channel: "whatsapp", direction: "in", n: 9 },
        { dia: "2026-10-01", channel: "telegram", direction: "in", n: 9 },
      ],
      days
    );
    expect(dto.rows).toHaveLength(6); // 3 días × (whatsapp, instagram)
    expect(dto.rows.filter((r) => r.channel === "whatsapp").map((r) => r.day)).toEqual(days);
    expect(dto.rows).toContainEqual({ day: "2026-10-02", channel: "whatsapp", inbound: 3, outbound: 2 });
    expect(dto.rows).toContainEqual({ day: "2026-10-01", channel: "whatsapp", inbound: 0, outbound: 0 });
    expect(dto.rows).toContainEqual({ day: "2026-10-03", channel: "instagram", inbound: 1, outbound: 0 });
  });
  it("sin mensajes: 90 días → 90 filas de WhatsApp en cero", () => {
    const ninety = Array.from({ length: 90 }, (_, i) =>
      new Date(Date.UTC(2026, 6, 14 + i)).toISOString().slice(0, 10)
    );
    const dto = shapeVolume([], ninety);
    expect(dto.rows).toHaveLength(90);
    expect(dto.rows.every((r) => r.inbound === 0 && r.outbound === 0)).toBe(true);
  });
});
