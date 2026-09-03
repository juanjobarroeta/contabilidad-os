import { prisma } from "@/lib/prisma";
import {
  detectComplementosPendientes,
  detectComplementosRecibidosPendientes,
} from "@/lib/complementos";
import { computeTaxPosition } from "@/lib/impuestos";
import { checklistDeclaracion } from "@/lib/fiscal/checklist-declaracion";
import { getSatSyncStatus } from "@/lib/sat-status";
import { signFileToken, publicBaseUrl } from "@/lib/facturas/file-token";
import { previewTimbrar } from "@/lib/facturas/preview-timbrar";
import { previewComplemento } from "@/lib/complementos-preview";
import { listUnmatched, scoreCandidates } from "@/lib/conciliacion";
import { stagePendingConciliar } from "@/lib/whatsapp/pending-action";
import { searchFiscalKnowledge, getArticulo } from "@/lib/fiscal-kb/search";
import { stageChatPendingAction } from "@/lib/ai/pending-action";
import { contarSimilaresSinConciliar } from "@/lib/bancos/reglas-categorizacion";
import { nombreContraparte, rfcContraparte } from "@/lib/facturas/contraparte";
import { saldoInsolutoPpd } from "@/lib/facturas/saldo-ppd";
import { parseRepresentacion } from "@/lib/facturas/representacion";
import {
  computeEmpresasBriefing,
  empresasConEstadoCuentaVencido,
} from "@/lib/briefing/matutino";
import { DIAS_DEADLINE_AVISO } from "@/lib/briefing/matutino-format";
import type { FamiliaConcepto } from "@/lib/bancos/categorizar-concepto";

type ToolInput = Record<string, unknown>;

/**
 * Extra context for write/propose tools.
 *  - conversationId: which conversation a proposal is staged on (WhatsApp or chat).
 *  - inApp: true for the in-app AI chat. The reversible "proponer_*" tools only
 *    work in-app (the chat renders the Confirm/Cancel card); they refuse over
 *    WhatsApp (which has its own preview_/code flow).
 *  - userId: quién hace la consulta. Necesario para las herramientas de CARTERA
 *    (`query_despacho_panorama`), que agregan a través de TODAS las empresas
 *    accesibles del usuario — no de la empresa activa. La lista de empresas se
 *    deriva del propio userId (misma fuente que la app), así que la herramienta
 *    nunca expone datos de empresas que el usuario no administra.
 */
export type ToolContext = { conversationId?: string; inApp?: boolean; userId?: string };

const MXN = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });

export async function executeToolCall(
  toolName: string,
  input: ToolInput,
  companyId: string,
  context: ToolContext = {}
): Promise<string> {
  switch (toolName) {
    case "preview_factura":
      return previewTimbrar(input, companyId, {
        conversationId: context.conversationId,
        userId: context.userId,
        inApp: context.inApp,
      });
    case "preview_complemento":
      return previewComplemento(input, companyId, {
        conversationId: context.conversationId,
        userId: context.userId,
        inApp: context.inApp,
      });
    case "list_unmatched_transactions":
      return JSON.stringify(
        await listUnmatched(companyId, typeof input.limit === "number" ? input.limit : 10)
      );
    case "preview_conciliacion":
      return previewConciliacion(input, companyId, context.conversationId);
    case "proponer_conciliacion":
      return proponerConciliacion(input, companyId, context);
    case "proponer_categorizacion":
      return proponerCategorizacion(input, companyId, context);
    case "proponer_categorizacion_lote":
      return proponerCategorizacionLote(input, companyId, context);
    case "proponer_resolver_hallazgo":
      return proponerResolverHallazgo(input, companyId, context);
    case "proponer_posponer_hallazgo":
      return proponerPosponerHallazgo(input, companyId, context);
    case "proponer_marcar_pendiente":
      return proponerMarcarPendiente(input, companyId, context);
    case "query_invoices":
      return queryInvoices(input, companyId);
    case "get_invoice_detail":
      return getInvoiceDetail(input, companyId);
    case "query_cancelaciones":
      return queryCancelaciones(input, companyId);
    case "query_ppd_cartera":
      return queryPpdCartera(input, companyId);
    case "query_bank_transactions":
      return queryBankTransactions(input, companyId);
    case "query_tax_declarations":
      return queryTaxDeclarations(input, companyId);
    case "query_dashboard_kpis":
      return queryDashboardKpis(companyId);
    case "query_customers":
      return queryCustomers(input, companyId);
    case "query_employees":
      return queryEmployees(input, companyId);
    case "query_obligations":
      return queryObligations(input, companyId);
    case "categorize_transaction":
      return categorizeTransaction(input, companyId);
    case "suggest_reconciliation_match":
      return suggestReconciliationMatch(input, companyId);
    case "analyze_anomalies":
      return analyzeAnomalies(input, companyId);
    case "query_declaracion_checklist": {
      // El periodo que se declara es, por defecto, el mes VENCIDO (anterior al
      // actual): en junio se declara mayo. El modelo puede pedir otro periodo.
      const now = new Date();
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const year = typeof input.year === "number" ? input.year : prev.getFullYear();
      const month = typeof input.month === "number" ? input.month : prev.getMonth() + 1;
      const checklist = await checklistDeclaracion(companyId, year, month);
      return JSON.stringify({
        ...checklist,
        instruccion_para_el_asistente:
          "Presenta el checklist en el orden dado: primero los puntos en 'atencion' y 'pendiente' con su 'detalle' textual, y después confirma brevemente lo que está 'listo' (omite los 'no-aplica'). Menciona siempre la fecha límite y los días restantes, o que ya venció. No inventes montos ni conteos: usa los del checklist.",
      });
    }
    case "query_despacho_panorama":
      return queryDespachoPanorama(context);
    case "query_complementos_pendientes":
      return JSON.stringify(await detectComplementosPendientes(companyId));
    case "query_complementos_recibidos_pendientes":
      return JSON.stringify(await detectComplementosRecibidosPendientes(companyId));
    case "query_sat_sync_status":
      return JSON.stringify(await getSatSyncStatus(companyId));
    case "get_invoice_files":
      return getInvoiceFiles(input, companyId);
    case "query_tax_position": {
      // Período por defecto = el EN JUEGO (mismo criterio que el dashboard):
      // del 1 al ~17 se trabaja el mes ANTERIOR (vence el 17); sólo cuando su
      // declaración ya está presentada se avanza al mes en curso. El modelo
      // puede pedir otro periodo explícito con year/month.
      const now = new Date();
      let year: number;
      let month: number;
      if (typeof input.year === "number" && typeof input.month === "number") {
        year = input.year;
        month = input.month;
      } else {
        const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const prevPeriodo = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
        const presentado = await prisma.taxDeclaration.findFirst({
          where: {
            companyId,
            tipo: "IVA_MENSUAL",
            periodo: prevPeriodo,
            status: { in: ["FILED", "PAID"] },
          },
          select: { id: true },
        });
        year = presentado ? now.getFullYear() : prev.getFullYear();
        month = presentado ? now.getMonth() + 1 : prev.getMonth() + 1;
      }
      const pos = await computeTaxPosition(companyId, year, month);
      // Cadena de arrastre rota (mes con CFDIs sin declaración guardada): el
      // usuario de WhatsApp/chat DEBE enterarse — las cifras pueden estar
      // sobrestimadas por tomar en cero el saldo a favor / pagos provisionales.
      return JSON.stringify(
        pos.advertencias.length > 0
          ? {
              ...pos,
              instruccion_para_el_asistente:
                "Comunica al usuario TODAS las 'advertencias' tal cual, antes de las cifras: los montos pueden estar sobrestimados por falta de declaraciones guardadas.",
            }
          : pos
      );
    }
    // Knowledge base de legislación fiscal — company-independent (es ley, no
    // datos de la empresa), por eso ignora companyId.
    case "search_fiscal_knowledge":
      try {
        return JSON.stringify(
          await searchFiscalKnowledge(String(input.query ?? ""), {
            fechaVigencia: typeof input.fecha_vigencia === "string" ? new Date(input.fecha_vigencia) : undefined,
            fuentes: Array.isArray(input.fuentes) ? input.fuentes.map(String) : undefined,
            limit: typeof input.limit === "number" ? input.limit : undefined,
            // El embedding de la consulta se cobra a la empresa/usuario que
            // preguntó (la ley es común, el gasto no).
            cost: { companyId, userId: context.userId ?? null },
          })
        );
      } catch (err) {
        // KB aún no aprovisionado (sin pgvector/ingesta/OPENAI_API_KEY) — que
        // el modelo lo diga honestamente en vez de tumbar el chat.
        console.error("[search_fiscal_knowledge]", err);
        return JSON.stringify({
          error: "Knowledge base fiscal no disponible en este momento.",
          instruccion: "Indica al usuario que no puedes citar fundamento legal ahora; NO inventes artículos.",
        });
      }
    case "get_articulo":
      try {
        const art = await getArticulo(
          String(input.ley ?? ""),
          String(input.articulo ?? ""),
          typeof input.fecha_vigencia === "string" ? new Date(input.fecha_vigencia) : undefined
        );
        return JSON.stringify(
          art ?? {
            error: `No hay ${String(input.ley)} artículo/regla ${String(input.articulo)} vigente en el knowledge base.`,
            instruccion: "Dilo al usuario; NO reconstruyas el artículo de memoria. Prueba search_fiscal_knowledge con la pregunta.",
          }
        );
      } catch (err) {
        console.error("[get_articulo]", err);
        return JSON.stringify({ error: "Knowledge base fiscal no disponible en este momento.", instruccion: "NO inventes el texto del artículo." });
      }
    default:
      return JSON.stringify({ error: `Herramienta desconocida: ${toolName}` });
  }
}

