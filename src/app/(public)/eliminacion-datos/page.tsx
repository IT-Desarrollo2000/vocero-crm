import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal-page";
import { LEGAL } from "@/lib/legal";
import { CONFIRMATION_CODE_RE } from "@/server/meta/data-deletion";

export const metadata: Metadata = {
  title: `Eliminación de datos — ${LEGAL.productName}`,
  description: `Cómo solicitar la eliminación de tus datos personales en ${LEGAL.productName} (WhatsApp, Instagram y Facebook Messenger).`,
};

export default async function EliminacionDatosPage({
  searchParams,
}: {
  searchParams: Promise<{ codigo?: string | string[] }>;
}) {
  const { codigo } = await searchParams;
  // Solo se muestra un código con el formato que emite el callback de Meta.
  const code =
    typeof codigo === "string" && CONFIRMATION_CODE_RE.test(codigo)
      ? codigo
      : null;
  const subject = encodeURIComponent("Eliminación de datos");
  return (
    <LegalPage title="Eliminación de datos">
      {code && (
        <p>
          <strong>Recibimos tu solicitud.</strong> Código de confirmación:{" "}
          <strong>{code}</strong>. La atenderemos en un máximo de{" "}
          {LEGAL.deletionDays} días naturales; para darle seguimiento escribe a{" "}
          <a
            href={`mailto:${LEGAL.privacyEmail}?subject=${encodeURIComponent(`Eliminación de datos ${code}`)}`}
          >
            {LEGAL.privacyEmail}
          </a>{" "}
          con ese código.
        </p>
      )}
      <p>
        Puedes pedir en cualquier momento que eliminemos los datos personales
        asociados a tu cuenta de WhatsApp, Instagram o Facebook Messenger que
        tratamos en {LEGAL.productName}.
      </p>

      <h2>Cómo solicitarla</h2>
      <ol>
        <li>
          <strong>Por correo:</strong> escribe a{" "}
          <a href={`mailto:${LEGAL.privacyEmail}?subject=${subject}`}>
            {LEGAL.privacyEmail}
          </a>{" "}
          con el asunto <strong>“Eliminación de datos”</strong>, indicando tu
          nombre, el canal (WhatsApp, Instagram o Messenger) y el número o
          nombre de cuenta con el que nos escribiste.
        </li>
        <li>
          <strong>Por el mismo canal:</strong> envía el mensaje{" "}
          <strong>“{LEGAL.deletionPhrase}”</strong> a la cuenta del negocio
          desde la cuenta cuyos datos quieres eliminar.
        </li>
      </ol>

      <h2>Qué se elimina</h2>
      <ul>
        <li>
          Tu contacto: nombre de perfil e identificador (número o ID de
          cuenta).
        </li>
        <li>El historial de conversaciones y los adjuntos asociados.</li>
        <li>Notas y etiquetas comerciales vinculadas a tu contacto.</li>
      </ul>
      <p>
        Podemos conservar de forma limitada la información que una ley nos
        obligue a guardar, por el tiempo que esa ley exija. Las copias de
        seguridad se depuran en su ciclo normal de rotación.
      </p>

      <h2>Plazo y confirmación</h2>
      <p>
        Atenderemos tu solicitud en un máximo de{" "}
        <strong>{LEGAL.deletionDays} días</strong> naturales. Te confirmaremos
        la eliminación por el mismo medio por el que la solicitaste. Podemos
        pedirte datos adicionales para verificar que eres titular de la cuenta.
      </p>

      <h2>Más información</h2>
      <p>
        Consulta la <Link href="/privacidad">Política de privacidad</Link>,
        donde también se explican tus derechos ARCO, y los{" "}
        <Link href="/terminos">Términos del servicio</Link>.
      </p>
    </LegalPage>
  );
}
