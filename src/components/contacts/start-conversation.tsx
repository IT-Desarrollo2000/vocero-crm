"use client";

import { displayFirstName } from "@/lib/template-fill";
import {
  NoTemplatesNotice,
  TemplateSteps,
  templateSendFailure,
  type TemplateSendOptions,
  type TemplateSendResult,
} from "@/components/inbox/template-sender";

/**
 * Abrir conversación con quien nunca ha escrito.
 *
 * WhatsApp obliga a usar una plantilla aprobada para escribir primero; no es
 * una decisión del CRM. 032: con los mismos tres pasos que la Bandeja usa
 * para retomar un chat (`TemplateSteps`), en vez de un selector con el nombre
 * técnico de la plantilla y campos «Valor de {{1}}». Si la ventana de 24 h
 * está abierta, la fila de Contactos ofrece «Abrir chat» y este panel ni se
 * muestra: gastar una plantilla ahí sería tirar dinero (la ruta lo rechaza
 * igual con `window_open`).
 */
export function StartConversation({
  contactId,
  contactName,
  onStarted,
}: {
  contactId: string;
  contactName: string;
  onStarted: (conversationId: string) => void;
}) {
  const name = displayFirstName(contactName);

  async function send(
    templateId: string,
    variables: string[] | undefined,
    options?: TemplateSendOptions
  ): Promise<TemplateSendResult> {
    const res = await fetch(`/api/contacts/${contactId}/start-conversation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateId, variables, ...(options?.force ? { force: true } : {}) }),
    }).catch(() => null);
    if (!res) return { ok: false, message: "Sin conexión con el servidor. Intenta de nuevo." };
    const data = (await res.json().catch(() => null)) as
      | { error?: { code?: string; message?: string }; conversationId?: string }
      | null;
    if (!res.ok) {
      // El fallo de Meta se explica aquí mismo (plantilla en pausa, número
      // que no la recibe, ventana abierta, chat de otro vendedor…). 033: si
      // el mismo mensaje acaba de salir, el formulario pide confirmar.
      return templateSendFailure(data, "No se pudo enviar el mensaje");
    }
    return { ok: true, conversationId: data?.conversationId };
  }

  return (
    <TemplateSteps
      groupName={`first-template-${contactId}`}
      idPrefix="first-template"
      contactName={contactName}
      headingId="primero-titulo"
      testId="first-message"
      submitLabel="Enviar y abrir el chat"
      header={
        <div className="space-y-1">
          <h2 id="primero-titulo" className="text-[15px] font-semibold leading-snug">
            Escribirle a {name ?? "este cliente"} por primera vez
          </h2>
          <p className="text-[13.5px] text-text-2">
            WhatsApp solo deja iniciar con un mensaje aprobado. Cuando{" "}
            {name ?? "el cliente"} te conteste, podrás escribir normal.
          </p>
        </div>
      }
      emptyState={
        <NoTemplatesNotice
          firstContact
          title="Todavía no puedes escribirle primero"
          intro={`${name ?? "Esta persona"} nunca te ha escrito, así que WhatsApp solo deja contactarla con un mensaje aprobado (plantilla).`}
          contactName={contactName}
        />
      }
      send={send}
      onSent={(conversationId) => onStarted(conversationId ?? "")}
    />
  );
}
