import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal-page";
import { LEGAL } from "@/lib/legal";

export const metadata: Metadata = {
  title: `Términos del servicio — ${LEGAL.productName}`,
  description: `Condiciones de uso de ${LEGAL.productName}, el sistema de atención por WhatsApp, Instagram y Facebook Messenger de ${LEGAL.businessName}.`,
};

export default function TerminosPage() {
  return (
    <LegalPage title="Términos del servicio">
      <p>
        Estos términos regulan el uso de {LEGAL.productName}, operado por{" "}
        <strong>{LEGAL.legalName}</strong>, titular de la marca{" "}
        <strong>{LEGAL.businessName}</strong>. Al comunicarte con el negocio
        por los canales conectados o al usar la plataforma, aceptas estas
        condiciones.
      </p>

      <h2>1. El servicio</h2>
      <p>
        {LEGAL.productName} es un CRM que centraliza las conversaciones del
        negocio por WhatsApp, Instagram y Facebook Messenger, y puede responder
        de forma automatizada mediante inteligencia artificial bajo
        supervisión del equipo humano. Las respuestas automatizadas son
        informativas y pueden contener errores; no constituyen una oferta
        vinculante salvo que un representante del negocio la confirme.
      </p>

      <h2>2. Uso aceptable</h2>
      <ul>
        <li>
          No usar el servicio para spam, fraude, acoso ni contenido ilícito.
        </li>
        <li>
          No intentar acceder sin autorización a la plataforma ni a datos de
          otras personas, ni vulnerar su seguridad.
        </li>
        <li>
          Cumplir los términos y políticas de las plataformas de mensajería
          (Meta, WhatsApp Business, Instagram y Messenger).
        </li>
      </ul>

      <h2>3. Responsabilidades del negocio y de los usuarios</h2>
      <p>
        El negocio es responsable de las comunicaciones que envía, de contar
        con una base legítima para contactar a las personas y de cumplir las
        políticas de Meta, incluida la ventana de atención de 24 horas y el uso
        de plantillas aprobadas. Los usuarios son responsables de la veracidad
        de la información que proporcionan.
      </p>

      <h2>4. Datos personales</h2>
      <p>
        El tratamiento de datos se describe en la{" "}
        <Link href="/privacidad">Política de privacidad</Link>. Puedes
        solicitar la baja de tus datos según{" "}
        <Link href="/eliminacion-datos">Eliminación de datos</Link>.
      </p>

      <h2>5. Propiedad intelectual</h2>
      <p>
        El software, la marca y los contenidos del servicio pertenecen a sus
        titulares. Los mensajes que envías siguen siendo tuyos; nos otorgas el
        permiso necesario para tratarlos con el fin de prestarte atención.
      </p>

      <h2>6. Disponibilidad y limitación de responsabilidad</h2>
      <p>
        El servicio se ofrece “tal cual” y depende de terceros (Meta, el
        proveedor de IA y la infraestructura de alojamiento), por lo que no
        garantizamos disponibilidad ininterrumpida. En la medida permitida por
        la ley, el Responsable no será responsable por daños indirectos ni por
        interrupciones atribuibles a dichos terceros.
      </p>

      <h2>7. Terminación</h2>
      <p>
        Podemos suspender el acceso ante incumplimientos de estos términos.
        Puedes dejar de usar el servicio y pedir la eliminación de tus datos en
        cualquier momento.
      </p>

      <h2>8. Cambios y ley aplicable</h2>
      <p>
        Podemos modificar estos términos publicando la versión vigente aquí. Se
        rigen por las leyes de los Estados Unidos Mexicanos; para su
        interpretación las partes se someten a los tribunales competentes del
        domicilio del Responsable ({LEGAL.address}).
      </p>

      <h2>9. Contacto</h2>
      <p>
        <a href={`mailto:${LEGAL.privacyEmail}`}>{LEGAL.privacyEmail}</a>
      </p>
    </LegalPage>
  );
}
