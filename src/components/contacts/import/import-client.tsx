"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleCheck,
  FileCheck,
  FileText,
  Loader2,
} from "lucide-react";
import {
  IMPORT_ACCEPT,
  IMPORT_BATCH_SIZE,
  IMPORT_EVENT_MAX,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  OUTCOME_TEXT,
  TEMPLATE_COLUMNS,
  plural,
  previewRowText,
  problemText,
  type ImportBatchDto,
  type ImportPreviewDto,
  type ImportRowInput,
  type ImportRowResult,
  type PreviewRow,
  type ResultSheetInput,
} from "@/lib/contact-import";
import { cn } from "@/lib/utils";
import { normalizePersonName } from "@/server/intake/seller-match";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, ImportHeader, StatCard, Stepper } from "./import-parts";

/**
 * 036 fase 2 — Contactos → Importar desde Excel (solo Propietario).
 * Diseño aprobado: specs/036-importar-leads-evento/diseno/{Main,Revisar,Resultado}.dc.html
 *
 * 1) Subir: nombre del evento + archivo. Al elegir el archivo se pide la
 *    vista previa (no escribe nada) para mostrar renglones y columnas.
 * 2) Revisar: qué entra, qué no y a quién se asigna cada chat.
 * 3) Importar de 50 en 50, en orden («Importando 50 de 117…»). Si un lote
 *    falla, «Reintentar lo que falta» (seguro: el servidor reconoce lo que ya
 *    entró). Listo: números reales y el resultado por renglón en .xlsx.
 */

type Filter = "problem" | "repeated" | "all";
const PAGE = 50;

async function errorText(res: Response | null, fallback: string): Promise<string> {
  if (!res) return "No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo.";
  const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return data?.error?.message ?? fallback;
}

function toImportRow(r: PreviewRow): ImportRowInput {
  return {
    rowNumber: r.rowNumber,
    name: r.name,
    phone: r.phone ?? r.rawPhone,
    seller: r.seller,
    model: r.model,
    notes: r.notes,
    email: r.email,
    consent: r.consent,
  };
}

