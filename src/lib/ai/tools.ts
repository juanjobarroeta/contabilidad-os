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
      "Busca transacciones bancarias. Puede filtrar por cuenta, rango de fechas, estatus de conciliación (UNMATCHED/MATCHED/IGNORED), tipo (CREDITO/DEBITO), o rango de monto.",
    input_schema: {
      type: "object" as const,
      properties: {
        bank_account_id: { type: "string" },
        date_from: { type: "string", description: "Fecha inicio ISO" },
        date_to: { type: "string", description: "Fecha fin ISO" },
        status: { type: "string", enum: ["UNMATCHED", "MATCHED", "IGNORED"] },
        tipo: { type: "string", enum: ["CREDITO", "DEBITO"] },
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
      "Calcula la posición fiscal del mes (IVA a pagar e ISR provisional) a partir de los CFDIs sincronizados, en flujo de efectivo. Úsala cuando pregunten '¿cuánto IVA/ISR debo este mes?', cuánto van a pagar de impuestos, o la posición fiscal de un periodo. Devuelve IVA trasladado/acreditable/a pagar, saldo a favor, y el ISR provisional (Art. 14) con su coeficiente de utilidad. Si no se dan mes/año, usa el mes actual.",
    input_schema: {
      type: "object" as const,
      properties: {
        year: { type: "number", description: "Año del periodo, e.g. 2026. Default: año actual." },
        month: { type: "number", description: "Mes 1-12. Default: mes actual." },
      },
      required: [],
    },
  },
  {
    name: "query_complementos_pendientes",
    description:
      "Detecta facturas PPD (pago en parcialidades o diferido) que recibieron pago pero a las que aún les falta emitir el Complemento de Pago (REP). Incluye la fecha límite legal (día 5 del mes siguiente al pago) y la urgencia (VENCIDO / POR_VENCER / EN_TIEMPO). Úsala cuando pregunten por complementos de pago, REP, o qué les falta timbrar.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
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
];
