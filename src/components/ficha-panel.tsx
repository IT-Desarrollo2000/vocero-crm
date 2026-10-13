"use client";

import { useEffect, useState } from "react";
import {
  Bot,
  Check,
  History,
  Lock,
  LockOpen,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fichaLabel, fichaValueText, parseFichaValue } from "@/lib/ficha";
import type { FichaFieldDef, FichaMeta } from "@/lib/ficha-fields";
import type { FichaDto, FichaEventDto, FichaValue } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  buildFichaRows,
  formatFichaEvent,
  parseTypedFichaValue,
  provenanceLocked,
  provenanceTitle,
  selectOptions,
  type FichaRow,
} from "@/components/ficha-view";

const OTRO = "__otro__";

/**
 * Lo que se sabe del lead, donde se trabaja la conversación.
 *
 * Existe porque `PUT /api/bot/ficha` ya deja al agente guardar lo que
 * averigua: sin esta pantalla, eso era un cajón que se llenaba y no se abría.
 *
 * Se puede corregir a mano. Un dato equivocado que el dueño ve pero no puede
 * arreglar es peor que no tenerlo: enseña a desconfiar de toda la ficha.
 *
 * 04 — Con campos definidos (`fields`), esos van primero, en su orden y aunque
 * estén vacíos, con un control por tipo. Cada valor dice quién lo puso (chip
 * "IA"/"Bot", candado si lo confirmó el equipo). Sin definición, es la ficha
 * libre de siempre.
 */
