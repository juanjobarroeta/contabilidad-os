/**
 * POST /api/hospital/servicios/importar
 *   multipart { archivo: xlsx/xls/csv, companyId, destino: "LISTA" | <pagadorId>,
 *               aplicar?: "1", desactivarFaltantes?: "1", lista?: <valor de la columna «lista de precio»> }
 *
 * Lista de precios del hospital → tarifario, cruzando por clave. Sin `aplicar`
 * sólo dice qué haría (nuevos, cambios de precio, iguales, faltantes y filas
 * con error); con `aplicar=1` lo hace en una transacción. Ver
 * src/lib/hospital/tarifario-importar.ts.
 *
 * - destino LISTA: crea lo nuevo con su categoría por grupo e IVA por default,
 *   actualiza precio de lista, nombre y grupo de lo que cambió y reactiva lo
 *   que estaba de baja. `desactivarFaltantes=1` da de baja lo que no vino.
 * - destino <pagadorId>: escribe el precio en el tabulador de ese pagador;
 *   una clave que no existe se crea con ese precio también como lista.
 * - Si la hoja trae varias listas (columna «lista de precio»), `lista` dice
 *   cuál importar; sin ella y con más de una, la vista previa responde
 *   { requiereLista, listas } y aplicar responde 400.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { ivaDefault } from "@/lib/hospital/util";
import { categoriaDeGrupo, filasDeArchivo, leerListaPrecios, planearImportacion, resumirPlan } from "@/lib/hospital/tarifario-importar";

const MAX_BYTES = 5 * 1024 * 1024;
const LOTE = 200;

export const POST = withHospital(async (req: Request) => {
  if (!(req.headers.get("content-type") ?? "").includes("multipart/form-data")) return error("Manda multipart con «archivo»");
  const form = await req.formData().catch(() => null);
  const f = form?.get("archivo");
  if (!f || typeof f === "string") return error("Falta el archivo (campo multipart «archivo»)");
  const campo = (k: string) => (typeof form?.get(k) === "string" ? String(form!.get(k)) : null);
  const companyId = campo("companyId") ?? new URL(req.url).searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  const destinoRaw = campo("destino") || "LISTA";
  const aplicar = campo("aplicar") === "1";
  const desactivarFaltantes = campo("desactivarFaltantes") === "1";
  const listaElegida = campo("lista");

  const buffer = Buffer.from(await f.arrayBuffer());
  if (buffer.length === 0) return error("Archivo vacío");
  if (buffer.length > MAX_BYTES) return error("El archivo pesa más de 5 MB", 413);

  const { user } = aplicar ? await requireWriter(companyId, req) : await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  let pagador: { id: string; nombre: string } | null = null;
  if (destinoRaw !== "LISTA") {
    pagador = await prisma.hospPagador.findFirst({ where: { id: destinoRaw, companyId }, select: { id: true, nombre: true } });
    if (!pagador) return error("El pagador destino no es de esta empresa");
  }

  const lectura = leerListaPrecios(filasDeArchivo(buffer));
  if (lectura.listas.length > 1 && !listaElegida) {
    // La pantalla pregunta cuál; aplicar sin elegir no se permite.
    if (aplicar) return error(`La hoja trae ${lectura.listas.length} listas (${lectura.listas.join(", ")}): elige cuál importar`, 400);
    return NextResponse.json({ aplicado: false, requiereLista: true, listas: lectura.listas, errores: lectura.errores });
  }
  const filas = listaElegida ? lectura.filas.filter((x) => (x.lista ?? "").toLowerCase() === listaElegida.toLowerCase()) : lectura.filas;

  const existentes = await prisma.hospServicio.findMany({
    where: { companyId },
    select: { id: true, clave: true, nombre: true, grupo: true, precioLista: true, activo: true, ...(pagador ? { tarifas: { where: { pagadorId: pagador.id }, select: { precio: true } } } : {}) },
  });
  const plan = planearImportacion(
    filas,
    existentes.map((s) => ({
      id: s.id, clave: s.clave, nombre: s.nombre, grupo: s.grupo, activo: s.activo, precioLista: Number(s.precioLista),
      precioPagador: "tarifas" in s && Array.isArray(s.tarifas) && s.tarifas[0] ? Number(s.tarifas[0].precio) : null,
    })),
    pagador ? { pagadorId: pagador.id } : "LISTA",
  );
  const resumen = { destino: pagador ? { pagadorId: pagador.id, nombre: pagador.nombre } : "LISTA", listas: lectura.listas, filas: filas.length, errores: lectura.errores, ...resumirPlan(plan) };
  if (!aplicar) return NextResponse.json({ aplicado: false, ...resumen });

  const config = await prisma.hospConfig.findUnique({ where: { companyId }, select: { ivaServicios: true } });
  const ivaServicios = config ? Number(config.ivaServicios) : null;

  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < plan.nuevos.length; i += LOTE) {
      await tx.hospServicio.createMany({
        data: plan.nuevos.slice(i, i + LOTE).map((n) => {
          const categoria = categoriaDeGrupo(n.grupo);
          return { companyId, clave: n.clave, nombre: n.descripcion, grupo: n.grupo, categoria, precioLista: n.precio, ivaTasa: ivaDefault(categoria, ivaServicios) };
        }),
        skipDuplicates: true,
      });
    }
    if (pagador) {
      const ids = new Map((await tx.hospServicio.findMany({ where: { companyId, clave: { in: filas.map((x) => x.clave) } }, select: { id: true, clave: true } })).map((s) => [s.clave, s.id]));
      for (const x of [...plan.nuevos, ...plan.cambios]) {
        const servicioId = ids.get(x.clave);
        if (!servicioId) continue;
        await tx.hospTarifa.upsert({
          where: { servicioId_pagadorId: { servicioId, pagadorId: pagador.id } },
          create: { servicioId, pagadorId: pagador.id, precio: x.precio },
          update: { precio: x.precio },
        });
      }
    } else {
      for (const c of plan.cambios) {
        await tx.hospServicio.update({
          where: { id: c.id },
          data: { precioLista: c.precio, nombre: c.descripcion, ...(c.grupo ? { grupo: c.grupo } : {}), ...(c.reactivar ? { activo: true } : {}) },
        });
      }
      if (desactivarFaltantes && plan.faltantes.length) {
        await tx.hospServicio.updateMany({ where: { id: { in: plan.faltantes.map((x) => x.id) } }, data: { activo: false } });
      }
    }
  }, { timeout: 120_000, maxWait: 10_000 });

  bitacora(user, req, {
    companyId,
    accion: "hospital.tarifario.importar",
    entidad: "HospServicio",
    entidadId: pagador?.id ?? "LISTA",
    detalle: {
      archivo: f.name,
      destino: pagador?.nombre ?? "Precio de lista",
      lista: listaElegida,
      nuevos: plan.nuevos.length,
      cambios: plan.cambios.length,
      iguales: plan.iguales,
      desactivados: !pagador && desactivarFaltantes ? plan.faltantes.length : 0,
      // El historial de precios: qué clave cambió de cuánto a cuánto (hasta 500).
      precios: plan.cambios.slice(0, 500).map((c) => [c.clave, c.antes, c.precio]),
    },
  });
  return NextResponse.json({ aplicado: true, ...resumen, desactivados: !pagador && desactivarFaltantes ? plan.faltantes.length : 0 });
});
