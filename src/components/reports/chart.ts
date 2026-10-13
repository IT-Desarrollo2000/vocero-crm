/**
 * 02 — Escalas, colores y agregaciones de presentación de los gráficos del
 * reporte. Lógica pura (sin React) para poder probarla en unit.
 */

import { CHANNEL_LABEL, CHANNEL_ORDER, type Channel } from "@/lib/channels";
import type { AttentionDto, VolumeRowDto } from "./types";

/**
 * Color de cada canal en los gráficos. Tonos medios de la marca de cada canal
 * (el degradado del distintivo no sirve como relleno de barra), elegidos para
 * contrastar ≥ 3:1 contra el fondo claro y el oscuro — ver la prueba
 * `reports-ui-chart.test.ts`. Nunca van solos: la leyenda dice el nombre.
 */
export const CHANNEL_CHART_COLOR: Record<Channel, string> = {
  whatsapp: "#1f9d55",
  instagram: "#d6336c",
  messenger: "#3b7ddd",
};

/** Fondos del tema (globals.css) contra los que se mide el contraste. */
export const THEME_BACKGROUNDS = { light: "#ffffff", dark: "#101115" } as const;

function channel(hex: string): number {
  const c = parseInt(hex, 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  return (
    0.2126 * channel(h.slice(0, 2)) +
    0.7152 * channel(h.slice(2, 4)) +
    0.0722 * channel(h.slice(4, 6))
  );
}

/** Razón de contraste WCAG entre dos colores `#rrggbb`. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Máximo «redondo» del eje y y sus marcas (paso 1, 2 o 5 × 10^k). Con todo en
 * cero devuelve `max = 1` para que la escala no divida entre cero.
 */
export function niceScale(
  maxValue: number,
  targetTicks = 4
): { max: number; ticks: number[] } {
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return { max: 1, ticks: [0, 1] };
  }
  const rough = maxValue / Math.max(1, targetTicks);
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  // Conteos: el paso nunca baja de 1 (no hay «0.5 mensajes»).
  const safeStep = Math.max(1, step);
  const max = Math.ceil(maxValue / safeStep) * safeStep;
  const ticks: number[] = [];
  for (let v = 0; v <= max + safeStep / 2; v += safeStep) ticks.push(v);
  return { max, ticks };
}

/** Cada cuántos días poner una etiqueta en el eje x (≈ 7 etiquetas). */
export function dayLabelStep(dayCount: number): number {
  if (dayCount <= 8) return 1;
  return Math.ceil(dayCount / 7);
}

/** Ancho de cada barra diaria: anchas con pocos días, delgadas con muchos. */
export function dayBarStep(dayCount: number): number {
  if (dayCount <= 7) return 56;
  if (dayCount <= 31) return 22;
  if (dayCount <= 92) return 9;
  return 5;
}

export type VolumeDay = {
  day: string;
  inbound: number;
  outbound: number;
  total: number;
  byChannel: Record<Channel, number>;
};

export type VolumeSeries = {
  days: VolumeDay[];
  /** Canales con al menos un mensaje en el rango, en el orden del catálogo. */
  channels: Channel[];
  maxTotal: number;
  inbound: number;
  outbound: number;
};

function emptyByChannel(): Record<Channel, number> {
  return Object.fromEntries(CHANNEL_ORDER.map((c) => [c, 0])) as Record<
    Channel,
    number
  >;
}

/**
 * Una entrada por CADA día del rango (RF-02-07, CA-02-04: 90 días = 90
 * barras aunque haya días vacíos), sumando las filas día × canal del
 * servidor. Filas fuera del rango o de un canal desconocido se ignoran.
 */
export function buildVolumeSeries(
  rangeDays: readonly string[],
  rows: readonly VolumeRowDto[]
): VolumeSeries {
  const byDay = new Map<string, VolumeDay>(
    rangeDays.map((day) => [
      day,
      { day, inbound: 0, outbound: 0, total: 0, byChannel: emptyByChannel() },
    ])
  );
  const seen = new Set<Channel>();
  for (const row of rows) {
    const entry = byDay.get(row.day);
    if (!entry || !(CHANNEL_ORDER as readonly string[]).includes(row.channel)) {
      continue;
    }
    const inbound = Math.max(0, row.inbound || 0);
    const outbound = Math.max(0, row.outbound || 0);
    entry.inbound += inbound;
    entry.outbound += outbound;
    entry.total += inbound + outbound;
    entry.byChannel[row.channel] += inbound + outbound;
    if (inbound + outbound > 0) seen.add(row.channel);
  }
  const days = [...byDay.values()];
  return {
    days,
    channels: CHANNEL_ORDER.filter((c) => seen.has(c)),
    maxTotal: days.reduce((m, d) => Math.max(m, d.total), 0),
    inbound: days.reduce((s, d) => s + d.inbound, 0),
    outbound: days.reduce((s, d) => s + d.outbound, 0),
  };
}

export type StackSegment = {
  channel: Channel;
  label: string;
  value: number;
  /** Desde abajo, en unidades del eje (no píxeles). */
  start: number;
  color: string;
};

/** Segmentos apilados de una barra diaria, de abajo hacia arriba. */
export function stackDay(day: VolumeDay, channels: readonly Channel[]): StackSegment[] {
  let start = 0;
  const out: StackSegment[] = [];
  for (const c of channels) {
    const value = day.byChannel[c];
    if (value <= 0) continue;
    out.push({
      channel: c,
      label: CHANNEL_LABEL[c],
      value,
      start,
      color: CHANNEL_CHART_COLOR[c],
    });
    start += value;
  }
  return out;
}

export type AttentionKey = "aiOnly" | "aiAndHuman" | "humanOnly" | "noReply";

export type AttentionSegment = {
  key: AttentionKey;
  label: string;
  count: number;
  /** 0..1 de las activas; `null` sin activas. */
  share: number | null;
  /** Token del tema (`var(--x)`), legible en claro y oscuro. */
  color: string;
};

const ATTENTION_META: { key: AttentionKey; label: string; color: string }[] = [
  { key: "aiOnly", label: "Solo IA", color: "var(--success)" },
  { key: "aiAndHuman", label: "IA + humano", color: "var(--info)" },
  { key: "humanOnly", label: "Solo humano", color: "var(--warning)" },
  { key: "noReply", label: "Sin respuesta", color: "var(--danger)" },
];

/** M2 en el orden fijo de la barra apilada. */
export function attentionSegments(a: AttentionDto): AttentionSegment[] {
  return ATTENTION_META.map((m) => ({
    ...m,
    count: a[m.key],
    share: a.active > 0 ? a[m.key] / a.active : null,
  }));
}

/** Ancho relativo (0..100) de una barra horizontal; 0 si no hay escala. */
export function barPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}
