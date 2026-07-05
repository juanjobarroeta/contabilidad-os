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
import { listUnmatched, scoreCandidates } from "@/lib/conciliacion";
import { stagePendingConciliar } from "@/lib/whatsapp/pending-action";
import { searchFiscalKnowledge } from "@/lib/fiscal-kb/search";
import { stageChatPendingAction } from "@/lib/ai/pending-action";
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
    case "proponer_resolver_hallazgo":
      return proponerResolverHallazgo(input, companyId, context);
    case "proponer_posponer_hallazgo":
      return proponerPosponerHallazgo(input, companyId, context);
    case "proponer_marcar_pendiente":
      return proponerMarcarPendiente(input, companyId, context);
    case "query_invoices":
      return queryInvoices(input, companyId);
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
      const now = new Date();
      const year = typeof input.year === "number" ? input.year : now.getFullYear();
      const month = typeof input.month === "number" ? input.month : now.getMonth() + 1;
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

  const montoMatch = Math.abs(tx.monto).toFixed(2) === inv.total.toFixed(2);
  const summary =
    `Conciliar el movimiento del ${tx.fecha.toISOString().slice(0, 10)} ` +
    `(${tx.descripcion}, ${MXN(tx.monto)}) con la factura de ` +
    `${inv.customer?.razonSocial ?? "—"} (${MXN(inv.total)}). ` +
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
    `(${tx.descripcion}, ${MXN(tx.monto)}) como "${FAMILIA_LABEL[familia]}" y registrar su asiento ` +
    `en el libro mayor.`;

  const pa = await stageChatPendingAction(context.conversationId!, companyId, summary, {
    type: "categorizacion",
    payload: { txId, familia },
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
  const montoMatch = Math.abs(tx.monto).toFixed(2) === inv.total.toFixed(2);
  const preview =
    `Movimiento: ${tx.fecha} · ${tx.descripcion} · ${MXN(tx.monto)}\n` +
    `Factura: ${inv.customer?.razonSocial ?? "—"} · ${MXN(inv.total)} · ${inv.fecha.toISOString().slice(0, 10)}\n` +
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
        contraparte: inv.customer?.razonSocial ?? "—",
        contraparteRfc: inv.customer?.rfc ?? "—",
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
      totalEgresos: Math.abs(egresos._sum.monto ?? 0),
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
      monto: tx.monto,
      montoAbsoluto: Math.abs(tx.monto),
      flujo: tx.monto >= 0 ? "INGRESO" : "EGRESO",
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

  const ingresosDelMes = ingresos._sum.subtotal ?? 0;
  const gastosDelMes = gastos._sum.subtotal ?? 0;
  const ivaTrasl = ivaTrasladado._sum.importe ?? 0;
  const ivaAcred = ivaAcreditable._sum.importe ?? 0;

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

  const absAmount = Math.abs(tx.monto);
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
    const key = inv.total;
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
  const amounts = transactions.map((t) => Math.abs(t.monto));
  const mean = amounts.length ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0;
  const std = amounts.length
    ? Math.sqrt(amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length)
    : 0;
  const threshold = mean + 3 * std;
  const unusualTransactions = transactions
    .filter((t) => Math.abs(t.monto) > threshold && threshold > 0)
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
