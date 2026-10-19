import { describe, expect, it } from "vitest";
import { parseReportRange, previousRange, toRangeDto } from "@/server/reports/range";
import {
  RANGE_PRESETS,
  parseRangeParams,
  rangeToQuery,
} from "@/components/reports/range-params";
import {
  DEFAULT_REPORT_TIMEZONE,
  resolveReportTimezone,
} from "@/server/reports/timezone";

/**
 * 02 — Rango de reportes (RF-02-01, CA-02-04/06) y zona horaria (D-02-2).
 * Los cortes de día se calculan en Node, en la zona del negocio.
 */

const MX = "America/Mexico_City"; // UTC−6 todo el año (sin horario de verano desde 2022)
const qs = (s: string) => new URLSearchParams(s);

function ok(params: Parameters<typeof parseReportRange>[0], tz = MX, now?: Date) {
  const r = parseReportRange(params, tz, now);
  if (!r.ok) throw new Error(`esperaba rango válido: ${r.message}`);
  return r.range;
}

describe("presets (N días locales que terminan hoy)", () => {
  // 05:30Z del 12 = 23:30 del 11 en CDMX: "hoy" es el 11, no el 12.
  const now = new Date("2026-10-12T05:30:00Z");

  it("7 días: corte de día en America/Mexico_City", () => {
    const r = ok(qs("range=7"), MX, now);
    expect(r.preset).toBe("7d");
    expect(r.from).toBe("2026-10-05");
    expect(r.to).toBe("2026-10-11");
    expect(r.fromUtc.toISOString()).toBe("2026-10-05T06:00:00.000Z");
    expect(r.toUtc.toISOString()).toBe("2026-10-12T06:00:00.000Z");
    expect(r.days).toHaveLength(7);
    expect(r.days[0]).toBe("2026-10-05");
    expect(r.days.at(-1)).toBe("2026-10-11");
  });

  it("un minuto después de medianoche local ya es el día siguiente", () => {
    const r = ok(qs("range=7"), MX, new Date("2026-10-12T06:01:00Z"));
    expect(r.to).toBe("2026-10-12");
    expect(r.toUtc.toISOString()).toBe("2026-10-13T06:00:00.000Z");
  });

  it("sin parámetros → 30 días; 90 días → 90 días (90 barras)", () => {
    const d = ok(qs(""), MX, now);
    expect(d.preset).toBe("30d");
    expect(d.days).toHaveLength(30);
    const n = ok(qs("range=90"), MX, now);
    expect(n.days).toHaveLength(90);
    expect(n.from).toBe("2026-07-14");
  });

  it("CA-02-04: algo de hace 40 días cae fuera de 30 y dentro de 90", () => {
    const old = new Date(now.getTime() - 40 * 86_400_000);
    const r30 = ok(qs("range=30"), MX, now);
    const r90 = ok(qs("range=90"), MX, now);
    expect(old.getTime()).toBeLessThan(r30.fromUtc.getTime());
    expect(old.getTime()).toBeGreaterThanOrEqual(r90.fromUtc.getTime());
  });

  it("forma de la UI (7d|30d|90d) y forma del .md (7|30|90) son equivalentes", () => {
    for (const [ui, md] of [["7d", "7"], ["30d", "30"], ["90d", "90"]] as const) {
      const a = ok(qs(`range=${ui}`), MX, now);
      const b = ok(qs(`range=${md}`), MX, now);
      expect(a).toEqual(b);
      expect(a.preset).toBe(ui);
    }
  });

  it("preset desconocido → error", () => {
    expect(parseReportRange(qs("range=15d"), MX).ok).toBe(false);
    expect(parseReportRange(qs("range=15"), MX).ok).toBe(false);
    expect(parseReportRange(qs("range=abc"), MX).ok).toBe(false);
  });
});

describe("021 — preset «Hoy» (from = to = hoy en la zona del reporte)", () => {
  it("a las 23:30 locales del 11 (05:30Z del 12) «hoy» es el 11", () => {
    const r = ok(qs("range=today"), MX, new Date("2026-10-12T05:30:00Z"));
    expect(r.preset).toBe("today");
    expect(r.from).toBe("2026-10-11");
    expect(r.to).toBe("2026-10-11");
    expect(r.days).toEqual(["2026-10-11"]);
    expect(r.fromUtc.toISOString()).toBe("2026-10-11T06:00:00.000Z");
    expect(r.toUtc.toISOString()).toBe("2026-10-12T06:00:00.000Z");
    expect(r.toUtc.getTime() - r.fromUtc.getTime()).toBe(86_400_000);
  });

  it("un minuto después de medianoche local ya es el día siguiente", () => {
    const r = ok(qs("range=today"), MX, new Date("2026-10-12T06:01:00Z"));
    expect(r.from).toBe("2026-10-12");
    expect(r.to).toBe("2026-10-12");
  });

  it("el periodo anterior de «Hoy» es ayer", () => {
    const prev = previousRange(ok(qs("range=today"), MX, new Date("2026-10-12T18:00:00Z")))!;
    expect(prev.from).toBe("2026-10-11");
    expect(prev.to).toBe("2026-10-11");
    expect(prev.toUtc.toISOString()).toBe("2026-10-12T06:00:00.000Z");
  });

  it("from/to mandan sobre range=today; «todayd» y «hoy» no son presets", () => {
    expect(ok(qs("range=today&from=2026-10-01&to=2026-10-03")).days).toHaveLength(3);
    expect(parseReportRange(qs("range=todayd"), MX).ok).toBe(false);
    expect(parseReportRange(qs("range=hoy"), MX).ok).toBe(false);
  });

  it("UI: «Hoy» es el primer preset y la URL habla el mismo idioma que la API", () => {
    expect(RANGE_PRESETS[0]).toEqual({ preset: "today", label: "Hoy" });
    expect(rangeToQuery({ preset: "today" })).toBe("range=today");
    expect(parseRangeParams(qs("range=today"))).toEqual({ preset: "today" });
    expect(parseRangeParams(qs("range=TODAY"))).toEqual({ preset: "today" });
  });
});

