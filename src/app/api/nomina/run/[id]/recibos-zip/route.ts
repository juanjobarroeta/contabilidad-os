import { NextResponse } from "next/server";
import JSZip from "jszip";
import { prisma } from "@/lib/prisma";
import { requireUser, AuthzError, getEffectiveCompanyMembership } from "@/lib/authz";
import { decryptSecret } from "@/lib/crypto";
import { variantesUuid, normalizarUuid } from "@/lib/fiscal/uuid";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/nomina/run/[id]/recibos-zip — todos los recibos de la corrida en un ZIP.
//
// Por recibo: el XML (rawXml, siempre que lo tengamos — importados y emitidos)
// y el PDF (sólo emitidos desde la app: se pide a Facturapi, como
// facturas/[id]/download). Los que no tengan nada se listan en un
// _faltantes.txt en vez de fallar el ZIP entero.
// ─────────────────────────────────────────────────────────────────────────────

const FACTURAPI_BASE = "https://www.facturapi.io/v2";
const limpio = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 80);

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { id } = await params;
  const run = await prisma.payrollRun.findUnique({
    where: { id },
    include: {
      company: { select: { rfc: true, facturapiApiKey: true } },
      items: { select: { cfdiUuid: true, employee: { select: { nombre: true, apellidoPaterno: true, rfc: true } } } },
    },
  });
  if (!run) return NextResponse.json({ error: "Corrida no encontrada" }, { status: 404 });
  const member = await getEffectiveCompanyMembership(user.id, run.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const uuids = run.items.map((i) => i.cfdiUuid).filter((u): u is string => !!u);
  const invoices = uuids.length
    ? await prisma.invoice.findMany({
        where: { companyId: run.companyId, uuid: { in: variantesUuid(uuids) } },
        select: { uuid: true, rawXml: true, facturapiId: true },
      })
    : [];
  const porUuid = new Map(invoices.map((i) => [normalizarUuid(i.uuid ?? ""), i]));
  const apiKey = run.company.facturapiApiKey ? decryptSecret(run.company.facturapiApiKey) : null;

  const zip = new JSZip();
  const faltantes: string[] = [];
  let agregados = 0;
  for (const it of run.items) {
    const nombre = limpio(`${it.employee.apellidoPaterno}_${it.employee.nombre}_${it.employee.rfc}`);
    if (!it.cfdiUuid) { faltantes.push(`${nombre}: sin timbrar`); continue; }
    const inv = porUuid.get(normalizarUuid(it.cfdiUuid));
    let algo = false;
    if (inv?.rawXml) { zip.file(`${nombre}.xml`, inv.rawXml); algo = true; }
    if (inv?.facturapiId && apiKey) {
      try {
        const r = await fetch(`${FACTURAPI_BASE}/invoices/${inv.facturapiId}/pdf`, { headers: { Authorization: `Bearer ${apiKey}` } });
        if (r.ok) { zip.file(`${nombre}.pdf`, new Uint8Array(await r.arrayBuffer())); algo = true; }
      } catch { /* se anota abajo */ }
    }
    if (algo) agregados++; else faltantes.push(`${nombre}: sin XML ni PDF (${it.cfdiUuid})`);
  }
  if (faltantes.length) zip.file("_faltantes.txt", faltantes.join("\n"));
  if (agregados === 0) return NextResponse.json({ error: "Ningún recibo de esta corrida tiene XML o PDF disponible." }, { status: 422 });

  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="recibos_${run.company.rfc}_${run.periodo.replace(/\//g, "_")}.zip"`,
    },
  });
}
