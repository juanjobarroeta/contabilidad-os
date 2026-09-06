/**
 * POST /api/hospital/contabilidad/apertura/leer-balanza
 *   multipart { archivo: xlsx/xls/csv, companyId } (o ?companyId=), o JSON { companyId, base64, nombre }
 *   → { columnas, lineas: [{ fila, codigo, nombre, saldoDeudor, saldoAcreedor, saldo, agrupadora,
 *        cuentaSugerida: { codigo, nombre, tipo, naturaleza } | null, confianza: EXACTA|PREFIJO|NOMBRE|null }],
 *      sinMapear: [...], totales: { cuentas, deudor, acreedor, diferencia, tolerancia, cuadra }, advertencia }
 *
 * Lee la balanza del sistema anterior y propone la cuenta del catálogo de la
 * empresa para cada línea; `lineas[].saldo` ya va en el signo que espera
 * POST /contabilidad/apertura. No escribe nada. Ver src/lib/hospital/balanza.ts.
 */

import { NextResponse } from "next/server";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { prisma } from "@/lib/prisma";
import { leerBalanza } from "@/lib/hospital/balanza";
import { catalogoDeEmpresa } from "@/lib/hospital/contabilidad";

const MAX_BYTES = 5 * 1024 * 1024;

async function leerEntrada(req: Request): Promise<{ companyId: string | null; buffer: Buffer; nombre: string } | { error: string; status: number }> {
  const contentType = req.headers.get("content-type") ?? "";
  const companyIdQuery = new URL(req.url).searchParams.get("companyId");
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    const f = form?.get("archivo");
    if (!f || typeof f === "string") return { error: "Falta el archivo (campo multipart «archivo»)", status: 400 };
    const companyId = (typeof form?.get("companyId") === "string" ? String(form.get("companyId")) : null) ?? companyIdQuery;
    return { companyId, buffer: Buffer.from(await f.arrayBuffer()), nombre: f.name || "balanza.xlsx" };
  }
  const body = (await req.json().catch(() => null)) as { companyId?: unknown; base64?: unknown; nombre?: unknown } | null;
  if (!body || typeof body.base64 !== "string" || !body.base64) {
    return { error: "Manda multipart con «archivo» o JSON { companyId, base64, nombre }", status: 400 };
  }
  return {
    companyId: typeof body.companyId === "string" ? body.companyId : companyIdQuery,
    buffer: Buffer.from(body.base64, "base64"),
    nombre: typeof body.nombre === "string" && body.nombre ? body.nombre.slice(0, 200) : "balanza.xlsx",
  };
}

export const POST = withHospital(async (req: Request) => {
  const entrada = await leerEntrada(req);
  if ("error" in entrada) return error(entrada.error, entrada.status);
  if (!entrada.companyId) return error("companyId requerido");
  if (entrada.buffer.length === 0) return error("Archivo vacío");
  if (entrada.buffer.length > MAX_BYTES) return error("El archivo pesa más de 5 MB", 413);

  await requireMembership(entrada.companyId, undefined, req);
  await requireModule(entrada.companyId, "HOSPITAL", req);

  const catalogo = await catalogoDeEmpresa(prisma, entrada.companyId);
  return NextResponse.json(leerBalanza(entrada.buffer, entrada.nombre, catalogo));
});
