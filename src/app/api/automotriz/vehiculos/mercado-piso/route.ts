import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { consultarMercadoVehiculo } from "@/lib/automotriz/mercado";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/automotriz/vehiculos/mercado-piso?companyId=… — el barrido: pone
// precio de mercado a TODO el piso seminuevo disponible de un jalón, para que
// la lista de inventario enseñe «±N% vs mercado» por unidad sin abrir fichas.
//
// Respeta la caché de 7 días (sólo consulta lo vencido o nunca visto), agrupa
// por marca+modelo+año (dos Sei7 2021 comparten UNA búsqueda) y corta a 30
// consultas por corrida para cuidar la cuota mensual compartida.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CONSULTAS = 30;
const FRESCO_MS = 7 * 24 * 60 * 60 * 1000;

export const POST = withAuthz(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const unidades = await prisma.vehiculo.findMany({
    where: { companyId, tipo: "SEMINUEVO", estado: { in: ["DISPONIBLE", "APARTADO"] } },
    select: {
      id: true, marca: true, modelo: true, anio: true,
      mercado: { select: { consultadoAt: true } },
    },
  });

  const ahora = Date.now();
  const pendientes = unidades.filter(
    (u) => (u.marca || u.modelo) && (!u.mercado || ahora - new Date(u.mercado.consultadoAt).getTime() > FRESCO_MS)
  );

  // Dos unidades iguales comparten una búsqueda: se agrupa por marca+modelo+año.
  const grupos = new Map<string, typeof pendientes>();
  for (const u of pendientes) {
    const llave = [u.marca, u.modelo, u.anio].join("|");
    const arr = grupos.get(llave) ?? [];
    arr.push(u);
    grupos.set(llave, arr);
  }

  let consultas = 0;
  let unidadesActualizadas = 0;
  const errores: string[] = [];

  for (const [, grupo] of grupos) {
    if (consultas >= MAX_CONSULTAS) break;
    const u = grupo[0];
    await new Promise((r) => setTimeout(r, 1_200)); // 1 req/s del plan gratis
    try {
      const resumen = await consultarMercadoVehiculo(u.marca, u.modelo, u.anio);
      consultas += resumen.busquedas;
      const datos = {
        consultadoAt: new Date(),
        precioMin: resumen.precioMin,
        precioMax: resumen.precioMax,
        precioMediana: resumen.precioMediana,
        listados: resumen.listados,
        resultados: resumen.resultados,
      };
      for (const unidad of grupo) {
        await prisma.vehiculoMercado.upsert({
          where: { vehiculoId: unidad.id },
          create: { companyId, vehiculoId: unidad.id, ...datos },
          update: datos,
        });
        unidadesActualizadas++;
      }
    } catch (e) {
      const err = e as Error & { cuotaAgotada?: boolean };
      errores.push(`${u.marca} ${u.modelo} ${u.anio}: ${err.message}`.slice(0, 100));
      consultas += 1;
      if (err.cuotaAgotada) break;
    }
  }

  registrarBitacora({
    companyId,
    userId: user.id,
    actorEmail: user.email,
    accion: "automotriz.mercado.piso",
    entidad: "VehiculoMercado",
    detalle: { consultas, unidadesActualizadas, pendientesAlInicio: pendientes.length },
  });
  return NextResponse.json({
    piso: unidades.length,
    yaFrescas: unidades.length - pendientes.length,
    consultas,
    unidadesActualizadas,
    errores: errores.slice(0, 5),
  });
});
