/**
 * GET /api/hospital/farmacia/libro-control?companyId=…[&desde=&hasta=&grupo=I|II|III&insumoId=&formato=json|csv|xlsx]
 *
 * Libro de control de medicamentos controlados (LGS arts. 234/245; libro
 * autorizado por COFEPRIS): cada entrada y salida de los insumos de los
 * grupos I-III en el periodo, con su lote y caducidad, el saldo corrido por
 * insumo (arranca del saldo al inicio del periodo), el paciente/episodio al
 * que salió, la receta que la ampara, el prescriptor con su cédula, el CFDI
 * de compra y quién capturó. `insumos` es el balance del periodo por
 * sustancia (saldo inicial, entradas, salidas, saldo final) —lo que se
 * presenta a la autoridad— y `encabezado` la identidad sanitaria del
 * establecimiento (licencia, responsable, CLUES) de HospConfig.
 *
 * Sin fechas: el mes local en curso; sólo `desde`: hasta hoy; sólo `hasta`:
 * desde el primer día de ese mes. `formato=csv`
 * o `xlsx` (también `format=`) descarga el mismo tabulado —el XLSX con el
 * encabezado y el balance en pestañas aparte— y deja constancia en
 * HospAcceso (EXPORTACION): quién sacó qué periodo y desde qué IP (NOM-024 /
 * LFPDPPP). La constancia se escribe ANTES de servir el archivo.
 */

import { NextResponse } from "next/server";
import type { HospGrupoControl } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { ipDeRequest } from "@/lib/audit";
import { toCsv, type CsvRow } from "@/lib/csv";
import { headersDescargaXlsx, toXlsx, type XlsxRow } from "@/lib/export/xlsx";
import { GRUPOS_LIBRO_CONTROL } from "@/lib/hospital/controlados";
import { nombrePaciente } from "@/lib/hospital/formato";
import { rangoDeQuery } from "@/lib/hospital/http";
import { claveDia, horaLocal, partesLocales, rangoMesLocal } from "@/lib/hospital/tz";
import { r2 } from "@/lib/hospital/util";

/** Tope de renglones por consulta: un mes de un hospital mediano cabe de sobra. */
const MAX_FILAS = 5000;
const FORMATOS = ["json", "csv", "xlsx"] as const;
type Formato = (typeof FORMATOS)[number];

