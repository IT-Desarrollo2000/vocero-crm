import { formatLegalDate, LEGAL } from "@/lib/legal";

/** Cascarón común de las páginas legales públicas. */
export function LegalPage({
  title,
  children,
}: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <article className="space-y-6 break-words [&_a]:text-brand [&_a]:underline [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_li]:leading-relaxed [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-6 [&_p]:leading-relaxed [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">
          Última actualización:{" "}
          <time dateTime={LEGAL.lastUpdated}>
            {formatLegalDate(LEGAL.lastUpdated)}
          </time>
        </p>
      </header>
      <aside
        role="note"
        className="rounded-md border border-border bg-muted p-4 text-sm text-muted-foreground"
      >
        Este documento es una plantilla específica para {LEGAL.productName} y no
        constituye asesoría legal. Se recomienda su revisión por un profesional
        calificado antes del lanzamiento comercial.
      </aside>
      {children}
    </article>
  );
}
