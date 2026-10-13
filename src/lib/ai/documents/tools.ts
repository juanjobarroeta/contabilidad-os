import type Anthropic from "@anthropic-ai/sdk";
import { DOCUMENT_KINDS } from "./contract";

const str = { type: "string" };
const taxes = { type: "array", maxItems: 10, items: { type: "object", properties: {
  type: { type: "string", enum: ["IVA", "ISR", "IEPS"] }, rate: { type: "number", minimum: 0, maximum: 1 },
  factor: { type: "string", enum: ["Tasa", "Exento"] }, withholding: { type: "boolean" },
}, required: ["type", "rate", "factor", "withholding"], additionalProperties: false } };

export const documentTools: Anthropic.Tool[] = [
  { name: "reporte_facturas", description: "Arma un REPORTE de facturas de esta empresa y lo entrega en el chat con descargas: Excel (renglón por CFDI con subtotal, descuento, IVA, retenciones, total, método, estado, pagado y saldo) y ZIP con los XML. Úsalo cuando pidan «las facturas de X», «lo que nos facturó Y en tal periodo», «facturas pendientes de cobro/pago de A y B», «descárgame las facturas…». Traduce el periodo a fechas AAAA-MM-DD (p. ej. «el primer trimestre de 2026» → 2026-01-01 a 2026-03-31). Contrapartes por nombre o RFC tal como las dice el usuario; si la respuesta trae `aclarar`, pregunta cuál de los candidatos es — no escojas tú. Las cifras del resumen vienen de la consulta: repítelas, no las recalcules ni inventes. Entregar el archivo aquí no autoriza enviarlo a terceros.", input_schema: {
    type: "object", properties: {
      contrapartes: { type: "array", maxItems: 20, items: { type: "string" }, description: "Nombres o RFC de clientes/proveedores. Vacío = todas." },
      desde: { type: "string", description: "AAAA-MM-DD" }, hasta: { type: "string", description: "AAAA-MM-DD" },
      direccion: { type: "string", enum: ["EMITIDAS", "RECIBIDAS", "AMBAS"], description: "EMITIDAS = a clientes; RECIBIDAS = de proveedores." },
      tipos: { type: "array", maxItems: 4, items: { type: "string", enum: ["I", "E", "P", "N"] }, description: "I ingreso/gasto, E nota de crédito, P complemento de pago, N nómina. Vacío = todos." },
      estado: { type: "string", enum: ["VIGENTES", "CANCELADAS", "TODAS"] },
      metodoPago: { type: "string", enum: ["PUE", "PPD"] },
      saldo: { type: "string", enum: ["PAGADAS", "PENDIENTES", "TODAS"] },
    }, additionalProperties: false,
  } },
  { name: "buscar_documentos", description: "Recupera CFDIs, prefacturas, corridas y recibos de nómina de ESTA empresa. Usa nombre/RFC/UUID y fechas; devuelve tarjetas con archivos auténticos y vista previa. Para un documento antiguo recupera el existente; nunca lo generes o timbres de nuevo. Los archivos se entregan al usuario en el chat; enviar a terceros es otra acción y requiere petición expresa.", input_schema: {
    type: "object", properties: { kind: { type: "string", enum: ["factura", "prefactura", "nomina", "recibo_nomina"] }, q: str, date_from: str, date_to: str, cursor: { type: "integer", minimum: 0 } }, required: ["kind"], additionalProperties: false,
  } },
  { name: "mostrar_documento", description: "Entrega en el chat un documento contable real con vista ampliada y descargas: balanza, pólizas/libro, catálogo, papeles IVA/ISR/retenciones, CFDI, prefactura o nómina. Para reportes indica año/mes; para un documento concreto el ID que devolvieron las consultas. La tarjeta conserva empresa y periodo y consulta el motor; no redactes cifras inventadas. Balanza es la calculada en la app, no la presentada al SAT.", input_schema: {
    type: "object", properties: { kind: { type: "string", enum: [...DOCUMENT_KINDS] }, id: str, year: { type: "integer", minimum: 2000, maximum: 2100 }, month: { type: "integer", minimum: 1, maximum: 12 } }, required: ["kind"], additionalProperties: false,
  } },
  { name: "preparar_prefactura", description: "Crea una prefactura persistente SIN TIMBRAR usando el motor de facturación y entrega su PDF y tarjeta en este chat. Sólo cuando el usuario pide prepararla. Para público general pide la información global explícita (periodicity, months, year). Obtén el cliente real con query_customers y pregunta sólo lo faltante. Requiere claves SAT, método/forma/uso e impuestos explícitos; no infieras tasa o exención ni inventes pagos. Los precios son en MXN antes de impuestos. Timbrar requiere que el usuario revise el documento y pulse Confirmar y timbrar en su tarjeta; un sí en texto no timbra. No envía correos.", input_schema: {
    type: "object", properties: {
      global: { type: "object", properties: { periodicity: { type: "string", enum: ["day", "week", "fortnight", "month", "two_months"] }, months: str, year: { type: "integer", minimum: 2000, maximum: 2100 } }, required: ["periodicity", "months", "year"], additionalProperties: false },
      customer_id: str, forma_pago: str, metodo_pago: { type: "string", enum: ["PUE", "PPD"] }, uso_cfdi: str, notes: str,
      items: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", properties: {
        description: str, product_key: str, unit_key: str, quantity: { type: "number", exclusiveMinimum: 0 }, unit_price: { type: "number", exclusiveMinimum: 0 }, taxes,
      }, required: ["description", "product_key", "unit_key", "quantity", "unit_price", "taxes"], additionalProperties: false } },
    }, required: ["customer_id", "forma_pago", "metodo_pago", "uso_cfdi", "items"], additionalProperties: false,
  } },
  { name: "preparar_nomina", description: "Calcula una corrida ORDINARIA para empleados explícitamente seleccionados y entrega recibos borrador en este chat. Usa empleados existentes y el motor de nómina; no inventes salario, incidencias ni días pagados. Busca primero corridas existentes para no duplicar. Para recibos históricos usa buscar_documentos. No timbra ni dispersa: el usuario revisa empleados, fechas y desglose y confirma el timbrado del lote exacto desde la tarjeta.", input_schema: {
    type: "object", properties: {
      employee_ids: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: str },
      periodo_inicio: str, periodo_fin: str, fecha_pago: str, dias_pagados: { type: "number", exclusiveMinimum: 0, maximum: 31 },
    }, required: ["employee_ids", "periodo_inicio", "periodo_fin", "fecha_pago", "dias_pagados"], additionalProperties: false,
  } },
];
