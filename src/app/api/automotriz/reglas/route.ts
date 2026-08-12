import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { MAX_PATRON, validarRegla } from "@/lib/automotriz/reglas";

// ─────────────────────────────────────────────────────────────────────────────
// GET/POST/PATCH /api/automotriz/reglas?companyId=…
//
// Las reglas que el distribuidor confirmó sobre su propio residuo. Se capturan
// desde la cola de clusters del reporte de cobertura: se reconoce un grupo
// («BONO INCREMENTAL PISO», 1,765 conceptos, $44.4M), se dice qué es, y a
// partir de ahí la clasificación vuelve a ser determinista.
//
// Confirmar una regla MUEVE dinero de línea en el estado de resultados, así
// que exige permiso de escritura y se guarda quién y cuándo. Que el número se
// pueda explicar después es la mitad del producto.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const reglas = await prisma.reglaClasificacion.findMany({
    where: { companyId },
    orderBy: [{ activa: "desc" }, { createdAt: "desc" }],
  });
  return NextResponse.json({ reglas });
});

const postSchema = z.object({
  companyId: z.string().min(1),
  ambito: z.enum(["INGRESO", "EGRESO", "NOMINA"]),
  clavePrefijo: z.string().trim().max(8).nullable().optional(),
  patron: z.string().trim().max(MAX_PATRON).nullable().optional(),
  destino: z.string().trim().min(1).max(64),
  etiqueta: z.string().trim().min(1).max(120),
  razon: z.string().trim().max(500).nullable().optional(),
  /**
   * Una regla capturada a mano nace ACTIVA: quien la escribió ya la confirmó
   * al escribirla. Las propuestas de un modelo llegarán con activa=false y su
   * confirmación es un PATCH aparte — que es justo el punto de control.
   */
  activa: z.boolean().optional(),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { companyId, activa, ...datos } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  // La validación de fondo vive en la librería, no aquí: el mismo cheque tiene
  // que correr cuando las reglas entren por otra puerta (propuestas, importadas
  // de otro distribuidor) y no sólo cuando las teclea una persona.
  const problema = validarRegla({ ...datos, ambito: parsed.data.ambito });
  if (problema) return NextResponse.json({ error: problema }, { status: 400 });

  const encendida = activa ?? true;
  const regla = await prisma.reglaClasificacion.create({
    data: {
      companyId,
      ambito: parsed.data.ambito,
      clavePrefijo: datos.clavePrefijo?.trim() || null,
      patron: datos.patron?.trim() || null,
      destino: datos.destino,
      etiqueta: datos.etiqueta,
      razon: datos.razon ?? null,
      origen: "MANUAL",
      activa: encendida,
      confirmadaPor: encendida ? user.id : null,
      confirmadaAt: encendida ? new Date() : null,
    },
  });
  return NextResponse.json({ regla }, { status: 201 });
});

const patchSchema = z.object({
  companyId: z.string().min(1),
  id: z.string().min(1),
  activa: z.boolean(),
});

/**
 * Enciende o apaga una regla. Apagar NO la borra: la regla y su razón se
 * conservan porque explican por qué un número del cierre pasado era el que era.
 */
export const PATCH = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { companyId, id, activa } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  // El companyId va en el WHERE, no sólo en la autorización: sin él, un id de
  // otra empresa se podría prender desde una sesión con permiso en la propia.
  const { count } = await prisma.reglaClasificacion.updateMany({
    where: { id, companyId },
    data: {
      activa,
      confirmadaPor: activa ? user.id : null,
      confirmadaAt: activa ? new Date() : null,
    },
  });
  if (count === 0) return NextResponse.json({ error: "Regla no encontrada" }, { status: 404 });

  const regla = await prisma.reglaClasificacion.findUnique({ where: { id } });
  return NextResponse.json({ regla });
});