// ─── Herramientas de PROPUESTA (acciones reversibles, in-app) ────────────────
// Cada una STAGEA una propuesta sobre la conversación del chat y devuelve un
// resumen + token. NO ejecutan: la ejecución ocurre cuando el usuario toca
// "Confirmar" (POST /api/ai/confirm). Sólo operan en el chat in-app.

/** Respuesta estándar de una propuesta exitosa para el modelo. */
function propuestaStaged(summary: string, token: string) {
  return JSON.stringify({
    staged: true,
    summary,
    confirm_token: token,
    instruccion_para_el_asistente:
      "Resume al usuario EXACTAMENTE lo que pasará y dile que toque el botón Confirmar de la tarjeta. " +
      "NO digas que ya se hizo: sólo ocurre cuando el usuario toca Confirmar. No repitas el token.",
  });
}

function requiereInApp(context: ToolContext): string | null {
  if (!context.inApp || !context.conversationId) {
    return JSON.stringify({
      error: "Las propuestas con confirmación sólo están disponibles en el asistente dentro de la app.",
    });
  }
  return null;
}

const FAMILIA_LABEL: Record<FamiliaConcepto, string> = {
  COMISION: "Comisiones bancarias",
  TAX_PAYMENT: "Impuestos y derechos",
  PAYROLL_NO_CFDI: "Nómina sin CFDI",
  INTERNAL_TRANSFER: "Traspaso entre cuentas propias",
  FINANCIAL_INCOME: "Intereses / rendimientos",
  RENT: "Renta / arrendamiento",
  NON_DEDUCTIBLE: "Gasto no deducible",
  LOAN_RECEIVED: "Préstamo recibido",
  LOAN_GIVEN: "Préstamo otorgado",
};

async function proponerConciliacion(input: ToolInput, companyId: string, context: ToolContext): Promise<string> {
  const guard = requiereInApp(context);
  if (guard) return guard;
  const txId = String(input.transaction_id ?? "");
  const invoiceId = String(input.invoice_id ?? "");
  if (!txId || !invoiceId) return JSON.stringify({ error: "Faltan transaction_id e invoice_id." });

  const tx = await prisma.bankTransaction.findFirst({
    where: { id: txId, companyId },
    select: {
      fecha: true,
      descripcion: true,
      monto: true,
      status: true,
      invoiceId: true,
      conciliacionDetalles: { select: { id: true }, take: 1 },
    },
  });
  if (!tx) return JSON.stringify({ error: "Movimiento no encontrado." });
  if (tx.invoiceId || tx.conciliacionDetalles.length > 0) {
    return JSON.stringify({ error: "El movimiento ya está conciliado." });
  }

  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, companyId },
    select: { total: true, fecha: true, customer: { select: { razonSocial: true } } },
  });
  if (!inv) return JSON.stringify({ error: "Factura no encontrada para esta empresa." });

  const invTotal = Number(inv.total);
  const montoMatch = Math.abs(Number(tx.monto)).toFixed(2) === invTotal.toFixed(2);
  const summary =
    `Conciliar el movimiento del ${tx.fecha.toISOString().slice(0, 10)} ` +
    `(${tx.descripcion}, ${MXN(Number(tx.monto))}) con la factura de ` +
    `${inv.customer?.razonSocial ?? "—"} (${MXN(invTotal)}). ` +
    (montoMatch ? "Los montos coinciden." : "Atención: los montos NO coinciden exactamente.");

  const pa = await stageChatPendingAction(context.conversationId!, companyId, summary, {
    type: "conciliar",
    payload: { txId, invoiceId },
  });
  return propuestaStaged(summary, pa.token);
}

async function proponerCategorizacion(input: ToolInput, companyId: string, context: ToolContext): Promise<string> {
  const guard = requiereInApp(context);
  if (guard) return guard;
  const txId = String(input.transaction_id ?? "");
  const familia = String(input.familia ?? "") as FamiliaConcepto;
  if (!txId || !FAMILIA_LABEL[familia]) {
    return JSON.stringify({ error: "Falta transaction_id o la familia es inválida." });
  }

  const tx = await prisma.bankTransaction.findFirst({
    where: { id: txId, companyId },
    select: {
      fecha: true,
      descripcion: true,
      monto: true,
      invoiceId: true,
      conciliacionDetalles: { select: { id: true }, take: 1 },
    },
  });
  if (!tx) return JSON.stringify({ error: "Movimiento no encontrado." });
  if (tx.invoiceId || tx.conciliacionDetalles.length > 0) {
    return JSON.stringify({ error: "El movimiento ya está conciliado con un CFDI." });
  }

  const summary =
    `Categorizar el movimiento del ${tx.fecha.toISOString().slice(0, 10)} ` +
    `(${tx.descripcion}, ${MXN(Number(tx.monto))}) como "${FAMILIA_LABEL[familia]}" y registrar su asiento ` +
    `en el libro mayor.`;

  const pa = await stageChatPendingAction(context.conversationId!, companyId, summary, {
    type: "categorizacion",
    payload: { txId, familia },
  });
  return propuestaStaged(summary, pa.token);
}

async function proponerCategorizacionLote(input: ToolInput, companyId: string, context: ToolContext): Promise<string> {
  const guard = requiereInApp(context);
  if (guard) return guard;
  const patron = String(input.patron ?? "").trim();
  const familia = String(input.familia ?? "") as FamiliaConcepto;
  const signoRaw = input.signo === "CREDITO" || input.signo === "DEBITO" ? input.signo : undefined;
  if (!patron || !FAMILIA_LABEL[familia]) {
    return JSON.stringify({ error: "Falta el patrón o la familia es inválida." });
  }

  // Cuenta cuántos movimientos sin conciliar se verían afectados (para el resumen).
  const n = await contarSimilaresSinConciliar(companyId, patron, signoRaw);
  if (n === 0) {
    return JSON.stringify({
      error: `No hay movimientos sin conciliar cuya descripción contenga "${patron}".`,
    });
  }

  const summary =
    `Categorizar ${n} movimiento(s) sin conciliar que contienen "${patron}" ` +
    `como "${FAMILIA_LABEL[familia]}", registrar sus asientos en el libro mayor y ` +
    `guardar la regla para los próximos estados de cuenta.`;

  const pa = await stageChatPendingAction(context.conversationId!, companyId, summary, {
    type: "categorizacion_lote",
    payload: { patron, familia, signo: signoRaw, crearRegla: true },
  });
  return propuestaStaged(summary, pa.token);
}

