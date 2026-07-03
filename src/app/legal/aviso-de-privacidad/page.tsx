import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Aviso de Privacidad | ContabilidadOS",
  description:
    "Aviso de privacidad integral de ContabilidadOS conforme a la Ley Federal de Protección de Datos Personales en Posesión de los Particulares (LFPDPPP).",
};

/**
 * Aviso de privacidad integral conforme a los artículos 15 a 17 de la LFPDPPP.
 * Los textos marcados «[COMPLETAR: …]» son datos del responsable que el
 * titular de la operación debe llenar antes de publicar en producción.
 */
export default function AvisoDePrivacidadPage() {
  return (
    <>
      <h1>Aviso de Privacidad</h1>
      <p className="text-cos-ink-faint">
        Última actualización: «[COMPLETAR: fecha]»
      </p>

      <p>
        El presente aviso de privacidad se emite en cumplimiento de la Ley
        Federal de Protección de Datos Personales en Posesión de los
        Particulares (en adelante, la «LFPDPPP»), su Reglamento y los
        Lineamientos del Aviso de Privacidad, y aplica al tratamiento de datos
        personales realizado a través de la plataforma ContabilidadOS (en
        adelante, la «Plataforma»).
      </p>

      <h2>1. Identidad y domicilio del responsable</h2>
      <p>
        «[COMPLETAR: razón social]» (en adelante, el «Responsable»), con
        domicilio en «[COMPLETAR: domicilio]», es responsable del tratamiento
        de sus datos personales conforme a este aviso. Para cualquier tema
        relacionado con la protección de sus datos personales puede
        contactarnos en el correo electrónico «[COMPLETAR: correo]».
      </p>

      <h2>2. Datos personales que recabamos</h2>
      <p>
        Para las finalidades descritas en este aviso, el Responsable recaba y
        trata las siguientes categorías de datos personales, proporcionados
        directamente por usted, generados por el uso de la Plataforma u
        obtenidos de las fuentes que usted autoriza conectar:
      </p>
      <ul>
        <li>
          <strong>Datos de identificación y contacto:</strong> nombre, correo
          electrónico, contraseña de acceso (almacenada de forma cifrada
          mediante hash) y, en su caso, número telefónico vinculado a WhatsApp.
        </li>
        <li>
          <strong>Datos fiscales:</strong> Registro Federal de Contribuyentes
          (RFC), constancia de situación fiscal, régimen fiscal, domicilio
          fiscal y demás información fiscal de las empresas que usted registra
          en la Plataforma.
        </li>
        <li>
          <strong>Credenciales fiscales:</strong> certificados y llaves
          privadas de la firma electrónica avanzada (e.firma, antes FIEL) y de
          los Certificados de Sello Digital (CSD), junto con sus contraseñas.
          Estas credenciales se almacenan cifradas en reposo mediante el
          algoritmo AES-256-GCM y se utilizan exclusivamente para las
          finalidades primarias descritas en este aviso.
        </li>
        <li>
          <strong>Datos bancarios y movimientos:</strong> estados de cuenta,
          CLABE interbancaria, saldos y movimientos bancarios de las cuentas
          que usted registra o conecta a la Plataforma.
        </li>
        <li>
          <strong>Datos de nómina:</strong> información de los empleados de
          las empresas administradas en la Plataforma (por ejemplo, nombre,
          RFC, salario y percepciones), la cual es tratada por el Responsable
          por cuenta y bajo las instrucciones del cliente titular de la cuenta,
          en calidad de encargado del tratamiento.
        </li>
        <li>
          <strong>Comprobantes fiscales:</strong> CFDIs emitidos y recibidos
          descargados del Servicio de Administración Tributaria (SAT) mediante
          los mecanismos que usted autoriza.
        </li>
      </ul>
      <p>
        El Responsable no recaba deliberadamente datos personales sensibles en
        los términos del artículo 3, fracción VI de la LFPDPPP.
      </p>

      <h2>3. Finalidades del tratamiento</h2>
      <h3>Finalidades primarias</h3>
      <p>
        Sus datos personales serán utilizados para las siguientes finalidades,
        necesarias para la existencia y cumplimiento de la relación jurídica
        entre usted y el Responsable:
      </p>
      <ul>
        <li>Crear y administrar su cuenta y las empresas registradas en la Plataforma.</li>
        <li>
          Sincronizar y descargar su información fiscal del SAT (CFDIs,
          declaraciones y constancias) mediante las credenciales que usted
          proporciona.
        </li>
        <li>Calcular impuestos y apoyar la preparación de declaraciones fiscales.</li>
        <li>Realizar la conciliación bancaria de las cuentas registradas.</li>
        <li>Emitir CFDIs (timbrado) a nombre de las empresas que usted administra.</li>
        <li>Gestionar la nómina de los empleados de las empresas administradas.</li>
        <li>Atender sus solicitudes de soporte y comunicaciones operativas del servicio.</li>
        <li>Facturar y cobrar el servicio contratado.</li>
      </ul>
      <h3>Finalidades secundarias</h3>
      <p>
        De manera adicional, sus datos podrán utilizarse para las siguientes
        finalidades que no son necesarias para la prestación del servicio:
      </p>
      <ul>
        <li>Mejorar el producto, sus funcionalidades y la experiencia de uso.</li>
        <li>
          Enviarle notificaciones y avisos sobre novedades o recordatorios de
          la Plataforma.
        </li>
      </ul>
      <p>
        Si usted no desea que sus datos personales sean tratados para las
        finalidades secundarias, puede manifestar su negativa en cualquier
        momento enviando un correo a «[COMPLETAR: correo]». La negativa al
        tratamiento para finalidades secundarias no será motivo para negarle
        el servicio.
      </p>

      <h2>4. Transferencias y encargados del tratamiento</h2>
      <p>
        Para prestar el servicio, el Responsable se apoya en proveedores que
        actúan como encargados del tratamiento y que únicamente tratan los
        datos conforme a nuestras instrucciones:
      </p>
      <ul>
        <li>
          <strong>Procesamiento de documentos e inteligencia artificial:</strong>{" "}
          Anthropic PBC (Estados Unidos de América), para el procesamiento
          automatizado de documentos y funciones de asistencia; y OpenAI
          (Estados Unidos de América), para la transcripción de notas de voz
          recibidas por WhatsApp y funciones de búsqueda.
        </li>
        <li>
          <strong>Timbrado de CFDI:</strong> Facturapi, proveedor de
          certificación autorizado para la emisión de comprobantes fiscales.
        </li>
        <li>
          <strong>Mensajería por WhatsApp:</strong> Twilio Inc. y Meta
          Platforms, Inc., cuando usted vincula su número y utiliza el canal
          de WhatsApp.
        </li>
        <li>
          <strong>Agregación bancaria:</strong> Belvo, cuando usted conecta
          sus cuentas bancarias para la sincronización de movimientos.
        </li>
        <li>
          <strong>Datos fiscales del SAT:</strong> Syntage, proveedor de
          descarga y sincronización de información fiscal ante el SAT.
        </li>
        <li>
          <strong>Infraestructura de hospedaje y base de datos:</strong>{" "}
          Railway Corp. (Estados Unidos de América).
        </li>
      </ul>
      <p>
        Algunas de estas transferencias implican que sus datos se alojen o
        procesen fuera de los Estados Unidos Mexicanos. En todos los casos, el
        Responsable exige a sus encargados condiciones de tratamiento
        equivalentes a las de este aviso. Fuera de los supuestos anteriores y
        de los previstos en el artículo 37 de la LFPDPPP (por ejemplo,
        requerimientos de autoridad competente), sus datos no serán
        transferidos a terceros sin su consentimiento.{" "}
        <strong>El Responsable no vende datos personales.</strong>
      </p>

      <h2>5. Derechos ARCO</h2>
      <p>
        Usted tiene derecho a conocer qué datos personales tenemos de usted,
        para qué los utilizamos y las condiciones de su uso (Acceso); a
        solicitar la corrección de su información cuando sea inexacta o esté
        desactualizada (Rectificación); a que la eliminemos de nuestros
        registros cuando considere que no está siendo utilizada conforme a la
        ley (Cancelación); así como a oponerse al uso de sus datos para fines
        específicos (Oposición). Estos derechos se conocen como derechos ARCO.
      </p>
      <p>
        Para ejercer cualquiera de los derechos ARCO, envíe una solicitud al
        correo «[COMPLETAR: correo]» indicando: (i) su nombre y un medio para
        comunicarle la respuesta; (ii) los documentos que acrediten su
        identidad o, en su caso, la representación legal del titular; (iii) la
        descripción clara y precisa de los datos respecto de los que busca
        ejercer alguno de los derechos; y (iv) cualquier otro elemento que
        facilite la localización de los datos. El Responsable comunicará la
        determinación adoptada en los plazos previstos por la LFPDPPP.
      </p>

      <h2>6. Revocación del consentimiento y limitación de uso</h2>
      <p>
        Usted puede revocar en cualquier momento el consentimiento que nos
        haya otorgado para el tratamiento de sus datos personales, así como
        solicitar la limitación de su uso o divulgación, mediante solicitud al
        correo «[COMPLETAR: correo]». Tome en cuenta que la revocación puede
        implicar que no podamos seguir prestándole el servicio, y que ciertos
        tratamientos deberán continuar mientras subsistan obligaciones legales
        que lo exijan.
      </p>

      <h2>7. Conservación y medidas de seguridad</h2>
      <p>
        El Responsable ha implementado medidas de seguridad administrativas,
        técnicas y físicas para proteger sus datos personales contra daño,
        pérdida, alteración, destrucción o el uso, acceso o tratamiento no
        autorizado. En particular:
      </p>
      <ul>
        <li>
          Las credenciales fiscales (llaves privadas de e.firma y CSD y sus
          contraseñas) se almacenan cifradas en reposo mediante AES-256-GCM.
        </li>
        <li>
          El acceso a la información está restringido por empresa: cada
          usuario únicamente puede consultar los datos de las empresas a las
          que tiene acceso autorizado.
        </li>
      </ul>
      <p>
        Los datos personales se conservarán durante el tiempo necesario para
        cumplir con las finalidades descritas y con las obligaciones legales
        aplicables, incluidos los plazos de conservación en materia fiscal.
      </p>

      <h2>8. Cookies y almacenamiento local</h2>
      <p>
        La Plataforma utiliza cookies y mecanismos de almacenamiento local del
        navegador limitados al funcionamiento de su sesión (autenticación y
        preferencias de la interfaz, como el tema visual). No utilizamos
        cookies de publicidad ni de rastreo de terceros.
      </p>

      <h2>9. Cambios al aviso de privacidad</h2>
      <p>
        El presente aviso puede sufrir modificaciones, cambios o
        actualizaciones derivadas de nuevos requerimientos legales, de
        necesidades propias del servicio o de cambios en nuestras prácticas de
        privacidad. Cualquier modificación será publicada en esta misma página
        y, cuando implique cambios sustanciales al tratamiento, se lo
        comunicaremos a través de la Plataforma o del correo electrónico
        registrado en su cuenta.
      </p>

      <p className="pt-4">
        Consulte también nuestros{" "}
        <Link href="/legal/terminos">Términos y Condiciones</Link>.
      </p>
    </>
  );
}
