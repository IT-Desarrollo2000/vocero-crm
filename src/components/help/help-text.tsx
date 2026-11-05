import { parseInline } from "@/lib/help/topics";

/**
 * 031 — Pinta un texto de la guía con su marcado mínimo. Las etiquetas «…»
 * se resaltan como en la pantalla para que el vendedor las reconozca.
 * Sin estado: sirve igual en la página (servidor) que en los «?» (cliente).
 */
export function HelpText({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((s, i) => {
        switch (s.tipo) {
          case "negrita":
            // Una negrita puede llevar etiquetas dentro («Enviar plantilla»).
            return (
              <strong key={i} className="font-semibold text-foreground">
                <HelpText text={s.valor} />
              </strong>
            );
          case "cursiva":
            return (
              <em key={i} className="text-text-2">
                {s.valor}
              </em>
            );
          case "codigo":
            return (
              <code
                key={i}
                className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.92em] text-foreground"
              >
                {s.valor}
              </code>
            );
          case "etiqueta":
            return (
              <span
                key={i}
                // Sin nowrap: hay etiquetas largas y a 360px se saldrían;
                // `box-decoration-clone` repite el borde al partirse.
                className="box-decoration-clone rounded border border-brand-soft bg-brand-tint px-1 py-px font-medium text-brand-text"
              >
                {s.valor}
              </span>
            );
          default:
            return <span key={i}>{s.valor}</span>;
        }
      })}
    </>
  );
}
