import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";
import { stampPayrollRun } from "@/lib/nomina/payroll-run";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/nomina/cockpit/batch-timbrar — TIMBRA en LOTE varias corridas de
// distintas empresas desde el cockpit del despacho.
//
// ⚠ ACCIÓN IRREVERSIBLE: emite CFDIs de nómina REALES ante el SAT vía Facturapi.
// Por eso el contrato exige una LISTA EXPLÍCITA de runIds (no existe un "timbrar
// todo"): el llamador debe pasar los ids concretos a timbrar. Lista vacía → 400.
//
// Reglas (no abortan el lote; cada corrida se reporta):
//  - AUTZ por empresa de cada corrida: getEffectiveCompanyMembership. VIEWER o
//    sin acceso → se OMITE y se reporta (nunca timbra). Misma comprobación que
//    el endpoint de timbrado por corrida (/api/nomina/run/[id]/stamp).
//  - Sólo se timbran corridas en estado CALCULATED. DRAFT/STAMPED/PAID se omiten
//    con motivo (STAMPED ya está timbrada; DRAFT aún no se calcula).
//  - Idempotencia: stampPayrollRun() ya salta los items con cfdiUuid; reintentar
//    una corrida parcialmente timbrada sólo emite los faltantes.
//  - Candado: stampPayrollRun() reclama la corrida de forma atómica
//    (extraData.stampingInProgress). Si un timbrado individual se traslapa con
//    el lote, sólo una llamada emite; la otra se reporta con error, sin
//    duplicar CFDIs ante el SAT.
//
// Concurrencia: las corridas se procesan con un límite PEQUEÑO (2) para no
// saturar Facturapi entre empresas — cada corrida ya emite con concurrencia 5
// internamente. La salida agrega { stamped, total, errors } por corrida.
// ─────────────────────────────────────────────────────────────────────────────

// Petición de larga duración (emite CFDIs vía Facturapi para cientos de
// empleados en varias empresas) — mismo patrón que api/ai/chat/route.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RUN_CONCURRENCY = 2;

type TimbrarResult = {
  runId: string;
  companyId: string;
  razonSocial: string;
  stamped: number;
  total: number;
  skipped?: string;
  errors?: string[];
};

/** Ejecuta N tareas a la vez, conservando el orden de los resultados. */
async function parallelLimit<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;
  const actorEmail = session.user.email ?? null;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Cuerpo inválido" }, { status: 400 });
  }

  const { runIds } = (body ?? {}) as { runIds?: unknown };
  if (!Array.isArray(runIds) || runIds.length === 0) {
    return NextResponse.json({ error: "runIds requerido" }, { status: 400 });
  }
  // Sólo strings, deduplicados — la selección explícita del usuario.
  const ids = Array.from(
    new Set(runIds.filter((x): x is string => typeof x === "string" && x.length > 0))
  );
  if (ids.length === 0) {
    return NextResponse.json({ error: "runIds requerido" }, { status: 400 });
  }

  // Gating de suscripción (bandera SUBSCRIPTION_ENFORCEMENT_ENABLED).
  const gate = await gateEscritura(userId);
  if (gate) return gate;

  // Cargar las corridas una sola vez (estado + empresa) para validar antes de timbrar.
  const runs = await prisma.payrollRun.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      status: true,
      companyId: true,
      company: { select: { razonSocial: true } },
      _count: { select: { items: true } },
    },
  });
  const runById = new Map(runs.map((r) => [r.id, r]));

  // Caché de membresía por empresa: una sola verificación por compañía.
  const membershipCache = new Map<string, { role: string } | null>();
  async function membership(companyId: string) {
    if (membershipCache.has(companyId)) return membershipCache.get(companyId)!;
    const m = await getEffectiveCompanyMembership(userId, companyId);
    membershipCache.set(companyId, m);
    return m;
  }

  const tasks = ids.map((runId) => async (): Promise<TimbrarResult> => {
    const run = runById.get(runId);
    if (!run) {
      return { runId, companyId: "", razonSocial: runId, stamped: 0, total: 0, skipped: "no encontrada" };
    }
    const razonSocial = run.company.razonSocial || run.companyId;
    const base = { runId, companyId: run.companyId, razonSocial, total: run._count.items };

    try {
      // AUTZ por empresa: VIEWER o sin acceso nunca timbra.
      const member = await membership(run.companyId);
      if (!member || member.role === "VIEWER") {
        return { ...base, stamped: 0, skipped: "sin permisos" };
      }

      // Sólo CALCULATED se timbra; el resto se reporta con motivo.
      if (run.status !== "CALCULATED") {
        const motivo =
          run.status === "STAMPED"
            ? "ya timbrada"
            : run.status === "PAID"
              ? "ya pagada"
              : run.status === "DRAFT"
                ? "borrador (sin calcular)"
                : `estado ${run.status}`;
        return { ...base, stamped: 0, skipped: motivo };
      }

      // Reutiliza la lógica de timbrado por corrida: idempotente (salta items ya
      // timbrados), concurrencia 5 interna, pasa la corrida a STAMPED si completa.
      const result = await stampPayrollRun(runId);

      // Bitácora de seguridad: timbrado en lote, una fila por corrida que
      // efectivamente timbró CFDIs (fire-and-forget).
      if (result.stamped > 0) {
        registrarBitacora({
          companyId: run.companyId,
          userId,
          actorEmail,
          accion: "nomina.timbrar",
          entidad: "PayrollRun",
          entidadId: runId,
          detalle: {
            stamped: result.stamped,
            total: result.total,
            errores: result.errors.length,
            lote: true,
          },
          req,
        });
      }

      return {
        ...base,
        stamped: result.stamped,
        errors: result.errors.length ? result.errors : undefined,
      };
    } catch (e) {
      return { ...base, stamped: 0, errors: [e instanceof Error ? e.message : "Error desconocido"] };
    }
  });

  const results = await parallelLimit(tasks, RUN_CONCURRENCY);

  const totalStamped = results.reduce((s, r) => s + r.stamped, 0);
  const totalErrors = results.reduce((s, r) => s + (r.errors?.length ?? 0), 0);
  // Corridas efectivamente procesadas (timbraron al menos un CFDI nuevo o
  // quedaron completas) — excluye las omitidas por permisos/estado.
  const runsTimbradas = results.filter((r) => !r.skipped && r.stamped > 0).length;

  return NextResponse.json({ ok: true, results, totalStamped, totalErrors, runsTimbradas });
}
