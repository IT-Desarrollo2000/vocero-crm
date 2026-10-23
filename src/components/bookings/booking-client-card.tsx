"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Copy, MessageSquareText } from "lucide-react";
import { AnuncioOrigen } from "@/components/anuncio-origen";
import { PriorityBadge } from "@/components/pipeline/priority-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CHANNEL_LABEL } from "@/lib/channels";
import { formatPhone } from "@/lib/utils";
import type {
  BookingClientCard as ClientCard,
  BookingClientResponse,
} from "@/server/agenda/client-card";
import { SOURCE_LABELS } from "@/server/contact-source";

/**
 * 029 (US-3) — Sección Cliente de una cita: nombre, teléfono (copiar), canal,
 * etapa/prioridad/fuente, anuncio de origen y «Abrir conversación». Se pide
 * al montar (`GET /api/bookings/[id]/client`); un fallo deja un aviso con
 * Reintentar y el resto del panel sigue funcionando. Con `restricted` el
 * servidor solo manda nombre y teléfono.
 */
export function BookingClientCard({ bookingId }: { bookingId: string }) {
  const [card, setCard] = useState<ClientCard | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    void (async () => {
      const res = await fetch(`/api/bookings/${bookingId}/client`).catch(() => null);
      const json = res?.ok
        ? ((await res.json().catch(() => null)) as BookingClientResponse | null)
        : null;
      if (cancelled) return;
      if (!json) {
        setState("error");
        return;
      }
      setCard(json.card);
      setState("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [bookingId, attempt]);

  if (state === "loading") {
    return (
      <p className="text-sm text-text-3" data-testid="booking-client-loading">
        Cargando datos del cliente…
      </p>
    );
  }
  if (state === "error") {
    return (
      <div
        role="alert"
        data-testid="booking-client-error"
        className="flex flex-wrap items-center gap-2 rounded-sm border border-danger-soft bg-danger-tint p-2 text-sm text-danger-text"
      >
        <span>No se pudieron cargar los datos del cliente</span>
        <Button size="sm" variant="outline" onClick={() => setAttempt((a) => a + 1)}>
          Reintentar
        </Button>
      </div>
    );
  }
  // Bloqueo (o contacto que ya no existe): no hay sección Cliente.
  if (!card) return null;

  return (
    <div
      data-testid="booking-client-card"
      data-restricted={card.restricted ? "true" : "false"}
      className="space-y-2 rounded-md border bg-subtle p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{card.name}</span>
        {card.priority && <PriorityBadge value={card.priority} />}
        {card.stageName && <Badge variant="outline">{card.stageName}</Badge>}
        {card.source && card.source.value !== "desconocida" && (
          <Badge variant="secondary" data-testid="booking-client-source">
            {SOURCE_LABELS[card.source.value]}
          </Badge>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-2">
        <PhoneLine phone={card.phone} />
        {card.channel && (
          <span data-testid="booking-client-channel">{CHANNEL_LABEL[card.channel]}</span>
        )}
      </div>

      {card.anuncio && <AnuncioOrigen anuncio={card.anuncio} />}

      <OpenChat card={card} />
    </div>
  );
}

function PhoneLine({ phone }: { phone: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!phone) {
    return (
      <span data-testid="booking-client-phone" data-phone="">
        Sin teléfono
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <span data-testid="booking-client-phone" data-phone={phone}>
        {formatPhone(phone)}
      </span>
      <button
        type="button"
        aria-label="Copiar teléfono"
        title="Copiar teléfono"
        data-testid="booking-client-copy"
        className="rounded p-1 text-text-3 hover:bg-accent hover:text-foreground"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(phone)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {});
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </span>
  );
}

function OpenChat({ card }: { card: ClientCard }) {
  if (!card.conversation) {
    return (
      <p className="text-sm text-text-3" data-testid="booking-no-chat">
        Sin conversación
      </p>
    );
  }
  if (!card.conversation.canOpenChat) {
    const who = card.conversation.assignedUserName;
    const label = who ? `Chat asignado a ${who}` : "No puedes abrir este chat";
    return (
      <Button
        size="sm"
        variant="outline"
        disabled
        title={label}
        data-testid="booking-open-chat"
        data-can-open="false"
      >
        <MessageSquareText className="h-4 w-4" />
        {label}
      </Button>
    );
  }
  return (
    <Link
      href={`/inbox?contact=${card.contactId}`}
      data-testid="booking-open-chat"
      data-can-open="true"
      className="inline-flex h-8 items-center gap-2 rounded-md border border-input px-3 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <MessageSquareText className="h-4 w-4" />
      Abrir conversación
    </Link>
  );
}