export function ImportClient() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [event, setEvent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewDto | null>(null);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const readId = useRef(0);

  const [results, setResults] = useState<Map<number, ImportRowResult>>(new Map());
  const [importing, setImporting] = useState<{ done: number; total: number } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const eventName = event.trim();

  function reset(keepEvent: boolean) {
    readId.current++;
    setStep(1);
    if (!keepEvent) setEvent("");
    setFile(null);
    setPreview(null);
    setReading(false);
    setFileError(null);
    setResults(new Map());
    setImporting(null);
    setImportError(null);
    setDownloadError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function choose(f: File | null | undefined) {
    if (!f) return;
    const id = ++readId.current;
    setFile(f);
    setPreview(null);
    setFileError(null);
    if (!/\.(xlsx|csv)$/i.test(f.name)) {
      setFileError(
        /\.xls$/i.test(f.name)
          ? "Es un Excel antiguo (.xls). Ábrelo en Excel y guárdalo como «Libro de Excel (.xlsx)»."
          : "Solo se leen archivos de Excel (.xlsx) o .csv."
      );
      return;
    }
    if (f.size > IMPORT_MAX_BYTES) {
      setFileError("El archivo pesa más de 5 MB. Quítale hojas o columnas que no sean de la lista.");
      return;
    }
    setReading(true);
    const form = new FormData();
    form.set("file", f);
    const res = await fetch("/api/contacts/import/preview", { method: "POST", body: form }).catch(() => null);
    if (id !== readId.current) return;
    if (!res?.ok) {
      setFileError(await errorText(res, "No se pudo leer el archivo."));
      setReading(false);
      return;
    }
    const data = (await res.json().catch(() => null)) as ImportPreviewDto | null;
    if (id !== readId.current) return;
    setReading(false);
    if (!data) {
      setFileError("No se pudo leer el archivo.");
      return;
    }
    setPreview(data);
  }

  const ready = useMemo(() => preview?.rows.filter((r) => r.status === "ready") ?? [], [preview]);

  /** Importa lo que falta (lo que no ha entrado o falló), de 50 en 50. */
  async function runImport() {
    if (!preview || importing) return;
    const todo = ready.filter((r) => {
      const done = results.get(r.rowNumber);
      return !done || done.outcome === "error";
    });
    if (todo.length === 0) {
      setStep(3);
      return;
    }
    setImportError(null);
    const merged = new Map(results);
    const total = ready.length;
    let done = total - todo.length;
    setImporting({ done, total });
    for (let i = 0; i < todo.length; i += IMPORT_BATCH_SIZE) {
      const batch = todo.slice(i, i + IMPORT_BATCH_SIZE);
      const res = await fetch("/api/contacts/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: eventName, rows: batch.map(toImportRow) }),
      }).catch(() => null);
      const data = res?.ok ? ((await res.json().catch(() => null)) as ImportBatchDto | null) : null;
      if (!data) {
        const why = await errorText(res, "El servidor no respondió bien.");
        setResults(merged);
        setImporting(null);
        setImportError(
          `Se detuvo en ${done.toLocaleString("es-MX")} de ${total.toLocaleString("es-MX")}: ${why} Lo que ya entró no se duplica al reintentar.`
        );
        return;
      }
      for (const r of data.results) merged.set(r.rowNumber, r);
      done += batch.length;
      setResults(new Map(merged));
      setImporting({ done, total });
    }
    setImporting(null);
    setStep(3);
  }

  async function downloadResult() {
    if (!preview) return;
    setDownloading(true);
    setDownloadError(null);
    const memberOf = new Map(
      preview.sellers.filter((s) => s.memberName).map((s) => [normalizePersonName(s.text), s.memberName as string])
    );
    const rows: ResultSheetInput["rows"] = preview.rows.map((r) => {
      const res = results.get(r.rowNumber);
      const result =
        r.status !== "ready"
          ? `No se importó: ${problemText(r.problem, r.repeatOf)}`
          : res
            ? OUTCOME_TEXT[res.outcome]
            : "No se importó";
      const assignment =
        !res || res.outcome === "error"
          ? ""
          : res.assignee === "seller"
            ? `Asignado a ${memberOf.get(normalizePersonName(r.seller)) ?? r.seller}`
            : res.assignee === "other"
              ? "Ya tenía vendedor"
              : "Buzón, sin asignar";
      return {
        rowNumber: r.rowNumber,
        name: r.name,
        phone: r.phone ? r.phone.slice(2) : r.rawPhone,
        seller: r.seller,
        result,
        assignment,
      };
    });
    const res = await fetch("/api/contacts/import/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: eventName, rows }),
    }).catch(() => null);
    if (!res?.ok) {
      setDownloadError(await errorText(res, "No se pudo armar el archivo."));
      setDownloading(false);
      return;
    }
    const blob = await res.blob();
    const name =
      /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "resultado-importacion.xlsx";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setDownloading(false);
  }

  return (
    <div className="h-full overflow-y-auto">
      <div
        className={cn(
          "flex flex-col gap-5 px-4 pb-10 pt-6 text-sm sm:px-8 sm:pt-7",
          step === 2 ? "max-w-[1024px]" : "max-w-[944px]"
        )}
      >
        {step === 1 && (
          <UploadStep
            event={event}
            setEvent={setEvent}
            file={file}
            preview={preview}
            reading={reading}
            fileError={fileError}
            dragging={dragging}
            setDragging={setDragging}
            inputRef={inputRef}
            onChoose={choose}
            onNext={() => setStep(2)}
          />
        )}
        {step === 2 && preview && (
          <ReviewStep
            preview={preview}
            event={eventName}
            importing={importing}
            importError={importError}
            started={results.size > 0}
            onImport={runImport}
            onOtherFile={() => reset(true)}
          />
        )}
        {step === 3 && preview && (
          <DoneStep
            preview={preview}
            event={eventName}
            results={results}
            downloading={downloading}
            downloadError={downloadError}
            onDownload={downloadResult}
            onAnother={() => reset(false)}
          />
        )}
      </div>
    </div>
  );
}

/* ───────────────────────────── 1. Subir ───────────────────────────── */

