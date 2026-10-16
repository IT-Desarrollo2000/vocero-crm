import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { tipoDeOrigen } from "@/lib/anuncios";
import type { SourceValue } from "@/lib/types";
import {
  ADS_REPORT_SQL,
  ADS_SOURCE_ORDER,
  adsReport,
  shapeByAd,
  shapeBySource,
  sourceOfGroup,
  summaryFigures,
  type AdsReportParams,
} from "@/server/reports/ads";
import { effectiveSource, SOURCE_VALUES } from "@/server/contact-source";
import { parseReportRange, previousRange } from "@/server/reports/range";
import type { ReportExec } from "@/server/reports/run";
import {
  adTypeLabel,
  classifyAdsReportResponse,
  formatChange,
  formatWonAmount,
  isAdsReportEmpty,
  totalWonWithoutAmount,
  wonAmountNote,
} from "@/components/reports/ads-report-format";
import type { AdsReportDto, WonAmountDto } from "@/lib/reports";

/**
 * 020 fase B — Reportes → Anuncios: la fuente del reporte ES la de la ficha
 * (`effectiveSource`), un contacto cuenta una vez con su primer anuncio (D1),
 * los montos no se mezclan entre monedas y un ganado sin monto cuenta pero no
 * suma. Más las reglas de todo reporte sobre el SQL renderizado.
 */

const dialect = new PgDialect();
const P: AdsReportParams = {
  organizationId: "org_1",
  fromUtc: new Date("2026-09-17T06:00:00.000Z"),
  toUtc: new Date("2026-10-17T06:00:00.000Z"),
};

const all = Object.entries(ADS_REPORT_SQL).map(
  ([name, build]) => [name, dialect.sqlToQuery((build as (p: AdsReportParams) => SQL)(P))] as const
);

describe("SQL", () => {
  it("tenant en todas, límites ::timestamp y nada de now()", () => {
    for (const [name, q] of all) {
      expect(q.params, name).toContain("org_1");
      expect(q.sql, name).toMatch(/"organization_id" = \$\d+/);
      expect(q.sql, name).not.toMatch(/now\(\)/i);
      expect(q.params, name).toContain("2026-09-17 06:00:00.000");
      expect(q.params, name).toContain("2026-10-17 06:00:00.000");
      expect(q.sql, name).toMatch(/\$\d+::timestamp/);
    }
  });

  it("el primer origen se elige como la ficha: created_at asc, id asc, uno por contacto", () => {
    for (const [name, q] of all) {
      expect(q.sql, name).toContain(`select distinct on ("ad_attribution"."contact_id")`);
      expect(q.sql, name).toContain(
        `order by "ad_attribution"."contact_id", "ad_attribution"."created_at" asc, "ad_attribution"."id" asc`
      );
    }
  });

  it("Laboratorio fuera: conversaciones is_test y contactos solo de prueba", () => {
    const conv = all.find(([n]) => n === "conversationsBySourceSql")![1];
    expect(conv.sql).toContain(`"conversation"."is_test" = false`);
    for (const [name, q] of all.filter(([n]) => n !== "conversationsBySourceSql")) {
      expect(q.sql, name).toContain("lab.is_test = true");
      expect(q.sql, name).toContain("real_conv.is_test = false");
    }
  });

  it("la cohorte entra por la fecha de llegada (primer anuncio o alta del lead)", () => {
    for (const [name, q] of all.filter(([n]) => n !== "conversationsBySourceSql")) {
      expect(q.sql, name).toContain(`coalesce(fa.arrived_at, "lead"."created_at") >= `);
      expect(q.sql, name).toContain(`coalesce(fa.arrived_at, "lead"."created_at") < `);
      expect(q.sql, name).toContain(`("pipeline_stage"."kind" = 'won') as won`);
    }
  });

  it("por anuncio: una fila por source_id (o por fila sin id), tope 50", () => {
    const q = all.find(([n]) => n === "byAdSql")![1];
    expect(q.sql).toContain("coalesce(fa.source_id, fa.attribution_id) as ad_key");
    expect(q.sql).toContain("group by ad_key");
    expect(q.params).toContain(50);
  });
});

describe("fuente efectiva ≡ effectiveSource", () => {
  const stored: (SourceValue | null)[] = [null, ...SOURCE_VALUES];
  const origins: { has: boolean; type: string | null }[] = [
    { has: false, type: null },
    { has: true, type: "ad" },
    { has: true, type: "post" },
    { has: true, type: null },
    { has: true, type: "rara" },
  ];
  for (const s of stored) {
    for (const o of origins) {
      it(`capturada=${s ?? "—"} · origen=${o.has ? (o.type ?? "null") : "ninguno"}`, () => {
        const expected = effectiveSource(
          s,
          tipoDeOrigen(o.has ? { sourceType: o.type } : null)
        ).value;
        expect(
          sourceOfGroup({ stored_source: s, has_origin: o.has ? "t" : "f", origin_type: o.type })
        ).toBe(expected);
      });
    }
  }

  it("una publicación sin captura es «Contenido orgánico», no «Anuncio»", () => {
    expect(sourceOfGroup({ stored_source: null, has_origin: true, origin_type: "post" })).toBe(
      "organico"
    );
  });
});

