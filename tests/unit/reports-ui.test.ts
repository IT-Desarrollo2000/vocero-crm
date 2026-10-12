import { describe, expect, it } from "vitest";
import {
  DEFAULT_RANGE,
  MAX_RANGE_DAYS,
  daysInclusive,
  isIsoDay,
  parseRangeParams,
  rangeToQuery,
  validateCustomRange,
} from "@/components/reports/range-params";
import {
  EMPTY_VALUE,
  formatCount,
  formatDayLong,
  formatDayRange,
  formatDayShort,
  formatDuration,
  formatPercent,
  ratio,
} from "@/components/reports/format";
import {
  CHANNEL_CHART_COLOR,
  THEME_BACKGROUNDS,
  attentionSegments,
  barPercent,
  buildVolumeSeries,
  contrastRatio,
  dayLabelStep,
  niceScale,
  stackDay,
} from "@/components/reports/chart";
import {
  TIMEOUT_MESSAGE,
  classifyReportResponse,
  isReportEmpty,
} from "@/components/reports/report-fetch";
import type { AgentReportDto } from "@/components/reports/types";
import { CHANNEL_ORDER } from "@/lib/channels";

// 02 — Lógica pura de la pantalla Reportes → Agente (02-B).

const params = (q: string) => new URLSearchParams(q);

describe("rango en la URL", () => {
  it("lee presets con y sin sufijo d", () => {
    expect(parseRangeParams(params("range=7"))).toEqual({ preset: "7d" });
    expect(parseRangeParams(params("range=90d"))).toEqual({ preset: "90d" });
    expect(parseRangeParams(params("range=30"))).toEqual({ preset: "30d" });
  });

  it("sin parámetros o ilegible → 30 días", () => {
    expect(parseRangeParams(params(""))).toEqual(DEFAULT_RANGE);
    expect(parseRangeParams(params("range=15"))).toEqual(DEFAULT_RANGE);
    expect(parseRangeParams(params("range=custom&from=2026-10-10&to=2026-10-01"))).toEqual(
      DEFAULT_RANGE
    );
    expect(parseRangeParams(params("from=2026-02-30&to=2026-03-01"))).toEqual(DEFAULT_RANGE);
  });

  it("personalizado con o sin range=custom", () => {
    const custom = { preset: "custom", from: "2026-10-01", to: "2026-10-10" };
    expect(parseRangeParams(params("range=custom&from=2026-10-01&to=2026-10-10"))).toEqual(
      custom
    );
    expect(parseRangeParams(params("from=2026-10-01&to=2026-10-10"))).toEqual(custom);
  });

  it("emite una sola forma canónica, ida y vuelta", () => {
    expect(rangeToQuery({ preset: "90d" })).toBe("range=90d");
    const q = rangeToQuery({ preset: "custom", from: "2026-01-01", to: "2026-01-31" });
    expect(q).toBe("range=custom&from=2026-01-01&to=2026-01-31");
    expect(parseRangeParams(params(q))).toEqual({
      preset: "custom",
      from: "2026-01-01",
      to: "2026-01-31",
    });
  });

  it("valida el personalizado como la API (from ≤ to, ≤ 366 días)", () => {
    expect(isIsoDay("2026-02-29")).toBe(false);
    expect(isIsoDay("2028-02-29")).toBe(true);
    expect(daysInclusive("2026-10-01", "2026-10-01")).toBe(1);
    expect(validateCustomRange("2026-10-01", "2026-10-07")).toEqual({ ok: true, days: 7 });
    expect(validateCustomRange("2026-10-10", "2026-10-01").ok).toBe(false);
    expect(validateCustomRange("", "2026-10-01").ok).toBe(false);
    // 2025-10-12 → 2026-10-12 son 366 días con ambos extremos: justo el tope.
    expect(validateCustomRange("2025-10-12", "2026-10-12")).toEqual({
      ok: true,
      days: MAX_RANGE_DAYS,
    });
    expect(validateCustomRange("2025-10-11", "2026-10-12").ok).toBe(false);
  });

  it("cruza el cambio de horario sin perder ni duplicar días", () => {
    // Días calendario, no horas: el DST no mueve la cuenta.
    expect(daysInclusive("2026-03-01", "2026-03-31")).toBe(31);
    expect(daysInclusive("2026-10-25", "2026-11-05")).toBe(12);
  });
});

