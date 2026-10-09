"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  MessageSquareText,
  Search,
  Send,
  UserPlus,
} from "lucide-react";
import type { ContactDto } from "@/lib/types";
import { formatPhone } from "@/lib/utils";
import { ContactAvatar } from "@/components/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SOURCE_LABELS } from "@/server/contact-source";
import { priorityRank } from "@/server/leads/priority";
import { PriorityBadge } from "@/components/pipeline/priority-picker";
import { useStages } from "@/components/use-stages";
import { PAGE_DEFAULT_LIMIT, PAGE_MAX_LIMIT } from "@/lib/pagination";
import { stageColorByName } from "@/lib/stage-colors";
import { NewContactDialog } from "./new-contact-dialog";
import { StartConversation } from "./start-conversation";

/** Contactos por página del directorio ("Cargar más" pide otros tantos). */
const PAGE_SIZE = PAGE_DEFAULT_LIMIT;

type ContactsPage = {
  contacts: ContactDto[];
  total?: number;
  nextOffset?: number | null;
};

/**
 * A quién llamar primero: alta arriba, sin prioridad al final. El orden lo
 * decide esta lista, no el servidor, porque es una preferencia de trabajo y no
 * un dato del contacto. Se aplica a lo YA cargado: "Cargar más" puede
 * intercalar contactos con prioridad entre los anteriores.
 */
function byPriority(list: ContactDto[]): ContactDto[] {
  return [...list].sort(
    (a, b) => priorityRank(a.priority ?? null) - priorityRank(b.priority ?? null)
  );
}