function UploadStep(props: {
  event: string;
  setEvent: (v: string) => void;
  file: File | null;
  preview: ImportPreviewDto | null;
  reading: boolean;
  fileError: string | null;
  dragging: boolean;
  setDragging: (v: boolean) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChoose: (f: File | null | undefined) => void;
  onNext: () => void;
}) {
  const { file, preview, reading, fileError } = props;
  const canNext = !!props.event.trim() && !!preview && !reading && !fileError;
  const pick = () => props.inputRef.current?.click();

  return (
    <>
      <ImportHeader title="Importar contactos desde Excel">
        <p className="max-w-[680px] text-foreground">
          Para listas que tu equipo llenó a mano, como en un evento. Cada contacto entra a la Bandeja con una tarjeta
          de lo que anotaron. <strong>No se le manda ningún mensaje</strong>: cada vendedor le escribe después con una
          plantilla.
        </p>
      </ImportHeader>
      <Stepper current={1} />

      <Card aria-labelledby="plantilla-titulo" className="gap-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <FileText className="h-[22px] w-[22px] text-brand-text" strokeWidth={1.8} aria-hidden="true" />
          <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-0.5">
            <h2 id="plantilla-titulo" className="text-base font-semibold">
              La plantilla para tu equipo
            </h2>
            <p className="text-[13px] text-text-2">
              Pásasela a tus vendedores antes del evento. Ya trae las columnas en orden, el WhatsApp en formato de
              texto y la lista de vendedores de tu equipo.
            </p>
          </div>
          <a
            href="/api/contacts/import/template"
            download
            className={buttonVariants({ variant: "outline", className: "h-11 px-3.5 font-semibold" })}
            data-testid="import-template"
          >
            <ArrowDownToLine className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
            Descargar plantilla (.xlsx)
          </a>
        </div>
        <ul className="flex flex-wrap gap-1.5 text-[12.5px]" aria-label="Columnas de la plantilla">
          {TEMPLATE_COLUMNS.map((c, i) => (
            <li
              key={c}
              className={cn("rounded-sm border border-border-strong px-2.5 py-1", i < 2 && "bg-accent")}
            >
              {i === 0 ? (
                <>
                  <strong>{c}</strong> · obligatorio
                </>
              ) : i === 1 ? (
                <>
                  <strong>{c}</strong> · obligatorio, 10 dígitos
                </>
              ) : (
                c
              )}
            </li>
          ))}
        </ul>
        <p className="text-[12.5px] text-text-2">
          ¿Tu lista ya existe con otro formato? También se lee: las columnas se reconocen por su nombre (Teléfono,
          Celular, Asesor, Notas…).
        </p>
      </Card>

      <Card aria-labelledby="subir-titulo" className="gap-4">
        <h2 id="subir-titulo" className="text-base font-semibold">
          Sube la lista
        </h2>

        <label className="flex max-w-[460px] flex-col gap-1 text-[13px] font-semibold">
          Nombre del evento
          <input
            type="text"
            value={props.event}
            onChange={(e) => props.setEvent(e.target.value)}
            maxLength={IMPORT_EVENT_MAX}
            placeholder="Ej. Expo Autos 2026"
            data-testid="import-event"
            className="min-h-11 rounded-md border border-input bg-transparent px-3 py-2 text-sm font-normal text-foreground placeholder:text-text-4 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <span className="text-[12.5px] font-normal text-text-2">
            Sale en la tarjeta de cada contacto. Escríbelo siempre igual: si subes la lista otra vez con este mismo
            nombre, no se duplica nada.
          </span>
        </label>

        <input
          ref={props.inputRef}
          type="file"
          accept={IMPORT_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="import-file"
          onChange={(e) => props.onChoose(e.target.files?.[0])}
        />

        {!file ? (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              props.setDragging(true);
            }}
            onDragLeave={() => props.setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              props.setDragging(false);
              props.onChoose(e.dataTransfer.files?.[0]);
            }}
            className={cn(
              "flex flex-col items-center gap-2 rounded-lg border-[1.5px] border-dashed px-5 py-7 text-center",
              props.dragging ? "border-brand bg-brand-tint" : "border-border-strong bg-subtle"
            )}
            data-testid="import-dropzone"
          >
            <ArrowUpFromLine className="h-7 w-7 text-text-2" strokeWidth={1.6} aria-hidden="true" />
            <p className="text-sm">Arrastra el archivo aquí o</p>
            <Button type="button" variant="outline" className="h-11 bg-background px-3.5 font-semibold" onClick={pick}>
              Elegir archivo
            </Button>
            <p className="text-[12.5px] text-text-2">
              Excel (.xlsx) o .csv · hasta {IMPORT_MAX_ROWS.toLocaleString("es-MX")} renglones · se lee la primera hoja
            </p>
          </div>
        ) : (
          <div
            className={cn(
              "flex flex-wrap items-center gap-3 rounded-md border px-3.5 py-2.5",
              fileError
                ? "border-danger-soft bg-danger-tint text-danger-text"
                : reading
                  ? "border-border text-text-2"
                  : "border-success-soft bg-success-tint text-success-text"
            )}
            data-testid="import-file-state"
            role={fileError ? "alert" : undefined}
          >
            {fileError ? (
              <AlertCircle className="h-5 w-5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
            ) : reading ? (
              <Loader2 className="h-5 w-5 shrink-0 animate-spin" strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <FileCheck className="h-5 w-5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
            )}
            <span className="flex min-w-0 flex-[1_1_240px] flex-col gap-px">
              <strong className="truncate text-[13.5px] text-foreground">{file.name}</strong>
              <span className="text-[12.5px]">
                {fileError
                  ? fileError
                  : reading || !preview
                    ? "Leyendo la lista…"
                    : `${plural(preview.totalRows, "renglón", "renglones")} · columnas: ${preview.columns.recognized.join(", ")}${
                        preview.columns.ignored.length
                          ? ` · se ignoran: ${preview.columns.ignored.join(", ")}`
                          : ""
                      }`}
              </span>
            </span>
            <Button
              type="button"
              variant="outline"
              className="h-10 bg-background px-3 text-foreground"
              onClick={pick}
              disabled={reading}
            >
              {fileError ? "Elegir otro archivo" : "Cambiar archivo"}
            </Button>
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2.5">
          <Link href="/contacts" className="flex min-h-11 items-center px-3.5 text-[13.5px] text-text-2 hover:text-foreground">
            Cancelar
          </Link>
          <Button
            type="button"
            className="h-11 px-[18px] text-sm font-semibold"
            disabled={!canNext}
            onClick={props.onNext}
            data-testid="import-review"
          >
            Revisar la lista
          </Button>
        </div>
      </Card>
    </>
  );
}

