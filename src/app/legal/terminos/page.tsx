import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Términos y Condiciones | ContabilidadOS",
  description:
    "Términos y condiciones de uso de la plataforma ContabilidadOS, sistema contable y fiscal para empresas mexicanas.",
};

/**
 * Términos y condiciones de uso de la Plataforma. Datos del responsable y
 * condiciones comerciales llenados el 2026-07-03 (persona física; actualizar
 * cuando la operación migre a una sociedad).
 *
 * Versión vigente: src/lib/legal/documentos.ts (TERMINOS.version). Al cambiar
 * el texto de forma sustancial, actualizar la fecha aquí y allá: eso obliga a
 * los usuarios existentes a volver a aceptar (AceptacionLegalGate).
 *
 * BORRADOR PARA REVISIÓN LEGAL (2026-09-03): las secciones 3, 4, 9, 10, 11 y
 * 12 se añadieron o reescribieron como punto de partida (uso de e.firma y
 * CSD, despachos, indemnización, límite de responsabilidad, tratamiento de
 * datos por cuenta del cliente, servicios de terceros). Un abogado debe
 * validarlas —en particular el límite de responsabilidad y la indemnización
 * frente a la legislación de protección al consumidor— antes de considerarlas
 * definitivas.
 */
export default function TerminosPage() {
  return (
    <>
      <h1>Términos y Condiciones</h1>
      <p className="text-cos-ink-faint">
        Última actualización: 3 de septiembre de 2026
      </p>

      <p>
        Los presentes términos y condiciones (los «Términos») regulan el
        acceso y uso de la plataforma ContabilidadOS (la «Plataforma»),
        operada por Juan José Barroeta Huerta (el «Proveedor»). Al crear una
        cuenta o utilizar la Plataforma, usted (el «Usuario») acepta quedar
        obligado por estos Términos. Si no está de acuerdo con ellos, deberá
        abstenerse de utilizar la Plataforma.
      </p>
      <p>
        La Plataforma está dirigida a empresas, personas físicas con actividad
        empresarial o profesional y despachos contables, para su uso en el
        ejercicio de dichas actividades. El Usuario declara que la contrata
        con ese carácter.
      </p>

      <h2>1. Descripción del servicio</h2>
      <p>
        ContabilidadOS es una plataforma en línea de apoyo contable y fiscal
        para empresas mexicanas que ofrece, entre otras funciones: la
        sincronización de información fiscal con el Servicio de Administración
        Tributaria (SAT), la descarga y organización de CFDIs emitidos y
        recibidos, el cálculo estimado de impuestos, la conciliación bancaria,
        la emisión de CFDIs (timbrado) y la gestión de nómina. Las
        funcionalidades disponibles pueden variar según el plan contratado.
      </p>

      <h2>2. Cuentas y responsabilidad del Usuario</h2>
      <ul>
        <li>
          Para utilizar la Plataforma, el Usuario debe crear una cuenta con
          información veraz, completa y actualizada, y mantenerla así durante
          la vigencia del servicio.
        </li>
        <li>
          El Usuario es responsable de la confidencialidad de sus credenciales
          de acceso y de toda actividad realizada desde su cuenta, incluida la
          de las personas que invite a ella. Deberá notificar de inmediato al
          Proveedor cualquier uso no autorizado.
        </li>
        <li>
          El Usuario declara contar con las facultades y autorizaciones
          necesarias respecto de las empresas que registra en la Plataforma,
          incluidas las credenciales fiscales (e.firma y CSD), las cuentas
          bancarias y los datos de nómina de empleados que incorpora o conecta.
        </li>
        <li>
          El Usuario se obliga a utilizar la Plataforma conforme a la
          legislación aplicable y a abstenerse de usarla para fines ilícitos,
          de intentar vulnerar su seguridad o de acceder a información de
          terceros sin autorización.
        </li>
      </ul>

      <h2>3. Credenciales fiscales: e.firma y CSD</h2>
      <ul>
        <li>
          El uso que el Proveedor hace de la e.firma de cada empresa se limita
          a lo previsto en la{" "}
          <Link href="/legal/mandato-efirma">Autorización de uso de la e.firma</Link>,
          que el Usuario acepta de manera expresa por cada empresa al cargarla
          y que forma parte de estos Términos. El Proveedor no presenta
          declaraciones ni realiza trámites ante el SAT a nombre del
          Contribuyente.
        </li>
        <li>
          El Certificado de Sello Digital (CSD) se utiliza exclusivamente para
          la emisión de CFDI que el Usuario ordena desde la Plataforma, a
          través de un proveedor de certificación autorizado por el SAT. El
          Usuario es responsable del contenido de cada CFDI que ordena emitir
          o cancelar, y de firmar ante dicho proveedor la carta manifiesto que
          la normativa exige.
        </li>
        <li>
          El Usuario puede eliminar sus credenciales fiscales de la Plataforma
          en cualquier momento desde la configuración de la empresa.
        </li>
      </ul>

      <h2>4. Despachos y uso por cuenta de terceros</h2>
      <p>
        Cuando el Usuario registra empresas de terceros (por ejemplo, como
        despacho contable o representante), declara y garantiza que cuenta con
        la autorización escrita de cada uno de esos terceros para incorporar
        su información, sus credenciales fiscales y los datos personales de su
        personal a la Plataforma, y para instruir al Proveedor su tratamiento
        conforme a estos Términos. El Usuario conservará dichas autorizaciones
        y las exhibirá al Proveedor cuando se lo solicite. El Usuario responde
        frente al Proveedor por cualquier reclamación de esos terceros o de su
        personal derivada de la falta o insuficiencia de dicha autorización.
      </p>

      <h2>5. Limitación de responsabilidad fiscal y de los resultados</h2>
      <p>
        <strong>
          La Plataforma es una herramienta de apoyo. Los cálculos de
          impuestos, las declaraciones y, en general, el cumplimiento de las
          obligaciones fiscales son responsabilidad exclusiva del
          contribuyente y/o de su contador.
        </strong>{" "}
        La información, cifras, estimaciones y documentos generados por la
        Plataforma tienen carácter informativo y de apoyo, y deben ser
        revisados y validados por el contribuyente o por un profesional en la
        materia antes de su presentación ante cualquier autoridad.
      </p>
      <p>
        El servicio no constituye asesoría fiscal, contable ni legal, y no
        sustituye la intervención de un contador público o asesor fiscal. El
        Proveedor no será responsable de multas, recargos, actualizaciones,
        diferencias de impuestos ni de cualquier otra consecuencia derivada de
        la información presentada por el Usuario ante las autoridades, de
        errores u omisiones en la información proporcionada por el Usuario o
        por terceros (incluido el SAT y las instituciones bancarias), ni del
        uso que el Usuario dé a los resultados de la Plataforma.
      </p>
      <p>
        Algunas funciones de la Plataforma (lectura de documentos,
        clasificación de operaciones, asistente conversacional) utilizan
        modelos de inteligencia artificial que pueden producir resultados
        incompletos o inexactos. Dichos resultados se presentan como
        sugerencias y no surten efectos hasta que el Usuario los revisa y
        confirma.
      </p>

      <h2>6. Planes y pagos</h2>
      <ul>
        <li>
          La Plataforma ofrece un periodo de prueba gratuito de 15 días, sin
          requerir tarjeta de crédito.
        </li>
        <li>
          Concluido el periodo de prueba, el uso de la Plataforma requiere la
          contratación de un plan de pago conforme a los precios y condiciones
          vigentes: plan Básico $499 MXN/mes por empresa; plan Profesional $1,299 MXN/mes por empresa; plan Despachos: multiempresa con precio por volumen conforme a la propuesta o contrato correspondiente. Precios más IVA cuando aplique; el Proveedor puede modificarlos con aviso previo de treinta días naturales.
        </li>
        <li>
          Facturación y renovaciones: cobro mensual por adelantado con
          renovación automática hasta su cancelación; la cancelación surte
          efecto al final del período pagado; no se otorgan reembolsos por
          períodos parciales.
        </li>
        <li>
          El Proveedor podrá modificar los precios de los planes, notificando
          al Usuario con anticipación razonable; los cambios aplicarán a
          partir del siguiente periodo de facturación.
        </li>
      </ul>

      <h2>7. Disponibilidad del servicio</h2>
      <p>
        El Proveedor procurará mantener la Plataforma disponible de manera
        continua; sin embargo, el servicio se presta «tal cual» y «según
        disponibilidad», sin garantía de continuidad ininterrumpida ni de
        ausencia de errores. La disponibilidad puede verse afectada por
        mantenimientos, causas de fuerza mayor o fallas de servicios de
        terceros de los que depende la Plataforma (incluidos los servicios del
        SAT, proveedores de timbrado, agregación bancaria, mensajería e
        infraestructura). El Proveedor no será responsable por daños
        derivados de interrupciones o indisponibilidad del servicio.
      </p>

      <h2>8. Propiedad intelectual</h2>
      <p>
        La Plataforma, su código, diseño, marcas, logotipos y demás elementos
        que la integran son propiedad del Proveedor o de sus licenciantes y
        están protegidos por la legislación de propiedad intelectual. La
        contratación del servicio otorga al Usuario una licencia limitada, no
        exclusiva, intransferible y revocable para usar la Plataforma conforme
        a estos Términos. La información y documentos que el Usuario incorpora
        a la Plataforma son y seguirán siendo propiedad del Usuario o de las
        empresas correspondientes.
      </p>

      <h2>9. Indemnización</h2>
      <p>
        El Usuario se obliga a indemnizar y sacar en paz y a salvo al
        Proveedor de cualquier reclamación, demanda, procedimiento, multa,
        daño, gasto u honorario razonable de defensa que provenga de terceros
        (incluidas autoridades, las empresas registradas, su personal, sus
        clientes o proveedores) y que derive de: (i) la información,
        documentos y credenciales que el Usuario incorpora a la Plataforma o
        su falta de veracidad, actualidad o autorización; (ii) el uso que el
        Usuario haga de la Plataforma o de sus resultados, incluidos los CFDI
        que ordene emitir o cancelar y las declaraciones que presente; (iii)
        el incumplimiento de estos Términos, de la Autorización de uso de la
        e.firma o de la legislación aplicable por parte del Usuario o de las
        personas a quienes dé acceso a su cuenta. Esta obligación no aplica en
        la medida en que la reclamación tenga su origen en un incumplimiento
        del Proveedor.
      </p>

      <h2>10. Límite de responsabilidad</h2>
      <p>
        En la máxima medida permitida por la legislación aplicable, la
        responsabilidad total y acumulada del Proveedor frente al Usuario por
        cualquier causa relacionada con estos Términos o con la Plataforma no
        excederá del monto efectivamente pagado por el Usuario al Proveedor
        por el servicio durante los doce (12) meses anteriores al hecho que
        origine la reclamación. El Proveedor no será responsable por daños
        indirectos, lucro cesante, pérdida de oportunidades de negocio ni
        pérdida de información, salvo que ésta se deba a su propia culpa. Nada
        de lo anterior limita la responsabilidad que por ley no puede
        limitarse, incluida la derivada de dolo o mala fe del Proveedor.
      </p>

      <h2>11. Datos personales y tratamiento por cuenta del Usuario</h2>
      <p>
        El tratamiento de los datos personales del Usuario se rige por nuestro{" "}
        <Link href="/legal/aviso-de-privacidad">Aviso de Privacidad</Link>,
        que forma parte integrante de estos Términos.
      </p>
      <p>
        Respecto de los datos personales de terceros que el Usuario incorpora
        a la Plataforma (empleados, clientes, proveedores y personal de las
        empresas registradas), el Usuario o la empresa correspondiente es el
        responsable del tratamiento y el Proveedor actúa como encargado, por
        su cuenta y bajo sus instrucciones. Para ese tratamiento las partes
        acuerdan lo siguiente:
      </p>
      <ul>
        <li>
          El Proveedor tratará esos datos únicamente para prestar el servicio
          conforme a estos Términos y a las instrucciones del Usuario dadas a
          través de la Plataforma, y no para fines propios.
        </li>
        <li>
          El Proveedor guardará confidencialidad, aplicará las medidas de
          seguridad descritas en el Aviso de Privacidad y notificará al Usuario
          sin dilación indebida las vulneraciones de seguridad que afecten
          dichos datos.
        </li>
        <li>
          El Proveedor podrá apoyarse en los subencargados listados en el
          Aviso de Privacidad, bajo condiciones equivalentes, e informará de
          cambios en dicha lista mediante su actualización.
        </li>
        <li>
          Al terminar la relación, el Proveedor suprimirá o devolverá esos
          datos conforme a la sección 13, salvo los que deba conservar por
          obligación legal.
        </li>
        <li>
          El Usuario es responsable de contar con el aviso de privacidad y, en
          su caso, el consentimiento de los titulares que la legislación exija
          para que el Proveedor trate esos datos por su cuenta, incluida la
          transferencia a los subencargados ubicados fuera de México.
        </li>
      </ul>

      <h2>12. Servicios de terceros</h2>
      <p>
        Ciertas funciones dependen de servicios de terceros que el Usuario
        contrata o autoriza a través de la Plataforma y cuyos términos acepta
        al utilizarlas: el proveedor de certificación de CFDI (Facturapi), el
        servicio de agregación bancaria (Belvo) cuando conecta sus cuentas, el
        canal de WhatsApp (Twilio y Meta) cuando vincula su número, y el
        procesador de pagos (Stripe) para el cobro del servicio. El Proveedor
        no responde por la disponibilidad ni por los actos u omisiones de
        dichos terceros.
      </p>

      <h2>13. Terminación de la cuenta</h2>
      <p>
        El Usuario puede dejar de utilizar la Plataforma y solicitar la
        cancelación de su cuenta en cualquier momento. El Proveedor podrá
        suspender o terminar la cuenta del Usuario en caso de incumplimiento
        de estos Términos, falta de pago o uso indebido de la Plataforma,
        notificándolo al correo registrado. A la terminación, el Usuario podrá
        solicitar la exportación de su información dentro del plazo de
        treinta días naturales;
        transcurrido dicho plazo, la información podrá ser eliminada, salvo
        aquella que deba conservarse por obligación legal o como evidencia
        para la defensa de reclamaciones (por ejemplo, la bitácora de
        seguridad y el registro de aceptación de estos Términos).
      </p>

      <h2>14. Aceptación, evidencia y modificaciones</h2>
      <p>
        La aceptación de estos Términos se otorga de manera expresa al crear
        la cuenta y, tras cada modificación sustancial, al volver a aceptarlos
        en la Plataforma. El Proveedor conserva registro de cada aceptación
        (usuario, versión aceptada, fecha y hora, dirección IP y navegador)
        como evidencia del consentimiento otorgado.
      </p>
      <p>
        El Proveedor podrá modificar estos Términos en cualquier momento. Las
        modificaciones serán publicadas en esta misma página con la fecha de
        última actualización. Cuando sean sustanciales, la Plataforma
        solicitará al Usuario su aceptación expresa antes de continuar
        usándola; el Usuario que no esté de acuerdo podrá cancelar su cuenta
        conforme a la sección 13.
      </p>

      <h2>15. Legislación aplicable y jurisdicción</h2>
      <p>
        Estos Términos se rigen por las leyes de los Estados Unidos Mexicanos.
        Para la interpretación y cumplimiento de los mismos, las partes se
        someten a la jurisdicción de los tribunales competentes de
        la ciudad de Puebla, Puebla, renunciando a cualquier otro fuero que pudiera
        corresponderles por razón de su domicilio presente o futuro.
      </p>

      <p className="pt-4">
        Consulte también nuestro{" "}
        <Link href="/legal/aviso-de-privacidad">Aviso de Privacidad</Link> y la{" "}
        <Link href="/legal/mandato-efirma">Autorización de uso de la e.firma</Link>.
      </p>
    </>
  );
}