async function proponerResolverHallazgo(input: ToolInput, companyId: string, context: ToolContext): Promise<string> {
  const guard = requiereInApp(context);
  if (guard) return guard;
  const hallazgoId = String(input.hallazgo_id ?? "");
  if (!hallazgoId) return JSON.stringify({ error: "Falta hallazgo_id." });

  const h = await prisma.fiscalHallazgo.findFirst({
    where: { id: hallazgoId, companyId },
    select: { mensaje: true, estado: true },
  });
  if (!h) return JSON.stringify({ error: "Hallazgo no encontrado." });
  if (h.estado === "RESUELTO") return JSON.stringify({ error: "El hallazgo ya está resuelto." });

  const summary = `Marcar como RESUELTO el hallazgo: "${h.mensaje.slice(0, 160)}".`;
  const pa = await stageChatPendingAction(context.conversationId!, companyId, summary, {
    type: "resolver_hallazgo",
    payload: { hallazgoId },
  });
  return propuestaStaged(summary, pa.token);
}

async function proponerPosponerHallazgo(input: ToolInput, companyId: string, context: ToolContext): Promise<string> {
  const guard = requiereInApp(context);
  if (guard) return guard;
  const hallazgoId = String(input.hallazgo_id ?? "");
  const plazo = String(input.plazo ?? "");
  if (!hallazgoId || !["7d", "30d", "fin_de_mes"].includes(plazo)) {
    return JSON.stringify({ error: "Falta hallazgo_id o el plazo es inválido." });
  }

  const h = await prisma.fiscalHallazgo.findFirst({
    where: { id: hallazgoId, companyId },
    select: { mensaje: true },
  });
  if (!h) return JSON.stringify({ error: "Hallazgo no encontrado." });

  const plazoLabel = plazo === "7d" ? "7 días" : plazo === "30d" ? "30 días" : "fin de mes";
  const summary = `Posponer ${plazoLabel} el hallazgo: "${h.mensaje.slice(0, 160)}".`;
  const pa = await stageChatPendingAction(context.conversationId!, companyId, summary, {
    type: "posponer_hallazgo",
    payload: { hallazgoId, token: plazo as "7d" | "30d" | "fin_de_mes" },
  });
  return propuestaStaged(summary, pa.token);
}

async function proponerMarcarPendiente(input: ToolInput, companyId: string, context: ToolContext): Promise<string> {
  const guard = requiereInApp(context);
  if (guard) return guard;
  const itemId = String(input.pendiente_id ?? "");
  const accion = String(input.accion ?? "");
  if (!itemId || !["hecho", "posponer"].includes(accion)) {
    return JSON.stringify({ error: "Falta pendiente_id o la acción es inválida." });
  }

  const item = await prisma.notificationItem.findFirst({
    where: { id: itemId, companyId },
    select: { titulo: true, estado: true },
  });
  if (!item) return JSON.stringify({ error: "Pendiente no encontrado para esta empresa." });

  const summary =
    accion === "hecho"
      ? `Marcar como HECHO el pendiente: "${item.titulo}".`
      : `Posponer 7 días el pendiente: "${item.titulo}".`;
  const pa = await stageChatPendingAction(context.conversationId!, companyId, summary, {
    type: "marcar_pendiente",
    payload: { itemId, accion: accion as "hecho" | "posponer" },
  });
  return propuestaStaged(summary, pa.token);
}

// ─── query_invoices ──────────────────────────────────────────────────────────

async function previewConciliacion(
  input: ToolInput,
  companyId: string,
  conversationId?: string
): Promise<string> {
  if (!conversationId) {
    return JSON.stringify({ error: "La conciliación con confirmación solo está disponible por WhatsApp." });
  }
  const txId = String(input.transaction_id ?? "");
  const invoiceId = String(input.invoice_id ?? "");
  if (!txId || !invoiceId) {
    return JSON.stringify({ error: "Faltan transaction_id e invoice_id." });
  }

  // Validate both belong to the company and build a preview.
  const { tx, candidates } = await scoreCandidates(txId, companyId);
  if (!tx) return JSON.stringify({ error: "Movimiento no encontrado." });
  const cand = candidates.find((c) => c.invoiceId === invoiceId);

  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, companyId },
    select: { id: true, uuid: true, total: true, fecha: true, customer: { select: { razonSocial: true } } },
  });
  if (!inv) return JSON.stringify({ error: "Factura no encontrada para esta empresa." });

  const MXN = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
  const invTotal = Number(inv.total);
  const montoMatch = Math.abs(tx.monto).toFixed(2) === invTotal.toFixed(2);
  const preview =
    `Movimiento: ${tx.fecha} · ${tx.descripcion} · ${MXN(tx.monto)}\n` +
    `Factura: ${inv.customer?.razonSocial ?? "—"} · ${MXN(invTotal)} · ${inv.fecha.toISOString().slice(0, 10)}\n` +
    `${montoMatch ? "Los montos coinciden ✅" : "⚠️ Los montos NO coinciden exactamente — revisa."}`;

  const { code } = await stagePendingConciliar(conversationId, companyId, { txId, invoiceId }, preview);
  return JSON.stringify({
    staged: true,
    preview,
    confianza: cand?.confidence ?? "baja",
    instruccion_para_el_asistente:
      `Muestra el resumen y pide al usuario que confirme con el código ${code} para conciliar, o 'cancelar'. ` +
      `NO digas que ya se concilió — solo ocurre cuando el usuario envía el código.`,
    codigo_confirmacion: code,
  });
}

async function getInvoiceFiles(input: ToolInput, companyId: string): Promise<string> {
  const where: Record<string, unknown> = { companyId };
  if (input.uuid) where.uuid = String(input.uuid).toUpperCase();
  if (input.date_from || input.date_to) {
    where.fecha = {
      ...(input.date_from ? { gte: new Date(String(input.date_from)) } : {}),
      ...(input.date_to ? { lte: new Date(`${input.date_to}T23:59:59`) } : {}),
    };
  }
  if (input.cliente) {
    where.customer = {
      OR: [
        { razonSocial: { contains: String(input.cliente), mode: "insensitive" } },
        { rfc: { contains: String(input.cliente).toUpperCase() } },
      ],
    };
  }
  const limit = typeof input.limit === "number" ? Math.min(input.limit, 20) : 10;

  const invoices = await prisma.invoice.findMany({
    where,
    select: {
      id: true, uuid: true, fecha: true, total: true,
      rawXml: true, facturapiId: true,
      customer: { select: { razonSocial: true } },
    },
    orderBy: { fecha: "desc" },
    take: limit,
  });

  if (invoices.length === 0) {
    return JSON.stringify({ count: 0, message: "No encontré facturas con esos criterios." });
  }

  const base = publicBaseUrl();
  const files = invoices.map((inv) => {
    const hasXml = !!inv.rawXml;
    const hasPdf = !!inv.facturapiId;
    return {
      uuid: inv.uuid,
      fecha: inv.fecha.toISOString().slice(0, 10),
      cliente: inv.customer?.razonSocial ?? null,
      total: inv.total,
      xmlUrl: hasXml ? `${base}/api/facturas/${inv.id}/file?format=xml&token=${signFileToken(inv.id, "xml")}` : null,
      pdfUrl: hasPdf ? `${base}/api/facturas/${inv.id}/file?format=pdf&token=${signFileToken(inv.id, "pdf")}` : null,
      nota: !hasXml ? "XML no disponible (factura importada antes de guardarse el archivo)" : (!hasPdf ? "Solo XML disponible (las facturas del SAT no tienen PDF)" : undefined),
    };
  });

  return JSON.stringify({
    count: files.length,
    files,
    instrucciones: "Comparte los enlaces con el usuario. Son temporales (30 min). Si falta el XML, explícale que esa factura se importó antes de que guardáramos el archivo.",
  });
}