describe("formato", () => {
  it("denominador 0 → null → «—», nunca NaN ni 0 %", () => {
    expect(ratio(1, 0)).toBeNull();
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(Number.NaN, 4)).toBeNull();
    expect(formatPercent(ratio(0, 0))).toBe(EMPTY_VALUE);
    expect(formatPercent(Number.NaN)).toBe(EMPTY_VALUE);
    expect(formatCount(null)).toBe(EMPTY_VALUE);
  });

  it("porcentajes de los criterios de aceptación", () => {
    expect(formatPercent(1 / 4)).toBe("25 %");
    expect(formatPercent(1 / 10)).toBe("10 %");
    expect(formatPercent(8 / 10)).toBe("80 %");
    expect(formatPercent(6 / 8)).toBe("75 %");
    expect(formatPercent(0)).toBe("0 %");
    expect(formatPercent(1)).toBe("100 %");
    expect(formatPercent(0.025)).toBe("2.5 %");
    expect(formatPercent(0.004)).toBe("0.4 %");
  });

  it("duraciones legibles", () => {
    expect(formatDuration(null)).toBe(EMPTY_VALUE);
    expect(formatDuration(-1)).toBe(EMPTY_VALUE);
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(4.2)).toBe("4 s");
    expect(formatDuration(59)).toBe("59 s");
    expect(formatDuration(60)).toBe("1 min");
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(3600)).toBe("1 h");
    expect(formatDuration(3900)).toBe("1 h 5 min");
    expect(formatDuration(26 * 3600)).toBe("1 d 2 h");
    expect(formatDuration(48 * 3600)).toBe("2 d");
  });

  it("días sin pasar por Date (no se corren de zona)", () => {
    expect(formatDayShort("2026-10-01")).toBe("1 oct");
    expect(formatDayLong("2026-01-31")).toBe("31 ene 2026");
    expect(formatDayRange("2026-10-01", "2026-10-07")).toBe("1 oct – 7 oct 2026");
    expect(formatDayRange("2025-12-30", "2026-01-02")).toBe("30 dic 2025 – 2 ene 2026");
    expect(formatDayRange("2026-10-01", "2026-10-01")).toBe("1 oct 2026");
  });
});

describe("gráficos", () => {
  it("escala redonda y nunca entre cero", () => {
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceScale(Number.NaN).max).toBe(1);
    expect(niceScale(3)).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
    expect(niceScale(37)).toEqual({ max: 40, ticks: [0, 10, 20, 30, 40] });
    expect(niceScale(180).max).toBe(200);
    const s = niceScale(1234);
    expect(s.max).toBeGreaterThanOrEqual(1234);
    expect(s.ticks.at(-1)).toBe(s.max);
  });

  it("etiquetas del eje x: todas con pocos días, ~7 con muchos", () => {
    expect(dayLabelStep(7)).toBe(1);
    expect(Math.ceil(30 / dayLabelStep(30))).toBeLessThanOrEqual(8);
    expect(Math.ceil(90 / dayLabelStep(90))).toBeLessThanOrEqual(8);
    expect(Math.ceil(366 / dayLabelStep(366))).toBeLessThanOrEqual(8);
  });

  it("una barra por día del rango, también los vacíos (CA-02-04)", () => {
    const days = Array.from({ length: 90 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 6, 1 + i));
      return d.toISOString().slice(0, 10);
    });
    const series = buildVolumeSeries(days, [
      { day: days[3]!, channel: "whatsapp", inbound: 2, outbound: 3 },
      { day: days[3]!, channel: "instagram", inbound: 1, outbound: 0 },
      { day: days[50]!, channel: "whatsapp", inbound: 4, outbound: 0 },
      // Fuera del rango: se ignora.
      { day: "2020-01-01", channel: "whatsapp", inbound: 99, outbound: 99 },
    ]);
    expect(series.days).toHaveLength(90);
    expect(series.days[3]).toMatchObject({ inbound: 3, outbound: 3, total: 6 });
    expect(series.days[0]?.total).toBe(0);
    expect(series.maxTotal).toBe(6);
    expect(series.inbound).toBe(7);
    expect(series.outbound).toBe(3);
    expect(series.channels).toEqual(["whatsapp", "instagram"]);

    const stack = stackDay(series.days[3]!, series.channels);
    expect(stack.map((s) => [s.channel, s.start, s.value])).toEqual([
      ["whatsapp", 0, 5],
      ["instagram", 5, 1],
    ]);
    expect(stackDay(series.days[0]!, series.channels)).toEqual([]);
  });

  it("reparto de atención en orden fijo y sin NaN con 0 activas", () => {
    const segs = attentionSegments({
      active: 4,
      aiOnly: 1,
      aiAndHuman: 1,
      humanOnly: 1,
      noReply: 1,
      aiOnlyRate: 0.25,
    });
    expect(segs.map((s) => s.label)).toEqual([
      "Solo IA",
      "IA + humano",
      "Solo humano",
      "Sin respuesta",
    ]);
    expect(segs[0]?.share).toBe(0.25);
    const empty = attentionSegments({
      active: 0,
      aiOnly: 0,
      aiAndHuman: 0,
      humanOnly: 0,
      noReply: 0,
      aiOnlyRate: null,
    });
    expect(empty.every((s) => s.share === null)).toBe(true);
  });

  it("barras horizontales acotadas a 0..100", () => {
    expect(barPercent(5, 10)).toBe(50);
    expect(barPercent(5, 0)).toBe(0);
    expect(barPercent(20, 10)).toBe(100);
  });

  it("cada canal tiene color y contrasta ≥ 3:1 en claro y oscuro", () => {
    for (const c of CHANNEL_ORDER) {
      const color = CHANNEL_CHART_COLOR[c];
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(contrastRatio(color, THEME_BACKGROUNDS.light)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(color, THEME_BACKGROUNDS.dark)).toBeGreaterThanOrEqual(3);
    }
  });
});

