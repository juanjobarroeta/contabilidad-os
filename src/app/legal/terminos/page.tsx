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
 */
export default function TerminosPage() {
  return (
    <>
      <h1>Términos y Condiciones</h1>
      <p className="text-cos-ink-faint">
        Última actualización: 3 de julio de 2026
      </p>

      <p>
        Los presentes términos y condiciones (los «Términos») regulan el
        acceso y uso de la plataforma ContabilidadOS (la «Plataforma»),
        operada por Juan José Barroeta Huerta (el «Proveedor»). Al crear una
        cuenta o utilizar la Plataforma, usted (el «Usuario») acepta quedar
        obligado por estos Términos. Si no está de acuerdo con ellos, deberá
        abstenerse de utilizar la Plataforma.
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
          de acceso y de toda actividad realizada desde su cuenta. Deberá
          notificar de inmediato al Proveedor cualquier uso no autorizado.
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

      <h2>3. Limitación de responsabilidad fiscal</h2>
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

      <h2>4. Planes y pagos</h2>
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

      <h2>5. Disponibilidad del servicio</h2>
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

      <h2>6. Propiedad intelectual</h2>
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

      <h2>7. Datos personales</h2>
      <p>
        El tratamiento de los datos personales recabados a través de la
        Plataforma se rige por nuestro{" "}
        <Link href="/legal/aviso-de-privacidad">Aviso de Privacidad</Link>,
        que forma parte integrante de estos Términos.
      </p>

      <h2>8. Terminación de la cuenta</h2>
      <p>
        El Usuario puede dejar de utilizar la Plataforma y solicitar la
        cancelación de su cuenta en cualquier momento. El Proveedor podrá
        suspender o terminar la cuenta del Usuario en caso de incumplimiento
        de estos Términos, falta de pago o uso indebido de la Plataforma,
        notificándolo al correo registrado. A la terminación, el Usuario podrá
        solicitar la exportación de su información dentro del plazo de
        treinta días naturales;
        transcurrido dicho plazo, la información podrá ser eliminada, salvo
        aquella que deba conservarse por obligación legal.
      </p>

      <h2>9. Modificaciones</h2>
      <p>
        El Proveedor podrá modificar estos Términos en cualquier momento. Las
        modificaciones serán publicadas en esta misma página con la fecha de
        última actualización y, cuando sean sustanciales, se notificarán a
        través de la Plataforma o del correo electrónico registrado. El uso
        continuado de la Plataforma después de la publicación de los cambios
        constituye la aceptación de los mismos.
      </p>

      <h2>10. Legislación aplicable y jurisdicción</h2>
      <p>
        Estos Términos se rigen por las leyes de los Estados Unidos Mexicanos.
        Para la interpretación y cumplimiento de los mismos, las partes se
        someten a la jurisdicción de los tribunales competentes de
        la ciudad de Puebla, Puebla, renunciando a cualquier otro fuero que pudiera
        corresponderles por razón de su domicilio presente o futuro.
      </p>

      <p className="pt-4">
        Consulte también nuestro{" "}
        <Link href="/legal/aviso-de-privacidad">Aviso de Privacidad</Link>.
      </p>
    </>
  );
}