// ─── query_despacho_panorama (CARTERA — cruza todas las empresas) ────────────
// Responde preguntas "a nivel despacho" ("¿qué estados de cuenta me faltan?",
// "¿dónde tengo vencimientos?", "¿en qué empresas hay hallazgos?") agregando a
// través de TODAS las empresas que el usuario administra. Reusa la misma capa de
// datos del briefing matutino (computeEmpresasBriefing), que ya deriva las
// empresas accesibles del userId con el mismo aislamiento por inquilino que la
// app — la empresa "activa" de la conversación NO acota esta herramienta.
async function queryDespachoPanorama(context: ToolContext): Promise<string> {
  if (!context.userId) {
    return JSON.stringify({
      error: "No puedo identificar tu cuenta para consultar la cartera completa.",
    });
  }

  const empresas = await computeEmpresasBriefing(context.userId);
  if (empresas.length === 0) {
    return JSON.stringify({ totalEmpresas: 0, message: "No administras ninguna empresa activa." });
  }
  if (empresas.length === 1) {
    return JSON.stringify({
      totalEmpresas: 1,
      instruccion_para_el_asistente:
        "El usuario sólo administra una empresa, así que no hay panorama de cartera que dar. " +
        "Responde con las herramientas normales por empresa (query_dashboard_kpis, etc.).",
    });
  }

  const estadosCuentaPendientes = empresasConEstadoCuentaVencido(empresas).map((e) => ({
    razonSocial: e.razonSocial,
    diasSinMovimiento: e.diasSinMovimiento,
    // null ⇒ nunca se ha subido un movimiento para esa empresa.
    nuncaHaSubido: e.diasSinMovimiento == null,
  }));

  const proximosVencimientos = empresas
    .filter((e) => e.proxDeadline && e.proxDeadline.diasRestantes <= DIAS_DEADLINE_AVISO)
    .sort((a, b) => a.proxDeadline!.diasRestantes - b.proxDeadline!.diasRestantes)
    .map((e) => ({
      razonSocial: e.razonSocial,
      periodo: e.proxDeadline!.periodo,
      diasRestantes: e.proxDeadline!.diasRestantes,
    }));

  const conHallazgos = empresas
    .filter((e) => e.hallazgosAbiertos > 0)
    .sort((a, b) => b.hallazgosCriticos - a.hallazgosCriticos || b.hallazgosAbiertos - a.hallazgosAbiertos)
    .map((e) => ({
      razonSocial: e.razonSocial,
      abiertos: e.hallazgosAbiertos,
      criticos: e.hallazgosCriticos,
    }));

  return JSON.stringify({
    totalEmpresas: empresas.length,
    empresas: empresas.map((e) => e.razonSocial),
    estadosCuentaPendientes,
    proximosVencimientos,
    hallazgos: conHallazgos,
    totalHallazgosCriticos: empresas.reduce((s, e) => s + e.hallazgosCriticos, 0),
    instruccion_para_el_asistente:
      "Es un resumen a nivel CARTERA (todas las empresas del usuario), no de la empresa activa. " +
      "Responde la pregunta del usuario con estos datos: para '¿qué estados de cuenta me faltan?' " +
      "lista 'estadosCuentaPendientes' por razón social (di 'nunca has subido' si nuncaHaSubido). " +
      "Menciona conteos, no inventes cifras. Si una lista viene vacía, dilo (p.ej. 'estás al día con los estados de cuenta'). " +
      "Para detalles de UNA empresa, ofrece cambiar el foco a ella (el usuario escribe 'cambiar a [nombre de la empresa]').",
  });
}

async function queryInvoices(input: ToolInput, companyId: string) {
  const where: Record<string, unknown> = { companyId };

  if (input.tipo) where.tipo = input.tipo;
  if (input.status) where.status = input.status;
  if (input.date_from || input.date_to) {
    where.fecha = {
      ...(input.date_from ? { gte: new Date(input.date_from as string) } : {}),
      ...(input.date_to ? { lte: new Date(input.date_to as string) } : {}),
    };
  }
  if (input.customer_rfc) {
    where.customer = { rfc: input.customer_rfc };
  }
  if (input.metodo_pago) where.metodoPago = input.metodo_pago;
  // Búsqueda libre: folio, UUID, nombre o RFC de la contraparte — incluyendo la
  // denormalizada del comprobante (público en general no tiene Customer).
  if (input.q) {
    const q = String(input.q);
    where.OR = [
      { uuid: { contains: q, mode: "insensitive" } },
      { folio: { contains: q, mode: "insensitive" } },
      { contraparteNombre: { contains: q, mode: "insensitive" } },
      { contraparteRfc: { contains: q, mode: "insensitive" } },
      { customer: { razonSocial: { contains: q, mode: "insensitive" } } },
      { customer: { rfc: { contains: q, mode: "insensitive" } } },
    ];
  }

  if (input.summary_only) {
    const [agg, count] = await Promise.all([
      prisma.invoice.aggregate({ where, _sum: { subtotal: true, total: true, totalImpuestos: true } }),
      prisma.invoice.count({ where }),
    ]);
    return JSON.stringify({
      count,
      subtotal: agg._sum.subtotal ?? 0,
      total: agg._sum.total ?? 0,
      totalImpuestos: agg._sum.totalImpuestos ?? 0,
    });
  }

  const invoices = await prisma.invoice.findMany({
    where,
    include: { customer: { select: { razonSocial: true, rfc: true } } },
    orderBy: { fecha: "desc" },
    take: Math.min((input.limit as number) || 20, 50),
  });

  // Direction: INGRESO/EGRESO imply it directly; for NOMINA/PAGO it comes from
  // the SAT import tag in `notas` ("emitidos"/"recibidos"). Direction is what
  // determines income vs. expense — critical to get right.
  const directionOf = (inv: { tipo: string; notas: string | null }): "EMITIDO" | "RECIBIDO" | "DESCONOCIDO" => {
    if (inv.tipo === "INGRESO") return "EMITIDO";
    if (inv.tipo === "EGRESO") return "RECIBIDO";
    const n = (inv.notas ?? "").toLowerCase();
    if (n.includes("emitido")) return "EMITIDO";
    if (n.includes("recibido")) return "RECIBIDO";
    return "DESCONOCIDO";
  };

  const interpret = (tipo: string, dir: string): string => {
    if (tipo === "NOMINA") {
      if (dir === "RECIBIDO") return "CFDI de nómina que TE pagaron (sueldos o asimilados a salarios): es tu INGRESO, NO un gasto deducible tuyo.";
      if (dir === "EMITIDO") return "Nómina que TÚ pagaste como patrón: es tu gasto/deducción.";
    }
    if (tipo === "INGRESO") return "Factura que emitiste: tu ingreso.";
    if (tipo === "EGRESO") return "Factura que recibiste de un proveedor: tu gasto.";
    return "";
  };

  return JSON.stringify({
    _nota: "Revisa 'direccion' e 'interpretacion' para no confundir ingreso vs gasto. Un CFDI de nómina RECIBIDO es ingreso tuyo, no gasto.",
    facturas: invoices.map((inv) => {
      const direccion = directionOf(inv);
      return {
        id: inv.id,
        tipo: inv.tipo,
        direccion, // EMITIDO = tú lo expediste · RECIBIDO = te lo expidieron
        interpretacion: interpret(inv.tipo, direccion),
        fecha: inv.fecha.toISOString().substring(0, 10),
        // Customer cuando existe; si no, lo que trae el propio comprobante
        // (público en general y extranjeros no llevan Customer a propósito).
        contraparte: nombreContraparte(inv),
        contraparteRfc: rfcContraparte(inv),
        subtotal: inv.subtotal,
        total: inv.total,
        status: inv.status,
        uuid: inv.uuid,
        formaPago: inv.formaPago,
        metodoPago: inv.metodoPago,
      };
    }),
  });
}

