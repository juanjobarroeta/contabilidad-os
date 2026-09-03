import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Autorización de uso de la e.firma | ContabilidadOS",
  description:
    "Términos bajo los cuales el usuario autoriza a ContabilidadOS a usar la e.firma (FIEL) de una empresa exclusivamente para autenticarse ante el SAT y descargar su información fiscal.",
};

/**
 * Autorización de uso de la e.firma. Se acepta POR EMPRESA cada vez que se
 * carga o reemplaza la e.firma (onboarding y Configuración → Empresa); la
 * evidencia queda en LegalAcceptance con documento MANDATO_EFIRMA.
 *
 * Versión vigente: src/lib/legal/documentos.ts (MANDATO_EFIRMA.version). Al
 * cambiar el texto de forma sustancial, actualizar la fecha aquí y allá.
 *
 * BORRADOR PARA REVISIÓN LEGAL (2026-09-03): redactado como punto de partida;
 * un abogado debe validar el alcance del mandato, la referencia al CFF y la
 * distribución de responsabilidad antes de considerarlo definitivo.
 */
export default function MandatoEfirmaPage() {
  return (
    <>
      <h1>Autorización de uso de la e.firma</h1>
      <p className="text-cos-ink-faint">
        Última actualización: 3 de septiembre de 2026
      </p>

      <p>
        Este documento establece los términos bajo los cuales usted (el
        «Usuario») autoriza a ContabilidadOS, operada por Juan José Barroeta
        Huerta (el «Proveedor»), a resguardar y utilizar la firma electrónica
        avanzada (e.firma, antes FIEL) de la empresa o persona contribuyente
        que usted registra en la Plataforma (el «Contribuyente»). Forma parte
        de los <Link href="/legal/terminos">Términos y Condiciones</Link> y se
        acepta de manera expresa, por cada Contribuyente, al cargar o
        reemplazar su e.firma.
      </p>

      <h2>1. Naturaleza de la e.firma y declaraciones del Usuario</h2>
      <p>
        La e.firma es un medio de identificación personal e intransferible
        que, conforme al Código Fiscal de la Federación, produce los mismos
        efectos que la firma autógrafa de su titular, quien es responsable de
        su resguardo y de los actos realizados con ella. Al cargar la e.firma
        de un Contribuyente, el Usuario declara bajo protesta de decir verdad
        que:
      </p>
      <ul>
        <li>
          Es el titular de la e.firma, o cuenta con facultades suficientes
          (representante legal, apoderado o persona expresamente autorizada
          por escrito por el titular) para entregarla en resguardo y autorizar
          su uso en los términos de este documento.
        </li>
        <li>
          Si actúa por cuenta de un tercero (por ejemplo, como despacho
          contable), conserva la autorización escrita de ese tercero y la
          exhibirá al Proveedor cuando se lo solicite.
        </li>
        <li>
          Ha informado al titular de la e.firma del alcance de esta
          autorización y de las medidas de resguardo descritas más adelante.
        </li>
      </ul>

      <h2>2. Alcance de la autorización</h2>
      <p>
        El Usuario autoriza al Proveedor a utilizar la e.firma del
        Contribuyente <strong>única y exclusivamente</strong> para:
      </p>
      <ul>
        <li>
          Autenticarse ante los servicios electrónicos del Servicio de
          Administración Tributaria (SAT) con el fin de solicitar y descargar
          los comprobantes fiscales digitales (CFDI) emitidos y recibidos por
          el Contribuyente y sus metadatos, mediante el servicio de descarga
          masiva del SAT.
        </li>
        <li>
          Consultar, directamente o a través de los proveedores señalados en
          el <Link href="/legal/aviso-de-privacidad">Aviso de Privacidad</Link>,
          información fiscal del Contribuyente de carácter consultivo: opinión
          de cumplimiento, constancia de situación fiscal, declaraciones
          presentadas y acuses, y estatus de los CFDI.
        </li>
        <li>
          Verificar la vigencia del certificado para avisar al Usuario de su
          próximo vencimiento.
        </li>
      </ul>

      <h2>3. Usos expresamente NO autorizados</h2>
      <p>
        Esta autorización <strong>no</strong> faculta al Proveedor, y el
        Proveedor se obliga a no utilizar la e.firma del Contribuyente, para:
      </p>
      <ul>
        <li>
          Firmar, sellar, presentar o enviar declaraciones, contabilidad
          electrónica, avisos, solicitudes, trámites o cualquier promoción
          ante el SAT u otra autoridad.
        </li>
        <li>
          Firmar contratos, convenios, documentos o manifestaciones de
          voluntad de cualquier naturaleza a nombre del Contribuyente.
        </li>
        <li>
          Realizar actos ante instituciones financieras, notarios, el IMSS,
          el Infonavit u otras entidades, o registrar o modificar datos del
          Contribuyente ante cualquier autoridad.
        </li>
        <li>
          Ceder, compartir, exportar o transmitir la e.firma a terceros, salvo
          la transmisión cifrada estrictamente necesaria a los proveedores
          señalados en el Aviso de Privacidad para las finalidades del
          apartado 2.
        </li>
      </ul>
      <p>
        La emisión de CFDI (timbrado) no se realiza con la e.firma sino con el
        Certificado de Sello Digital (CSD) que el Usuario carga por separado y
        cuyo uso se rige por los Términos y Condiciones y por la Carta
        Manifiesto del proveedor de certificación.
      </p>

      <h2>4. Resguardo y seguridad</h2>
      <ul>
        <li>
          El certificado, la llave privada y la contraseña se almacenan
          cifrados en reposo (AES-256-GCM) con una llave de cifrado separada de
          la base de datos, y sólo se descifran en memoria durante el tiempo
          necesario para las operaciones autorizadas.
        </li>
        <li>
          La e.firma nunca se muestra, descarga ni exporta desde la Plataforma,
          ni siquiera al propio Usuario.
        </li>
        <li>
          Toda carga, reemplazo o eliminación de la e.firma queda registrada en
          la bitácora de seguridad de la empresa (fecha, usuario e IP), sin
          incluir el contenido de la credencial.
        </li>
        <li>
          El Proveedor notificará al Usuario, sin dilación indebida, cualquier
          vulneración de seguridad que afecte o pueda afectar la e.firma, para
          que el titular pueda revocarla ante el SAT.
        </li>
      </ul>

      <h2>5. Vigencia y revocación</h2>
      <p>
        Esta autorización surte efectos desde su aceptación y se mantiene
        mientras la e.firma permanezca cargada en la Plataforma. El Usuario
        puede revocarla en cualquier momento eliminando la e.firma desde la
        configuración de la empresa o dando de baja la empresa; el Proveedor
        eliminará la credencial de sus sistemas y suspenderá las operaciones
        que dependan de ella. Con independencia de lo anterior, el titular
        puede revocar en todo momento su certificado directamente ante el
        SAT.
      </p>

      <h2>6. Responsabilidad</h2>
      <ul>
        <li>
          El Proveedor responde por el uso de la e.firma fuera del alcance
          autorizado en este documento y por el incumplimiento de las medidas
          de resguardo descritas, en los términos y con los límites de los
          Términos y Condiciones.
        </li>
        <li>
          El Usuario responde por la veracidad de sus declaraciones del
          apartado 1, por el uso de la e.firma fuera de la Plataforma y por
          cualquier reclamación del titular o de terceros derivada de haber
          cargado una e.firma sin facultades para ello.
        </li>
        <li>
          El Proveedor no es responsable por la indisponibilidad de los
          servicios del SAT ni por las consecuencias fiscales de la información
          descargada, cuya revisión corresponde al Contribuyente o a su
          contador.
        </li>
      </ul>

      <h2>7. Evidencia de la aceptación</h2>
      <p>
        El Proveedor conserva registro de cada aceptación de este documento
        (usuario, empresa, versión aceptada, fecha y hora, dirección IP y
        navegador) como evidencia de la autorización otorgada. Dicho registro
        se conserva incluso después de la baja de la empresa o de la cuenta,
        por el tiempo necesario para la defensa de reclamaciones.
      </p>

      <p className="pt-4">
        Consulte también los{" "}
        <Link href="/legal/terminos">Términos y Condiciones</Link> y el{" "}
        <Link href="/legal/aviso-de-privacidad">Aviso de Privacidad</Link>.
      </p>
    </>
  );
}