function report(overrides: Partial<AgentReportDto> = {}): AgentReportDto {
  return {
    range: {
      preset: "30d",
      from: "2026-09-13",
      to: "2026-10-12",
      days: ["2026-10-12"],
      tz: "America/Mexico_City",
      fromUtc: "2026-09-13T06:00:00.000Z",
      toUtc: "2026-10-13T06:00:00.000Z",
    },
    attention: {
      ok: true,
      data: { active: 0, aiOnly: 0, aiAndHuman: 0, humanOnly: 0, noReply: 0, aiOnlyRate: null },
    },
    escalations: { ok: false, error: "x" },
    responseTimes: { ok: false, error: "x" },
    failures: { ok: false, error: "x" },
    delivery: { ok: false, error: "x" },
    volume: { ok: true, data: { rows: [] } },
    ...overrides,
  };
}

describe("respuesta de la API", () => {
  it("503 → mensaje de rango menor", () => {
    expect(classifyReportResponse(503, null)).toEqual({ kind: "timeout" });
    expect(TIMEOUT_MESSAGE).toBe("El reporte tardó demasiado; prueba un rango menor.");
  });

  it("422 usa el mensaje del servidor si viene", () => {
    expect(
      classifyReportResponse(422, { error: { code: "invalid_range", message: "Máximo 366 días" } })
    ).toEqual({ kind: "invalid", message: "Máximo 366 días" });
    expect(classifyReportResponse(422, null).kind).toBe("invalid");
  });

  it("401, 403/404 y cuerpos raros", () => {
    expect(classifyReportResponse(401, null).kind).toBe("unauthorized");
    expect(classifyReportResponse(403, null).kind).toBe("forbidden");
    expect(classifyReportResponse(500, null).kind).toBe("error");
    expect(classifyReportResponse(200, { hola: 1 }).kind).toBe("error");
    expect(classifyReportResponse(200, report()).kind).toBe("ok");
  });

  it("vacío solo cuando se sabe que no hubo actividad", () => {
    expect(isReportEmpty(report())).toBe(true);
    expect(isReportEmpty(report({ attention: { ok: false, error: "x" } }))).toBe(false);
    expect(
      isReportEmpty(
        report({
          volume: {
            ok: true,
            data: { rows: [{ day: "2026-10-12", channel: "whatsapp", inbound: 0, outbound: 2 }] },
          },
        })
      )
    ).toBe(false);
  });
});