// ─── get_invoice_detail ──────────────────────────────────────────────────────

/**
 * Detalle COMPLETO de un CFDI: conceptos, desglose de impuestos, contraparte
 * con régimen (del XML), estatus de cancelación con sustitución, y saldo PPD
 * con sus complementos de pago. Es la herramienta que quita la venda al
 * asistente: antes sólo veía encabezados.
 */
async function getInvoiceDetail(input: ToolInput, companyId: string): Promise<string> {
  const uuid = input.uuid ? String(input.uuid).toUpperCase() : null;
  const folio = input.folio ? String(input.folio) : null;
  if (!uuid && !folio) {
    return JSON.stringify({ error: "Indica uuid (folio fiscal) o folio interno de la factura." });
  }

  const invoice = await prisma.invoice.findFirst({
    where: uuid
      ? { companyId, uuid: { equals: uuid, mode: "insensitive" } }
      : { companyId, folio: { equals: folio as string, mode: "insensitive" } },
    include: {
      customer: { select: { razonSocial: true, rfc: true, regimenFiscal: true } },
      items: true,
      taxes: true,
      doctosRelacionados: true,
    },
    orderBy: { fecha: "desc" }, // con folio repetido, la más reciente
  });
  if (!invoice) {
    return JSON.stringify({
      error: `No encontré la factura ${uuid ?? folio}. Prueba con query_invoices y el parámetro q para buscarla.`,
    });
  }

  // Vista del XML: régimen y uso que las columnas no guardan, y el respaldo de
  // conceptos/impuestos para CFDIs importados antes de que se parsearan.
  let delXml: Record<string, unknown> | null = null;
  if (invoice.rawXml) {
    try {
      const rep = parseRepresentacion(invoice.rawXml);
      delXml = {
        emisor: rep.emisor,
        receptor: rep.receptor,
        ...(invoice.items.length === 0 && rep.conceptos.length > 0
          ? { conceptos: rep.conceptos }
          : {}),
        ...(invoice.taxes.length === 0
          ? { traslados: rep.traslados, retenciones: rep.retenciones }
          : {}),
      };
    } catch {
      /* XML ilegible: el detalle de BD sigue siendo válido */
    }
  }

  // PPD: complementos que la pagan y saldo vivo.
  let ppd: Record<string, unknown> | null = null;
  if (invoice.metodoPago === "PPD" && invoice.uuid && invoice.tipo !== "PAGO") {
    const doctos = await prisma.pagoDoctoRelacionado.findMany({
      // parentUuid indexa CROSS-empresa: el filtro por pagoInvoice.companyId
      // es obligatorio para no leer complementos de otra empresa.
      where: {
        parentUuid: { equals: invoice.uuid, mode: "insensitive" },
        pagoInvoice: { companyId, status: { not: "CANCELLED" } },
      },
      include: { pagoInvoice: { select: { uuid: true, fecha: true, status: true } } },
      orderBy: { fechaPago: "asc" },
    }).then((rows) =>
      rows.map((d) => ({
        ...d,
        impPagado: d.impPagado === null ? null : Number(d.impPagado),
        impSaldoInsoluto: d.impSaldoInsoluto === null ? null : Number(d.impSaldoInsoluto),
      })),
    );
    const s = saldoInsolutoPpd(Number(invoice.total), doctos);
    ppd = {
      saldoInsoluto: s.saldo,
      cobrado: s.pagado,
      parcialidades: s.parcialidades,
      ultimoPagoLegal: s.ultimoPago?.toISOString().slice(0, 10) ?? null,
      complementos: doctos.map((d) => ({
        repUuid: d.pagoInvoice.uuid,
        fechaPago: d.fechaPago?.toISOString().slice(0, 10) ?? null,
        parcialidad: d.numParcialidad,
        pagado: d.impPagado,
        saldoDespues: d.impSaldoInsoluto,
      })),
    };
  }

  // Cancelación: motivo, y si otra factura VIVA la sustituye (refacturación —
  // el ingreso no desapareció, sólo cambió de UUID).
  let cancelacion: Record<string, unknown> | null = null;
  if (invoice.status === "CANCELLED" && invoice.uuid) {
    const sustituta = await prisma.invoice.findFirst({
      where: {
        companyId,
        status: { not: "CANCELLED" },
        cfdiRelacionadoUuid: { equals: invoice.uuid, mode: "insensitive" },
      },
      select: { uuid: true, folio: true, fecha: true, total: true },
    });
    cancelacion = {
      canceladaAt: invoice.canceladaAt?.toISOString().slice(0, 10) ?? null,
      motivo: invoice.cancelMotivo,
      sustituidaPor: sustituta,
      interpretacion: sustituta
        ? "Refacturación: existe una factura viva que la sustituye — el ingreso no desapareció, sólo cambió de UUID."
        : "Cancelada SIN sustituta: si su mes ya se declaró, ese ingreso/gasto salió de la base y puede ameritar revisar el periodo.",
    };
  }

  return JSON.stringify({
    uuid: invoice.uuid,
    tipo: invoice.tipo,
    status: invoice.status,
    fecha: invoice.fecha.toISOString().slice(0, 10),
    serie: invoice.serie,
    folio: invoice.folio,
    contraparte: nombreContraparte(invoice),
    contraparteRfc: rfcContraparte(invoice),
    regimenContraparte: invoice.customer?.regimenFiscal ?? null,
    metodoPago: invoice.metodoPago,
    formaPago: invoice.formaPago,
    usoCfdi: invoice.usoCfdi,
    moneda: invoice.moneda,
    subtotal: invoice.subtotal,
    descuento: invoice.descuento,
    totalImpuestos: invoice.totalImpuestos,
    total: invoice.total,
    naturaleza: invoice.naturaleza,
    conceptos: invoice.items.map((it) => ({
      descripcion: it.descripcion,
      claveProdServ: it.claveProdServ,
      cantidad: it.cantidad,
      valorUnitario: it.valorUnitario,
      importe: it.importe,
      descuento: it.descuento,
    })),
    impuestos: invoice.taxes.map((t) => ({
      tipo: t.tipo,
      factor: t.factor,
      tasa: t.tasa,
      base: t.base,
      importe: t.importe,
      retencion: t.retencion,
    })),
    // REP (tipo PAGO): a qué facturas aplica este complemento.
    ...(invoice.tipo === "PAGO" && invoice.doctosRelacionados.length > 0
      ? {
          pagaA: invoice.doctosRelacionados.map((d) => ({
            facturaUuid: d.parentUuid,
            fechaPago: d.fechaPago?.toISOString().slice(0, 10) ?? null,
            pagado: d.impPagado,
            parcialidad: d.numParcialidad,
          })),
        }
      : {}),
    ...(ppd ? { ppd } : {}),
    ...(cancelacion ? { cancelacion } : {}),
    ...(delXml ? { delXml } : {}),
    vigenciaVerificadaAt: invoice.vigenciaCheckedAt?.toISOString().slice(0, 10) ?? null,
  });
}

// ─── query_cancelaciones ─────────────────────────────────────────────────────