export function FichaPanel({
  ficha,
  onSave,
  fields = null,
  meta,
  onUnlock,
  contactId,
}: {
  ficha: FichaDto;
  /** Parche: solo lo que cambia. `null` borra la clave. */
  onSave: (patch: Record<string, FichaValue | null>) => Promise<void>;
  /** Definición de campos de la organización; `null` = ficha libre. */
  fields?: FichaFieldDef[] | null;
  /** Procedencia por clave (`contact.fichaMeta`). */
  meta?: FichaMeta;
  /** Quita el candado sin borrar el valor (RF-04-08). */
  onUnlock?: (key: string) => Promise<void>;
  /** Para abrir el historial; sin él no se ofrece. */
  contactId?: string;
}) {
  const [editando, setEditando] = useState<string | null>(null);
  const [borrador, setBorrador] = useState("");
  const [errorEdicion, setErrorEdicion] = useState<string | null>(null);
  const [agregando, setAgregando] = useState(false);
  const [claveNueva, setClaveNueva] = useState("");
  const [valorNuevo, setValorNuevo] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [historial, setHistorial] = useState(false);
  // Sube cuando el servidor ya respondió a un cambio: recarga el historial
  // (no antes, o la lectura le gana la carrera al PATCH).
  const [histVersion, setHistVersion] = useState(0);

  const filas = buildFichaRows(ficha, meta, fields);

  async function guardar(patch: Record<string, FichaValue | null>) {
    setGuardando(true);
    try {
      await onSave(patch);
    } finally {
      setGuardando(false);
      setHistVersion((v) => v + 1);
    }
  }

  function empezarEdicion(fila: FichaRow) {
    setEditando(fila.key);
    setErrorEdicion(null);
    setBorrador(fila.value === undefined ? "" : fichaValueText(fila.value));
  }

  function cancelar() {
    setEditando(null);
    setErrorEdicion(null);
  }

  async function confirmarEdicion(fila: FichaRow, texto = borrador) {
    let valor: FichaValue;
    if (fila.def) {
      // Vacío en un campo definido: no hace nada. Borrar es el bote.
      if (!texto.trim()) return cancelar();
      const r = parseTypedFichaValue(fila.def, texto);
      if (!r.ok) {
        setErrorEdicion(r.error);
        return;
      }
      valor = r.value;
    } else {
      valor = parseFichaValue(texto, fila.value);
    }
    cancelar();
    // Vacío no borra: para eso está el bote de basura. Un campo que se vacía
    // solo, porque alguien seleccionó y salió, se lleva un dato que costó una
    // conversación.
    if (valor === "" || valor === fila.value) return;
    await guardar({ [fila.key]: valor });
  }

  async function agregar() {
    const clave = claveNueva.trim();
    const valor = valorNuevo.trim();
    if (!clave || !valor) return;
    setAgregando(false);
    setClaveNueva("");
    setValorNuevo("");
    await guardar({ [clave]: valor });
  }

  async function desbloquear(clave: string) {
    if (!onUnlock) return;
    setGuardando(true);
    try {
      await onUnlock(clave);
    } finally {
      setGuardando(false);
      setHistVersion((v) => v + 1);
    }
  }

  const labelFor = (key: string) =>
    fields?.find((f) => f.key === key)?.label ?? fichaLabel(key);

  return (
    <section className="border-b p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-text-3">
          Ficha
        </p>
        <span className="flex items-center gap-1">
          {contactId && (
            <button
              onClick={() => setHistorial((v) => !v)}
              aria-expanded={historial}
              className={cn(
                "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-3 hover:bg-accent hover:text-foreground",
                historial && "bg-accent text-foreground"
              )}
            >
              <History className="h-3 w-3" />
              Historial
            </button>
          )}
          {!agregando && (
            <button
              onClick={() => setAgregando(true)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-3 hover:bg-accent hover:text-foreground"
            >
              <Plus className="h-3 w-3" />
              Agregar
            </button>
          )}
        </span>
      </div>

      {filas.length === 0 && !agregando && (
        <p className="text-xs leading-relaxed text-text-3">
          Todavía vacía. Aquí aparece lo que tu agente va averiguando del lead
          mientras conversa — y puedes escribirlo tú.
        </p>
      )}

      {filas.length > 0 && (
        <dl className="space-y-1.5">
          {filas.map((fila) => (
            <div key={fila.key} className="group flex items-start gap-2 text-xs">
              <dt className="w-[38%] shrink-0 break-words pt-1 text-text-3">
                {fila.label}
              </dt>
              <dd className="min-w-0 flex-1">
                {editando === fila.key ? (
                  <Editor
                    fila={fila}
                    borrador={borrador}
                    error={errorEdicion}
                    onBorrador={(t) => {
                      setBorrador(t);
                      setErrorEdicion(null);
                    }}
                    onConfirmar={(t) => void confirmarEdicion(fila, t)}
                    onCancelar={cancelar}
                  />
                ) : (
                  <div className="flex items-start gap-1">
                    <button
                      onClick={() => empezarEdicion(fila)}
                      className={cn(
                        "min-w-0 flex-1 break-words rounded px-1 py-1 text-left hover:bg-accent",
                        fila.value === undefined && "text-text-4"
                      )}
                      aria-label={`Editar ${fila.label}`}
                    >
                      {fila.value === undefined ? "—" : fichaValueText(fila.value)}
                    </button>
                    <Procedencia fila={fila} />
                    <span className="flex opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <button
                        onClick={() => empezarEdicion(fila)}
                        aria-label={`Editar ${fila.label}`}
                        className="rounded p-1 text-text-3 hover:bg-accent hover:text-foreground"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      {onUnlock && provenanceLocked(fila.provenance) && (
                        <button
                          disabled={guardando}
                          onClick={() => void desbloquear(fila.key)}
                          aria-label={`Dejar que el agente actualice ${fila.label}`}
                          title="Dejar que el agente lo actualice"
                          className="rounded p-1 text-text-3 hover:bg-accent hover:text-foreground"
                        >
                          <LockOpen className="h-3 w-3" />
                        </button>
                      )}
                      {fila.value !== undefined && (
                        <button
                          disabled={guardando}
                          onClick={() => void guardar({ [fila.key]: null })}
                          aria-label={`Quitar ${fila.label}`}
                          className="rounded p-1 text-text-3 hover:bg-accent hover:text-danger"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  </div>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {agregando && (
        <div className="mt-2 space-y-1.5">
          <Input
            autoFocus
            value={claveNueva}
            onChange={(e) => setClaveNueva(e.target.value)}
            placeholder="Qué dato (ej. presupuesto)"
            className="h-7 py-0 text-xs"
            aria-label="Nombre del dato"
          />
          <Input
            value={valorNuevo}
            onChange={(e) => setValorNuevo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void agregar();
              if (e.key === "Escape") setAgregando(false);
            }}
            placeholder="Valor"
            className="h-7 py-0 text-xs"
            aria-label="Valor del dato"
          />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              disabled={!claveNueva.trim() || !valorNuevo.trim() || guardando}
              onClick={() => void agregar()}
            >
              Agregar
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAgregando(false);
                setClaveNueva("");
                setValorNuevo("");
              }}
            >
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {historial && contactId && (
        <FichaHistorial
          // Remontar recarga el historial: tras un cambio propio ya confirmado
          // o cuando la ficha llega distinta del servidor (agente vía SSE).
          key={`${contactId}:${histVersion}:${JSON.stringify(ficha)}:${JSON.stringify(meta ?? {})}`}
          contactId={contactId}
          labelFor={labelFor}
        />
      )}
    </section>
  );
}

/** Chip "IA"/"Bot" o candado, con quién y cuándo en el tooltip. */
function Procedencia({ fila }: { fila: FichaRow }) {
  const p = fila.provenance;
  if (!p) return null;
  const title = provenanceTitle(p, fila.meta);
  if (p === "ia") {
    return (
      <span
        title={title}
        role="img"
        aria-label={title}
        className="mt-1 flex shrink-0 items-center gap-0.5 rounded-full border border-brand-soft bg-brand-tint px-1.5 text-[10px] font-medium text-brand-text"
      >
        <Sparkles className="h-2.5 w-2.5" />
        IA
      </span>
    );
  }
  if (p === "bot") {
    return (
      <span
        title={title}
        role="img"
        aria-label={title}
        className="mt-1 flex shrink-0 items-center gap-0.5 rounded-full border border-info-soft bg-info-tint px-1.5 text-[10px] font-medium text-info-text"
      >
        <Bot className="h-2.5 w-2.5" />
        Bot
      </span>
    );
  }
  return (
    <span title={title} role="img" aria-label={title} className="mt-1.5 shrink-0 text-text-3">
      <Lock className="h-3 w-3" />
    </span>
  );
}

/** Control de edición según el tipo del campo (texto libre en claves libres). */
function Editor({
  fila,
  borrador,
  error,
  onBorrador,
  onConfirmar,
  onCancelar,
}: {
  fila: FichaRow;
  borrador: string;
  error: string | null;
  onBorrador: (t: string) => void;
  onConfirmar: (t: string) => void;
  onCancelar: () => void;
}) {
  const def = fila.def;
  const [otro, setOtro] = useState(
    () =>
      def?.type === "opcion" &&
      Boolean(def.allowOther) &&
      fila.value !== undefined &&
      !(def.options ?? []).includes(fichaValueText(fila.value))
  );

  const botonCancelar = (
    <button
      onClick={onCancelar}
      aria-label="Cancelar"
      className="rounded p-1 text-text-3 hover:bg-accent hover:text-foreground"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );

  if (def?.type === "si_no") {
    const actual = fila.value;
    return (
      <div className="flex items-center gap-1">
        <div role="group" aria-label={fila.label} className="flex overflow-hidden rounded-md border">
          {(["Sí", "No"] as const).map((op) => {
            const activo = actual === (op === "Sí");
            return (
              <button
                key={op}
                aria-pressed={activo}
                onClick={() => onConfirmar(op)}
                className={cn(
                  "px-2.5 py-1 text-xs",
                  activo ? "bg-brand-tint font-semibold text-brand-text" : "hover:bg-accent"
                )}
              >
                {op}
              </button>
            );
          })}
        </div>
        {botonCancelar}
      </div>
    );
  }

  if (def?.type === "opcion" && !otro) {
    const opciones = selectOptions(def, fila.value);
    return (
      <div className="flex items-center gap-1">
        <select
          autoFocus
          value={fila.value === undefined ? "" : fichaValueText(fila.value)}
          onChange={(e) => {
            if (e.target.value === OTRO) {
              setOtro(true);
              onBorrador("");
              return;
            }
            if (e.target.value) onConfirmar(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancelar();
          }}
          aria-label={`Valor de ${fila.label}`}
          className="h-7 min-w-0 flex-1 rounded-md border border-input bg-card px-1.5 text-xs"
        >
          <option value="" disabled>
            Elige…
          </option>
          {opciones.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
          {def.allowOther && <option value={OTRO}>Otro…</option>}
        </select>
        {botonCancelar}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start gap-1">
        <Input
          autoFocus
          value={borrador}
          inputMode={def?.type === "numero" ? "decimal" : undefined}
          placeholder={def?.type === "opcion" ? "Escribe otro valor" : undefined}
          onChange={(e) => onBorrador(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onConfirmar(borrador);
            if (e.key === "Escape") onCancelar();
          }}
          className="h-7 py-0 text-xs"
          aria-label={`Valor de ${fila.label}`}
          aria-invalid={error ? true : undefined}
        />
        <button
          onClick={() => onConfirmar(borrador)}
          aria-label="Guardar"
          className="rounded p-1 text-text-3 hover:bg-accent hover:text-foreground"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        {botonCancelar}
      </div>
      {error && <p className="mt-0.5 text-[11px] text-danger-text">{error}</p>}
    </div>
  );
}

type HistState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; events: FichaEventDto[] };

/** Bitácora de la ficha del contacto: quién, qué, cuándo y si se aplicó. */
function FichaHistorial({
  contactId,
  labelFor,
}: {
  contactId: string;
  labelFor: (key: string) => string;
}) {
  const [state, setState] = useState<HistState>({ status: "loading" });

  useEffect(() => {
    let vigente = true;
    void fetch(`/api/contacts/${contactId}/ficha/history`)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const body = (await r.json()) as { events?: FichaEventDto[] };
        if (vigente) {
          setState({ status: "ok", events: Array.isArray(body.events) ? body.events : [] });
        }
      })
      // 501/404/red: se dice, no se finge una bitácora vacía.
      .catch(() => {
        if (vigente) setState({ status: "error" });
      });
    return () => {
      vigente = false;
    };
  }, [contactId]);

  return (
    <div className="mt-3 rounded-md border p-2.5">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-3">
        Historial
      </p>
      {state.status === "loading" && <p className="text-xs text-text-3">Cargando…</p>}
      {state.status === "error" && (
        <p className="text-xs text-text-3">Historial no disponible por ahora.</p>
      )}
      {state.status === "ok" && state.events.length === 0 && (
        <p className="text-xs text-text-3">Sin cambios registrados todavía.</p>
      )}
      {state.status === "ok" && state.events.length > 0 && (
        <ul className="max-h-64 space-y-1.5 overflow-y-auto">
          {state.events.map((e) => {
            const v = formatFichaEvent(e, labelFor);
            return (
              <li
                key={v.id}
                className={cn("text-[11px] leading-snug", v.aplicado ? "text-text-2" : "text-text-4")}
              >
                <span className="font-medium">{v.campo}</span>
                {v.cambio && <> · {v.cambio}</>}
                <br />
                <span className={v.aplicado ? "text-text-3" : undefined}>
                  {v.quien} · {v.cuando}
                  {!v.aplicado && <> · {v.resultado}</>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
