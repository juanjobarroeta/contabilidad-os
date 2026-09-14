import { NextResponse } from "next/server";
import { requireMembership, requireWriter, withAuthz } from "@/lib/authz";
import { esConfianza, esTema, esTipoNota, type Confianza } from "@/lib/expediente/claves";
import { hechosVigentes, historiaDeClave, registrarHecho } from "@/lib/expediente/hechos";
import { anotar, notasRecientes, pendientesAbiertas } from "@/lib/expediente/notas";

// ─────────────────────────────────────────────────────────────────────────────
// GET  /api/expediente?companyId=[&clave=]   → el expediente, o la historia de una clave
// POST /api/expediente                        → registra un hecho o escribe una nota
//
// Lo que se captura AQUÍ lleva fuente «usuario»: lo escribió una persona, con
// sus palabras. Es la única vía por la que un hecho puede quedar verificado y
// dejar de ser pisable por los motores y por el agente.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

export const GET = withAuthz(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const companyId = sp.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId es requerido" }, { status: 400 });
  await requireMembership(companyId, undefined, req);

  const clave = sp.get("clave");
  if (clave) return NextResponse.json({ historia: await historiaDeClave(companyId, clave) });

  const tema = sp.get("tema");
  const tipo = sp.get("tipo");
  const estado = sp.get("estado");
  const [hechos, pendientes, notas] = await Promise.all([
    hechosVigentes(companyId),
    pendientesAbiertas(companyId, 50),
    notasRecientes(companyId, {
      tema: esTema(tema) ? tema : undefined,
      tipo: esTipoNota(tipo) ? tipo : undefined,
      estado: estado === "abierta" || estado === "resuelta" ? estado : undefined,
      limite: 100,
    }),
  ]);
  return NextResponse.json({ hechos, pendientes, notas });
});

export const POST = withAuthz(async (req: Request) => {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const companyId = typeof body?.companyId === "string" ? body.companyId : null;
  if (!companyId) return NextResponse.json({ error: "companyId es requerido" }, { status: 400 });
  const { user } = await requireWriter(companyId, req);

  const texto = (k: string): string | undefined =>
    typeof body?.[k] === "string" && (body[k] as string).trim() ? (body[k] as string).trim() : undefined;
  const refs = Array.isArray(body?.refs)
    ? (body.refs as unknown[]).filter((x): x is string => typeof x === "string")
    : [];

  if (body?.kind === "hecho") {
    const clave = texto("clave");
    const valor = texto("valor");
    if (!clave || !valor) return NextResponse.json({ error: "clave y valor son requeridos" }, { status: 400 });
    const confianza: Confianza = esConfianza(body.confianza) ? body.confianza : "alta";
    const r = await registrarHecho({
      companyId,
      clave: clave.toLowerCase(),
      valor,
      fuente: "usuario",
      evidencia: refs,
      confianza,
      // Lo que una persona captura aquí nace verificado salvo que diga lo
      // contrario: es exactamente el acto de confirmarlo.
      verificado: body.verificado !== false,
    });
    return NextResponse.json(r);
  }

  const titulo = texto("titulo");
  const cuerpo = texto("cuerpo");
  if (!titulo || !cuerpo) return NextResponse.json({ error: "titulo y cuerpo son requeridos" }, { status: 400 });
  const nota = await anotar({
    companyId,
    autor: "usuario",
    autorId: user.id,
    tipo: esTipoNota(body?.tipo) && body.tipo !== "resumen_corrida" ? body.tipo : "observacion",
    tema: esTema(body?.tema) ? body.tema : "general",
    titulo,
    cuerpo,
    refs,
  });
  return NextResponse.json({ nota });
});
