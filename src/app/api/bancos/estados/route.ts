import { NextResponse } from "next/server";
import { requireBancosAccess, requireEscrituraBancos, sesionOBearer } from "@/lib/bancos/statements/access";
import { gateEscritura } from "@/lib/subscription";
import { publicError } from "@/lib/bancos/statements/contract";
import { panelEstados, cuentaPorTexto } from "@/lib/bancos/statements/panel";
import { uploadBankDocument } from "@/lib/bancos/statements/upload";
import { leerPdf } from "@/lib/bancos/pdf-paginas";
import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// GET  /api/bancos/estados?companyId&year[&month]  → cuadrícula cuentas × meses,
//      documentos «Sin mes» y, con month, de qué se compone la diferencia
//      banco vs libros del mes.
// POST /api/bancos/estados?companyId[&bankAccountId]  (multipart: file, password?)
//      → sube un estado de cualquier cuenta y mes: si no se indica la cuenta, se
//      reconoce por el número o la CLABE impresos en el documento.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const maxDuration = 300;
const noStore = { "Cache-Control": "no-store" };
const fallo = (e: unknown) => NextResponse.json({ error: publicError(e) }, { status: (e as { status?: number }).status ?? 409, headers: noStore });

export async function GET(req: Request) {
  const session = await sesionOBearer(req); if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const p = new URL(req.url).searchParams;
  const companyId = p.get("companyId") ?? "", year = Number(p.get("year") ?? new Date().getUTCFullYear()), month = p.get("month") ? Number(p.get("month")) : null;
  if (!companyId || !Number.isInteger(year)) return NextResponse.json({ error: "Empresa y año requeridos." }, { status: 400 });
  try {
    const access = await requireBancosAccess(session.user.id, companyId);
    return NextResponse.json({ ...(await panelEstados(companyId, year, month)), canWrite: access.canWrite }, { headers: noStore });
  } catch (e) { return fallo(e); }
}

export async function POST(req: Request) {
  const session = await sesionOBearer(req); if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const p = new URL(req.url).searchParams;
  const companyId = p.get("companyId") ?? "";
  if (!companyId) return NextResponse.json({ error: "Empresa requerida." }, { status: 400 });
  try {
    await requireEscrituraBancos(session.user.id, companyId);
    const gate = await gateEscritura(session.user.id); if (gate) return gate;
    const form = await req.formData(), file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Selecciona un archivo." }, { status: 400 });
    if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: "El archivo excede 15 MB." }, { status: 413 });
    if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.type)) return NextResponse.json({ error: "Usa PDF o imagen." }, { status: 415 });
    const bytes = Buffer.from(await file.arrayBuffer());
    let bankAccountId = p.get("bankAccountId") ?? (typeof form.get("bankAccountId") === "string" ? String(form.get("bankAccountId")) : "");
    if (bankAccountId) {
      const ok = await prisma.bankAccount.findFirst({ where: { id: bankAccountId, companyId }, select: { id: true } });
      if (!ok) return NextResponse.json({ error: "Cuenta no encontrada en esta empresa." }, { status: 404 });
    } else {
      const texto = file.type === "application/pdf" ? (await leerPdf(bytes).catch(() => null))?.texto ?? "" : "";
      const cuenta = texto ? await cuentaPorTexto(companyId, texto) : null;
      if (!cuenta) return NextResponse.json({ necesitaCuenta: true, error: "No se reconoció la cuenta en el documento: elige a cuál pertenece." }, { status: 422, headers: noStore });
      bankAccountId = cuenta.id;
    }
    const result = await uploadBankDocument({ companyId, bankAccountId, userId: session.user.id, bytes, filename: file.name, mime: file.type,
      password: String(form.get("password") ?? "") });
    return NextResponse.json({ ...result, bankAccountId }, { status: "needsPassword" in result && result.needsPassword ? 422 : 200, headers: noStore });
  } catch (e) { return fallo(e); }
}
