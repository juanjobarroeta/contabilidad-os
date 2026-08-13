// ─────────────────────────────────────────────────────────────────────────────
// MCP del OPERADOR — la operación de contabilidadOS como herramientas.
//
// Todo lo que el operador venía haciendo con curl y SQL a mano (diagnóstico de
// una empresa, barridos dirigidos, resúmenes de cancelaciones, re-evaluar un
// crédito) expuesto por Model Context Protocol, para operarlo en lenguaje
// natural desde Claude. Este módulo registra las tools; el transporte y la
// autenticación viven en la ruta (/api/mcp/[key]).
//
// Principios:
//  - LECTURA por default. Las únicas escrituras son las dos acciones que el
//    operador ya ejecuta hoy por otros medios (empujar un cron dirigido y
//    evaluar un crédito), ambas idempotentes/append-only y con bitácora.
//  - Nada de SQL libre: cada tool es una consulta con forma fija.
//  - Empresas por RFC o id — el operador piensa en RFCs.
// ─────────────────────────────────────────────────────────────────────────────

import { fromJsonSchema } from "@modelcontextprotocol/server";
import { prisma } from "@/lib/prisma";
import { registrarBitacora } from "@/lib/audit";
import { evaluarEtapas, cronsPendientes, type ConteosEmpresa } from "@/lib/onboarding/estado";
import { cargarAjusteInflacion } from "@/lib/fiscal/ajuste-inflacion-ledger";
import { cargarInsumosCredito } from "@/lib/credito/insumos";
import { calcularScoreCredito } from "@/lib/credito/score";
import { generarAnalisisCredito } from "@/lib/credito/analisis";

// La forma mínima que mcp-handler nos pide del server (evita acoplarnos a los
// tipos internos del SDK: sólo usamos registerTool con este contrato).
type ToolResult = { content: Array<{ type: "text"; text: string }> };
export interface McpServerLike {
  registerTool(
    name: string,
    // inputSchema: StandardSchema del SDK (vía fromJsonSchema — la app trae
    // zod 3 y el SDK sólo convierte zod ≥4, así que los schemas van en JSON
    // Schema plano).
    meta: { title: string; description: string; inputSchema?: unknown },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (input: any) => Promise<ToolResult>,
  ): void;
}

const texto = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 1) }],
});

/** Resuelve una empresa por id o RFC (el operador usa ambos indistintamente). */
async function resolverEmpresa(ref: string) {
  const empresa = await prisma.company.findFirst({
    where: { OR: [{ id: ref }, { rfc: ref.toUpperCase() }] },
    select: { id: true, rfc: true, razonSocial: true, isActive: true, tier: true },
  });
  if (!empresa) throw new Error(`No hay empresa con id o RFC "${ref}".`);
  return empresa;
}

/** Crons que el operador puede empujar dirigidos. Whitelist cerrada: el MCP no
 *  debe poder tocar rutas arbitrarias del server. */
const CRONS_PERMITIDOS = [
  "sat-backfill",
  "sat-sync",
  "sat-cancel-sync",
  "sat-vigencia-sync",
  "sat-rawxml-backfill",
  "invoice-taxes-backfill",
  "invoice-contraparte-backfill",
  "declaraciones-backfill",
  "onboarding-drive",
  "fiscal-audit",
  "compliance-sync",
] as const;

