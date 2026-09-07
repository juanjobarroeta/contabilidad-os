// ─────────────────────────────────────────────────────────────────────────────
// EL CIERRE EN CASTELLANO.
//
// Las señales de los motores dicen el DATO («0 de 1 cuenta con la conciliación
// del mes firmada»), no la acción ni por qué importa. Leídas de corrido son una
// pantalla de jerga: conciliación, coeficiente, complementos, agrupadores.
//
// Aquí vive, por señal, lo mismo dicho como se lo dirías a alguien que no es
// contador: qué hay que HACER (imperativo, corto) y qué es eso (una línea).
// El dato exacto lo sigue poniendo la señal; esto no lo sustituye, lo enmarca.
//
// Tabla pura, sin dependencias: se usa igual en la pantalla del contador y en
// la del dueño de la empresa.
// ─────────────────────────────────────────────────────────────────────────────

export interface TextoLlano {
  /** Qué hacer, en imperativo y sin jerga. */
  hacer: string;
  /** Qué es y por qué importa, una línea. */
  que: string;
}

/** Por clave de señal. Lo que no esté aquí cae al resumen del motor. */
export const LLANO: Record<string, TextoLlano> = {
  // ── Contabilidad (ce:) ─────────────────────────────────────────────────────
  "ce:cfdis": {
    hacer: "Traer las facturas del mes",
    que: "Las facturas que emitiste y recibiste tienen que estar descargadas del SAT: son la base de todo lo demás.",
  },
  "ce:banco": {
    hacer: "Cargar los movimientos del banco",
    que: "Sin el estado de cuenta del mes no se puede comprobar que lo facturado sea lo que de verdad entró y salió.",
  },
  "ce:sin_clasificar": {
    hacer: "Clasificar los movimientos que faltan",
    que: "Cada movimiento del banco tiene que decir qué fue (una venta, un gasto, un pago de impuestos) para que la contabilidad lo registre bien.",
  },
  "ce:cuadre": {
    hacer: "Cuadrar la contabilidad",
    que: "Lo que entra y lo que sale tiene que sumar igual. Si no cuadra, hay un registro mal hecho.",
  },
  "ce:agrupadores": {
    hacer: "Etiquetar las cuentas que faltan",
    que: "Cada cuenta contable lleva la etiqueta que pide el SAT; sin ella la contabilidad electrónica se rechaza.",
  },
  "ce:posteo": {
    hacer: "Generar las pólizas del mes",
    que: "Las pólizas son el registro contable formal de lo que pasó en el mes.",
  },
  "ce:capital_inicial": {
    hacer: "Capturar el saldo con el que arrancó la empresa",
    que: "Es el punto de partida del balance: sin él, los saldos de todos los meses salen mal.",
  },

  // ── Fiscal (fx:) ───────────────────────────────────────────────────────────
  "fx:apertura": {
    hacer: "Confirmar el punto de partida",
    que: "Revisar una vez de dónde salen los saldos con los que arranca la empresa, para que no se arrastre un error todos los meses.",
  },
  "fx:sincronizacion-sat": {
    hacer: "Completar la descarga del SAT",
    que: "Faltan meses por bajar del SAT; lo que no está descargado no se puede revisar.",
  },
  "fx:cadena-declaraciones": {
    hacer: "Completar las declaraciones anteriores",
    que: "Los saldos a favor y los pagos de meses previos alimentan el de este mes: si falta un eslabón, el cálculo sale mal.",
  },
  "fx:conciliacion-bancaria": {
    hacer: "Emparejar el banco con las facturas",
    que: "Cada depósito y cada pago debe quedar ligado a su factura, para saber qué está cobrado y qué no.",
  },
  "fx:complementos-por-emitir": {
    hacer: "Timbrar los complementos de pago que debes",
    que: "Cuando te pagan una factura a crédito, el SAT exige un comprobante extra por el pago. Sin él, tu cliente no puede deducir.",
  },
  "fx:complementos-proveedores": {
    hacer: "Pedir los complementos de pago a tus proveedores",
    que: "Sin ese comprobante del pago no puedes deducir el gasto ni acreditar su IVA.",
  },
  "fx:posicion-calculada": {
    hacer: "Calcular los impuestos del mes",
    que: "Cuánto sale a pagar de IVA e ISR con lo que ya está registrado.",
  },
  "fx:diot": {
    hacer: "Preparar la DIOT",
    que: "Es el informe mensual de con qué proveedores gastaste; se presenta aparte de la declaración.",
  },
  "fx:nomina": {
    hacer: "Timbrar la nómina del mes",
    que: "Cada pago a un empleado necesita su recibo timbrado; si falta, no es deducible y el empleado queda sin comprobante.",
  },
  "fx:ajuste-anual": {
    hacer: "Hacer el ajuste anual de ISR de los empleados",
    que: "En diciembre se recalcula el impuesto del año de cada empleado y se corrige la diferencia.",
  },
  "fx:cuotas-imss": {
    hacer: "Pagar las cuotas del IMSS",
    que: "Las cuotas del mes se pagan aunque no haya cambios; el recargo corre solo.",
  },
  "fx:declaracion-periodo": {
    hacer: "Presentar la declaración del mes",
    que: "Es el trámite en el portal del SAT con el que se cierra el mes.",
  },
  "fx:fecha-limite": {
    hacer: "Presentar antes de la fecha límite",
    que: "Pasada la fecha corren recargos y multas, aunque no salga nada a pagar.",
  },

  // ── Extras del cierre (x:) ─────────────────────────────────────────────────
  "x:cfdi_faltantes": {
    hacer: "Recuperar las facturas que el SAT tiene y nosotros no",
    que: "El SAT las tiene registradas a tu nombre; si no las tenemos, faltan en la contabilidad.",
  },
  "x:coeficiente": {
    hacer: "Fijar el coeficiente de utilidad",
    que: "Es el porcentaje —salido de tu declaración anual— con el que se calcula el pago provisional de ISR de cada mes.",
  },
  "x:datos_apertura": {
    hacer: "Capturar los datos con los que arranca la empresa",
    que: "Saldos a favor, pérdidas de años anteriores y coeficiente. Sin capturarlos se toman como cero, y un cero que nadie revisó puede inflar el impuesto.",
  },
  "x:cuentas_sin_estado": {
    hacer: "Subir el estado de cuenta del mes",
    que: "Sin el estado de cuenta no hay contra qué comparar lo registrado.",
  },
  "x:firmas_conciliacion": {
    hacer: "Dar por conciliada la cuenta del banco",
    que: "Es la firma que deja constancia de que alguien revisó el mes y el banco cuadra con la contabilidad.",
  },
  "x:empleados_sin_recibo": {
    hacer: "Timbrar los recibos que faltan",
    que: "Hay empleados activos sin recibo de nómina del mes.",
  },
  "x:idse_pendientes": {
    hacer: "Presentar los movimientos en el IMSS",
    que: "Altas, bajas y cambios de sueldo se avisan al IMSS; si no, las cuotas salen mal.",
  },
  "x:hallazgos_criticos": {
    hacer: "Resolver las alertas graves",
    que: "El revisor automático encontró cosas que pueden costarte dinero o una multa.",
  },
  "x:efos": {
    hacer: "Revisar las alertas de la lista negra del SAT",
    que: "Hay facturas de proveedores señalados por el SAT (lista 69-B): deducirlas es un riesgo.",
  },
  "x:pago_conciliado": {
    hacer: "Ligar el pago del impuesto con su movimiento del banco",
    que: "Deja constancia de que la declaración no sólo se presentó: se pagó.",
  },
};

/** Los doce pasos, dichos en llano (para la vista del dueño y el avance). */
export const PASO_LLANO: Record<string, string> = {
  apertura: "De dónde partimos",
  sat: "Facturas del SAT",
  nomina: "Nómina",
  imss: "IMSS",
  banco: "Banco",
  complementos: "Complementos de pago",
  impuestos: "Cálculo de impuestos",
  diot: "DIOT",
  contabilidad: "Contabilidad",
  revision: "Revisión de riesgos",
  declaracion: "Declaración",
  entregables: "Papeles del mes",
};
