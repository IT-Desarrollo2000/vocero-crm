"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, FileText } from "lucide-react";
import {
  formatDuration,
  formatSizeMb,
  TRAINING_RULES,
  trainingFileUrl,
  type TrainingAssetDto,
  type TrainingKind,
} from "@/lib/training";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * 034 — Ajustes › Material de capacitación (solo Propietario; la guarda está
 * en `settings/(owner)/layout.tsx`). Diseño aprobado
 * `specs/034-ayuda-material/diseno/Ajustes.dc.html`: Documentos, Videos e
 * Imágenes de la Ayuda.
 *
 * La subida va por `POST /api/training` (route handler multipart: una server
 * action topa en 1 MB). El tipo lo decide la FIRMA en el servidor; aquí solo
 * se adelanta el aviso de tamaño. La duración de un video y el tamaño de una
 * imagen los lee el navegador antes de subir; si no puede, viajan vacíos y
 * la Ayuda se arregla sin ellos.
 */

export type TrainingTopicOption = {
  id: string;
  title: string;
  /** Captura de ejemplo (`public/ayuda/…`) o null si no existe. */
  example: string | null;
};

type Status = { kind: "busy" | "error" | "ok"; text: string } | null;

const META_TIMEOUT_MS = 8000;

/** Duración (s) leída por el navegador; null si no la sabe leer a tiempo. */
function readVideoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let done = false;
    const finish = (v: number | null) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      resolve(v);
    };
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () =>
      finish(Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration) : null);
    video.onerror = () => finish(null);
    setTimeout(() => finish(null), META_TIMEOUT_MS);
    video.src = url;
  });
}

/** Tamaño natural de una imagen; null si el navegador no la decodifica. */
function readImageSize(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    let done = false;
    const finish = (v: { width: number; height: number } | null) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(v);
    };
    img.onload = () =>
      finish(img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null);
    img.onerror = () => finish(null);
    setTimeout(() => finish(null), META_TIMEOUT_MS);
    img.src = url;
  });
}

async function errorText(res: Response | null, fallback: string): Promise<string> {
  if (!res) return "Sin conexión con el servidor";
  const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return data?.error?.message ?? fallback;
}

