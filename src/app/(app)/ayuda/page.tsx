import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import Image from "next/image";
import { redirect } from "next/navigation";
import {
  Bot,
  CalendarPlus,
  Clock3,
  Inbox,
  MessageSquareText,
  Package,
  Paperclip,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { getSessionOrNull } from "@/lib/auth/session";
import { loginRedirectPath } from "@/lib/auth/guards";
import { getBranding } from "@/server/branding";
import { agendaEnabled } from "@/server/agenda/flag";
import { enabledChannels } from "@/server/channels/enabled";
import {
  fillBrand,
  HELP_HEADER,
  visibleTopics,
  type HelpBlock,
} from "@/lib/help/topics";
import { HelpText } from "@/components/help/help-text";
import { TopicMedia, TrainingBox } from "@/components/help/training-media";
import { trainingFileUrl, type TrainingAssetDto } from "@/lib/training";
import { listTrainingAssets } from "@/server/training/store";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Ayuda" };

// Las banderas se leen en cada petición (igual que Ajustes): encender la
// agenda en la plataforma tiene que mostrar su tema sin reconstruir.
export const dynamic = "force-dynamic";

/** Ícono del mosaico de cada tema en el índice. */
const TOPIC_ICON: Record<string, LucideIcon> = {
  plantillas: MessageSquareText,
  "respuestas-rapidas": Zap,
  archivos: Paperclip,
  catalogo: Package,
  "mis-chats": Inbox,
  ia: Bot,
  citas: CalendarPlus,
  "ventana-24h": Clock3,
};

type Capture = { file: string; width: number; height: number };

/**
 * Tamaño real de una PNG (cabecera IHDR: ancho y alto en los bytes 16–23).
 * Las capturas vienen recortadas a la zona que explica cada tema; con su
 * tamaño real se pintan a escala 1:1 (topadas al ancho del artículo) en vez
 * de estirarse y verse borrosas.
 */
function pngSize(file: string): { width: number; height: number } | null {
  try {
    const head = readFileSync(file).subarray(0, 24);
    if (head.length < 24 || head.toString("ascii", 12, 16) !== "IHDR") return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return null;
  }
}

/** Las capturas las genera un script aparte; sin archivo, no se pinta nada. */
function existingCaptures(files: string[] | undefined): Capture[] {
  const dir = path.join(process.cwd(), "public", "ayuda");
  return (files ?? []).flatMap((f) => {
    const full = path.join(dir, f);
    if (!existsSync(full)) return [];
    const size = pngSize(full) ?? { width: 1366, height: 768 };
    return [{ file: f, ...size }];
  });
}

/**
 * 031 — Guía para el equipo de ventas, por situaciones (estilo del diseño
 * aprobado: índice en mosaicos y un artículo por tema con pasos numerados,
 * captura y «¿Y si…?»). Cualquier rol con sesión (el layout `(app)` ya la
 * exige; esta guarda solo evita que la página le gane la carrera al layout y
 * pierda el `?next=`).
 */
export default async function AyudaPage() {
  const session = await getSessionOrNull();
  if (!session) redirect(await loginRedirectPath());
  const branding = await getBranding(session.organizationId);
  const brand = (t: string) => fillBrand(t, branding.name);
  const topics = visibleTopics({
    agenda: agendaEnabled(),
    channels: enabledChannels(),
  });

  // 034 — Material de capacitación del negocio. Sin filas (o si la consulta
  // falla) la guía se ve exactamente como siempre.
  const assets = await listTrainingAssets(session.organizationId).catch((err: unknown) => {
    console.error("[ayuda] no se pudo leer el material de capacitación", err);
    return [] as TrainingAssetDto[];
  });
  const documents = assets.filter((a) => a.kind === "document");
  const videos = assets.filter((a) => a.kind === "video");
  const topicTitles = Object.fromEntries(topics.map((t) => [t.id, brand(t.titulo)]));
  /** El primer video (por orden) de cada tema VISIBLE. */
  const videoByTopic = new Map<string, TrainingAssetDto>();
  for (const v of videos) {
    if (v.topicId && topicTitles[v.topicId] && !videoByTopic.has(v.topicId)) {
      videoByTopic.set(v.topicId, v);
    }
  }
  const imageByTopic = new Map(
    assets.filter((a) => a.kind === "help_image" && a.topicId).map((a) => [a.topicId!, a])
  );
  const hasTraining = documents.length > 0 || videos.length > 0;

  return (
    <div className="h-full overflow-y-auto scroll-smooth">
      <div className="mx-auto max-w-[920px] space-y-9 px-4 pb-16 pt-6 sm:px-8 sm:pt-10">
        <header id="inicio" className="scroll-mt-6 space-y-2">
          <h1 className="text-[26px] font-bold leading-tight tracking-tight sm:text-[32px]">
            {brand(HELP_HEADER.titulo)}
          </h1>
          <p className="max-w-[640px] text-base leading-relaxed text-text-2 sm:text-[17px]">
            <HelpText text={brand(HELP_HEADER.intro)} />
          </p>
        </header>

        {hasTraining && (
          <TrainingBox documents={documents} videos={videos} topicTitles={topicTitles} />
        )}

        <nav aria-label="Temas de la guía" className="space-y-3">
          {hasTraining && (
            <h2 className="text-[17px] font-semibold text-foreground">¿Qué te está pasando?</h2>
          )}
          <ul className="grid gap-3 sm:grid-cols-2">
            {topics.map((t) => {
              const Icon = TOPIC_ICON[t.id] ?? MessageSquareText;
              return (
                <li key={t.id}>
                  <a
                    href={`#${t.id}`}
                    className="flex h-full items-start gap-3.5 rounded-lg border bg-card p-4 transition-colors hover:border-brand-soft hover:bg-brand-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                        t.id === "plantillas"
                          ? "bg-warning-tint text-warning-text"
                          : "bg-brand-tint text-brand-text"
                      )}
                    >
                      <Icon className="h-5 w-5" strokeWidth={1.7} />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      {videoByTopic.has(t.id) ? (
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <strong className="text-[15px] font-semibold leading-snug text-foreground">
                            {brand(t.titulo)}
                          </strong>
                          <span
                            data-testid="topic-has-video"
                            className="rounded-full bg-brand-soft px-2 py-px text-[11.5px] font-semibold text-brand-text"
                          >
                            Con video
                          </span>
                        </span>
                      ) : (
                        <strong className="text-[15px] font-semibold leading-snug text-foreground">
                          {brand(t.titulo)}
                        </strong>
                      )}
                      <span className="text-sm leading-snug text-text-2">
                        {brand(t.resumen)}
                      </span>
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        {topics.map((t) => {
          const captures = existingCaptures(t.captura);
          const main = t.bloques.filter((b) => b.tono !== "siNo");
          const siNo = t.bloques.filter((b) => b.tono === "siNo");
          const own = imageByTopic.get(t.id);
          const video = videoByTopic.get(t.id);
          // La imagen del negocio reemplaza TODA la figura de ejemplo del tema.
          const imagePanel = own ? (
            <figure className="space-y-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- material privado servido con sesión; sus dimensiones pueden faltar */}
              <img
                src={trainingFileUrl(own.id)}
                alt={`Captura de pantalla: ${brand(t.titulo)}`}
                width={own.width ?? undefined}
                height={own.height ?? undefined}
                loading="lazy"
                data-testid="topic-own-image"
                className="h-auto max-w-full rounded-lg border"
              />
              <figcaption className="text-[13px] text-text-2">Así se ve en tu pantalla.</figcaption>
            </figure>
          ) : captures.length > 0 ? (
            <figure className="space-y-2">
              {captures.map((c) => (
                <Image
                  key={c.file}
                  src={`/ayuda/${c.file}`}
                  alt={`Captura de pantalla: ${brand(t.titulo)}`}
                  width={c.width}
                  height={c.height}
                  // Las PNG ya salen al tamaño final: sin optimizador, la
                  // imagen Docker no necesita `sharp`.
                  unoptimized
                  // A su tamaño real (nunca estirada), topada al ancho.
                  className="h-auto max-w-full rounded-lg border"
                />
              ))}
              <figcaption className="text-[13px] text-text-2">
                Así se ve en tu pantalla.
              </figcaption>
            </figure>
          ) : null;
          return (
            <article
              key={t.id}
              id={t.id}
              aria-labelledby={`${t.id}-titulo`}
              className="scroll-mt-6 space-y-5 border-t pt-8"
            >
              <div className="space-y-1.5">
                <p
                  className={cn(
                    "text-[13px] font-semibold",
                    t.id === "plantillas" ? "text-warning-text" : "text-brand-text"
                  )}
                >
                  {brand(t.antetitulo)}
                </p>
                <h2
                  id={`${t.id}-titulo`}
                  className="text-[22px] font-bold leading-tight tracking-tight sm:text-2xl"
                >
                  {brand(t.titulo)}
                </h2>
                <p className="max-w-[680px] text-[15px] leading-relaxed text-text-2 sm:text-base">
                  <HelpText text={brand(t.intro)} />
                </p>
              </div>

              {main.map((b, j) => (
                <Block key={j} block={b} brand={brand} />
              ))}

              {video ? (
                <TopicMedia topicId={t.id} video={video} imagePanel={imagePanel} />
              ) : (
                imagePanel
              )}

              {siNo.map((b, j) => (
                <Block key={`si-${j}`} block={b} brand={brand} />
              ))}

              <a
                href="#inicio"
                className="inline-block rounded text-sm font-medium text-brand-text hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                ↑ Volver a los temas
              </a>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function Block({ block, brand }: { block: HelpBlock; brand: (t: string) => string }) {
  const tone = block.tono ?? "normal";
  const title = block.titulo ? (
    <h3 className="mb-2 text-base font-semibold text-foreground">
      <HelpText text={brand(block.titulo)} />
    </h3>
  ) : null;

  let body: React.ReactNode;
  switch (block.tipo) {
    case "parrafo":
      body = (
        <p>
          <HelpText text={brand(block.texto)} />
        </p>
      );
      break;
    case "pasos":
      body = (
        <ol className="space-y-3.5">
          {block.items.map((item, k) => (
            <li key={k} className="flex items-start gap-3.5">
              <span
                aria-hidden
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-bold text-brand-fg"
              >
                {k + 1}
              </span>
              <span className="pt-1">
                <span className="sr-only">Paso {k + 1}: </span>
                <HelpText text={brand(item)} />
              </span>
            </li>
          ))}
        </ol>
      );
      break;
    case "lista":
      body = (
        <ul className="list-disc space-y-2 pl-5 marker:text-text-3">
          {block.items.map((item, k) => (
            <li key={k}>
              <HelpText text={brand(item)} />
            </li>
          ))}
        </ul>
      );
      break;
    case "tabla":
      body = (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm">
            <thead className="bg-secondary text-text-2">
              <tr>
                {block.columnas.map((c) => (
                  <th key={c} scope="col" className="px-3 py-2 font-semibold">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.filas.map((row, k) => (
                <tr key={k} className="border-t">
                  {row.map((cell, c) =>
                    c === 0 ? (
                      <th key={c} scope="row" className="px-3 py-2 font-medium">
                        {cell}
                      </th>
                    ) : (
                      <td
                        key={c}
                        className={cn(
                          "px-3 py-2 text-text-2",
                          c === row.length - 1 && "whitespace-nowrap tabular-nums"
                        )}
                      >
                        {cell}
                      </td>
                    )
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      break;
  }

  return (
    <div
      className={cn(
        "text-[15px] leading-relaxed text-text-2 sm:text-base",
        tone === "siNo" && "rounded-lg bg-secondary px-5 py-4",
        tone === "nota" && "rounded-lg border border-info-soft bg-info-tint px-4 py-3 text-info-text"
      )}
    >
      {title}
      {body}
    </div>
  );
}