export function registrarToolsOperador(server: McpServerLike): void {
  server.registerTool(
    "listar_empresas",
    {
      title: "Listar empresas",
      description:
        "Empresas del sistema con id, RFC, razón social, plan y actividad. Filtra con q (subcadena de RFC o razón social).",
      inputSchema: fromJsonSchema<{ q?: string }>({
        type: "object",
        properties: { q: { type: "string" } },
        additionalProperties: false,
      }),
    },
    async ({ q }: { q?: string }) => {
      const empresas = await prisma.company.findMany({
        where: q
          ? {
              OR: [
                { rfc: { contains: q, mode: "insensitive" } },
                { razonSocial: { contains: q, mode: "insensitive" } },
              ],
            }
          : {},
        select: {
          id: true,
          rfc: true,
          razonSocial: true,
          tier: true,
          isActive: true,
          createdAt: true,
          _count: { select: { invoices: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return texto(
        empresas.map((e) => ({
          id: e.id,
          rfc: e.rfc,
          razonSocial: e.razonSocial,
          tier: e.tier,
          activa: e.isActive,
          cfdis: e._count.invoices,
          alta: e.createdAt.toISOString().slice(0, 10),
        })),
      );
    },
  );

  server.registerTool(
    "estado_carga",
    {
      title: "Estado de carga inicial",
      description:
        "Avance del pipeline de una empresa (descarga CFDIs → XML → impuestos → contraparte → vigencia): porcentaje por etapa, qué falta y qué cron lo avanza. Es el diagnóstico de '¿por qué esta empresa no está al corriente?'.",
      inputSchema: fromJsonSchema<{ empresa: string }>({
        type: "object",
        properties: { empresa: { type: "string", description: "id o RFC" } },
        required: ["empresa"],
        additionalProperties: false,
      }),
    },
    async ({ empresa }: { empresa: string }) => {
      const e = await resolverEmpresa(empresa);
      const [total, conXml, conImpuestos, conContraparte, conVigencia, backfill] = await Promise.all([
        prisma.invoice.count({ where: { companyId: e.id } }),
        prisma.invoice.count({ where: { companyId: e.id, rawXml: { not: null } } }),
        prisma.invoice.count({ where: { companyId: e.id, taxes: { some: {} } } }),
        prisma.invoice.count({ where: { companyId: e.id, contraparteNombre: { not: null } } }),
        prisma.invoice.count({ where: { companyId: e.id, vigenciaCheckedAt: { not: null } } }),
        prisma.company.findUnique({ where: { id: e.id }, select: { satBackfillCompletedAt: true } }),
      ]);
      const conteos: ConteosEmpresa = {
        companyId: e.id,
        total,
        conXml,
        conImpuestos,
        conContraparte,
        conVigencia,
        backfillCompleto: backfill?.satBackfillCompletedAt != null,
      };
      const etapas = evaluarEtapas(conteos);
      return texto({
        empresa: { rfc: e.rfc, razonSocial: e.razonSocial },
        etapas: etapas.map((x) => ({ etapa: x.etiqueta, pct: x.pct, completa: x.completa, cron: x.cron })),
        siguienteEmpuje: cronsPendientes(etapas),
      });
    },
  );

  server.registerTool(
    "estado_contable",
    {
      title: "Estado contable del ejercicio",
      description:
        "Cierres mensuales de un ejercicio (qué meses están posteados y cuáles no) y, para personas morales, el ajuste anual por inflación calculado del ledger (Arts. 44-46 LISR) con sus promedios y factor. Responde '¿por qué esta empresa no tiene tal cifra?' sin abrir la app.",
      inputSchema: fromJsonSchema<{ empresa: string; ejercicio?: number }>({
        type: "object",
        properties: {
          empresa: { type: "string", description: "id o RFC" },
          ejercicio: { type: "number", description: "año (default: el anterior al actual)" },
        },
        required: ["empresa"],
        additionalProperties: false,
      }),
    },
    async ({ empresa, ejercicio }: { empresa: string; ejercicio?: number }) => {
      const e = await resolverEmpresa(empresa);
      const year = ejercicio ?? new Date().getFullYear() - 1;
      const esPM = e.rfc.trim().length === 12;

      const periodos = await prisma.accountingPeriod.findMany({
        where: { companyId: e.id, year },
        select: { month: true, status: true },
        orderBy: { month: "asc" },
      });
      const posteados = periodos
        .filter((p) => p.status === "POSTED" || p.status === "CLOSED")
        .map((p) => p.month);
      const sinPostear = Array.from({ length: 12 }, (_, i) => i + 1).filter(
        (m) => !posteados.includes(m),
      );

      // El ajuste sólo aplica a PM (Título II) y sólo es confiable con los 12
      // cierres: es justo la condición que hace callar al hallazgo del auditor.
      const ajuste = esPM ? (await cargarAjusteInflacion(e.id, year)).resultado : null;

      return texto({
        empresa: { rfc: e.rfc, razonSocial: e.razonSocial, tipoPersona: esPM ? "PM" : "PF" },
        ejercicio: year,
        cierres: {
          posteados,
          sinPostear,
          detalle: periodos.map((p) => ({ mes: p.month, status: p.status })),
        },
        ajusteInflacion: ajuste
          ? {
              calculable: ajuste.calculable,
              factor: ajuste.factorAjuste.factor,
              promedioCreditos: ajuste.promedioCreditos,
              promedioDeudas: ajuste.promedioDeudas,
              acumulable: ajuste.acumulable,
              deducible: ajuste.deducible,
              advertencias: ajuste.advertencias,
              // Las cuentas que MUEVEN la cifra, para poder cotejarla sin abrir
              // la app: un ajuste grande casi siempre se explica por dos o tres
              // saldos, y si alguno no debería estar ahí se ve de inmediato.
              topCuentas: ajuste.cuentas
                .filter((c) => c.clase !== "EXCLUIDA" && c.promedio !== 0)
                .sort((a, b) => Math.abs(b.promedio) - Math.abs(a.promedio))
                .slice(0, 15)
                .map((c) => ({
                  cuenta: c.clave,
                  nombre: c.nombre,
                  clase: c.clase,
                  promedio: Math.round(c.promedio),
                  revisar: c.revisar,
                })),
            }
          : "No aplica: el ajuste anual por inflación es del Título II (personas morales).",
      });
    },
  );

  server.registerTool(
    "diagnostico_sat",
    {
      title: "Diagnóstico de solicitudes SAT",
      description:
        "Solicitudes de descarga masiva de una empresa agrupadas por tipo y estatus, con muestra de errores. Distingue 'no se ha consultado' de 'se consulta y falla' — y de qué falla (credencial, cuota 5002, formato).",
      inputSchema: fromJsonSchema<{ empresa: string }>({
        type: "object",
        properties: { empresa: { type: "string", description: "id o RFC" } },
        required: ["empresa"],
        additionalProperties: false,
      }),
    },
    async ({ empresa }: { empresa: string }) => {
      const e = await resolverEmpresa(empresa);
      const grupos = await prisma.satSyncRequest.groupBy({
        by: ["tipo", "status"],
        where: { companyId: e.id },
        _count: { _all: true },
        _max: { createdAt: true },
      });
      const errores = await prisma.satSyncRequest.findMany({
        where: { companyId: e.id, status: "FAILED", errorMessage: { not: null } },
        select: { tipo: true, year: true, month: true, errorMessage: true },
        orderBy: { createdAt: "desc" },
        take: 5,
      });
      return texto({
        empresa: { rfc: e.rfc, razonSocial: e.razonSocial },
        solicitudes: grupos.map((g) => ({
          tipo: g.tipo,
          status: g.status,
          n: g._count._all,
          ultima: g._max.createdAt?.toISOString().slice(0, 16),
        })),
        ultimosErrores: errores,
      });
    },
  );

  server.registerTool(
    "resumen_cancelaciones",
    {
      title: "Resumen de cancelaciones",
      description:
        "Facturas canceladas de una empresa por mes, separando las que tienen sustituta (refacturación, sin efecto declarado) de las que no (posible corrección de periodo). El análisis que decide si hay complementarias que preparar.",
      inputSchema: fromJsonSchema<{ empresa: string; desde?: string }>({
        type: "object",
        properties: {
          empresa: { type: "string", description: "id o RFC" },
          desde: { type: "string", description: "YYYY-MM-DD (default: sin límite)" },
        },
        required: ["empresa"],
        additionalProperties: false,
      }),
    },
    async ({ empresa, desde }: { empresa: string; desde?: string }) => {
      const e = await resolverEmpresa(empresa);
      const canceladas = await prisma.invoice.findMany({
        where: {
          companyId: e.id,
          status: "CANCELLED",
          ...(desde ? { fecha: { gte: new Date(desde) } } : {}),
        },
        select: { uuid: true, tipo: true, fecha: true, total: true, cancelMotivo: true },
        orderBy: { fecha: "desc" },
        take: 500,
      });
      const uuids = canceladas.map((c) => c.uuid).filter((u): u is string => u != null);
      const sustituidas = new Set(
        (
          await prisma.invoice.findMany({
            where: {
              companyId: e.id,
              status: { not: "CANCELLED" },
              cfdiRelacionadoUuid: { in: uuids, mode: "insensitive" },
            },
            select: { cfdiRelacionadoUuid: true },
          })
        ).map((s) => s.cfdiRelacionadoUuid!.toUpperCase()),
      );
      const porMes = new Map<string, { n: number; total: number; sinSustituta: number; montoSinSustituta: number }>();
      for (const c of canceladas) {
        const mes = c.fecha.toISOString().slice(0, 7);
        const m = porMes.get(mes) ?? { n: 0, total: 0, sinSustituta: 0, montoSinSustituta: 0 };
        m.n++;
        m.total += c.total;
        const tieneSustituta = c.uuid != null && sustituidas.has(c.uuid.toUpperCase());
        if (!tieneSustituta && c.tipo !== "PAGO") {
          m.sinSustituta++;
          m.montoSinSustituta += c.total;
        }
        porMes.set(mes, m);
      }
      return texto({
        empresa: { rfc: e.rfc, razonSocial: e.razonSocial },
        totalCanceladas: canceladas.length,
        porMes: [...porMes.entries()]
          .sort((a, b) => b[0].localeCompare(a[0]))
          .map(([mes, m]) => ({ mes, ...m })),
        nota: "sinSustituta > 0 en un mes ya declarado = candidato a revisar/corregir ese periodo.",
      });
    },
  );

  server.registerTool(
    "empujar_cron",
    {
      title: "Empujar un cron dirigido",
      description:
        "Ejecuta AHORA un cron del pipeline para una empresa (o global si no se indica) y devuelve su resumen. Sustituye los curls manuales. Crons: " +
        CRONS_PERMITIDOS.join(", ") +
        ". Nota: sat-cancel-sync consume cuota vitalicia del SAT por periodo; sat-vigencia-sync no.",
      inputSchema: fromJsonSchema<{
        cron: (typeof CRONS_PERMITIDOS)[number];
        empresa?: string;
        limit?: number;
        desde?: string;
      }>({
        type: "object",
        properties: {
          cron: { type: "string", enum: [...CRONS_PERMITIDOS] },
          empresa: { type: "string", description: "id o RFC (omitir = corrida global)" },
          limit: { type: "integer", minimum: 1, maximum: 100000 },
          desde: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "sólo sat-vigencia-sync" },
        },
        required: ["cron"],
        additionalProperties: false,
      }),
    },
    async ({ cron, empresa, limit, desde }: { cron: (typeof CRONS_PERMITIDOS)[number]; empresa?: string; limit?: number; desde?: string }) => {
      const secret = process.env.CRON_SECRET;
      if (!secret) return texto({ error: "CRON_SECRET no configurado en el servidor." });
      const e = empresa ? await resolverEmpresa(empresa) : null;
      const params = new URLSearchParams();
      if (e) params.set("companyId", e.id);
      if (limit) params.set("limit", String(limit));
      if (desde) params.set("desde", desde);
      const base = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
      const res = await fetch(`${base}/api/cron/${cron}?${params}`, {
        method: "POST",
        headers: { "x-cron-secret": secret },
      });
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (e) {
        registrarBitacora({
          companyId: e.id,
          userId: null,
          accion: "mcp.empujar_cron",
          entidad: "Company",
          entidadId: e.id,
          detalle: { cron, limit: limit ?? null, desde: desde ?? null, status: res.status },
        });
      }
      return texto({ cron, empresa: e ? { rfc: e.rfc } : "global", httpStatus: res.status, resultado: body });
    },
  );

  server.registerTool(
    "evaluar_credito",
    {
      title: "Evaluar crédito de una empresa",
      description:
        "Corre el score de crédito AHORA con los datos fiscales/bancarios actuales y guarda el snapshot inmutable (aparece en la ficha de /creditos con su memo). Es la misma evaluación que el botón 'Evaluar de nuevo'.",
      inputSchema: fromJsonSchema<{ empresa: string }>({
        type: "object",
        properties: { empresa: { type: "string", description: "id o RFC" } },
        required: ["empresa"],
        additionalProperties: false,
      }),
    },
    async ({ empresa }: { empresa: string }) => {
      const e = await resolverEmpresa(empresa);
      const detalle = await prisma.company.findUnique({
        where: { id: e.id },
        select: { razonSocial: true, rfc: true, regimenFiscal: true },
      });
      const insumos = await cargarInsumosCredito(e.id);
      const resultado = calcularScoreCredito(insumos);
      const analisis = await generarAnalisisCredito({
        razonSocial: detalle?.razonSocial ?? e.razonSocial,
        rfc: detalle?.rfc ?? e.rfc,
        regimenFiscal: detalle?.regimenFiscal ?? null,
        resultado,
        insumos,
        companyId: e.id,
      });
      const evaluacion = await prisma.creditoEvaluacion.create({
        data: {
          companyId: e.id,
          score: resultado.score,
          banda: resultado.banda,
          limiteSugerido: resultado.limiteSugerido,
          provisional: resultado.provisional,
          detalle: JSON.parse(
            JSON.stringify({
              dimensiones: resultado.dimensiones,
              insumos,
              flujoLibreMensual: resultado.flujoLibreMensual,
              pagoMensualMax: resultado.pagoMensualMax,
              capacidadDesglose: resultado.capacidadDesglose,
            }),
          ),
          cobertura: resultado.cobertura,
          analisis,
        },
        select: { id: true, createdAt: true },
      });
      registrarBitacora({
        companyId: e.id,
        userId: null,
        accion: "credito.evaluar",
        entidad: "CreditoEvaluacion",
        entidadId: evaluacion.id,
        detalle: { score: resultado.score, banda: resultado.banda, provisional: resultado.provisional, via: "mcp" },
      });
      return texto({
        empresa: { rfc: e.rfc, razonSocial: e.razonSocial },
        score: resultado.score,
        banda: resultado.banda,
        limiteSugerido: resultado.limiteSugerido,
        pagoMensualMax: resultado.pagoMensualMax,
        provisional: resultado.provisional,
        cobertura: resultado.cobertura,
        evaluacionId: evaluacion.id,
      });
    },
  );

  server.registerTool(
    "brief_auditor",
    {
      title: "Lectura del auditor",
      description:
        "La síntesis priorizada del auditor fiscal de una empresa: qué atender primero, qué se arregla en lote, y los grupos de hallazgos abiertos por causa raíz.",
      inputSchema: fromJsonSchema<{ empresa: string }>({
        type: "object",
        properties: { empresa: { type: "string", description: "id o RFC" } },
        required: ["empresa"],
        additionalProperties: false,
      }),
    },
    async ({ empresa }: { empresa: string }) => {
      const e = await resolverEmpresa(empresa);
      const [brief, abiertos] = await Promise.all([
        prisma.auditBrief.findUnique({
          where: { companyId: e.id },
          select: { resumen: true, grupos: true, hallazgosAbiertos: true, generadoAt: true },
        }),
        prisma.fiscalHallazgo.count({ where: { companyId: e.id, estado: "ABIERTO" } }),
      ]);
      return texto({
        empresa: { rfc: e.rfc, razonSocial: e.razonSocial },
        hallazgosAbiertosAhora: abiertos,
        brief: brief ?? "Sin brief todavía — empuja fiscal-audit para esta empresa.",
      });
    },
  );

  server.registerTool(
    "costos_llm",
    {
      title: "Costos de IA y extracción",
      description:
        "Costo del mes por empresa y subtipo (LLM + Syntage), en USD. La vista con la que se detectó el loop de re-parseo de $750/mes. mes en formato YYYY-MM (default: el actual).",
      inputSchema: fromJsonSchema<{ mes?: string }>({
        type: "object",
        properties: { mes: { type: "string", pattern: "^\\d{4}-\\d{2}$" } },
        additionalProperties: false,
      }),
    },
    async ({ mes }: { mes?: string }) => {
      const ahora = new Date();
      const [y, m] = (mes ?? `${ahora.getUTCFullYear()}-${String(ahora.getUTCMonth() + 1).padStart(2, "0")}`)
        .split("-")
        .map(Number);
      const desde = new Date(Date.UTC(y, m - 1, 1));
      const hasta = new Date(Date.UTC(y, m, 1));
      const filas = await prisma.$queryRaw<
        Array<{ rfc: string | null; subtipo: string; usd: number }>
      >`
        SELECT c.rfc, e.subtipo, SUM(e."costoMicroUsd")::float / 1e6 AS usd
        FROM "CostEvent" e
        LEFT JOIN "Company" c ON c.id = e."companyId"
        WHERE e."occurredAt" >= ${desde} AND e."occurredAt" < ${hasta}
        GROUP BY c.rfc, e.subtipo
        ORDER BY SUM(e."costoMicroUsd") DESC
        LIMIT 60`;
      const total = filas.reduce((s, f) => s + f.usd, 0);
      return texto({
        mes: mes ?? `${y}-${String(m).padStart(2, "0")}`,
        totalUsd: Math.round(total * 100) / 100,
        renglones: filas.map((f) => ({ empresa: f.rfc ?? "(global)", subtipo: f.subtipo, usd: Math.round(f.usd * 100) / 100 })),
      });
    },
  );
}