export function ContactsClient() {
  const router = useRouter();
  const [contacts, setContacts] = useState<ContactDto[]>([]);
  // Paginado del servidor: cuántos hay en total con estos filtros y desde
  // dónde pedir la siguiente página (null = ya no hay más).
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Cada recarga de la primera página invalida lo que siga en vuelo: una
  // respuesta tardía no debe pisar ni mezclarse con la lista nueva.
  const requestId = useRef(0);
  const loadedCount = useRef(0);
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("all");
  const { stages: pipelineStages } = useStages();
  const stages = pipelineStages.map((s) => s.name);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<ContactDto | null>(null);
  const [creando, setCreando] = useState(false);
  const [escribiendo, setEscribiendo] = useState<ContactDto | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mismo rescate que en la Bandeja: lo tecleado antes de que hidrate el JS
  // se perdía en silencio. Ver conversation-list.tsx.
  useEffect(() => {
    const typed = inputRef.current?.value ?? "";
    if (typed) setQuery(typed);
  }, []);

  const fetchPage = useCallback(
    async (offset: number, limit: number) => {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (stage !== "all") params.set("stage", stage);
      if (showArchived) params.set("archived", "true");
      params.set("limit", String(limit));
      params.set("offset", String(offset));
      const res = await fetch(`/api/contacts?${params}`).catch(() => null);
      if (!res?.ok) return null;
      return (await res.json().catch(() => null)) as ContactsPage | null;
    },
    [query, stage, showArchived]
  );

  /**
   * Primera página: REEMPLAZA la lista. `keep` pide al menos esa cantidad
   * para que archivar o editar en la página 3 no lo regrese a la 1.
   */
  const refetch = useCallback(
    async (keep = 0) => {
      const id = ++requestId.current;
      const limit = Math.min(PAGE_MAX_LIMIT, Math.max(PAGE_SIZE, keep));
      const data = await fetchPage(0, limit);
      if (!data || id !== requestId.current) return;
      loadedCount.current = data.contacts.length;
      setContacts(byPriority(data.contacts));
      setTotal(data.total ?? data.contacts.length);
      setNextOffset(data.nextOffset ?? null);
    },
    [fetchPage]
  );

  /** Siguiente página: se AGREGA a lo que ya está en pantalla. */
  async function loadMore() {
    if (nextOffset === null || loadingMore) return;
    const id = requestId.current;
    setLoadingMore(true);
    const data = await fetchPage(nextOffset, PAGE_SIZE);
    setLoadingMore(false);
    if (!data || id !== requestId.current) return;
    setContacts((prev) => {
      // Si alguien escribió mientras se paginaba, su contacto subió al
      // principio y el offset repite uno: se descarta por `id`.
      const seen = new Set(prev.map((c) => c.id));
      const merged = byPriority([
        ...prev,
        ...data.contacts.filter((c) => !seen.has(c.id)),
      ]);
      loadedCount.current = merged.length;
      return merged;
    });
    setTotal(data.total ?? total);
    setNextOffset(data.nextOffset ?? null);
  }

  useEffect(() => {
    const t = setTimeout(() => void refetch(), 250);
    return () => clearTimeout(t);
  }, [refetch]);

  async function patch(id: string, body: Record<string, unknown>) {
    await fetch(`/api/contacts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    void refetch(loadedCount.current);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:gap-4 sm:px-6 sm:py-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">Contactos</h2>
          <Button size="sm" onClick={() => setCreando(true)}>
            <UserPlus className="mr-1.5 h-4 w-4" strokeWidth={1.8} />
            Nuevo contacto
          </Button>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:gap-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="accent-primary"
            />
            Ver archivados
          </label>
          {stages.length > 0 && (
            <select
              value={stage}
              onChange={(e) => setStage(e.target.value)}
              aria-label="Filtrar por etapa del embudo"
              className="h-9 rounded-md border border-input bg-card px-2 text-sm"
            >
              <option value="all">Toda etapa</option>
              {stages.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
          <div className="relative w-full sm:w-auto">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              ref={inputRef}
              placeholder="Buscar por nombre o teléfono…"
              aria-label="Buscar contacto"
              defaultValue=""
              onChange={(e) => setQuery(e.target.value)}
              className="w-full pl-8 sm:w-72"
            />
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {contacts.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            {query.trim() || stage !== "all" ? (
              <>
                <p className="text-sm font-medium">Sin resultados</p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  Nadie coincide con
                  {query.trim() ? ` «${query.trim()}»` : ""}
                  {query.trim() && stage !== "all" ? " en" : ""}
                  {stage !== "all" ? ` la etapa «${stage}»` : ""}.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">Sin contactos</p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  Cada persona que escriba a tu WhatsApp quedará registrada aquí
                  automáticamente.
                </p>
              </>
            )}
          </div>
        ) : (
          <ul className="space-y-2">
            {contacts.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-3 py-3 sm:flex-nowrap sm:gap-x-4 sm:px-4"
              >
                <ContactAvatar name={c.name} seed={c.id} />
                {/* El 60% mínimo es lo que empuja los botones a su propio
                    renglón en el teléfono en vez de exprimir el nombre. */}
                <div className="min-w-[60%] flex-1 sm:min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {c.name}
                    </span>
                    {c.priority && <PriorityBadge value={c.priority} />}
                    {c.stageName && (
                      <Badge variant="outline" className="gap-1.5">
                        <span
                          aria-hidden
                          className="h-[7px] w-[7px] rounded-full"
                          style={{
                            background: stageColorByName(
                              c.stageName,
                              pipelineStages
                            ),
                          }}
                        />
                        {c.stageName}
                      </Badge>
                    )}
                    {c.archivedAt && (
                      <Badge variant="secondary">Archivado</Badge>
                    )}
                    {/* Solo la fuente que alguien capturó: presentar una
                        deducción como dato la volvería un número inventado en
                        cuanto se cuente por fuente. */}
                    {c.source?.source === "capturada" && (
                      <Badge variant="secondary">
                        {SOURCE_LABELS[c.source.value]}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {formatPhone(c.phone)}
                    {c.notes ? ` · ${c.notes.slice(0, 60)}` : ""}
                  </p>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing(c)}
                  >
                    Editar
                  </Button>
                  {/* A quien nunca escribió hay que abrirle la conversación con
                      una plantilla: es regla de Meta, no del CRM. */}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Escribir primero"
                    title="Escribir primero (con plantilla)"
                    onClick={() => setEscribiendo(c)}
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                  <Link href={`/inbox?contact=${c.id}`}>
                    <Button variant="ghost" size="icon" aria-label="Abrir conversación">
                      <MessageSquareText className="h-4 w-4" />
                    </Button>
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={c.archivedAt ? "Desarchivar" : "Archivar"}
                    onClick={() => void patch(c.id, { archived: !c.archivedAt })}
                  >
                    {c.archivedAt ? (
                      <ArchiveRestore className="h-4 w-4" />
                    ) : (
                      <Archive className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {contacts.length > 0 && (
          <div className="mt-4 flex flex-col items-center gap-2">
            <p className="text-xs text-muted-foreground">
              Mostrando {contacts.length} de {Math.max(total, contacts.length)}
            </p>
            {nextOffset !== null && (
              <Button
                variant="outline"
                size="sm"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Cargando…" : "Cargar más"}
              </Button>
            )}
          </div>
        )}
      </div>

      {editing && (
        <EditDialog
          contact={editing}
          onClose={() => setEditing(null)}
          onSave={async (patchBody) => {
            await patch(editing.id, patchBody);
            setEditing(null);
          }}
        />
      )}

      {escribiendo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Escribir primero"
        >
          <div className="w-full max-w-md rounded-lg border bg-card p-4 shadow-pop">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h3 className="font-semibold">
                Escribir a {escribiendo.name}
              </h3>
              <Button variant="ghost" size="sm" onClick={() => setEscribiendo(null)}>
                Cerrar
              </Button>
            </div>
            <StartConversation
              contactId={escribiendo.id}
              onStarted={() => {
                const contactId = escribiendo.id;
                setEscribiendo(null);
                // La Bandeja resuelve por CONTACTO (`?contact=`), no por
                // conversación: con `?conversation=` no seleccionaría nada.
                router.push(`/inbox?contact=${contactId}`);
              }}
            />
          </div>
        </div>
      )}

      {creando && (
        <NewContactDialog
          onClose={() => setCreando(false)}
          onCreated={() => {
            setCreando(false);
            void refetch();
          }}
          onOpenExisting={(contactId) => {
            setCreando(false);
            router.push(`/inbox?contact=${contactId}`);
          }}
        />
      )}
    </div>
  );
}

function EditDialog({
  contact,
  onClose,
  onSave,
}: {
  contact: ContactDto;
  onClose: () => void;
  onSave: (patch: { name: string; notes: string }) => Promise<void>;
}) {
  const [name, setName] = useState(contact.name);
  const [notes, setNotes] = useState(contact.notes ?? "");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-overlay p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-lg border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 font-semibold">Editar contacto</h3>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="edit-name">
              Nombre
            </label>
            <Input
              id="edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="edit-notes">
              Notas
            </label>
            <Textarea
              id="edit-notes"
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!name.trim()}
            onClick={() => void onSave({ name: name.trim(), notes })}
          >
            Guardar
          </Button>
        </div>
      </div>
    </div>
  );
}