describe("forma por fuente", () => {
  it("sin filas: las seis fuentes en orden, en cero y con % null", () => {
    const dto = shapeBySource([], [], "MXN");
    expect(dto.rows.map((r) => r.value)).toEqual(ADS_SOURCE_ORDER);
    expect(dto.rows.every((r) => r.leads === 0 && r.winRate === null)).toBe(true);
    expect(dto.rows[0]!.wonAmount).toEqual({
      currency: "MXN",
      amountCents: 0,
      otherCurrencies: [],
      wonWithoutAmount: 0,
    });
  });

  it("pliega grupos crudos: montos por moneda, ganados sin monto, % de cierre", () => {
    const conv = [
      { stored_source: null, has_origin: true, origin_type: "ad", n: "5" },
      { stored_source: null, has_origin: true, origin_type: "post", n: 2 },
      { stored_source: null, has_origin: false, origin_type: null, n: 3 },
      // Capturada a mano manda sobre el anuncio.
      { stored_source: "referido", has_origin: true, origin_type: "ad", n: 1 },
    ];
    const leads = [
      { stored_source: null, has_origin: true, origin_type: "ad", won: false, currency: null, has_amount: false, n: 3, cents: "0" },
      { stored_source: null, has_origin: true, origin_type: "ad", won: true, currency: "MXN", has_amount: true, n: 1, cents: "150000" },
      { stored_source: null, has_origin: true, origin_type: "ad", won: true, currency: null, has_amount: true, n: 1, cents: "50000" },
      { stored_source: null, has_origin: true, origin_type: "ad", won: true, currency: "USD", has_amount: true, n: 1, cents: "2000" },
      { stored_source: null, has_origin: true, origin_type: "ad", won: true, currency: null, has_amount: false, n: 2, cents: "0" },
      { stored_source: "anuncio", has_origin: false, origin_type: null, won: false, currency: null, has_amount: false, n: 1, cents: 0 },
      { stored_source: null, has_origin: false, origin_type: null, won: true, currency: null, has_amount: true, n: 1, cents: 9900 },
    ];
    const dto = shapeBySource(conv, leads, "MXN");
    const by = Object.fromEntries(dto.rows.map((r) => [r.value, r]));
    expect(by.anuncio).toMatchObject({ conversations: 5, leads: 9, won: 5 });
    expect(by.anuncio!.winRate).toBeCloseTo(5 / 9);
    expect(by.anuncio!.wonAmount).toEqual({
      currency: "MXN",
      amountCents: 200000,
      otherCurrencies: [{ currency: "USD", amountCents: 2000, won: 1 }],
      wonWithoutAmount: 2,
    });
    expect(by.organico).toMatchObject({ conversations: 2, leads: 0, winRate: null });
    expect(by.referido).toMatchObject({ conversations: 1 });
    expect(by.desconocida).toMatchObject({ conversations: 3, leads: 1, won: 1 });
    expect(by.desconocida!.wonAmount.amountCents).toBe(9900);

    const sum = summaryFigures(dto, "MXN");
    expect(sum).toMatchObject({ conversations: 11, adConversations: 5, adLeads: 9, adWon: 5 });
    expect(sum.adShare).toBeCloseTo(5 / 11);
    expect(sum.adWonAmount.amountCents).toBe(200000);
  });
});

describe("forma por anuncio", () => {
  it("titular, miniatura, montos por moneda y total", () => {
    const dto = shapeByAd(
      [
        {
          ad_key: "AD1",
          source_id: "AD1",
          source_type: "ad",
          headline: "Kit de verano",
          media_type: "video",
          leads: "4",
          won: "2",
          image_asset_id: "ma_1",
          total: "3",
          amounts: [
            { currency: "MXN", has_amount: true, won: 1, cents: 120000 },
            { currency: null, has_amount: false, won: 1, cents: 0 },
          ],
        },
        {
          ad_key: "at_x",
          source_id: null,
          source_type: "post",
          headline: null,
          media_type: null,
          leads: 1,
          won: 0,
          image_asset_id: null,
          total: 3,
          amounts: [],
        },
      ],
      "MXN"
    );
    expect(dto.total).toBe(3);
    expect(dto.rows[0]).toMatchObject({
      key: "AD1",
      title: "Kit de verano",
      imageUrl: "/api/media/ma_1",
      leads: 4,
      won: 2,
      winRate: 0.5,
    });
    expect(dto.rows[0]!.wonAmount).toMatchObject({ amountCents: 120000, wonWithoutAmount: 1 });
    expect(dto.rows[1]).toMatchObject({
      title: "Publicación sin título",
      imageUrl: null,
      winRate: 0,
    });
  });

  it("sin filas → vacío con total 0", () => {
    expect(shapeByAd([], "MXN")).toEqual({ rows: [], total: 0 });
  });
});

