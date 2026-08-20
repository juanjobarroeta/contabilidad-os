import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";
import { registrarBitacora } from "@/lib/audit";
import { emitirComplementoPago } from "@/lib/complementos-rep-emit";

// ─────────────────────────────────────────────────────────────────────────────
// Emisión de complementos de pago (REP) EN LOTE.
//
// POST { companyId, items: [{ invoiceId, bankTransactionId?, monto?, fechaPago?,
// formaPago? }] } — cada item pasa por el MISMO motor que la emisión individual
// (emitirComplementoPago: validación fiscal, timbrado en Facturapi y
// persistencia consistente). Reglas del lote:
//
//   - SECUENCIAL, nunca en paralelo: cada emisión timbra un CFDI real ante el
//     SAT; paralelizar arriesga parcialidades cruzadas sobre el mismo padre y
//     condiciones de carrera en los saldos.
//   - Un fallo NO aborta el resto: se acumula el resultado por item y el
//     cliente decide qué reintentar.
//   - Tope de 20 por lote: el timbrado es lento y costoso; un lote más grande
//     se parte en varios.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_LOTE = 20;

interface ItemLote {
  invoiceId: string;
  bankTransactionId?: string;
  monto?: number;
  fechaPago?: string;
  formaPago?: string;
}

interface ResultadoItem {
  invoiceId: string;
  ok: boolean;
  uuid?: string;
  monto?: number;
  numParcialidad?: number;
  error?: string;
}

// POST /api/facturas/complemento-pagos/lote
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const companyId: unknown = body?.companyId;
  const items: unknown = body?.items;

  if (typeof companyId !== "string" || !companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: "items requerido (arreglo con al menos un complemento por emitir)" }, { status: 400 });
  }
  if (items.length > MAX_LOTE) {
    return NextResponse.json(
      { error: `Máximo ${MAX_LOTE} complementos por lote — cada uno timbra un CFDI real ante el SAT. Parte la emisión en varios lotes.` },
      { status: 400 },
    );
  }
  if (items.some((it) => typeof it?.invoiceId !== "string" || !it.invoiceId)) {
    return NextResponse.json({ error: "Cada item del lote necesita su invoiceId" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  // Gating de suscripción (mismo que la emisión individual).
  const gate = await gateEscritura(session.user.id);
  if (gate) return gate;

  const lote = items as ItemLote[];
  const resultados: ResultadoItem[] = [];

  // Secuencial a propósito: cada iteración timbra un CFDI real.
  for (const item of lote) {
    try {
      const r = await emitirComplementoPago({
        companyId,
        invoiceId: item.invoiceId,
        bankTransactionId: item.bankTransactionId,
        monto: item.monto,
        fechaPago: item.fechaPago,
        formaPago: item.formaPago,
      });
      if (r.ok) {
        resultados.push({ invoiceId: item.invoiceId, ok: true, uuid: r.uuid, monto: r.monto, numParcialidad: r.numParcialidad });
        // Misma entrada que la emisión individual, para que la bitácora no
        // distinga cómo se llegó al timbrado.
        registrarBitacora({
          accion: "complemento.emitir",
          userId: session.user.id,
          companyId,
          entidad: "Invoice",
          entidadId: item.invoiceId,
          detalle: { uuid: r.uuid, monto: r.monto, parcialidad: r.numParcialidad, parentUuid: r.parentUuid, lote: true },
        });
      } else {
        resultados.push({ invoiceId: item.invoiceId, ok: false, error: r.error });
      }
    } catch (e) {
      // Un item que explota (red, Prisma…) no debe tirar el resto del lote.
      console.error("[complemento-pago/lote] fallo inesperado", item.invoiceId, e);
      resultados.push({
        invoiceId: item.invoiceId,
        ok: false,
        error: e instanceof Error ? e.message : "Error inesperado al emitir el complemento.",
      });
    }
  }

  const emitidos = resultados.filter((r) => r.ok).length;
  const fallidos = resultados.length - emitidos;

  // Resumen del lote en bitácora (además de la entrada por CFDI emitido).
  registrarBitacora({
    accion: "complemento.emitir-lote",
    userId: session.user.id,
    companyId,
    entidad: "Invoice",
    detalle: { total: resultados.length, emitidos, fallidos },
  });

  return NextResponse.json({ total: resultados.length, emitidos, fallidos, resultados });
}
