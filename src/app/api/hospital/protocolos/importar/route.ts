/**
 * POST /api/hospital/protocolos/importar
 *   multipart { archivo: xlsx, companyId, aplicar?: "1", omitir?: "CLAVE1,CLAVE2" }
 *
 * Tablas de cotización del hospital (una hoja por procedimiento) → protocolos,
 * para que la cotización y la agenda partan de ellos. Sin `aplicar` sólo
 * muestra lo que leyó: cada hoja con sus partidas, con qué servicio del
 * tarifario se emparejó cada una y si la clave ya existe. Con `aplicar=1` crea
 * los que no existen (y no se omitieron) en una transacción. Ver
 * src/lib/hospital/protocolo-importar.ts.
 *
 * Los precios de la hoja vienen CON IVA (su suma da el «TOTAL C/IVA»). Con
 * servicio del tarifario manda la tarifa; sin él se guarda el de la hoja sin
 * IVA (tasa por categoría) como precio de referencia, porque la cotización le
 * suma el IVA. El «PAQUETE» de la hoja queda como precio del paquete.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { ivaDefault, r2 } from "@/lib/hospital/util";
import { indexar } from "@/lib/hospital/cotizacion-competencia";
import { emparejarTabla, hojasDeArchivo, leerTablas } from "@/lib/hospital/protocolo-importar";

const MAX_BYTES = 5 * 1024 * 1024;

export const POST = withHospital(async (req: Request) => {
  if (!(req.headers.get("content-type") ?? "").includes("multipart/form-data")) return error("Manda multipart con «archivo»");
  const form = await req.formData().catch(() => null);
  const f = form?.get("archivo");
  if (!f || typeof f === "string") return error("Falta el archivo (campo multipart «archivo»)");
  const campo = (k: string) => (typeof form?.get(k) === "string" ? String(form!.get(k)) : null);
  const companyId = campo("companyId") ?? new URL(req.url).searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  const aplicar = campo("aplicar") === "1";
  const omitir = new Set((campo("omitir") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));

  const buffer = Buffer.from(await f.arrayBuffer());
  if (buffer.length === 0) return error("Archivo vacío");
  if (buffer.length > MAX_BYTES) return error("El archivo pesa más de 5 MB", 413);

  const { user } = aplicar ? await requireWriter(companyId, req) : await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  let tablas;
  try {
    tablas = leerTablas(hojasDeArchivo(buffer));
  } catch {
    return error("No se pudo leer el archivo: súbelo como Excel (.xlsx)");
  }
  if (tablas.length === 0) return error("Ninguna hoja trae una tabla con DESCRIPCIÓN y CANTIDAD", 422);

  const [servicios, config, existentes] = await Promise.all([
    prisma.hospServicio.findMany({ where: { companyId, activo: true }, select: { id: true, clave: true, nombre: true, categoria: true, precioLista: true, ivaTasa: true } }),
    prisma.hospConfig.findUnique({ where: { companyId }, select: { ivaServicios: true } }),
    prisma.hospProtocolo.findMany({ where: { companyId, clave: { in: tablas.map((t) => t.clave) } }, select: { clave: true } }),
  ]);
  const ivaServicios = config ? Number(config.ivaServicios) : null;
  const indice = indexar(servicios.map((s) => ({ id: s.id, clave: s.clave, nombre: s.nombre, categoria: s.categoria, precio: r2(Number(s.precioLista)), ivaTasa: s.ivaTasa == null ? null : Number(s.ivaTasa) })));
  const yaExisten = new Set(existentes.map((e) => e.clave));

  const plan = tablas.map((t) => {
    const partidas = emparejarTabla(t, indice).map((p) => {
      const tasa = ivaDefault(p.categoria, ivaServicios) ?? 0;
      return { ...p, precioReferencia: p.servicioId || p.precio == null ? null : Math.round((p.precio / (1 + tasa)) * 1e6) / 1e6 };
    });
    const accion = yaExisten.has(t.clave) ? "EXISTE" : omitir.has(t.clave) ? "OMITIDO" : "CREAR";
    return { ...t, accion, partidas, emparejadas: partidas.filter((p) => p.servicioId).length, renglones: undefined };
  });

  if (!aplicar) return NextResponse.json({ protocolos: plan });

  const crear = plan.filter((p) => p.accion === "CREAR");
  const creados = await prisma.$transaction(
    crear.map((p) =>
      prisma.hospProtocolo.create({
        data: {
          companyId,
          clave: p.clave,
          nombre: p.nombre.slice(0, 200),
          descripcion: `Importado de la hoja «${p.hoja.trim()}»${p.totalConIva != null ? ` · total de la hoja ${p.totalConIva} con IVA` : ""}`,
          tipoEpisodio: p.tipoEpisodio,
          estanciaNoches: p.estanciaNoches,
          quirofanoMinutos: p.quirofanoMinutos,
          precioPaquete: p.precioPaquete,
          partidas: {
            create: p.partidas.map((x, i) => ({
              orden: i, servicioId: x.servicioId, categoria: x.servicioId ? (servicios.find((s) => s.id === x.servicioId)?.categoria ?? x.categoria) : x.categoria,
              descripcion: x.descripcion.slice(0, 300), cantidad: x.cantidad, opcional: false, precioReferencia: x.precioReferencia,
            })),
          },
        },
        select: { id: true, clave: true, nombre: true },
      })
    )
  );

  bitacora(user, req, {
    companyId,
    accion: "hospital.protocolo.importar",
    detalle: { creados: creados.map((c) => c.clave), existian: plan.filter((p) => p.accion === "EXISTE").map((p) => p.clave), omitidos: [...omitir] },
  });
  return NextResponse.json({ protocolos: plan, creados });
});