/**
 * Facturas canceladas del periodo con análisis de SUSTITUCIÓN: la pregunta que
 * importa no es cuántas se cancelaron sino cuáles NO tienen factura sustituta —
 * ésas sacaron ingreso/gasto de una base posiblemente ya declarada.
 */
async function queryCancelaciones(input: ToolInput, companyId: string): Promise<string> {
  const where: Record<string, unknown> = { companyId, status: "CANCELLED" };
  // `por`: emision (default) filtra por fecha del CFDI; cancelacion, por cuándo
  // se canceló (canceladaAt puede ser null en detecciones del barrido).
  const campo = input.por === "cancelacion" ? "canceladaAt" : "fecha";
  if (input.date_from || input.date_to) {
    where[campo] = {
      ...(input.date_from ? { gte: new Date(String(input.date_from)) } : {}),
      ...(input.date_to ? { lte: new Date(`${input.date_to}T23:59:59`) } : {}),
    };
  }

  const canceladas = await prisma.invoice.findMany({
    where,
    select: {
      uuid: true, tipo: true, fecha: true, canceladaAt: true, cancelMotivo: true,
      total: true, contraparteNombre: true, contraparteRfc: true,
      customer: { select: { razonSocial: true, rfc: true } },
    },
    orderBy: { fecha: "desc" },
    take: Math.min((input.limit as number) || 50, 100),
  });
  if (canceladas.length === 0) {
    return JSON.stringify({ n: 0, mensaje: "Sin facturas canceladas en ese filtro." });
  }

  // Sustitución en UNA consulta: qué canceladas tienen una factura viva que las
  // referencia como CFDI relacionado.
  const uuids = canceladas.map((c) => c.uuid).filter((u): u is string => u != null);
  const sustitutas = await prisma.invoice.findMany({
    where: { companyId, status: { not: "CANCELLED" }, cfdiRelacionadoUuid: { in: uuids, mode: "insensitive" } },
    select: { cfdiRelacionadoUuid: true, uuid: true, total: true },
  });
  const porSustituida = new Map(sustitutas.map((s) => [s.cfdiRelacionadoUuid!.toUpperCase(), s]));

  const filas = canceladas.map((c) => {
    const sust = c.uuid ? porSustituida.get(c.uuid.toUpperCase()) ?? null : null;
    return {
      uuid: c.uuid,
      tipo: c.tipo,
      fecha: c.fecha.toISOString().slice(0, 10),
      canceladaAt: c.canceladaAt?.toISOString().slice(0, 10) ?? null,
      motivo: c.cancelMotivo,
      total: Number(c.total),
      contraparte: nombreContraparte(c),
      conSustituta: sust != null,
      sustitutaUuid: sust?.uuid ?? null,
    };
  });

  const sinSustituta = filas.filter((f) => !f.conSustituta && f.tipo !== "PAGO");
  return JSON.stringify({
    n: filas.length,
    totalCancelado: filas.reduce((s, f) => s + f.total, 0),
    conSustituta: filas.filter((f) => f.conSustituta).length,
    sinSustituta: sinSustituta.length,
    montoSinSustituta: sinSustituta.reduce((s, f) => s + f.total, 0),
    facturas: filas,
    _nota:
      "conSustituta=true es refacturación (el ingreso sigue vivo bajo otro UUID — sin efecto en lo declarado). Las SIN sustituta en meses ya declarados son las que pueden ameritar revisar/corregir ese periodo. Los REPs (tipo PAGO) cancelados afectan el IVA en flujo del mes del pago, no el ingreso.",
  });
}

// ─── query_ppd_cartera ───────────────────────────────────────────────────────

/**
 * Cartera PPD: facturas a crédito con su saldo vivo, calculado desde los
 * complementos de pago. Responde "¿quién me debe y desde cuándo?".
 */
async function queryPpdCartera(input: ToolInput, companyId: string): Promise<string> {
  const soloConSaldo = input.solo_con_saldo !== false; // default: sólo lo vivo
  const parents = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo: "INGRESO",
      metodoPago: "PPD",
      status: "STAMPED",
      uuid: { not: null },
      ...(input.date_from || input.date_to
        ? {
            fecha: {
              ...(input.date_from ? { gte: new Date(String(input.date_from)) } : {}),
              ...(input.date_to ? { lte: new Date(`${input.date_to}T23:59:59`) } : {}),
            },
          }
        : {}),
    },
    select: {
      uuid: true, serie: true, folio: true, fecha: true, total: true,
      contraparteNombre: true, contraparteRfc: true,
      customer: { select: { razonSocial: true, rfc: true } },
    },
    orderBy: { fecha: "desc" },
    take: 200,
  });
  if (parents.length === 0) {
    return JSON.stringify({ n: 0, mensaje: "Sin facturas PPD en ese filtro." });
  }

  const doctos = await prisma.pagoDoctoRelacionado.findMany({
    where: {
      parentUuid: { in: parents.map((p) => p.uuid as string) },
      pagoInvoice: { companyId, status: { not: "CANCELLED" } },
    },
    select: {
      parentUuid: true, numParcialidad: true, impPagado: true,
      impSaldoInsoluto: true, fechaPago: true,
    },
  }).then((rows) =>
    rows.map((d) => ({
      ...d,
      impPagado: d.impPagado === null ? null : Number(d.impPagado),
      impSaldoInsoluto: d.impSaldoInsoluto === null ? null : Number(d.impSaldoInsoluto),
    })),
  );
  const porParent = new Map<string, typeof doctos>();
  for (const d of doctos) {
    const k = d.parentUuid.toUpperCase();
    (porParent.get(k) ?? porParent.set(k, []).get(k)!).push(d);
  }

  const hoy = Date.now();
  const filas = parents
    .map((p) => {
      const s = saldoInsolutoPpd(Number(p.total), porParent.get((p.uuid as string).toUpperCase()) ?? []);
      return {
        uuid: p.uuid,
        folio: [p.serie, p.folio].filter(Boolean).join("") || null,
        fecha: p.fecha.toISOString().slice(0, 10),
        cliente: nombreContraparte(p),
        clienteRfc: rfcContraparte(p),
        total: Number(p.total),
        cobrado: s.pagado,
        saldo: s.saldo,
        parcialidades: s.parcialidades,
        ultimoPago: s.ultimoPago?.toISOString().slice(0, 10) ?? null,
        diasDesdeEmision: Math.floor((hoy - p.fecha.getTime()) / 86_400_000),
      };
    })
    .filter((f) => !soloConSaldo || f.saldo > 1);

  filas.sort((a, b) => b.saldo - a.saldo);
  return JSON.stringify({
    n: filas.length,
    totalFacturado: filas.reduce((s, f) => s + f.total, 0),
    totalCobrado: filas.reduce((s, f) => s + f.cobrado, 0),
    saldoTotal: filas.reduce((s, f) => s + f.saldo, 0),
    facturas: filas.slice(0, Math.min((input.limit as number) || 30, 60)),
    _nota:
      "saldo viene del ImpSaldoInsoluto del complemento más avanzado (o total − cobrado si no hay). diasDesdeEmision alto con saldo > 0 = cobranza atorada.",
  });
}

// ─── query_bank_transactions ─────────────────────────────────────────────────

