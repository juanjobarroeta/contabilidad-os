import type Anthropic from "@anthropic-ai/sdk";

export const tools: Anthropic.Tool[] = [
  {
    name: "query_invoices",
    description:
      "Busca y filtra facturas (CFDIs) de la empresa. Puede filtrar por rango de fechas, tipo (INGRESO/EGRESO/TRASLADO/NOMINA/PAGO), estatus (DRAFT/STAMPED/CANCELLED), cliente, o devolver un resumen agregado (conteo, totales).",
    input_schema: {
      type: "object" as const,
      properties: {
        date_from: { type: "string", description: "Fecha inicio ISO (YYYY-MM-DD)" },
        date_to: { type: "string", description: "Fecha fin ISO (YYYY-MM-DD)" },
        tipo: { type: "string", enum: ["INGRESO", "EGRESO", "TRASLADO", "NOMINA", "PAGO"] },
        status: { type: "string", enum: ["DRAFT", "STAMPED", "CANCELLED"] },
        customer_rfc: { type: "string", description: "RFC del cliente para filtrar" },
        q: {
          type: "string",
          description:
            "Búsqueda libre: folio, UUID, o nombre/RFC de la contraparte (incluye ventas a público en general)",
        },
        metodo_pago: { type: "string", enum: ["PUE", "PPD"] },
        summary_only: {
          type: "boolean",
          description: "Si es true, devuelve solo conteos y totales agregados en vez de la lista",
        },
        limit: { type: "number", description: "Máximo de resultados (default 20)" },
      },
      required: [],
    },
  },
  {
    name: "query_bank_transactions",
    description:
      "Busca transacciones bancarias. Convención: monto positivo = INGRESO (entró dinero), negativo = EGRESO (salió). Para el MAYOR EGRESO usa sort_by='monto_asc' y tipo='DEBITO'; para el MAYOR INGRESO usa sort_by='monto_desc'. Puede filtrar por cuenta, fechas, estatus (UNMATCHED/MATCHED/IGNORED), tipo (CREDITO/DEBITO), o rango de monto.",
    input_schema: {
      type: "object" as const,
      properties: {
        bank_account_id: { type: "string" },
        date_from: { type: "string", description: "Fecha inicio ISO" },
        date_to: { type: "string", description: "Fecha fin ISO" },
        status: { type: "string", enum: ["UNMATCHED", "MATCHED", "IGNORED"] },
        tipo: { type: "string", enum: ["CREDITO", "DEBITO"], description: "CREDITO=ingreso, DEBITO=egreso" },
        sort_by: { type: "string", enum: ["fecha", "monto_asc", "monto_desc"], description: "monto_asc = mayor egreso primero; monto_desc = mayor ingreso primero" },
        monto_min: { type: "number" },
        monto_max: { type: "number" },
        summary_only: { type: "boolean" },
        limit: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "query_tax_declarations",
    description:
      "Consulta declaraciones de impuestos. Puede filtrar por tipo (IVA_MENSUAL, ISR_PROVISIONAL, DIOT, DECLARACION_ANUAL) y periodo.",
    input_schema: {
      type: "object" as const,
      properties: {
        tipo: {
          type: "string",
          enum: ["IVA_MENSUAL", "ISR_PROVISIONAL", "DIOT", "DECLARACION_ANUAL", "CERO"],
        },
        periodo: { type: "string", description: "Periodo (YYYY-MM o YYYY)" },
        limit: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "query_dashboard_kpis",
    description:
      "Obtiene los KPIs principales del mes actual: ingresos, gastos, utilidad bruta, IVA estimado (trasladado vs acreditable), facturas emitidas/recibidas, transacciones sin conciliar, y próximas obligaciones fiscales.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "query_despacho_panorama",
    description:
      "Panorama de TODA la cartera del usuario (todas las empresas que administra), NO sólo la empresa activa. Úsala para preguntas 'intercompañía' o 'a nivel despacho': '¿qué estados de cuenta me quedan por subir?', '¿en qué empresas hay vencimientos próximos?', '¿dónde tengo hallazgos por resolver?', '¿cómo va mi cartera?'. Devuelve, por empresa: estados de cuenta pendientes de subir, vencimientos próximos y hallazgos abiertos/críticos. Si el usuario administra una sola empresa, no aporta nada (usa las herramientas normales).",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "query_customers",
    description: "Busca clientes por RFC, razón social, o devuelve la lista completa.",
    input_schema: {
      type: "object" as const,
      properties: {
        search: { type: "string", description: "Buscar por RFC o razón social (parcial)" },
        limit: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "query_employees",
    description: "Busca empleados y su información de nómina. Puede filtrar por nombre, RFC, o estatus activo.",
    input_schema: {
      type: "object" as const,
      properties: {
        search: { type: "string", description: "Buscar por nombre o RFC" },
        active_only: { type: "boolean", description: "Solo empleados activos (default true)" },
        limit: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "query_obligations",
    description:
      "Obtiene las obligaciones fiscales de la empresa con sus fechas de vencimiento próximas.",
    input_schema: {
      type: "object" as const,
      properties: {
        active_only: { type: "boolean", description: "Solo obligaciones activas (default true)" },
      },
      required: [],
    },
  },
  {
    name: "list_unmatched_transactions",
    description:
      "Lista los movimientos bancarios sin conciliar (UNMATCHED), cada uno con su mejor factura candidata. Úsala cuando pregunten qué falta por conciliar, o para iniciar la conciliación bancaria. Devuelve el total pendiente y los movimientos con su candidato sugerido.",
    input_schema: {
      type: "object" as const,
      properties: { limit: { type: "number", description: "Máx. movimientos a listar (default 10)" } },
      required: [],
    },
  },
  {
    name: "preview_conciliacion",
    description:
      "Prepara la conciliación de un movimiento bancario con una factura y la deja PENDIENTE de confirmación (NO la concilia). Devuelve un código que el usuario debe responder para confirmar. Úsala cuando el usuario quiera conciliar/emparejar un movimiento con una factura. Necesitas el id del movimiento (transaction_id) y el id de la factura (invoice_id) — obténlos de list_unmatched_transactions. Tras llamarla, muestra el resumen y pide el código.",
    input_schema: {
      type: "object" as const,
      properties: {
        transaction_id: { type: "string", description: "ID del movimiento bancario" },
        invoice_id: { type: "string", description: "ID de la factura a conciliar" },
      },
      required: ["transaction_id", "invoice_id"],
    },
  },
  {
    name: "preview_factura",
    description:
      "Prepara una PREFACTURA (CFDI de ingreso en borrador) para TIMBRAR y la deja PENDIENTE de confirmación. NO la timbra: genera un borrador con su PDF, un resumen y un código que el usuario debe responder para confirmar. Úsala cuando el usuario pida emitir/timbrar/hacer una factura. Necesitas: cliente (RFC o nombre ya dado de alta), y por cada concepto: descripción, cantidad, precio unitario, y si es 'servicio' o 'producto'. Para cada concepto fija la clave ProdServ SAT más específica que corresponda (p.ej. intereses/financieros 84121500); NO uses la genérica 01010101 salvo último recurso. Pregunta lo que falte ANTES de llamar la herramienta. Tras llamarla, comparte el enlace del PDF borrador para que el usuario valide la clasificación SAT (clave y unidad), muestra el resumen y pide el código de confirmación — nunca afirmes que ya se timbró.",
    input_schema: {
      type: "object" as const,
      properties: {
        customer_rfc: { type: "string", description: "RFC del cliente (receptor)" },
        customer_name: { type: "string", description: "Nombre/razón social del cliente si no hay RFC" },
        forma_pago: { type: "string", description: "Clave SAT forma de pago, e.g. 03 transferencia, 01 efectivo (default 99)" },
        metodo_pago: { type: "string", enum: ["PUE", "PPD"], description: "PUE pago en una exhibición, PPD en parcialidades (default PUE)" },
        uso_cfdi: { type: "string", description: "Clave SAT uso CFDI, e.g. G03 (default G03)" },
        items: {
          type: "array",
          description: "Conceptos de la factura",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              quantity: { type: "number" },
              unit_price: { type: "number", description: "Precio unitario antes de IVA" },
              tipo: { type: "string", enum: ["servicio", "producto"], description: "Si el concepto es un servicio o un bien/producto físico. Determina la unidad SAT por defecto (servicio→E48, producto→H87)." },
              product_key: { type: "string", description: "Clave ProdServ SAT (8 dígitos) lo más específica posible para el concepto. Obligatoria para un CFDI correcto; p.ej. intereses/servicios financieros 84121500." },
              unit_key: { type: "string", description: "Clave de unidad SAT. Servicios: E48 (Unidad de servicio) o ACT (Actividad). Productos: H87 (Pieza), KGM, LTR, MTR, etc. Si no la das, se infiere de 'tipo'." },
              iva_rate: { type: "number", description: "Tasa IVA, default 0.16. Usa 0 para TASA CERO (agua, alimentos, medicinas — Art. 2o.-A LIVA). Tasa 0 NO es lo mismo que exento: si el usuario dice 'sin IVA' por un producto de tasa cero, corresponde 0, no omitir el impuesto." },
            },
            required: ["description", "unit_price", "tipo"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "get_invoice_detail",
    description:
      "Detalle COMPLETO de un CFDI por UUID (folio fiscal) o folio interno: conceptos (descripción, clave SAT, cantidades, importes), desglose de impuestos (IVA/ISR/IEPS, tasas, retenciones), contraparte con régimen fiscal, uso CFDI, y — cuando aplica — saldo PPD con sus complementos de pago, o análisis de cancelación (¿tiene factura sustituta?). Úsala siempre que el usuario pregunte QUÉ contiene una factura, qué se vendió/compró, sus impuestos, o cuánto le deben de ella.",
    input_schema: {
      type: "object" as const,
      properties: {
        uuid: { type: "string", description: "UUID (folio fiscal) exacto" },
        folio: { type: "string", description: "Folio interno (si no tienes el UUID)" },
      },
      required: [],
    },
  },
  {
    name: "query_cancelaciones",
    description:
      "Facturas CANCELADAS con análisis de sustitución: cuáles tienen factura sustituta viva (refacturación — sin efecto en lo declarado) y cuáles NO (sacaron ingreso/gasto de una base posiblemente ya declarada; pueden ameritar revisar el periodo). Filtra por fecha de emisión o de cancelación. Úsala para '¿qué se me canceló?', '¿afecta mis declaraciones?'.",
    input_schema: {
      type: "object" as const,
      properties: {
        date_from: { type: "string", description: "Fecha inicio ISO (YYYY-MM-DD)" },
        date_to: { type: "string", description: "Fecha fin ISO" },
        por: {
          type: "string",
          enum: ["emision", "cancelacion"],
          description: "Filtrar por fecha del CFDI (default) o por cuándo se canceló",
        },
        limit: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "query_ppd_cartera",
    description:
      "Cartera de facturas PPD (a crédito): quién debe, cuánto, desde cuándo, y qué complementos de pago la han abonado. El saldo sale de los propios REPs (ImpSaldoInsoluto). Úsala para '¿quién me debe?', '¿cuánto ha pagado X?', 'facturas vencidas sin cobrar'.",
    input_schema: {
      type: "object" as const,
      properties: {
        date_from: { type: "string", description: "Emitidas desde (YYYY-MM-DD)" },
        date_to: { type: "string", description: "Emitidas hasta" },
        solo_con_saldo: {
          type: "boolean",
          description: "default true: sólo facturas con saldo vivo; false incluye ya cobradas",
        },
        limit: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "get_invoice_files",
    description:
      "Genera enlaces de descarga para el XML (y PDF si está disponible) de facturas/CFDIs. Úsala cuando el usuario pida 'mándame el XML/PDF de la factura X', 'descarga mis facturas de mayo', etc. Filtra por UUID, cliente, o rango de fechas. El XML está disponible para facturas descargadas del SAT después de cierta fecha; el PDF solo para facturas emitidas con Facturapi. Devuelve enlaces temporales (30 min) que el usuario abre para descargar.",
    input_schema: {
      type: "object" as const,
      properties: {
        uuid: { type: "string", description: "UUID (folio fiscal) exacto de una factura" },
        date_from: { type: "string", description: "Fecha desde (YYYY-MM-DD)" },
        date_to: { type: "string", description: "Fecha hasta (YYYY-MM-DD)" },
        cliente: { type: "string", description: "Nombre o RFC del cliente/proveedor" },
        limit: { type: "number", description: "Máx. facturas (default 10)" },
      },
      required: [],
    },
  },
  {
    name: "query_sat_sync_status",
    description:
      "Reporta el estado de la sincronización de CFDIs con el SAT: si la descarga histórica (backfill) ya terminó, cuántos periodos (meses) están completos vs. pendientes, el rango de fechas cubierto, cuántos CFDIs se han importado, y qué meses faltan. Úsala cuando pregunten '¿ya se descargaron todos mis CFDIs?', '¿ya terminó la descarga de 5 años?', '¿faltan facturas por bajar del SAT?'.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "query_tax_position",
    description:
      "Calcula la posición fiscal del mes (IVA a pagar e ISR provisional) a partir de los CFDIs sincronizados, en flujo de efectivo. Úsala cuando pregunten '¿cuánto IVA/ISR debo este mes?', cuánto van a pagar de impuestos, o la posición fiscal de un periodo. Devuelve IVA trasladado/acreditable/a pagar, saldo a favor, y el ISR provisional (Art. 14) con su coeficiente de utilidad. Si no se dan mes/año, usa el PERIODO EN JUEGO: el mes anterior mientras su declaración no esté presentada (del 1 al 17 se trabaja el mes pasado), y el mes en curso cuando ya se presentó — el campo 'periodo' de la respuesta dice cuál se usó; menciónalo SIEMPRE al responder.",
    input_schema: {
      type: "object" as const,
      properties: {
        year: { type: "number", description: "Año del periodo, e.g. 2026. Default: el del periodo en juego." },
        month: { type: "number", description: "Mes 1-12. Default: el del periodo en juego (mes anterior hasta presentarse; luego el actual)." },
      },
      required: [],
    },
  },
  {
    name: "query_declaracion_checklist",
    description:
      "Genera el checklist de la declaración mensual de la empresa: qué está listo y qué falta para declarar un periodo. Cubre la sincronización de CFDIs con el SAT, la cadena de declaraciones de meses anteriores, la conciliación bancaria del mes, los complementos de pago (REP) por emitir y los que deben los proveedores, el IVA e ISR calculados del periodo, la DIOT, la nómina timbrada y la fecha límite (día 17 del mes siguiente) con los días restantes. Úsala cuando pregunten '¿qué necesito para mi declaración?', '¿qué me falta para declarar mayo?' o si ya pueden presentar. Si no se dan mes/año, usa el último mes vencido (el anterior al actual), que es el que se declara.",
    input_schema: {
      type: "object" as const,
      properties: {
        year: { type: "number", description: "Año del periodo a declarar, e.g. 2026. Default: el del mes anterior al actual." },
        month: { type: "number", description: "Mes 1-12 del periodo a declarar. Default: el mes anterior al actual." },
      },
      required: [],
    },
  },
  {
    name: "query_complementos_pendientes",
    description:
      "Detecta facturas PPD (pago en parcialidades o diferido) que recibieron pago pero a las que aún les falta emitir el Complemento de Pago (REP). Incluye la fecha límite legal (día 5 del mes siguiente al pago) y la urgencia (VENCIDO / POR_VENCER / EN_TIEMPO). Úsala cuando pregunten por complementos de pago, REP, o qué les falta timbrar. Devuelve el invoiceId de cada factura, que necesitas para emitir su complemento con preview_complemento.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "preview_complemento",
    description:
      "Prepara la emisión del Complemento de Pago (REP) de una factura PPD y devuelve un ENLACE DE AUTORIZACIÓN para que el usuario lo revise y emita DENTRO de la app (no se emite aquí). Úsala cuando el usuario quiera emitir el complemento/REP de una factura concreta. Sin monto, asume el saldo pendiente completo (el caso común). El usuario abre el enlace, revisa la parcialidad y los saldos, y confirma con un toque; te llegará aquí el folio fiscal cuando quede.",
    input_schema: {
      type: "object" as const,
      properties: {
        invoice_id: { type: "string", description: "ID de la factura PPD a la que se le emite el complemento (de query_complementos_pendientes)" },
        bank_transaction_id: { type: "string", description: "ID del movimiento bancario del pago (opcional; de él se toma la fecha del pago)" },
        monto: { type: "number", description: "Monto del pago a complementar (opcional; por defecto el saldo pendiente completo)" },
        fecha_pago: { type: "string", description: "Fecha del pago YYYY-MM-DD (opcional)" },
        forma_pago: { type: "string", description: "Forma de pago SAT, p.ej. '03' transferencia (opcional; default 03)" },
      },
      required: ["invoice_id"],
    },
  },
  {
    name: "query_complementos_recibidos_pendientes",
    description:
      "Detecta gastos PPD que YA PAGASTE pero para los que el PROVEEDOR aún no te ha enviado el Complemento de Pago (REP). Sin ese complemento, la deducción del gasto está en riesgo. Úsala cuando pregunten qué complementos les deben los proveedores, o qué gastos están en riesgo por falta de complemento. Devuelve proveedor, monto pagado, fecha límite y urgencia.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "categorize_transaction",
    description:
      "Dada la descripción de una transacción bancaria, sugiere la cuenta contable (del catálogo SAT/COE) más apropiada para clasificarla. Usa el catálogo de cuentas de la empresa.",
    input_schema: {
      type: "object" as const,
      properties: {
        transaction_description: { type: "string", description: "Descripción de la transacción" },
        monto: { type: "number", description: "Monto de la transacción" },
        tipo: { type: "string", enum: ["CREDITO", "DEBITO"] },
      },
      required: ["transaction_description"],
    },
  },
  {
    name: "suggest_reconciliation_match",
    description:
      "Dada una transacción bancaria, busca facturas (CFDIs) y proveedores que podrían corresponder para conciliarla. Compara montos, fechas y RFCs.",
    input_schema: {
      type: "object" as const,
      properties: {
        transaction_id: { type: "string", description: "ID de la transacción bancaria" },
      },
      required: ["transaction_id"],
    },
  },
  {
    name: "analyze_anomalies",
    description:
      "Revisa qué podría estar mal en la contabilidad: montos duplicados, transacciones inusualmente altas, movimientos sin conciliar, CFDIs cancelados (que no deben contar en IVA/ISR), y complementos de pago pendientes en ambas direcciones (los que debes emitir y los que te deben tus proveedores, con riesgo a tu deducción). Úsala para '¿qué tengo mal?', '¿hay riesgos en mis deducciones?', revisiones generales.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Días hacia atrás para analizar (default 30)" },
      },
      required: [],
    },
  },
  {
    name: "search_fiscal_knowledge",
    description:
      "Busca en la legislación y normatividad fiscal mexicana vigente (leyes: LISR/LIVA/CFF/LIEPS y sus reglamentos RLISR/RLIVA/RCFF; nómina: LSS/LINFONAVIT/LFT; RMF y sus reglas; guías de llenado del CFDI / Anexo 20, incluyendo complemento de pago, PUE/PPD, método de pago) y devuelve fragmentos con su cita (artículo/regla/guía, fuente, fecha de vigencia). Úsala SIEMPRE antes de afirmar una regla, tasa, plazo, requisito o fundamento fiscal — no respondas de memoria. Si no devuelve resultados, dilo explícitamente y NO inventes un fundamento legal. Para preguntas sobre periodos pasados pasa fecha_vigencia del periodo, no la de hoy.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Consulta en lenguaje natural (e.g. '¿quién puede tributar en RESICO?')" },
        fecha_vigencia: {
          type: "string",
          description: "Fecha ISO (YYYY-MM-DD) del periodo fiscal relevante. Default: hoy. Para periodos pasados usa una fecha de ese periodo.",
        },
        fuentes: {
          type: "array",
          items: { type: "string", enum: ["LEY", "RMF", "CRITERIO", "DOF", "REGLAMENTO", "TESIS", "GUIA"] },
          description: "Filtrar por tipo de fuente (opcional). GUIA = guías de llenado del CFDI / Anexo 20.",
        },
        limit: { type: "number", description: "Máximo de fragmentos (default 6)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_articulo",
    description:
      "Trae COMPLETO un artículo de ley/reglamento o una regla de la RMF por su número (todas sus partes, vigentes a la fecha). Úsala para SEGUIR una referencia que apareció en otro fragmento — «para los efectos del artículo 27 de la Ley», «conforme a la regla 2.7.1.32» — o cuando el usuario pregunta por un artículo concreto. No sustituye a search_fiscal_knowledge para preguntas abiertas.",
    input_schema: {
      type: "object" as const,
      properties: {
        ley: {
          type: "string",
          enum: ["LISR", "LIVA", "CFF", "LIEPS", "RLISR", "RLIVA", "RCFF", "LSS", "LINFONAVIT", "LFT", "RMF"],
          description: "Clave del ordenamiento. RMF = Resolución Miscelánea Fiscal vigente.",
        },
        articulo: { type: "string", description: "Número tal como se cita: '27', '29-A', '113-E', '17-H Bis', o la regla '2.7.1.32'." },
        fecha_vigencia: { type: "string", description: "Fecha ISO (YYYY-MM-DD) del periodo relevante. Default: hoy." },
      },
      required: ["ley", "articulo"],
    },
  },
  {
    name: "get_valor_fiscal",
    description:
      "Devuelve VALORES fiscales vigentes desde las tablas oficiales cargadas en el sistema (con vigencia, fuente y si están verificados): montos de multas del CFF (Anexo 5 RMF), tarifas del ISR mensual/anual (Anexo 8), UMA, salario mínimo, tasa de recargos (LIF / Art. 21 CFF) y subsidio para el empleo. ÚSALA SIEMPRE antes de mencionar un monto, tarifa, UMA, salario mínimo o tasa de recargos: nunca los digas de memoria. Puede calcular: ISR de una base con la tarifa, recargos de un monto por meses de mora.",
    input_schema: {
      type: "object" as const,
      properties: {
        tipo: { type: "string", enum: ["multa", "tarifa_isr", "uma", "salario_minimo", "recargos", "subsidio_empleo"] },
        articulo: { type: "string", description: "multa: artículo del CFF que fija la sanción ('82', '84', '84-B'). La infracción (81, 83) remite a él." },
        fraccion: { type: "string", description: "multa: fracción en romano ('I', 'XXVI'); opcional." },
        inciso: { type: "string", description: "multa: inciso ('a'); opcional." },
        periodo: { type: "string", enum: ["mensual", "anual"], description: "tarifa_isr: mensual (Art. 96/116) o anual (Art. 152). Default mensual." },
        base: { type: "number", description: "tarifa_isr: base gravable para calcular el ISR; recargos: monto ya actualizado." },
        meses: { type: "number", description: "recargos: meses (o fracción) de mora." },
        fecha: { type: "string", description: "Fecha ISO (YYYY-MM-DD) del periodo relevante. Default: hoy." },
      },
      required: ["tipo"],
    },
  },
  // ── Herramientas de PROPUESTA (acciones reversibles) ───────────────────────
  // Estas herramientas NO ejecutan nada: STAGEAN una propuesta sobre la
  // conversación y devuelven un resumen legible + un token. El usuario debe tocar
  // "Confirmar" en la tarjeta para que se ejecute. NUNCA afirmes que ya se hizo:
  // sólo ocurre cuando el usuario toca Confirmar.
  {
    name: "proponer_conciliacion",
    description:
      "Propone aplicar una conciliación entre un movimiento bancario y una factura (CFDI), y la deja PENDIENTE de confirmación. NO concilia: stagea la propuesta y devuelve un resumen + token; el usuario debe tocar Confirmar. Necesitas transaction_id e invoice_id (obténlos de list_unmatched_transactions o suggest_reconciliation_match). Tras llamarla, resume el match y dile al usuario que toque Confirmar para aplicarlo.",
    input_schema: {
      type: "object" as const,
      properties: {
        transaction_id: { type: "string", description: "ID del movimiento bancario" },
        invoice_id: { type: "string", description: "ID de la factura a conciliar" },
      },
      required: ["transaction_id", "invoice_id"],
    },
  },
  {
    name: "proponer_categorizacion",
    description:
      "Propone categorizar un movimiento bancario SIN CFDI (comisión, impuesto, nómina sin CFDI, traspaso, intereses, renta o no deducible) registrándolo en el libro mayor, y lo deja PENDIENTE de confirmación. NO escribe nada: stagea la propuesta y devuelve un resumen + token; el usuario debe tocar Confirmar. Elige la 'familia' correcta según la naturaleza del concepto. Tras llamarla, explica brevemente por qué esa cuenta y pide al usuario tocar Confirmar.",
    input_schema: {
      type: "object" as const,
      properties: {
        transaction_id: { type: "string", description: "ID del movimiento bancario sin CFDI" },
        familia: {
          type: "string",
          enum: [
            "COMISION",
            "TAX_PAYMENT",
            "PAYROLL_NO_CFDI",
            "INTERNAL_TRANSFER",
            "FINANCIAL_INCOME",
            "RENT",
            "NON_DEDUCTIBLE",
          ],
          description:
            "Familia contable: COMISION (comisiones bancarias), TAX_PAYMENT (impuestos/derechos), PAYROLL_NO_CFDI (nómina sin CFDI), INTERNAL_TRANSFER (traspaso entre cuentas propias), FINANCIAL_INCOME (intereses/rendimientos), RENT (renta), NON_DEDUCTIBLE (gasto no deducible).",
        },
      },
      required: ["transaction_id", "familia"],
    },
  },
  {
    name: "proponer_categorizacion_lote",
    description:
      "Propone categorizar EN LOTE todos los movimientos bancarios SIN CFDI cuya descripción contiene un patrón (p.ej. 'RAPPI', 'OPENAI', 'ANTHROPIC'), registrándolos en el libro mayor con la MISMA familia, y recuerda una regla para que los próximos estados de cuenta se categoricen solos. Úsala cuando el usuario quiera 'categorizar todos los cargos de X', o para limpiar de una vez los cargos recurrentes sin factura. NO escribe nada: stagea la propuesta y devuelve un resumen + token; el usuario debe tocar Confirmar. Elige la familia correcta: usa NON_DEDUCTIBLE sólo para gastos claramente personales; los consumos en restaurantes pueden ser parcialmente deducibles, así que confirma con el usuario antes de agruparlos. Tras llamarla, resume cuántos movimientos se verían afectados y pide tocar Confirmar.",
    input_schema: {
      type: "object" as const,
      properties: {
        patron: {
          type: "string",
          description: "Texto a buscar dentro de la descripción del movimiento (p.ej. 'RAPPI'). Insensible a mayúsculas/acentos.",
        },
        familia: {
          type: "string",
          enum: [
            "COMISION",
            "TAX_PAYMENT",
            "PAYROLL_NO_CFDI",
            "INTERNAL_TRANSFER",
            "FINANCIAL_INCOME",
            "RENT",
            "NON_DEDUCTIBLE",
          ],
          description:
            "Familia contable con la que se categorizarán todos los movimientos que empaten el patrón.",
        },
        signo: {
          type: "string",
          enum: ["CREDITO", "DEBITO"],
          description: "Opcional: acota la regla a un signo (CREDITO=entra dinero, DEBITO=sale). Omítelo para ambos.",
        },
      },
      required: ["patron", "familia"],
    },
  },
  {
    name: "proponer_resolver_hallazgo",
    description:
      "Propone marcar un hallazgo del auditor fiscal como RESUELTO, y lo deja PENDIENTE de confirmación. NO lo resuelve: stagea la propuesta y devuelve un resumen + token; el usuario debe tocar Confirmar. Úsala cuando el usuario diga que ya atendió un hallazgo. Necesitas el hallazgo_id.",
    input_schema: {
      type: "object" as const,
      properties: {
        hallazgo_id: { type: "string", description: "ID del hallazgo fiscal" },
      },
      required: ["hallazgo_id"],
    },
  },
  {
    name: "proponer_posponer_hallazgo",
    description:
      "Propone posponer (snooze) un hallazgo del auditor fiscal hasta una fecha, y lo deja PENDIENTE de confirmación. NO lo pospone: stagea la propuesta y devuelve un resumen + token; el usuario debe tocar Confirmar.",
    input_schema: {
      type: "object" as const,
      properties: {
        hallazgo_id: { type: "string", description: "ID del hallazgo fiscal" },
        plazo: {
          type: "string",
          enum: ["7d", "30d", "fin_de_mes"],
          description: "Cuánto posponer: 7 días, 30 días, o hasta fin de mes.",
        },
      },
      required: ["hallazgo_id", "plazo"],
    },
  },
  {
    name: "proponer_marcar_pendiente",
    description:
      "Propone marcar un pendiente del inbox como HECHO o posponerlo, y lo deja PENDIENTE de confirmación. NO cambia nada: stagea la propuesta y devuelve un resumen + token; el usuario debe tocar Confirmar. Útil cuando trabajas un pendiente que el usuario abrió 'con el asistente' y ya lo atendieron.",
    input_schema: {
      type: "object" as const,
      properties: {
        pendiente_id: { type: "string", description: "ID del pendiente (NotificationItem)" },
        accion: {
          type: "string",
          enum: ["hecho", "posponer"],
          description: "hecho = marcar atendido; posponer = posponer 7 días.",
        },
      },
      required: ["pendiente_id", "accion"],
    },
  },
];
