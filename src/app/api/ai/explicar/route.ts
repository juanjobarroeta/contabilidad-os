import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { asegurarUsoIA, respuestaTopeIA } from "@/lib/ai/guardia";
import { recordLlmCost } from "@/lib/costos/record";
import { sanearRef, esRutaInterna, type Accion, type RefCopiloto } from "@/lib/copiloto/tarjetas";
import {
  accionesPara,
  CacheExplicaciones,
  llaveExplicacion,
  promptExplicacion,
  SISTEMA_EXPLICACION,
} from "@/lib/copiloto/explicar";
import { MODELO_RAPIDO, ajustarParams } from "@/lib/ai/modelos";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/explicar  { companyId, ref, ruta? } → { explicacion, acciones }
//
// La explicación corta de la mascota: ≤2 frases sobre el registro exacto que
// el usuario señaló. Modelo barato, sin herramientas, sin historial, y caché
// por (empresa, tipo, id, updatedAt): soltar la mascota dos veces sobre la
// misma celda no cuesta dos veces. Lo de fondo va al chat («Preguntar más»).
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const anthropic = new Anthropic();
const MODELO = process.env.AI_EXPLICAR_MODEL ?? MODELO_RAPIDO;

interface Respuesta {
  explicacion: string;
  acciones: Accion[];
}
const cache = new CacheExplicaciones<Respuesta>();

const num = (v: unknown) => (v == null ? null : Number(v));

/** Carga lo mínimo del registro para que el modelo hable de ÉL, no de lo que parece. */
async function cargarRegistro(companyId: string, ref: RefCopiloto): Promise<Record<string, unknown> | null> {
  try {
    switch (ref.tipo) {
      case "factura": {
        const f = await prisma.invoice.findFirst({
          where: { id: ref.id, companyId },
          select: {
            tipo: true, serie: true, folio: true, fecha: true, total: true, moneda: true, metodoPago: true,
            usoCfdi: true, status: true, contraparteNombre: true, contraparteRfc: true, naturaleza: true,
          },
        });
        return f ? { ...f, total: num(f.total) } : null;
      }
      case "movimiento": {
        const m = await prisma.bankTransaction.findFirst({
          where: { id: ref.id, companyId },
          select: { fecha: true, descripcion: true, monto: true, tipo: true, contraparteNombre: true, conceptoPago: true },
        });
        return m ? { ...m, monto: num(m.monto) } : null;
      }
      case "hallazgo":
        return await prisma.fiscalHallazgo.findFirst({
          where: { id: ref.id, companyId },
          select: {
            checkClave: true, severidad: true, mensaje: true, sugerencia: true,
            fundamentoLey: true, fundamentoArticulo: true, estado: true,
          },
        });
      case "obligacion":
      case "obligacion_mes": {
        // La celda del mes llega como «TIPO:YYYY-MM»; la obligación, por id o tipo.
        const clave = ref.id.split(":")[0];
        return await prisma.companyObligation.findFirst({
          where: { companyId, OR: [{ id: ref.id }, { tipo: clave }] },
          select: { tipo: true, descripcion: true, periodicidad: true, diaVencimiento: true, mesVencimiento: true },
        });
      }
      default:
        return null;
    }
  } catch (e) {
    console.error("[ai/explicar] no se pudo cargar el registro:", e instanceof Error ? e.message : e);
    return null;
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const companyId = typeof body?.companyId === "string" ? body.companyId : null;
  const ref = sanearRef(body?.ref);
  if (!companyId || !ref) return NextResponse.json({ error: "companyId y ref son requeridos" }, { status: 400 });
  const ruta = esRutaInterna(body?.ruta) ? body.ruta : ref.ruta;

  const member = await getEffectiveCompanyMembership(userId, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso a esta empresa" }, { status: 403 });

  const llave = llaveExplicacion(companyId, ref);
  const enCache = cache.get(llave);
  if (enCache) return NextResponse.json({ ...enCache, cache: true });

  const guardia = await asegurarUsoIA({ userId, companyId });
  if (!guardia.ok) return respuestaTopeIA(guardia);

  const registro = await cargarRegistro(companyId, ref);
  const acciones = accionesPara(ref);

  try {
    const r = await anthropic.messages.create(ajustarParams({
      model: MODELO,
      max_tokens: 160,
      system: SISTEMA_EXPLICACION,
      messages: [{ role: "user", content: promptExplicacion(ref, registro, ruta) }],
    }));
    await recordLlmCost(MODELO, r.usage, { companyId, userId, subtipo: "ai.explicar" });
    const explicacion = r.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400);
    const resp: Respuesta = {
      explicacion: explicacion || `Esto es «${ref.titulo}». Pregúntame más en el chat y lo reviso con tus datos.`,
      acciones,
    };
    if (explicacion) cache.set(llave, resp);
    return NextResponse.json(resp);
  } catch (e) {
    console.error("[ai/explicar] el modelo falló:", e instanceof Error ? e.message : e);
    return NextResponse.json({
      explicacion: `Esto es «${ref.titulo}». Ahora no pude resumirlo; pregúntame en el chat.`,
      acciones,
    });
  }
}