const TIPO_LABEL: Record<string, string> = {
  ENTRADA_COMPRA: "Entrada por compra",
  SALIDA_APLICACION: "Salida a paciente",
  SALIDA_VENTA: "Salida por venta",
  AJUSTE: "Ajuste",
  MERMA: "Merma",
  CADUCIDAD: "Baja por caducidad",
  DEVOLUCION: "Devolución",
};

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const { user } = await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  // Periodo: [desde, hasta) en día local; default el mes en curso.
  const hoy = new Date();
  const desdeParam = searchParams.get("desde");
  const hastaParam = searchParams.get("hasta");
  let rango: { desde: Date; hasta: Date } | null;
  if (!desdeParam && !hastaParam) {
    const p = partesLocales(hoy);
    rango = rangoMesLocal(p.y, p.m);
  } else if (!desdeParam && hastaParam) {
    // Sólo `hasta`: desde el primer día de ese mes.
    const dia = rangoDeQuery(hastaParam, hastaParam, hoy);
    if (dia) {
      const p = partesLocales(dia.desde);
      rango = { desde: rangoMesLocal(p.y, p.m).desde, hasta: dia.hasta };
    } else {
      rango = null;
    }
  } else {
    rango = rangoDeQuery(desdeParam, hastaParam ?? claveDia(hoy), hoy);
  }
  if (!rango || rango.hasta.getTime() <= rango.desde.getTime()) {
    return NextResponse.json({ error: "Rango de fechas inválido (desde/hasta en formato AAAA-MM-DD)" }, { status: 400 });
  }
  const desdeDia = claveDia(rango.desde);
  const hastaDia = claveDia(new Date(rango.hasta.getTime() - 1));

  const grupoParam = (searchParams.get("grupo") ?? "").toUpperCase();
  if (grupoParam && !(GRUPOS_LIBRO_CONTROL as readonly string[]).includes(grupoParam)) {
    return NextResponse.json({ error: "grupo debe ser I, II o III (los grupos que llevan libro de control)" }, { status: 400 });
  }
  const grupo = grupoParam ? (grupoParam as HospGrupoControl) : null;
  const insumoId = searchParams.get("insumoId");
  const formatoParam = (searchParams.get("formato") ?? searchParams.get("format") ?? "json").toLowerCase();
  if (!(FORMATOS as readonly string[]).includes(formatoParam)) {
    return NextResponse.json({ error: "formato debe ser json, csv o xlsx" }, { status: 400 });
  }
  const formato = formatoParam as Formato;

  const [config, insumos] = await Promise.all([
    prisma.hospConfig.findUnique({
      where: { companyId },
      select: { nombreHospital: true, clues: true, licenciaSanitaria: true, responsableSanitario: true, responsableSanitarioCedula: true },
    }),
    prisma.hospInsumo.findMany({
      where: {
        companyId,
        grupoControl: grupo ? grupo : { in: [...GRUPOS_LIBRO_CONTROL] },
        ...(insumoId ? { id: insumoId } : {}),
      },
      select: { id: true, clave: true, nombre: true, presentacion: true, unidad: true, grupoControl: true, sustanciaActiva: true, registroSanitario: true, activo: true },
      orderBy: { nombre: "asc" },
    }),
  ]);
  if (insumoId && insumos.length === 0) {
    throw new AuthzError(404, "Insumo no encontrado o no es un controlado con libro (grupos I-III)");
  }
  const ids = insumos.map((i) => i.id);

  const [saldosPrevios, movimientos] = await Promise.all([
    prisma.hospMovimientoInsumo.groupBy({
      by: ["insumoId"],
      where: { companyId, insumoId: { in: ids }, fecha: { lt: rango.desde } },
      _sum: { cantidad: true },
    }),
    prisma.hospMovimientoInsumo.findMany({
      where: { companyId, insumoId: { in: ids }, fecha: { gte: rango.desde, lt: rango.hasta } },
      orderBy: [{ fecha: "asc" }, { createdAt: "asc" }],
      take: MAX_FILAS + 1,
      select: {
        id: true, fecha: true, tipo: true, cantidad: true, insumoId: true, referencia: true, usuarioNombre: true,
        recetaRef: true, prescriptorNombre: true, prescriptorCedula: true,
        lote: { select: { lote: true, caducidad: true } },
        episodio: { select: { id: true, folio: true, paciente: { select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true } } } },
        invoice: { select: { id: true, uuid: true, serie: true, folio: true, contraparteNombre: true, customer: { select: { razonSocial: true } } } },
      },
    }),
  ]);
  const truncado = movimientos.length > MAX_FILAS;

  // Saldo corrido por insumo: arranca del saldo al inicio del periodo.
  const porInsumo = new Map(insumos.map((i) => [i.id, i]));
  const saldo = new Map<string, number>(insumos.map((i) => [i.id, 0]));
  for (const s of saldosPrevios) saldo.set(s.insumoId, r2(Number(s._sum.cantidad ?? 0)));
  const saldoInicial = new Map(saldo);
  const acumulado = new Map<string, { entradas: number; salidas: number; movimientos: number; salidasSinReceta: number }>();

  const filas = movimientos.slice(0, MAX_FILAS).map((m) => {
    const insumo = porInsumo.get(m.insumoId)!;
    const cantidad = Number(m.cantidad);
    const entrada = cantidad > 0 ? r2(cantidad) : 0;
    const salida = cantidad < 0 ? r2(-cantidad) : 0;
    const nuevo = r2((saldo.get(m.insumoId) ?? 0) + cantidad);
    saldo.set(m.insumoId, nuevo);
    const acc = acumulado.get(m.insumoId) ?? { entradas: 0, salidas: 0, movimientos: 0, salidasSinReceta: 0 };
    acc.entradas = r2(acc.entradas + entrada);
    acc.salidas = r2(acc.salidas + salida);
    acc.movimientos++;
    if ((m.tipo === "SALIDA_APLICACION" || m.tipo === "SALIDA_VENTA") && !m.recetaRef) acc.salidasSinReceta++;
    acumulado.set(m.insumoId, acc);
    return {
      id: m.id,
      fecha: m.fecha,
      insumoId: m.insumoId,
      insumo: insumo.nombre,
      clave: insumo.clave,
      grupoControl: insumo.grupoControl,
      sustanciaActiva: insumo.sustanciaActiva,
      registroSanitario: insumo.registroSanitario,
      presentacion: insumo.presentacion,
      unidad: insumo.unidad,
      lote: m.lote?.lote ?? null,
      caducidad: m.lote?.caducidad ?? null,
      tipo: m.tipo,
      entrada,
      salida,
      saldo: nuevo,
      episodio: m.episodio ? { id: m.episodio.id, folio: m.episodio.folio } : null,
      paciente: m.episodio ? nombrePaciente(m.episodio.paciente) : null,
      recetaRef: m.recetaRef,
      prescriptor: m.prescriptorNombre,
      prescriptorCedula: m.prescriptorCedula,
      cfdi: m.invoice
        ? {
            id: m.invoice.id,
            uuid: m.invoice.uuid,
            serie: m.invoice.serie,
            folio: m.invoice.folio,
            contraparte: m.invoice.customer?.razonSocial ?? m.invoice.contraparteNombre ?? null,
          }
        : null,
      referencia: m.referencia,
      usuario: m.usuarioNombre,
    };
  });

  const balance = insumos.map((i) => {
    const acc = acumulado.get(i.id) ?? { entradas: 0, salidas: 0, movimientos: 0, salidasSinReceta: 0 };
    return {
      id: i.id,
      clave: i.clave,
      nombre: i.nombre,
      presentacion: i.presentacion,
      unidad: i.unidad,
      grupoControl: i.grupoControl,
      sustanciaActiva: i.sustanciaActiva,
      registroSanitario: i.registroSanitario,
      activo: i.activo,
      saldoInicial: saldoInicial.get(i.id) ?? 0,
      entradas: acc.entradas,
      salidas: acc.salidas,
      saldoFinal: saldo.get(i.id) ?? 0,
      movimientos: acc.movimientos,
      salidasSinReceta: acc.salidasSinReceta,
    };
  });

  const encabezado = {
    hospital: config?.nombreHospital ?? null,
    clues: config?.clues ?? null,
    licenciaSanitaria: config?.licenciaSanitaria ?? null,
    responsableSanitario: config?.responsableSanitario ?? null,
    responsableSanitarioCedula: config?.responsableSanitarioCedula ?? null,
    periodo: { desde: rango.desde, hasta: rango.hasta, desdeDia, hastaDia },
    grupo: grupo ?? "I-III",
    insumoId: insumoId ?? null,
    generadoAt: hoy,
  };
  const resumen = {
    insumos: insumos.length,
    filas: filas.length,
    entradas: r2(balance.reduce((s, b) => s + b.entradas, 0)),
    salidas: r2(balance.reduce((s, b) => s + b.salidas, 0)),
    salidasSinReceta: balance.reduce((s, b) => s + b.salidasSinReceta, 0),
    truncado,
  };

  if (formato === "json") {
    return NextResponse.json({ encabezado, resumen, insumos: balance, filas });
  }

  // ── Exportación: constancia primero, archivo después ─────────────────────
  await prisma.hospAcceso.create({
    data: {
      companyId,
      userId: user.id,
      userEmail: user.email,
      accion: "EXPORTACION",
      detalle:
        `Libro de control (${formato}) ${desdeDia} a ${hastaDia} · grupo ${grupo ?? "I-III"}` +
        (insumoId ? ` · insumo ${insumoId}` : "") +
        ` · ${filas.length} movimientos de ${insumos.length} insumos${truncado ? " (truncado)" : ""}`,
      ip: ipDeRequest(req),
    },
  });

  const cabeceras = [
    "Fecha", "Hora", "Insumo", "Clave", "Grupo", "Sustancia activa", "Registro sanitario", "Lote", "Caducidad",
    "Movimiento", "Entrada", "Salida", "Saldo", "Unidad", "Episodio", "Paciente", "Receta", "Prescriptor", "Cédula",
    "CFDI", "Referencia", "Capturó",
  ];
  const tabla: XlsxRow[] = filas.map((f) => [
    claveDia(f.fecha),
    horaLocal(f.fecha),
    f.insumo,
    f.clave,
    f.grupoControl,
    f.sustanciaActiva,
    f.registroSanitario,
    f.lote,
    f.caducidad ? claveDia(f.caducidad) : null,
    TIPO_LABEL[f.tipo] ?? f.tipo,
    f.entrada > 0 ? f.entrada : null,
    f.salida > 0 ? f.salida : null,
    f.saldo,
    f.unidad,
    f.episodio?.folio ?? null,
    f.paciente,
    f.recetaRef,
    f.prescriptor,
    f.prescriptorCedula,
    f.cfdi ? [f.cfdi.serie, f.cfdi.folio].filter(Boolean).join("-") || f.cfdi.uuid || f.cfdi.id : null,
    f.referencia,
    f.usuario,
  ]);
  const nombreArchivo = `libro-control-${desdeDia}-${hastaDia}${grupo ? `-grupo-${grupo}` : ""}`;

  if (formato === "csv") {
    return new NextResponse(toCsv(cabeceras, tabla as CsvRow[]), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${nombreArchivo}.csv"`,
      },
    });
  }

  const libro = toXlsx([
    {
      nombre: "Libro de control",
      headers: cabeceras,
      rows: tabla,
      anchos: [11, 6, 34, 16, 6, 16, 14, 12, 11, 18, 9, 9, 9, 8, 14, 28, 16, 26, 12, 14, 30, 22],
    },
    {
      nombre: "Balance",
      headers: ["Insumo", "Clave", "Grupo", "Sustancia activa", "Registro sanitario", "Unidad", "Saldo inicial", "Entradas", "Salidas", "Saldo final", "Movimientos", "Salidas sin receta"],
      rows: balance.map((b) => [b.nombre, b.clave, b.grupoControl, b.sustanciaActiva, b.registroSanitario, b.unidad, b.saldoInicial, b.entradas, b.salidas, b.saldoFinal, b.movimientos, b.salidasSinReceta]),
      anchos: [34, 16, 6, 16, 14, 8, 12, 10, 10, 11, 11, 16],
    },
    {
      nombre: "Encabezado",
      headers: ["Dato", "Valor"],
      rows: [
        ["Establecimiento", encabezado.hospital],
        ["CLUES", encabezado.clues],
        ["Licencia sanitaria", encabezado.licenciaSanitaria],
        ["Responsable sanitario", encabezado.responsableSanitario],
        ["Cédula del responsable", encabezado.responsableSanitarioCedula],
        ["Periodo", `${desdeDia} a ${hastaDia}`],
        ["Grupo", encabezado.grupo],
        ["Generado", hoy],
        ["Generó", user.email ?? user.name ?? user.id],
        ...(truncado ? [["Aviso", `Se muestran los primeros ${MAX_FILAS} movimientos; acota el periodo`]] : []),
      ],
      anchos: [24, 48],
    },
  ]);
  return new NextResponse(new Uint8Array(libro), { headers: headersDescargaXlsx(`${nombreArchivo}.xlsx`) });
});
