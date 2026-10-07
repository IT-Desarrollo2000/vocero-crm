import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal-page";
import { LEGAL } from "@/lib/legal";

export const metadata: Metadata = {
  title: `Política de privacidad — ${LEGAL.productName}`,
  description: `Cómo ${LEGAL.productName} trata los datos personales de quienes escriben por WhatsApp, Instagram y Facebook Messenger, y cómo ejercer tus derechos ARCO.`,
};

export default function PrivacidadPage() {
  return (
    <LegalPage title="Política de privacidad">
      <p>
        {LEGAL.productName} es un sistema de atención a clientes (CRM) operado
        por <strong>{LEGAL.legalName}</strong>, para el negocio{" "}
        <strong>{LEGAL.businessName}</strong>, con domicilio en {LEGAL.address}{" "}
        (en adelante, “el Responsable”). Esta política explica cómo se tratan
        los datos personales de las personas que se comunican con el negocio
        por WhatsApp, Instagram o Facebook Messenger, conforme a la Ley Federal
        de Protección de Datos Personales en Posesión de los Particulares
        (LFPDPPP) de México.
      </p>

      <h2>1. Datos que se tratan</h2>
      <ul>
        <li>Nombre de perfil que tu cuenta tiene en el canal.</li>
        <li>
          Identificador de contacto: número de WhatsApp o identificador de
          cuenta de Instagram o Facebook Messenger (en algunos casos Meta
          entrega un identificador en lugar del teléfono).
        </li>
        <li>
          Contenido de los mensajes que envías y recibes, incluidos adjuntos
          (imágenes, audio, documentos).
        </li>
        <li>
          Metadatos de entrega: fecha y hora, estado de envío, entrega y
          lectura.
        </li>
        <li>
          Notas, etiquetas y datos comerciales que el equipo del negocio
          registre sobre la conversación (por ejemplo, interés en un vehículo).
        </li>
      </ul>
      <p>
        No solicitamos datos personales sensibles. Te pedimos no compartirlos
        por chat.
      </p>

      <h2>2. Finalidades</h2>
      <ul>
        <li>
          Atender tus consultas y dar seguimiento comercial a tu solicitud.
        </li>
        <li>
          Generar respuestas automatizadas mediante inteligencia artificial,
          que el negocio configura y supervisa; el equipo humano puede revisar
          la conversación e intervenir en cualquier momento.
        </li>
        <li>
          Mantener el historial de la conversación, medir la calidad de la
          atención y cumplir obligaciones legales.
        </li>
      </ul>
      <p>
        No vendemos tus datos ni los usamos para fines distintos a los
        anteriores.
      </p>

      <h2>3. Con quién se comparten</h2>
      <ul>
        <li>
          <strong>Meta Platforms, Inc.</strong> (WhatsApp, Instagram,
          Messenger), como proveedor del canal por el que te comunicas. El uso
          de los datos de la Plataforma de Meta se rige por los{" "}
          <a
            href="https://developers.facebook.com/terms"
            rel="noopener noreferrer"
            target="_blank"
          >
            Términos de la Plataforma de Meta
          </a>{" "}
          y sus políticas para desarrolladores; los datos recibidos de Meta se
          usan solo para prestar el servicio de atención descrito aquí.
        </li>
        <li>
          Un <strong>proveedor de modelos de IA</strong>, consumido por API, al
          que se envía el contenido necesario de la conversación para generar
          una respuesta.
        </li>
        <li>
          Un proveedor de <strong>base de datos alojada</strong> donde se
          almacena la información del sistema.
        </li>
        <li>Autoridades, cuando exista un mandato legal.</li>
      </ul>
      <p>
        Estos proveedores pueden estar ubicados fuera de México; las
        transferencias se limitan a lo necesario para operar el servicio.
      </p>

      <h2>4. Conservación</h2>
      <p>
        Conservamos las conversaciones mientras sea necesario para las
        finalidades descritas y por los plazos que exija la ley. Puedes pedir
        su eliminación en cualquier momento (ver{" "}
        <Link href="/eliminacion-datos">Eliminación de datos</Link>).
      </p>

      <h2>5. Seguridad</h2>
      <p>
        Las credenciales de integración (por ejemplo, tokens de Meta) se
        almacenan cifradas en reposo y no se exponen en la interfaz ni en
        registros. Los datos de cada negocio están aislados lógicamente y el
        acceso requiere autenticación. Ningún sistema es infalible, pero
        aplicamos medidas administrativas, técnicas y físicas razonables.
      </p>

      <h2>6. Derechos ARCO</h2>
      <p>
        Tienes derecho a <strong>Acceder</strong> a tus datos,{" "}
        <strong>Rectificarlos</strong>, <strong>Cancelarlos</strong> y{" "}
        <strong>Oponerte</strong> a su tratamiento, así como a revocar tu
        consentimiento. Para ejercerlos, escribe a{" "}
        <a href={`mailto:${LEGAL.privacyEmail}`}>{LEGAL.privacyEmail}</a>{" "}
        indicando tu nombre, el canal, el identificador (número o cuenta) con
        que nos contactaste y el derecho que deseas ejercer. Responderemos en
        un máximo de 20 días hábiles. Si consideras vulnerado tu derecho,
        puedes acudir a la autoridad competente en materia de protección de
        datos personales.
      </p>

      <h2>7. Cambios a esta política</h2>
      <p>
        Podemos actualizar esta política; publicaremos la versión vigente en
        esta misma dirección con su fecha de última actualización.
      </p>

      <h2>8. Contacto</h2>
      <p>
        {LEGAL.legalName} — {LEGAL.address} —{" "}
        <a href={`mailto:${LEGAL.privacyEmail}`}>{LEGAL.privacyEmail}</a>.
      </p>
    </LegalPage>
  );
}