/* ───────────────────────────── 2. Revisar ─────────────────────────── */

function ReviewStep(props: {
  preview: ImportPreviewDto;
  event: string;
  importing: { done: number; total: number } | null;
  importError: string | null;
  started: boolean;
  onImport: () => void;
  onOtherFile: () => void;
}) {
  const { preview, importing } = props;
  const { summary } = preview;
  const counts: Record<Filter, number> = {
    problem: summary.invalid,
    repeated: summary.repeated,
    all: preview.totalRows,
  };
  const [filter, setFilter] = useState<Filter>(
    summary.invalid > 0 ? "problem" : summary.repeated > 0 ? "repeated" : "all"
  );
  const [shown, setShown] = useState(PAGE);
  const rows = preview.rows.filter((r) =>
    filter === "problem" ? r.status === "invalid" : filter === "repeated" ? r.status === "repeated" : true
  );
  const unmatched = preview.sellers.filter((s) => s.kind !== "match");
  const toBuzon = unmatched.reduce((n, s) => n + s.count, 0) + preview.noSeller;

  const label = importing
    ? `Importando ${importing.done.toLocaleString("es-MX")} de ${importing.total.toLocaleString("es-MX")}…`
    : props.importError
      ? "Reintentar lo que falta"
      : `Importar ${plural(summary.ready, "contacto", "contactos")}`;

  return (
    <>
      <ImportHeader title="Revisa la lista antes de importar">
        <p className="text-foreground">
          {preview.fileName} · evento <strong>{props.event}</strong> ·{" "}
          {plural(preview.totalRows, "renglón", "renglones")}.{" "}
          {props.started ? "Ya se guardó una parte: lo que falta se puede reintentar." : "Todavía no se ha guardado nada."}
        </p>
      </ImportHeader>
      <Stepper current={2} />

      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2.5">
        <StatCard
          tone={summary.ready > 0 ? "success" : "neutral"}
          value={summary.ready}
          label="listos para importar"
          testId="stat-ready"
          note={
            summary.ready === 0
              ? "Ningún renglón tiene nombre y WhatsApp válidos."
              : summary.existing === 0
                ? "Todos son contactos nuevos."
                : summary.existing === 1
                  ? "1 de ellos ya está en tus contactos: se le agrega la tarjeta del evento y su nombre no cambia."
                  : `${summary.existing.toLocaleString("es-MX")} de ellos ya están en tus contactos: se les agrega la tarjeta del evento y su nombre no cambia.`
          }
        />
        <StatCard
          tone={summary.invalid > 0 ? "danger" : "neutral"}
          value={summary.invalid}
          label="con problema"
          testId="stat-invalid"
          note={
            summary.invalid > 0
              ? "No se importan. Corrígelos en el Excel y vuelve a subirlo."
              : "Todos traen nombre y un WhatsApp válido."
          }
        />
        <StatCard
          tone={summary.repeated > 0 ? "warning" : "neutral"}
          value={summary.repeated}
          label="repetidos en la lista"
          testId="stat-repeated"
          note={
            summary.repeated > 0
              ? "Mismo WhatsApp dos veces: se importa solo el primero."
              : "Ningún WhatsApp se repite."
          }
        />
      </div>

      {summary.ready > 0 && (
        <Card aria-labelledby="vend-titulo" className="gap-2.5">
          <div className="flex flex-col gap-0.5">
            <h2 id="vend-titulo" className="text-base font-semibold">
              A quién se le asigna cada chat
            </h2>
            <p className="text-[13px] text-text-2">
              Según la columna Vendedor. Un chat que ya tiene vendedor no se le quita.
            </p>
          </div>
          <ul className="flex flex-col rounded-md border border-border" data-testid="import-sellers">
            {preview.sellers.map((s) => (
              <li
                key={`${s.kind}:${s.text}`}
                className={cn(
                  "flex flex-wrap items-center gap-3 border-b border-border px-3.5 py-2 last:border-b-0",
                  s.kind !== "match" && "bg-warning-tint"
                )}
              >
                <span className="flex-[1_1_200px]">
                  «{s.text}» →{" "}
                  {s.kind === "match" ? (
                    <strong>{s.memberName}</strong>
                  ) : (
                    <strong className="text-warning-text">
                      {s.kind === "none"
                        ? "nadie del equipo se llama así"
                        : "coincide con más de una persona del equipo"}
                    </strong>
                  )}
                </span>
                <span className={cn("text-[13px]", s.kind === "match" ? "text-text-2" : "text-warning-text")}>
                  {s.kind === "match"
                    ? plural(s.count, "chat", "chats")
                    : `${plural(s.count, "chat", "chats")} al Buzón, sin asignar`}
                </span>
              </li>
            ))}
            {preview.noSeller > 0 && (
              <li className="flex flex-wrap items-center gap-3 px-3.5 py-2">
                <span className="flex-[1_1_200px] text-text-2">Sin vendedor anotado</span>
                <span className="text-[13px] text-text-2">
                  {plural(preview.noSeller, "chat", "chats")} al Buzón, sin asignar
                </span>
              </li>
            )}
          </ul>
          {toBuzon > 0 && (
            <p className="text-[12.5px] text-text-2">
              {unmatched.length > 0 ? (
                <>
                  Para asignar los de {unmatched.map((s) => `«${s.text}»`).join(", ")}, escribe en el Excel su nombre
                  como está en el equipo{unmatched.some((s) => s.kind === "ambiguous") ? " (nombre y apellido)" : ""} y
                  vuelve a subirlo: lo que ya entró no se duplica. También puedes asignarlos después desde la Bandeja.
                </>
              ) : (
                "Los que no traen vendedor quedan en el Buzón: asígnalos desde la Bandeja."
              )}
            </p>
          )}
        </Card>
      )}

      <Card aria-labelledby="filas-titulo" className="gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="filas-titulo" className="flex-auto text-base font-semibold">
            Renglones
          </h2>
          <div role="group" aria-label="Mostrar" className="flex flex-wrap gap-1.5">
            {(["problem", "repeated", "all"] as const)
              .filter((f) => f === "all" || counts[f] > 0)
              .map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={filter === f}
                  onClick={() => {
                    setFilter(f);
                    setShown(PAGE);
                  }}
                  className={cn(
                    "min-h-9 rounded-full border px-3 py-1.5 text-[13px]",
                    filter === f
                      ? "border-brand-text bg-brand-tint font-semibold text-brand-text"
                      : "border-border-strong hover:bg-accent"
                  )}
                >
                  {f === "problem" ? "Con problema" : f === "repeated" ? "Repetidos" : "Todos"} ·{" "}
                  {counts[f].toLocaleString("es-MX")}
                </button>
              ))}
          </div>
        </div>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[640px] border-collapse text-[13.5px]" data-testid="import-rows">
            <thead>
              <tr className="bg-secondary text-left text-xs text-text-2">
                {["Renglón", "Nombre", "WhatsApp", "Vendedor", "Qué pasa"].map((h) => (
                  <th key={h} scope="col" className="px-3.5 py-2 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((r) => (
                <tr key={r.rowNumber} className="border-t border-border">
                  <td className="px-3.5 py-2 text-text-2">{r.rowNumber}</td>
                  <td className={cn("px-3.5 py-2", !r.name && "text-text-2")}>{r.name || "(vacío)"}</td>
                  <td className="px-3.5 py-2 text-text-2">{r.rawPhone || "(vacío)"}</td>
                  <td className="px-3.5 py-2">{r.seller}</td>
                  <td
                    className={cn(
                      "px-3.5 py-2",
                      r.status === "invalid"
                        ? "text-danger-text"
                        : r.status === "repeated"
                          ? "text-warning-text"
                          : "text-text-2"
                    )}
                  >
                    {previewRowText(r)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > shown && (
          <Button type="button" variant="outline" className="self-start" onClick={() => setShown((n) => n + PAGE * 4)}>
            Mostrar más ({(rows.length - shown).toLocaleString("es-MX")} restantes)
          </Button>
        )}
      </Card>

      {props.importError && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-danger-soft bg-danger-tint px-3.5 py-2.5 text-[13px] text-danger-text"
          data-testid="import-error"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {props.importError}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-border pt-4">
        <p className="flex-[1_1_320px] text-[13px] text-text-2">
          No se le manda ningún mensaje a nadie. Cada vendedor verá sus chats en «Mis chats» y les escribe con una
          plantilla.
        </p>
        <Button
          type="button"
          variant="outline"
          className="h-11 px-3.5"
          onClick={props.onOtherFile}
          disabled={!!importing}
        >
          Subir otro archivo
        </Button>
        <Button
          type="button"
          className="h-11 px-[18px] text-sm font-semibold"
          onClick={props.onImport}
          disabled={!!importing || summary.ready === 0}
          aria-live="polite"
          data-testid="import-run"
        >
          {importing && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {label}
        </Button>
      </div>
    </>
  );
}

/* ───────────────────────────── 3. Listo ───────────────────────────── */

function DoneStep(props: {
  preview: ImportPreviewDto;
  event: string;
  results: Map<number, ImportRowResult>;
  downloading: boolean;
  downloadError: string | null;
  onDownload: () => void;
  onAnother: () => void;
}) {
  const all = [...props.results.values()];
  const n = (pred: (r: ImportRowResult) => boolean) => all.filter(pred).length;
  const ok = n((r) => r.outcome !== "error");
  const created = n((r) => r.outcome === "created");
  const existing = n((r) => r.outcome === "existing");
  const duplicate = n((r) => r.outcome === "duplicate");
  const errors = n((r) => r.outcome === "error");
  const assigned = n((r) => r.outcome !== "error" && r.assignee === "seller");
  const other = n((r) => r.outcome !== "error" && r.assignee === "other");
  const buzon = n((r) => r.outcome !== "error" && r.assignee === null);
  const { invalid, repeated } = props.preview.summary;
  const notIn = invalid + repeated;

  const next: React.ReactNode[] = [];
  if (assigned > 0) {
    next.push(
      <>
        Cada vendedor abre <strong>Mis chats</strong> y le manda a sus contactos la plantilla de seguimiento.
      </>
    );
  }
  if (buzon > 0) {
    next.push(
      buzon === 1
        ? "El del Buzón: asígnalo desde la Bandeja, o corrige el vendedor en el Excel y súbelo otra vez con el mismo nombre de evento."
        : `Los ${buzon.toLocaleString("es-MX")} del Buzón: asígnalos desde la Bandeja, o corrige el vendedor en el Excel y súbelo otra vez con el mismo nombre de evento.`
    );
  }
  if (other > 0) {
    next.push(
      other === 1
        ? "1 chat ya tenía vendedor: se quedó con esa persona."
        : `${other.toLocaleString("es-MX")} chats ya tenían vendedor: se quedaron con esa persona.`
    );
  }
  if (duplicate > 0) {
    next.push(
      duplicate === 1
        ? "1 ya se había importado con este evento: no se duplicó."
        : `${duplicate.toLocaleString("es-MX")} ya se habían importado con este evento: no se duplicó nada.`
    );
  }
  if (notIn > 0) {
    const parts = [
      invalid > 0 ? `${invalid.toLocaleString("es-MX")} con problema` : null,
      repeated > 0 ? plural(repeated, "repetido", "repetidos") : null,
    ].filter(Boolean);
    next.push(
      notIn === 1
        ? `El renglón que no entró (${parts.join(", ")}) viene en el resultado para corregirlo.`
        : `Los ${notIn.toLocaleString("es-MX")} renglones que no entraron (${parts.join(", ")}) vienen en el resultado para corregirlos.`
    );
  }
  if (errors > 0) {
    next.push(
      `${plural(errors, "renglón no se pudo", "renglones no se pudieron")} importar. Sube el archivo otra vez con el mismo nombre de evento: lo que ya entró no se duplica.`
    );
  }

  return (
    <>
      <ImportHeader
        title={`Listo: ${plural(ok, "contacto", "contactos")} de «${props.event}»`}
        icon={<CircleCheck className="h-[26px] w-[26px] shrink-0 text-success-text" strokeWidth={2} aria-hidden="true" />}
      />
      <Stepper current={3} />

      <dl className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2.5" data-testid="import-done">
        {(
          [
            ["Contactos nuevos", created, "created"],
            ["Ya estaban (con tarjeta nueva)", existing, "existing"],
            ["Asignados a su vendedor", assigned, "assigned"],
          ] as const
        ).map(([label, value, id]) => (
          <div key={id} className="rounded-md border border-border px-3.5 py-3" data-testid={`done-${id}`}>
            <dt className="text-[13px] text-text-2">{label}</dt>
            <dd className="mt-0.5 text-2xl font-bold">{value.toLocaleString("es-MX")}</dd>
          </div>
        ))}
        <div
          className={cn(
            "rounded-md border px-3.5 py-3",
            buzon > 0 ? "border-warning-soft bg-warning-tint text-warning-text" : "border-border"
          )}
          data-testid="done-buzon"
        >
          <dt className={cn("text-[13px]", buzon > 0 ? "" : "text-text-2")}>En el Buzón, sin asignar</dt>
          <dd className="mt-0.5 text-2xl font-bold">{buzon.toLocaleString("es-MX")}</dd>
        </div>
      </dl>

      {next.length > 0 && (
        <Card aria-labelledby="sig-titulo" className="gap-2.5">
          <h2 id="sig-titulo" className="text-base font-semibold">
            Lo que sigue
          </h2>
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-foreground" data-testid="import-next">
            {next.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ol>
        </Card>
      )}

      {props.downloadError && (
        <p role="alert" className="text-[13px] text-danger-text">
          {props.downloadError}
        </p>
      )}

      <div className="flex flex-wrap gap-2.5">
        <Link
          href="/inbox"
          className={buttonVariants({ className: "h-11 px-[18px] text-sm font-semibold" })}
          data-testid="import-inbox"
        >
          Ver en la Bandeja
        </Link>
        <Button
          type="button"
          variant="outline"
          className="h-11 px-3.5"
          onClick={props.onDownload}
          disabled={props.downloading}
          data-testid="import-result"
        >
          {props.downloading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <ArrowDownToLine className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
          )}
          Descargar el resultado por renglón (.xlsx)
        </Button>
        <Button type="button" variant="outline" className="h-11 px-3.5" onClick={props.onAnother}>
          Importar otra lista
        </Button>
      </div>
    </>
  );
}
