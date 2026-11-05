"use client";

import { useState } from "react";
import { Bot, UserRound } from "lucide-react";
import type { WhoAnswers } from "@/lib/who-answers";
import { handoffLabel } from "@/lib/handoff-labels";
import { cn } from "@/lib/utils";

/**
 * 031 — Franja bajo la cabecera del hilo: quién le está respondiendo al
 * cliente (A: la IA · B: una persona, IA en pausa · C: la IA pidió a una
 * persona). «Reactivar IA» y «Marcar como atendida» siguen en el panel de
 * detalles; aquí solo la acción que toca ahora.
 */
export function WhoAnswersStrip({
  state,
  name,
  onTakeOver,
  onGiveBack,
  onReply,
}: {
  state: WhoAnswers;
  /** Primer nombre del cliente o «este cliente». */
  name: string;
  /** «Atender yo»: el chat a tu nombre (si nadie lo tiene) e IA en pausa. */
  onTakeOver: () => Promise<boolean>;
  /** «Devolver a la IA». */
  onGiveBack: () => Promise<boolean>;
  /** «Responder a …»: lleva el foco al compositor. */
  onReply: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (state.kind === "none") return null;

  async function run(action: () => Promise<boolean>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  const primary =
    "shrink-0 rounded-md bg-brand px-3 py-1.5 text-[12.5px] font-semibold text-brand-fg transition-colors hover:bg-brand-hover disabled:opacity-60";

  if (state.kind === "ai") {
    return (
      <div
        role="note"
        aria-label="Quién responde"
        data-testid="who-answers"
        data-state="ai"
        className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-brand-tint px-3 py-2 text-[13px] text-brand-text md:px-4"
      >
        <Bot className="h-4 w-4 shrink-0" strokeWidth={1.7} aria-hidden />
        <p className="min-w-0 flex-1 basis-[220px]">
          <strong className="font-semibold">La IA está respondiendo a {name}.</strong> Si vas
          a contestar tú, toma el chat para que no respondan los dos.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(onTakeOver)}
          className={primary}
        >
          {busy ? "Un momento…" : "Atender yo"}
        </button>
      </div>
    );
  }

  if (state.kind === "human") {
    const lead =
      state.who === "me"
        ? "Tú atiendes este chat."
        : state.who === "nobody"
          ? "Nadie ha tomado este chat."
          : `Lo atiende ${state.who.name}.`;
    return (
      <div
        role="note"
        aria-label="Quién responde"
        data-testid="who-answers"
        data-state="human"
        className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-info-tint px-3 py-2 text-[13px] text-info-text md:px-4"
      >
        <UserRound className="h-4 w-4 shrink-0" strokeWidth={1.7} aria-hidden />
        <p className="min-w-0 flex-1 basis-[220px]">
          <strong className="font-semibold">{lead}</strong> La IA está en pausa y no le
          escribirá a {name}.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(onGiveBack)}
          className="shrink-0 rounded-md border border-info-soft bg-background px-3 py-1.5 text-[12.5px] font-medium text-info-text transition-colors hover:bg-accent disabled:opacity-60"
        >
          {busy ? "Un momento…" : "Devolver a la IA"}
        </button>
      </div>
    );
  }

  const client = state.reason === "cliente";
  return (
    <div
      role="note"
      aria-label="Quién responde"
      data-testid="who-answers"
      data-state="handoff"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-warning-tint px-3 py-2.5 text-[13px] text-warning-text md:px-4"
      )}
    >
      <UserRound className="h-4 w-4 shrink-0" strokeWidth={1.7} aria-hidden />
      <p className="flex min-w-0 flex-1 basis-[240px] flex-col gap-0.5">
        <strong className="font-semibold">
          {client
            ? `${name.charAt(0).toLocaleUpperCase("es")}${name.slice(1)} pidió hablar con una persona.`
            : handoffLabel(state.reason)}
        </strong>
        <span>
          {client
            ? "La IA ya le avisó que le responderán por este chat. Contéstale tú."
            : "La IA está en pausa en este chat. Contéstale tú."}
        </span>
      </p>
      <button type="button" onClick={onReply} className={primary}>
        Responder a {name}
      </button>
    </div>
  );
}
