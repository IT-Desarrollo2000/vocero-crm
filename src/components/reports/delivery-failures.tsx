import { splitSendError } from "@/lib/meta/send-errors";
import { CHANNEL_LABEL } from "@/lib/channels";
import { formatCount, formatPercent, ratio } from "./format";
import type { DeliveryDto, FailuresDto } from "./types";

/** Nombre visible del origen de un saliente (`message.origin`). */
export const ORIGIN_LABEL: Record<string, string> = {
  ai: "IA",
  operator: "Equipo (desde el CRM)",
  manual: "Equipo (desde el teléfono)",
  template: "Plantilla",
};

/** M6 — Salientes fallidas, por canal y por origen, y los errores más comunes. */
export function FailuresBreakdown({ data }: { data: FailuresDto }) {
  if (data.total === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Ni la IA ni el equipo mandaron mensajes en este rango.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-sm">
        <span className="text-2xl font-semibold tabular-nums">
          {formatPercent(data.rate)}
        </span>{" "}
        <span className="text-muted-foreground">
          no salieron · {formatCount(data.failed)} de {formatCount(data.total)} mensajes enviados
        </span>
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <SliceTable
          caption="Por canal"
          head="Canal"
          rows={data.byChannel.map((r) => ({
            key: r.channel,
            label: CHANNEL_LABEL[r.channel] ?? r.channel,
            total: r.total,
            failed: r.failed,
          }))}
        />
        <SliceTable
          caption="Por quién lo mandó"
          head="Origen"
          rows={data.byOrigin.map((r) => ({
            key: r.origin,
            label: ORIGIN_LABEL[r.origin] ?? r.origin,
            total: r.total,
            failed: r.failed,
          }))}
        />
      </div>
      {data.topErrors.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Por qué no salieron
          </p>
          <ul className="space-y-1 text-xs" aria-label="Por qué no salieron">
            {data.topErrors.map((e) => {
              // 032 — Frase entendible primero; el código de Meta, aparte y chico.
              const view = splitSendError(e.error);
              const secondary = [
                view.detail ? `Meta dice: «${view.detail}»` : null,
                view.code !== null ? `código Meta ${view.code}` : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li key={e.error} className="flex items-start justify-between gap-3">
                  <span className="min-w-0 break-words">
                    <span className="block text-text-2">{view.text}</span>
                    {secondary && (
                      <span className="block text-[11px] text-text-3">{secondary}</span>
                    )}
                  </span>
                  <span className="shrink-0 font-medium tabular-nums">
                    {formatCount(e.count)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function SliceTable({
  caption,
  head,
  rows,
}: {
  caption: string;
  head: string;
  rows: { key: string; label: string; total: number; failed: number }[];
}) {
  return (
    <table className="w-full text-xs">
      <caption className="mb-1 text-left font-medium text-muted-foreground">
        {caption}
      </caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">{head}</th>
          <th scope="col">No salieron</th>
          <th scope="col">Enviados</th>
          <th scope="col">Porcentaje que no salió</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t first:border-t-0">
            <th scope="row" className="py-1 pr-2 text-left font-normal">
              {r.label}
            </th>
            <td className="py-1 pr-2 text-right tabular-nums">{formatCount(r.failed)}</td>
            <td className="py-1 pr-2 text-right text-muted-foreground tabular-nums">
              de {formatCount(r.total)}
            </td>
            <td className="py-1 text-right font-medium tabular-nums">
              {formatPercent(ratio(r.failed, r.total))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const READ_HELP =
  "Pueden ser más: si un cliente apagó las confirmaciones de lectura (las palomitas azules), nunca aparece como «leído».";

/** M7 — Entrega y lectura, solo de los canales que confirman entrega. */
export function DeliveryRates({ data }: { data: DeliveryDto }) {
  if (data.channels.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Ningún canal encendido confirma la entrega de los mensajes.
      </p>
    );
  }
  const channels = data.channels.map((c) => CHANNEL_LABEL[c] ?? c).join(", ");
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-3">
        <div>
          <dt className="text-xs text-muted-foreground">Entregados</dt>
          <dd className="text-2xl font-semibold tabular-nums" data-testid="delivery-rate">
            {formatPercent(data.deliveryRate)}
          </dd>
          <dd className="text-xs text-muted-foreground tabular-nums">
            {formatCount(data.delivered + data.read)} de {formatCount(data.base)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Leídos</dt>
          <dd className="text-2xl font-semibold tabular-nums" data-testid="read-rate">
            {formatPercent(data.readRate)}
          </dd>
          <dd className="text-xs text-muted-foreground tabular-nums">
            {formatCount(data.read)} de {formatCount(data.delivered + data.read)} entregados
          </dd>
          {/* 032 — Antes en un ⓘ con `title`: ahora a la vista. */}
          <dd className="mt-1 text-xs text-text-3">{READ_HELP}</dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">
        Solo cuenta: {channels}. No incluye respuestas desde el teléfono ni los
        últimos 15 minutos.
        {data.unconfirmed > 0 &&
          ` Sin confirmar: ${formatCount(data.unconfirmed)}.`}
      </p>
    </div>
  );
}