describe("personalizado (`to` inclusive)", () => {
  it("toUtc = medianoche local del día siguiente a `to`", () => {
    const r = ok(qs("from=2026-10-01&to=2026-10-10"));
    expect(r.preset).toBe("custom");
    expect(r.fromUtc.toISOString()).toBe("2026-10-01T06:00:00.000Z");
    expect(r.toUtc.toISOString()).toBe("2026-10-11T06:00:00.000Z");
    expect(r.days).toHaveLength(10);
  });

  it("un solo día es válido", () => {
    expect(ok(qs("from=2026-10-01&to=2026-10-01")).days).toEqual(["2026-10-01"]);
  });

  it("range=custom con from/to (forma de la UI); custom sin fechas → error", () => {
    const r = ok(qs("range=custom&from=2026-10-01&to=2026-10-03"));
    expect(r.preset).toBe("custom");
    expect(r.days).toHaveLength(3);
    expect(parseReportRange(qs("range=custom"), MX).ok).toBe(false);
    expect(parseReportRange(qs("range=custom&from=2026-10-01"), MX).ok).toBe(false);
  });

  it("from/to mandan sobre range", () => {
    expect(ok(qs("range=7&from=2026-10-01&to=2026-10-03")).days).toHaveLength(3);
  });

  it("acepta un objeto plano además de URLSearchParams", () => {
    expect(ok({ from: "2026-01-01", to: "2026-01-31" }).days).toHaveLength(31);
  });

  it("CA-02-06: from > to → error", () => {
    expect(parseReportRange(qs("from=2026-10-10&to=2026-10-01"), MX).ok).toBe(false);
  });

  it("366 días pasa; 367 o 400 no", () => {
    expect(ok(qs("from=2024-01-01&to=2024-12-31")).days).toHaveLength(366);
    expect(parseReportRange(qs("from=2025-01-01&to=2026-01-02"), MX).ok).toBe(false);
    expect(parseReportRange(qs("from=2025-01-01&to=2026-02-04"), MX).ok).toBe(false);
  });

  it("fechas ilegibles o inexistentes → error", () => {
    for (const bad of [
      "from=2026-02-30&to=2026-03-01",
      "from=hoy&to=2026-03-01",
      "from=2026-1-1&to=2026-03-01",
      "from=2026-03-01",
      "to=2026-03-01",
    ]) {
      expect(parseReportRange(qs(bad), MX).ok, bad).toBe(false);
    }
  });
});

describe("zona con horario de verano", () => {
  it("America/New_York, día del cambio (8-mar-2026): 23 h y offsets distintos", () => {
    const r = ok(qs("from=2026-03-08&to=2026-03-09"), "America/New_York");
    expect(r.fromUtc.toISOString()).toBe("2026-03-08T05:00:00.000Z"); // EST
    expect(r.toUtc.toISOString()).toBe("2026-03-10T04:00:00.000Z"); // EDT
    expect(r.days).toEqual(["2026-03-08", "2026-03-09"]);
  });
});

describe("toRangeDto (RF-02-04: zona y límites UTC)", () => {
  it("serializa ISO y cuenta días", () => {
    const dto = toRangeDto(ok(qs("from=2026-10-01&to=2026-10-10")));
    expect(dto).toEqual({
      preset: "custom",
      from: "2026-10-01",
      to: "2026-10-10",
      tz: MX,
      fromUtc: "2026-10-01T06:00:00.000Z",
      toUtc: "2026-10-11T06:00:00.000Z",
      days: [
        "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
        "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10",
      ],
    });
  });
});

describe("D-02-2: zona de los reportes", () => {
  it("la de calendar_settings si es válida; si no, America/Mexico_City", () => {
    expect(DEFAULT_REPORT_TIMEZONE).toBe("America/Mexico_City");
    expect(resolveReportTimezone("America/Bogota")).toBe("America/Bogota");
    expect(resolveReportTimezone(null)).toBe(MX);
    expect(resolveReportTimezone(undefined)).toBe(MX);
    expect(resolveReportTimezone("")).toBe(MX);
    expect(resolveReportTimezone("Marte/Olympus")).toBe(MX);
  });
});
