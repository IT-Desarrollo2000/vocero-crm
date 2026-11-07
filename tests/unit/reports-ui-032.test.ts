import { describe, expect, it } from "vitest";
import type { SalesFunnelDto, SalesFunnelStageDto } from "@/lib/reports";
import { splitSendError } from "@/lib/meta/send-errors";
import {
  EMPTY_VALUE,
  formatDurationWords,
  rangePhrase,
  waitInWords,
} from "@/components/reports/format";
import { noSalesView } from "@/components/reports/sales-report-format";

// 032 — Reportes que se explican solos: tiempos en palabras, errores de Meta
// entendibles y «Ventas sin ventas».

describe("032 — tiempos en palabras", () => {
  it("misma unidad y redondeo que formatDuration, en palabras", () => {
    expect(formatDurationWords(null)).toBe(EMPTY_VALUE);
    expect(formatDurationWords(-1)).toBe(EMPTY_VALUE);
    expect(formatDurationWords(1)).toBe("1 segundo");
    expect(formatDurationWords(4.2)).toBe("4 segundos");
    expect(formatDurationWords(60)).toBe("1 minuto");
    expect(formatDurationWords(1020)).toBe("17 minutos");
    expect(formatDurationWords(3600)).toBe("1 hora");
    expect(formatDurationWords(3900)).toBe("1 hora 5 minutos");
    expect(formatDurationWords(26 * 3600)).toBe("1 día 2 horas");
    expect(formatDurationWords(48 * 3600)).toBe("2 días");
  });

  it("la mitad / casi siempre, sin «mediana» ni «p90»", () => {
    expect(waitInWords(4, 10)).toBe(
      "la mitad en menos de 4 segundos; casi siempre (9 de cada 10) en menos de 10 segundos"
    );
    // Si dicen lo mismo, basta una cifra.
    expect(waitInWords(600, 610)).toBe("la mitad en menos de 10 minutos");
    expect(waitInWords(5, null)).toBe("la mitad en menos de 5 segundos");
    expect(waitInWords(null, 10)).toBeNull();
  });

  it("frase del rango para los vacíos", () => {
    expect(rangePhrase({ preset: "30d", from: "2026-10-08", to: "2026-11-06" })).toBe(
      "en estos 30 días"
    );
    expect(rangePhrase({ preset: "today", from: "2026-11-06", to: "2026-11-06" })).toBe("hoy");
    expect(rangePhrase({ preset: "custom", from: "2026-10-01", to: "2026-10-09" })).toBe(
      "en este rango"
    );
  });
});

describe("032 — errores de Meta entendibles", () => {
  it("código conocido, crudo de la Graph API → frase del CRM y código aparte", () => {
    const v = splitSendError("(#131047) Re-engagement message");
    expect(v.code).toBe(131047);
    expect(v.text).toMatch(/^Pasaron más de 24 h/);
    expect(v.detail).toBeNull();
  });

  it("ya traducido por describeSendError → misma frase, sin el sufijo", () => {
    const v = splitSendError(
      "El destinatario no puede recibir mensajes de WhatsApp (número inexistente, sin cuenta o que no acepta mensajes de empresas). (Meta 131026)"
    );
    expect(v.code).toBe(131026);
    expect(v.text).not.toContain("(Meta");
  });

  it("código desconocido → frase genérica y el texto de Meta como detalle", () => {
    const v = splitSendError("Something odd happened (Meta 999999)");
    expect(v.code).toBe(999999);
    expect(v.text).toMatch(/Meta no dejó enviar el mensaje/);
    expect(v.detail).toBe("Something odd happened");
  });

  it("sin código (texto propio del CRM) → tal cual", () => {
    expect(splitSendError("No se pudo contactar la API de Meta")).toEqual({
      text: "No se pudo contactar la API de Meta",
      code: null,
      detail: null,
    });
  });
});

const stage = (
  stageId: string,
  name: string,
  kind: SalesFunnelStageDto["kind"],
  position: number,
  leads: number
): SalesFunnelStageDto => ({
  stageId,
  name,
  kind,
  position,
  leads,
  amountCents: 0,
  leadsWithoutAmount: 0,
  leadsOtherCurrency: 0,
});

describe("032 — Ventas sin ventas", () => {
  const funnel: SalesFunnelDto = {
    currency: "MXN",
    totalLeads: 13,
    stages: [
      stage("s_lost", "Perdido", "lost", 5, 1),
      stage("s_new", "Nuevo", "open", 1, 7),
      stage("s_conv", "En conversación", "open", 2, 3),
      stage("s_int", "Interesado", "open", 3, 2),
      stage("s_won", "Cliente", "won", 4, 0),
    ],
  };

  it("nombres reales de las etapas, embudo sin perdidas y el empujón", () => {
    const v = noSalesView(funnel);
    expect(v.wonName).toBe("Cliente");
    expect(v.lostName).toBe("Perdido");
    expect(v.stages?.map((s) => s.name)).toEqual(["Nuevo", "En conversación", "Interesado", "Cliente"]);
    expect(v.inProcess).toBe(12);
    expect(v.nudge).toBe(
      "¿Alguno de los 2 que están en «Interesado» ya compró? Muévelo a «Cliente» y captura el monto."
    );
  });

  it("uno solo en la etapa más avanzada; nadie en proceso → sin empujón", () => {
    const uno = noSalesView({
      ...funnel,
      stages: [stage("s_new", "Nuevo", "open", 1, 1), stage("s_won", "Ganado", "won", 2, 0)],
    });
    expect(uno.nudge).toBe("¿El que está en «Nuevo» ya compró? Muévelo a «Ganado» y captura el monto.");
    const vacio = noSalesView({ ...funnel, stages: [stage("s_won", "Ganado", "won", 1, 0)] });
    expect(vacio.nudge).toBeNull();
    expect(vacio.inProcess).toBe(0);
  });

  it("sin embudo (bloque caído) → rótulos genéricos y sin lista", () => {
    expect(noSalesView(null)).toEqual({
      wonName: "Ganado",
      lostName: "Perdido",
      stages: null,
      inProcess: 0,
      nudge: null,
    });
  });
});