async function queryBankTransactions(input: ToolInput, companyId: string) {
  const where: Record<string, unknown> = { companyId };

  if (input.bank_account_id) where.bankAccountId = input.bank_account_id;
  if (input.status) where.status = input.status;
  if (input.tipo) where.tipo = input.tipo;
  if (input.date_from || input.date_to) {
    where.fecha = {
      ...(input.date_from ? { gte: new Date(input.date_from as string) } : {}),
      ...(input.date_to ? { lte: new Date(input.date_to as string) } : {}),
    };
  }
  if (input.monto_min !== undefined || input.monto_max !== undefined) {
    where.monto = {
      ...(input.monto_min !== undefined ? { gte: input.monto_min } : {}),
      ...(input.monto_max !== undefined ? { lte: input.monto_max } : {}),
    };
  }

  if (input.summary_only) {
    const [agg, count, ingresos, egresos] = await Promise.all([
      prisma.bankTransaction.aggregate({ where, _sum: { monto: true } }),
      prisma.bankTransaction.count({ where }),
      prisma.bankTransaction.aggregate({ where: { ...where, monto: { gt: 0 } }, _sum: { monto: true } }),
      prisma.bankTransaction.aggregate({ where: { ...where, monto: { lt: 0 } }, _sum: { monto: true } }),
    ]);
    return JSON.stringify({
      _convencion: "monto positivo = INGRESO (entró dinero); negativo = EGRESO (salió dinero).",
      count,
      totalNeto: agg._sum.monto ?? 0,
      totalIngresos: ingresos._sum.monto ?? 0,
      totalEgresos: Math.abs(Number(egresos._sum.monto ?? 0)),
    });
  }

  // Sorting: by date (default) or by amount. For "mayor egreso" the agent
  // should sort egresos by monto ASC (most negative first); for "mayor ingreso"
  // by monto DESC. We expose explicit options so it doesn't have to guess.
  let orderBy: Record<string, "asc" | "desc"> = { fecha: "desc" };
  if (input.sort_by === "monto_asc") orderBy = { monto: "asc" }; // mayor egreso primero
  else if (input.sort_by === "monto_desc") orderBy = { monto: "desc" }; // mayor ingreso primero

  const txs = await prisma.bankTransaction.findMany({
    where,
    include: {
      bankAccount: { select: { banco: true, nombre: true } },
      invoice: { select: { uuid: true, total: true, tipo: true } },
      supplier: { select: { razonSocial: true, rfc: true } },
    },
    orderBy,
    take: Math.min((input.limit as number) || 20, 50),
  });

  return JSON.stringify({
    _convencion: "monto positivo = INGRESO (entró dinero); monto negativo = EGRESO (salió dinero). El 'mayor egreso' es el monto MÁS NEGATIVO (mayor en valor absoluto entre los negativos).",
    movimientos: txs.map((tx) => ({
      id: tx.id,
      fecha: tx.fecha.toISOString().substring(0, 10),
      descripcion: tx.descripcion,
      referencia: tx.referencia,
      monto: Number(tx.monto),
      montoAbsoluto: Math.abs(Number(tx.monto)),
      flujo: Number(tx.monto) >= 0 ? "INGRESO" : "EGRESO",
      tipo: tx.tipo,
      status: tx.status,
      banco: tx.bankAccount.banco,
      cuenta: tx.bankAccount.nombre,
      invoiceUuid: tx.invoice?.uuid,
      supplier: tx.supplier?.razonSocial,
    })),
  });
}

// ─── query_tax_declarations ──────────────────────────────────────────────────

async function queryTaxDeclarations(input: ToolInput, companyId: string) {
  const where: Record<string, unknown> = { companyId };
  if (input.tipo) where.tipo = input.tipo;
  if (input.periodo) where.periodo = input.periodo;

  const declarations = await prisma.taxDeclaration.findMany({
    where,
    orderBy: { periodo: "desc" },
    take: Math.min((input.limit as number) || 10, 20),
  });

  return JSON.stringify(
    declarations.map((d) => ({
      id: d.id,
      tipo: d.tipo,
      periodo: d.periodo,
      status: d.status,
      ivaTrasladadoCobrado: d.ivaTrasladadoCobrado,
      ivaAcreditableGastado: d.ivaAcreditableGastado,
      ivaPagar: d.ivaPagar,
      isrIngresos: d.isrIngresos,
      isrPagar: d.isrPagar,
      fechaPresentacion: d.fechaPresentacion?.toISOString().substring(0, 10),
    }))
  );
}

// ─── query_dashboard_kpis ────────────────────────────────────────────────────

async function queryDashboardKpis(companyId: string) {
  const now = new Date();
  const monthFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthTo = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const [ingresos, gastos, ivaTrasladado, ivaAcreditable, unmatched, obligations] =
    await Promise.all([
      prisma.invoice.aggregate({
        where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: monthFrom, lt: monthTo } },
        _sum: { subtotal: true, total: true },
        _count: { id: true },
      }),
      prisma.invoice.aggregate({
        where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: monthFrom, lt: monthTo } },
        _sum: { subtotal: true, total: true },
        _count: { id: true },
      }),
      prisma.invoiceTax.aggregate({
        where: {
          invoice: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: monthFrom, lt: monthTo } },
          tipo: "IVA",
          retencion: false,
        },
        _sum: { importe: true },
      }),
      prisma.invoiceTax.aggregate({
        where: {
          invoice: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: monthFrom, lt: monthTo } },
          tipo: "IVA",
          retencion: false,
        },
        _sum: { importe: true },
      }),
      prisma.bankTransaction.count({
        where: { companyId, status: "UNMATCHED" },
      }),
      prisma.companyObligation.findMany({
        where: { companyId, activa: true },
      }),
    ]);

  const ingresosDelMes = Number(ingresos._sum.subtotal ?? 0);
  const gastosDelMes = Number(gastos._sum.subtotal ?? 0);
  const ivaTrasl = Number(ivaTrasladado._sum.importe ?? 0);
  const ivaAcred = Number(ivaAcreditable._sum.importe ?? 0);

  return JSON.stringify({
    periodo: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
    ingresosDelMes,
    gastosDelMes,
    utilidadBruta: ingresosDelMes - gastosDelMes,
    ivaTrasladado: ivaTrasl,
    ivaAcreditable: ivaAcred,
    ivaEstimadoPagar: ivaTrasl - ivaAcred,
    facturasEmitidas: ingresos._count.id,
    facturasRecibidas: gastos._count.id,
    transaccionesSinConciliar: unmatched,
    obligacionesActivas: obligations.length,
  });
}

// ─── query_customers ─────────────────────────────────────────────────────────

async function queryCustomers(input: ToolInput, companyId: string) {
  const where: Record<string, unknown> = { companyId };
  if (input.search) {
    where.OR = [
      { rfc: { contains: input.search as string, mode: "insensitive" } },
      { razonSocial: { contains: input.search as string, mode: "insensitive" } },
    ];
  }

  const customers = await prisma.customer.findMany({
    where,
    orderBy: { razonSocial: "asc" },
    take: Math.min((input.limit as number) || 20, 50),
  });

  return JSON.stringify(
    customers.map((c) => ({
      id: c.id,
      rfc: c.rfc,
      razonSocial: c.razonSocial,
      regimenFiscal: c.regimenFiscal,
      email: c.email,
      codigoPostal: c.codigoPostal,
    }))
  );
}

// ─── query_employees ─────────────────────────────────────────────────────────

async function queryEmployees(input: ToolInput, companyId: string) {
  const where: Record<string, unknown> = { companyId };

  const activeOnly = input.active_only !== false;
  if (activeOnly) where.isActive = true;

  if (input.search) {
    where.OR = [
      { nombre: { contains: input.search as string, mode: "insensitive" } },
      { apellidoPaterno: { contains: input.search as string, mode: "insensitive" } },
      { rfc: { contains: input.search as string, mode: "insensitive" } },
    ];
  }

  const employees = await prisma.employee.findMany({
    where,
    orderBy: { nombre: "asc" },
    take: Math.min((input.limit as number) || 20, 50),
  });

  return JSON.stringify(
    employees.map((e) => ({
      id: e.id,
      nombre: `${e.nombre} ${e.apellidoPaterno} ${e.apellidoMaterno ?? ""}`.trim(),
      rfc: e.rfc,
      curp: e.curp,
      nss: e.nss,
      fechaIngreso: e.fechaIngreso.toISOString().substring(0, 10),
      salarioDiario: e.salarioDiario,
      sdi: e.salarioDiarioIntegrado,
      isActive: e.isActive,
    }))
  );
}