describe("ejecución", () => {
  const range = (() => {
    const r = parseReportRange({ range: "7d" }, "America/Mexico_City", new Date("2026-10-16T18:00:00Z"));
    if (!r.ok) throw new Error(r.message);
    return r.range;
  })();

  it("rango previo: los mismos días, inmediatamente antes", () => {
    const prev = previousRange(range)!;
    expect(prev.days).toHaveLength(7);
    expect(prev.to).toBe("2026-10-09");
    expect(prev.toUtc.getTime()).toBe(range.fromUtc.getTime());
  });

  it("un bloque que falla no tumba a los otros", async () => {
    const dialect2 = new PgDialect();
    const fake = async <T,>(fn: (exec: ReportExec) => Promise<T>) =>
      fn((async (q: SQL) => {
        if (dialect2.sqlToQuery(q).sql.includes("top as (")) throw new Error("boom");
        return [];
      }) as ReportExec);
    const dto = await adsReport("org_1", range, "MXN", {
      runReadOnly: fake,
      blocks: { onError: () => {} },
    });
    expect(dto.byAd).toEqual({ ok: false, error: "unavailable" });
    expect(dto.bySource.ok).toBe(true);
    expect(dto.summary.ok && dto.summary.data.previous?.to).toBe("2026-10-09");
    expect(dto.summary.ok && dto.summary.data.conversations).toBe(0);
  });
});

describe("formato", () => {
  const amount = (o: Partial<WonAmountDto> = {}): WonAmountDto => ({
    currency: "MXN",
    amountCents: 0,
    otherCurrencies: [],
    wonWithoutAmount: 0,
    ...o,
  });

  it("variación contra el rango anterior", () => {
    expect(formatChange(0, 0)).toBeNull();
    expect(formatChange(3, 0)).toBe("nuevo");
    expect(formatChange(5, 5)).toBe("igual");
    expect(formatChange(15, 10)).toBe("+50 %");
    expect(formatChange(5, 10)).toBe("−50 %");
  });

  it("aviso del monto: otras monedas y ventas sin monto", () => {
    expect(wonAmountNote(amount())).toBeNull();
    expect(wonAmountNote(amount({ wonWithoutAmount: 1 }))).toBe("1 venta sin monto");
    const n = wonAmountNote(
      amount({
        amountCents: 100000,
        otherCurrencies: [{ currency: "USD", amountCents: 2000, won: 1 }],
        wonWithoutAmount: 2,
      })
    );
    expect(n).toMatch(/USD.*20\.00 aparte/);
    expect(n).toContain("2 ventas sin monto");
    expect(formatWonAmount(amount({ amountCents: 1250050 }))).toContain("12,500.50");
  });

  it("solo ventas en otra moneda: esa es la principal (no «$0.00 · USD aparte»)", () => {
    const soloUsd = amount({ otherCurrencies: [{ currency: "USD", amountCents: 5000, won: 1 }] });
    expect(formatWonAmount(soloUsd)).toMatch(/50\.00/);
    expect(formatWonAmount(soloUsd)).not.toMatch(/^\$0\.00$/);
    expect(wonAmountNote(soloUsd)).toBeNull();
  });

  it("tipo de anuncio", () => {
    expect(adTypeLabel({ sourceType: "ad", mediaType: "video" })).toBe("Anuncio · video");
    expect(adTypeLabel({ sourceType: "post", mediaType: "image" })).toBe("Publicación · imagen");
    expect(adTypeLabel({ sourceType: null, mediaType: null })).toBe("Anuncio");
  });

  it("clasifica la respuesta y detecta el rango vacío", () => {
    const body = {
      range: { tz: "UTC", days: [] },
      summary: { ok: true, data: {} },
      bySource: { ok: true, data: shapeBySource([], [], "MXN") },
      byAd: { ok: true, data: { rows: [], total: 0 } },
    } as unknown as AdsReportDto;
    expect(classifyAdsReportResponse(200, body).kind).toBe("ok");
    expect(classifyAdsReportResponse(403, null).kind).toBe("forbidden");
    expect(classifyAdsReportResponse(503, null).kind).toBe("timeout");
    expect(classifyAdsReportResponse(200, { range: {} }).kind).toBe("error");
    expect(isAdsReportEmpty(body)).toBe(true);
    expect(totalWonWithoutAmount(body)).toBe(0);
    expect(isAdsReportEmpty({ ...body, bySource: { ok: false, error: "timeout" } })).toBe(false);
  });
});