export function TrainingClient({ topics }: { topics: TrainingTopicOption[] }) {
  const [assets, setAssets] = useState<TrainingAssetDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const setFor = (section: string, s: Status) => setStatus((prev) => ({ ...prev, [section]: s }));

  const refresh = useCallback(async () => {
    const res = await fetch("/api/training", { cache: "no-store" }).catch(() => null);
    if (res?.ok) {
      const data = (await res.json()) as { assets: TrainingAssetDto[] };
      setAssets(data.assets);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const documents = assets.filter((a) => a.kind === "document");
  const videos = assets.filter((a) => a.kind === "video");
  const images = new Map(
    assets.filter((a) => a.kind === "help_image" && a.topicId).map((a) => [a.topicId!, a])
  );

  async function upload(
    section: string,
    kind: TrainingKind,
    file: File,
    extra: { topicId?: string; replaceId?: string } = {}
  ) {
    const rule = TRAINING_RULES[kind];
    if (file.size > rule.maxBytes) {
      setFor(section, { kind: "error", text: `«${file.name}» es muy grande: se acepta ${rule.label}.` });
      return;
    }
    setFor(section, { kind: "busy", text: `Subiendo «${file.name}»…` });
    const form = new FormData();
    form.set("file", file);
    form.set("kind", kind);
    if (extra.topicId) form.set("topicId", extra.topicId);
    if (extra.replaceId) form.set("replaceId", extra.replaceId);
    if (kind === "video") {
      const d = await readVideoDuration(file);
      if (d !== null) form.set("durationSeconds", String(d));
    }
    if (kind === "help_image") {
      const size = await readImageSize(file);
      if (size) {
        form.set("width", String(size.width));
        form.set("height", String(size.height));
      }
    }
    const res = await fetch("/api/training", { method: "POST", body: form }).catch(() => null);
    if (!res?.ok) {
      setFor(section, { kind: "error", text: await errorText(res, "No se pudo subir el archivo") });
      return;
    }
    setFor(section, { kind: "ok", text: `Listo: «${file.name}» ya está en la Ayuda.` });
    await refresh();
  }

  async function patch(section: string, id: string, body: { title?: string; topicId?: string | null }) {
    const res = await fetch(`/api/training/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res?.ok) {
      setFor(section, { kind: "error", text: await errorText(res, "No se pudo guardar") });
      await refresh();
      return;
    }
    setFor(section, { kind: "ok", text: "Guardado." });
    await refresh();
  }

  async function remove(section: string, asset: TrainingAssetDto, done: string) {
    const res = await fetch(`/api/training/${asset.id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      setFor(section, { kind: "error", text: await errorText(res, "No se pudo quitar") });
      return;
    }
    setFor(section, { kind: "ok", text: done });
    await refresh();
  }

  async function move(section: string, kind: "document" | "video", list: TrainingAssetDto[], from: number, to: number) {
    if (to < 0 || to >= list.length) return;
    const ids = list.map((a) => a.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved!);
    const res = await fetch("/api/training/reorder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, ids }),
    }).catch(() => null);
    if (!res?.ok) {
      setFor(section, { kind: "error", text: await errorText(res, "No se pudo cambiar el orden") });
      return;
    }
    const data = (await res.json()) as { assets: TrainingAssetDto[] };
    setAssets(data.assets);
    setFor(section, { kind: "ok", text: "Orden guardado." });
  }

  if (!loaded) return <p className="text-sm text-text-3">Cargando…</p>;

  return (
    <div className="max-w-[960px] space-y-5">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-bold tracking-tight">Material de capacitación</h1>
        <p className="max-w-[680px] text-sm leading-relaxed text-text-2">
          Lo que subas aquí lo ve todo tu equipo en <strong className="text-foreground">Ayuda</strong>.
          Solo lo abren usuarios con sesión iniciada: no hay enlaces públicos.
        </p>
      </header>

      {/* ── Documentos ─────────────────────────────────────────────── */}
      <Section
        id="docs"
        title="Documentos para descargar"
        description="PDF de hasta 25 MB. Salen como botones arriba de la Ayuda, en este orden."
        action={
          <FilePickButton
            label="Subir PDF"
            accept={TRAINING_RULES.document.accept}
            testId="upload-document"
            onFile={(f) => upload("docs", "document", f)}
          />
        }
        status={status.docs ?? null}
      >
        {documents.length === 0 ? (
          <Empty>Todavía no hay documentos.</Empty>
        ) : (
          <ul className="divide-y rounded-md border" data-testid="training-documents">
            {documents.map((d, i) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5" data-asset={d.id}>
                <FileText aria-hidden className="h-5 w-5 shrink-0 text-text-2" strokeWidth={1.8} />
                <TitleField
                  label="Nombre del botón"
                  value={d.title}
                  onSave={(title) => patch("docs", d.id, { title })}
                />
                <span className="text-[13px] text-text-2">PDF · {formatSizeMb(d.sizeBytes)}</span>
                <MoveButtons
                  name={d.title}
                  first={i === 0}
                  last={i === documents.length - 1}
                  onMove={(dir) => move("docs", "document", documents, i, i + dir)}
                />
                <FilePickButton
                  label="Reemplazar"
                  variant="outline"
                  accept={TRAINING_RULES.document.accept}
                  onFile={(f) => upload("docs", "document", f, { replaceId: d.id })}
                />
                <RemoveButton onClick={() => remove("docs", d, `Se quitó «${d.title}».`)} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ── Videos ─────────────────────────────────────────────────── */}
      <Section
        id="videos"
        title="Videos"
        description="MP4 de hasta 100 MB. Elige el tema de la Ayuda donde aparece, junto a sus pasos."
        action={
          <FilePickButton
            label="Subir video"
            accept={TRAINING_RULES.video.accept}
            testId="upload-video"
            onFile={(f) => upload("videos", "video", f)}
          />
        }
        status={status.videos ?? null}
      >
        {videos.length === 0 ? (
          <Empty>Todavía no hay videos.</Empty>
        ) : (
          <ul className="divide-y rounded-md border" data-testid="training-videos">
            {videos.map((v, i) => (
              <li key={v.id} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5" data-asset={v.id}>
                <span
                  aria-hidden
                  className="flex h-10 w-[72px] shrink-0 items-center justify-center rounded-sm bg-video text-[11px] text-knob"
                >
                  {formatDuration(v.durationSeconds) ?? "Video"}
                </span>
                <TitleField label="Título" value={v.title} onSave={(title) => patch("videos", v.id, { title })} />
                <label className="flex min-w-0 flex-[1_1_200px] flex-col gap-0.5 text-xs text-text-2">
                  Tema de la Ayuda
                  <select
                    value={v.topicId && topics.some((t) => t.id === v.topicId) ? v.topicId : ""}
                    onChange={(e) => patch("videos", v.id, { topicId: e.target.value || null })}
                    className="h-9 rounded-md border border-input bg-card px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">Ninguno: solo en la lista de videos</option>
                    {topics.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                </label>
                <MoveButtons
                  name={v.title}
                  first={i === 0}
                  last={i === videos.length - 1}
                  onMove={(dir) => move("videos", "video", videos, i, i + dir)}
                />
                <RemoveButton onClick={() => remove("videos", v, `Se quitó «${v.title}».`)} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ── Imágenes de la Ayuda ───────────────────────────────────── */}
      <Section
        id="capturas"
        title="Imágenes de la Ayuda"
        description="Cada tema trae una imagen de ejemplo. Cámbiala por una de tu negocio para que tu equipo reconozca sus pantallas."
        status={status.capturas ?? null}
      >
        <ul className="grid gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(280px,1fr))]" data-testid="training-images">
          {topics.map((t) => {
            const own = images.get(t.id);
            return (
              <li key={t.id} className="flex items-center gap-2.5 rounded-md border p-2.5" data-topic={t.id}>
                <span
                  className={cn(
                    "flex h-14 w-[88px] shrink-0 items-center justify-center overflow-hidden rounded-sm border",
                    own ? "border-brand-soft bg-brand-tint" : "border-dashed bg-secondary"
                  )}
                >
                  {own ? (
                    // eslint-disable-next-line @next/next/no-img-element -- material privado servido con sesión
                    <img src={trainingFileUrl(own.id)} alt="" className="h-full w-full object-cover" />
                  ) : t.example ? (
                    // eslint-disable-next-line @next/next/no-img-element -- miniatura de la captura de ejemplo
                    <img src={`/ayuda/${t.example}`} alt="" className="h-full w-full object-cover opacity-80" />
                  ) : null}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <strong className="text-[13px] font-semibold leading-snug">{t.title}</strong>
                  {own ? (
                    <span className="text-xs font-semibold text-brand-text">Imagen de tu negocio</span>
                  ) : (
                    <span className="text-xs text-text-2">Imagen de ejemplo</span>
                  )}
                  <span className="flex flex-wrap gap-1.5">
                    <FilePickButton
                      label={own ? "Cambiar" : "Subir la tuya"}
                      variant="outline"
                      size="sm"
                      accept={TRAINING_RULES.help_image.accept}
                      onFile={(f) => upload("capturas", "help_image", f, { topicId: t.id })}
                    />
                    {own && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-9"
                        onClick={() => remove("capturas", own, `«${t.title}» vuelve a la imagen de ejemplo.`)}
                      >
                        Usar la de ejemplo
                      </Button>
                    )}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}

function Section({
  id,
  title,
  description,
  action,
  status,
  children,
}: {
  id: string;
  title: string;
  description: string;
  action?: React.ReactNode;
  status: Status;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-titulo`}
      data-testid={`training-section-${id}`}
      className="space-y-3 rounded-lg border px-4 py-4 sm:px-5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <h2 id={`${id}-titulo`} className="text-base font-semibold">
            {title}
          </h2>
          <p className="text-[13px] text-text-2">{description}</p>
        </div>
        {action}
      </div>
      <p
        role={status?.kind === "error" ? "alert" : "status"}
        data-testid={`training-status-${id}`}
        className={cn(
          "text-[13px]",
          !status && "sr-only",
          status?.kind === "error" && "rounded-sm border border-danger-soft bg-danger-tint px-3 py-2 text-danger-text",
          status?.kind === "ok" && "text-success-text",
          status?.kind === "busy" && "text-text-2"
        )}
      >
        {status?.text ?? ""}
      </p>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-dashed px-3.5 py-3 text-[13px] text-text-2">{children}</p>;
}

function FilePickButton({
  label,
  accept,
  onFile,
  variant = "default",
  size = "default",
  testId,
}: {
  label: string;
  accept: string;
  onFile: (file: File) => Promise<void> | void;
  variant?: "default" | "outline";
  size?: "default" | "sm";
  testId?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid={testId}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setBusy(true);
          try {
            await onFile(file);
          } finally {
            setBusy(false);
          }
        }}
      />
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={busy}
        className={size === "sm" ? "min-h-9" : "min-h-11"}
        onClick={() => ref.current?.click()}
      >
        {busy ? "Subiendo…" : label}
      </Button>
    </>
  );
}

function TitleField({
  label,
  value,
  onSave,
}: {
  label: string;
  value: string;
  onSave: (title: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const save = () => {
    const clean = text.trim();
    if (!clean) {
      setText(value);
      return;
    }
    if (clean !== value) onSave(clean);
  };
  return (
    <label className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5 text-xs text-text-2">
      {label}
      <Input
        value={text}
        maxLength={120}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="text-sm text-foreground"
      />
    </label>
  );
}

function MoveButtons({
  name,
  first,
  last,
  onMove,
}: {
  name: string;
  first: boolean;
  last: boolean;
  onMove: (dir: -1 | 1) => void;
}) {
  return (
    <span className="flex gap-1">
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-10 w-10"
        aria-label={`Subir de lugar: ${name}`}
        disabled={first}
        onClick={() => onMove(-1)}
      >
        <ArrowUp aria-hidden className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-10 w-10"
        aria-label={`Bajar de lugar: ${name}`}
        disabled={last}
        onClick={() => onMove(1)}
      >
        <ArrowDown aria-hidden className="h-4 w-4" />
      </Button>
    </span>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      className="min-h-10 border-danger-soft text-danger-text hover:bg-danger-tint hover:text-danger-text"
      onClick={onClick}
    >
      Quitar
    </Button>
  );
}
