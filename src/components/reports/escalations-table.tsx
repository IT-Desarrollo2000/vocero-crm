import Link from "next/link";
import { Info, PhoneOff } from "lucide-react";
import { barPercent } from "./chart";
import {
  formatCount,
  formatDateTime,
  formatPercent,
  ratio,
} from "./format";
import type { EscalationsDto } from "./types";

/**
 * M3 — Escalamientos por motivo, con hasta 5 notas reales por motivo y enlace
 * a la conversación en la Bandeja. Las pausas por respuesta manual NO son
 * escalamientos (Contrato 05/02-0): van en su propia línea, debajo.
 */
export function EscalationsTable({
  data,
  timezone,
}: {
  data: EscalationsDto;
  timezone: string;
}) {
  const max = data.byReason.reduce((m, r) => Math.max(m, r.count), 0);

  return (
    <div className="space-y-4">
      {data.approximate && <ApproximateNotice since={data.exactSince ?? null} timezone={timezone} />}

      {data.byReason.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          El agente no escaló ninguna conversación en este rango.
        </p>
      ) : (
        <table className="w-full text-sm" aria-label="Escalamientos por motivo">
          <thead className="sr-only">
            <tr>
              <th scope="col">Motivo</th>
              <th scope="col">Escalamientos</th>
              <th scope="col">Porcentaje del total</th>
              <th scope="col">Notas de muestra</th>
            </tr>
          </thead>
          <tbody>
            {data.byReason.map((r) => (
              <tr key={r.reason} className="border-t first:border-t-0 align-top">
                <th scope="row" className="py-2.5 pr-3 text-left font-normal">
                  <span className="block font-medium">{r.label}</span>
                  <span
                    className="mt-1.5 block h-1.5 w-full max-w-[220px] overflow-hidden rounded-full bg-secondary"
                    aria-hidden="true"
                  >
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${barPercent(r.count, max)}%`,
                        background: "var(--accent)",
                      }}
                    />
                  </span>
                </th>
                <td className="w-12 py-2.5 pr-2 text-right font-semibold tabular-nums">
                  {formatCount(r.count)}
                </td>
                <td className="w-14 py-2.5 pr-3 text-right text-xs text-muted-foreground tabular-nums">
                  {formatPercent(ratio(r.count, data.total))}
                </td>
                <td className="hidden py-2.5 sm:table-cell">
                  <Samples samples={r.samples} timezone={timezone} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* En móvil las notas van debajo de la tabla, no en una columna apretada. */}
      {data.byReason.some((r) => r.samples.length > 0) && (
        <div className="space-y-3 sm:hidden">
          {data.byReason
            .filter((r) => r.samples.length > 0)
            .map((r) => (
              <div key={r.reason}>
                <p className="mb-1 text-xs font-medium text-muted-foreground">{r.label}</p>
                <Samples samples={r.samples} timezone={timezone} />
              </div>
            ))}
        </div>
      )}

      <p
        className="flex items-center gap-2 border-t pt-3 text-sm text-muted-foreground"
        data-testid="manual-reply-pauses"
      >
        <PhoneOff className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          Pausas por respuesta manual:{" "}
          <span className="font-semibold text-foreground tabular-nums">
            {formatCount(data.manualReplyPauses)}
          </span>
        </span>
        <span
          className="text-text-4"
          title="Veces que alguien respondió desde la app del teléfono y la IA se pausó sola. No es un escalamiento del agente."
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="sr-only">
            Veces que alguien respondió desde la app del teléfono y la IA se
            pausó sola. No es un escalamiento del agente.
          </span>
        </span>
      </p>
    </div>
  );
}

function Samples({
  samples,
  timezone,
}: {
  samples: EscalationsDto["byReason"][number]["samples"];
  timezone: string;
}) {
  if (samples.length === 0) {
    return <p className="text-xs text-text-3">Sin notas.</p>;
  }
  return (
    <ul className="space-y-1.5" aria-label="Notas de muestra">
      {samples.map((s) => (
        <li key={`${s.conversationId}-${s.occurredAt}`} className="text-xs">
          <Link
            href={`/inbox?contact=${encodeURIComponent(s.contactId)}`}
            className="font-medium text-brand-text hover:underline"
          >
            {s.contactName?.trim() || "Contacto sin nombre"}
          </Link>{" "}
          <span className="text-text-3">· {formatDateTime(s.occurredAt, timezone)}</span>
          <p className="mt-0.5 line-clamp-2 text-muted-foreground">
            {s.note?.trim() ? `«${s.note.trim()}»` : "Sin nota."}
          </p>
        </li>
      ))}
    </ul>
  );
}

function ApproximateNotice({
  since,
  timezone,
}: {
  since: string | null;
  timezone: string;
}) {
  return (
    <p
      role="note"
      data-testid="approximate-notice"
      className="flex items-start gap-2 rounded-md border border-info-soft bg-info-tint px-3 py-2 text-xs text-info-text"
    >
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        Datos aproximados: este rango incluye escalamientos anteriores al
        registro histórico
        {since ? ` (exacto desde el ${formatDateTime(since, timezone)})` : ""}.
        De esa época solo se conoce el último escalamiento de cada
        conversación, así que el conteo puede quedarse corto.
      </span>
    </p>
  );
}