// ─── query_obligations ───────────────────────────────────────────────────────

async function queryObligations(input: ToolInput, companyId: string) {
  const where: Record<string, unknown> = { companyId };
  if (input.active_only !== false) where.activa = true;

  const obligations = await prisma.companyObligation.findMany({
    where,
    orderBy: { tipo: "asc" },
  });

  return JSON.stringify(
    obligations.map((ob) => ({
      id: ob.id,
      tipo: ob.tipo,
      descripcion: ob.descripcion,
      periodicidad: ob.periodicidad,
      diaVencimiento: ob.diaVencimiento,
      mesVencimiento: ob.mesVencimiento,
      activa: ob.activa,
      fuente: ob.fuente,
    }))
  );
}

// ─── categorize_transaction ──────────────────────────────────────────────────

async function categorizeTransaction(input: ToolInput, companyId: string) {
  // Fetch the company's chart of accounts for context
  const accounts = await prisma.chartAccount.findMany({
    where: { companyId, isActive: true },
    orderBy: { cuentaSAT: "asc" },
  });

  return JSON.stringify({
    transaction: {
      descripcion: input.transaction_description,
      monto: input.monto,
      tipo: input.tipo,
    },
    available_accounts: accounts.map((a) => ({
      cuentaSAT: a.cuentaSAT,
      subcuenta: a.subcuenta,
      nombre: a.nombre,
      tipo: a.tipo,
    })),
    instruction:
      "Con base en la descripción de la transacción y las cuentas disponibles, sugiere la cuenta contable más apropiada y explica por qué.",
  });
}

// ─── suggest_reconciliation_match ────────────────────────────────────────────

async function suggestReconciliationMatch(input: ToolInput, companyId: string) {
  const tx = await prisma.bankTransaction.findFirst({
    where: { id: input.transaction_id as string, companyId },
    include: { bankAccount: { select: { banco: true, nombre: true } } },
  });

  if (!tx) return JSON.stringify({ error: "Transacción no encontrada" });

  const absAmount = Math.abs(Number(tx.monto));
  const tolerance = absAmount * 0.02; // 2% tolerance

  // Find invoices with similar amounts around the same date
  const candidateInvoices = await prisma.invoice.findMany({
    where: {
      companyId,
      status: "STAMPED",
      total: { gte: absAmount - tolerance, lte: absAmount + tolerance },
      fecha: {
        gte: new Date(tx.fecha.getTime() - 30 * 86400000),
        lte: new Date(tx.fecha.getTime() + 30 * 86400000),
      },
    },
    include: { customer: { select: { razonSocial: true, rfc: true } } },
    take: 10,
  });

  // Find suppliers with matching names in description
  const suppliers = await prisma.supplier.findMany({
    where: { companyId },
    take: 100,
  });

  const matchingSuppliers = suppliers.filter(
    (s) =>
      tx.descripcion.toUpperCase().includes(s.razonSocial.toUpperCase()) ||
      tx.descripcion.toUpperCase().includes(s.rfc.toUpperCase())
  );

  return JSON.stringify({
    transaction: {
      id: tx.id,
      fecha: tx.fecha.toISOString().substring(0, 10),
      descripcion: tx.descripcion,
      monto: tx.monto,
      tipo: tx.tipo,
      banco: tx.bankAccount.banco,
    },
    candidate_invoices: candidateInvoices.map((inv) => ({
      id: inv.id,
      uuid: inv.uuid,
      tipo: inv.tipo,
      fecha: inv.fecha.toISOString().substring(0, 10),
      total: inv.total,
      cliente: inv.customer?.razonSocial,
      clienteRfc: inv.customer?.rfc,
    })),
    matching_suppliers: matchingSuppliers.map((s) => ({
      id: s.id,
      rfc: s.rfc,
      razonSocial: s.razonSocial,
    })),
  });
}

// ─── analyze_anomalies ───────────────────────────────────────────────────────

async function analyzeAnomalies(input: ToolInput, companyId: string) {
  const days = (input.days as number) || 30;
  const since = new Date();
  since.setDate(since.getDate() - days);

  const [invoices, transactions] = await Promise.all([
    prisma.invoice.findMany({
      where: { companyId, status: "STAMPED", fecha: { gte: since } },
      include: { customer: { select: { razonSocial: true, rfc: true } } },
      orderBy: { fecha: "desc" },
    }),
    prisma.bankTransaction.findMany({
      where: { companyId, fecha: { gte: since } },
      orderBy: { fecha: "desc" },
    }),
  ]);

  // Detect duplicate amounts in invoices
  const amountMap = new Map<number, typeof invoices>();
  for (const inv of invoices) {
    const key = Number(inv.total);
    if (!amountMap.has(key)) amountMap.set(key, []);
    amountMap.get(key)!.push(inv);
  }
  const duplicateAmounts = Array.from(amountMap.entries())
    .filter(([, invs]) => invs.length > 1)
    .map(([amount, invs]) => ({
      amount,
      count: invs.length,
      invoices: invs.map((i) => ({
        id: i.id,
        uuid: i.uuid,
        fecha: i.fecha.toISOString().substring(0, 10),
        cliente: i.customer?.razonSocial,
      })),
    }));

  // Detect unusually high transactions (> 3 std deviations)
  const amounts = transactions.map((t) => Math.abs(Number(t.monto)));
  const mean = amounts.length ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0;
  const std = amounts.length
    ? Math.sqrt(amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length)
    : 0;
  const threshold = mean + 3 * std;
  const unusualTransactions = transactions
    .filter((t) => Math.abs(Number(t.monto)) > threshold && threshold > 0)
    .map((t) => ({
      id: t.id,
      fecha: t.fecha.toISOString().substring(0, 10),
      descripcion: t.descripcion,
      monto: t.monto,
      tipo: t.tipo,
    }));

  // Unmatched transactions count
  const unmatchedCount = transactions.filter((t) => t.status === "UNMATCHED").length;

  // ── Fiscal-specific checks ────────────────────────────────────────────────
  // Cancelled CFDIs in the window — these must NOT be counted in IVA/ISR, a
  // common error when a CFDI is cancelled after the declaration was computed.
  const cancelledCount = await prisma.invoice.count({
    where: { companyId, status: "CANCELLED", fecha: { gte: since } },
  });

  // Complementos de pago: both directions (accurate, deadline-aware).
  const [emitidos, recibidos] = await Promise.all([
    detectComplementosPendientes(companyId),
    detectComplementosRecibidosPendientes(companyId),
  ]);

  return JSON.stringify({
    periodo: `Últimos ${days} días`,
    totalFacturas: invoices.length,
    totalTransacciones: transactions.length,
    duplicateAmounts: duplicateAmounts.slice(0, 10),
    unusualTransactions: unusualTransactions.slice(0, 10),
    unmatchedTransactions: unmatchedCount,
    cfdisCancelados: cancelledCount,
    complementosQueDebesEmitir: {
      total: emitidos.stats.totalPendientes,
      vencidos: emitidos.stats.vencidos,
      montoPendiente: emitidos.stats.montoPendiente,
    },
    complementosQueTeDebenProveedores: {
      total: recibidos.stats.totalPendientes,
      vencidos: recibidos.stats.vencidos,
      ejemplos: recibidos.pendientes.slice(0, 5).map((p) => ({
        proveedor: p.proveedor,
        totalPagado: p.totalPagado,
        fechaLimite: p.fechaLimite,
        urgencia: p.urgencia,
      })),
    },
    stats: { mean: Math.round(mean), stdDev: Math.round(std), threshold: Math.round(threshold) },
  });
}
