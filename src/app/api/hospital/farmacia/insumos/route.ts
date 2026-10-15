/**
 * GET  /api/hospital/farmacia/insumos?companyId=…[&q=&tab=TODOS|BAJO_MINIMO|POR_CADUCAR|CONTROLADOS|SIN_EXISTENCIA
 *                                                  &controlados=1&refrigeracion=1&grupo=I|II|III|IV|V|VI&incluirInactivos=1
 *                                                  &origen=INVENTARIO|CFDI|TODOS&almacen=<nombre>]
 * POST /api/hospital/farmacia/insumos   { companyId, nombre, clave?, …, grupoControl?, registroSanitario?, sustanciaActiva?, requiereRefrigeracion? }
 *
 * Farmacia y almacén como lo lee el jefe de farmacia: una fila por insumo con
 * sus LOTES (caducidad y existencia por lote), el estado (en nivel / bajo
 * mínimo / sin existencia) y el valor a último costo. La verdad de la
 * existencia es el KARDEX (Σ HospMovimientoInsumo.cantidad, una consulta
 * agrupada para todo el catálogo); HospLote.existencia es el saldo
 * materializado por lote. Los KPIs y `porTab` respetan la búsqueda y los
 * filtros.
 *
 * Controlados (LGS arts. 234/245): `grupoControl` I-VI, `sustanciaActiva` y
 * `registroSanitario` COFEPRIS; `exigeLibroControl` / `exigeRecetaEspecial`
 * salen del grupo para que el satélite lo etiquete. Cadena de frío:
 * `requiereRefrigeracion`. `controlados=1` = grupo I-III o bandera
 * `controlado`; `refrigeracion=1` = cadena de frío; `grupo=` un grupo exacto.
 *
 * POST da de alta un insumo capturado a mano (derivadoDeCfdi = false); los
 * derivados del archivo de CFDIs nacen en insumos-cfdi.ts. Sin `grupoControl`
 * explícito se PROPONE por nombre (lib/hospital/controlados) —la respuesta lo
 * avisa con `grupoControlPropuesto`— y el responsable sanitario lo confirma.
 *
 * ORIGEN y ALMACÉN (lib/hospital/farmacia-almacenes): la lista arranca en
 * `origen=INVENTARIO` —lo que cargó el inventario físico y lo capturado a
 * mano—; los insumos que sólo nacieron de CFDIs, sin lote, se ven con
 * `origen=CFDI`. `almacen=` deja los insumos con lotes o kardex en ese almacén
 * y su existencia ES la de ese almacén: el kardex repartido por el almacén del
 * lote de cada movimiento. Sin filtro, cada insumo trae `porAlmacen`. La
 * respuesta trae `almacenes` (para el selector) y `porOrigen`, ambos sobre la
 * búsqueda y los filtros vigentes, como los KPIs.
 */

import { NextResponse } from "next/server";
import { precioAlEntrar } from "@/lib/hospital/factores-precio";
import { z } from "zod";
import type { HospGrupoControl, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import { diasDesde, r2 } from "@/lib/hospital/cobranza";
import { claveDeInsumo } from "@/lib/hospital/insumos-cfdi";
import { banderasControl, exigeLibroControl, GRUPOS_LIBRO_CONTROL, sustanciaControladaPorNombre } from "@/lib/hospital/controlados";
import { ORIGENES, origenDe, pasaOrigen, repartirPorAlmacen, type FiltroOrigen } from "@/lib/hospital/farmacia-almacenes";

const TABS = ["TODOS", "BAJO_MINIMO", "POR_CADUCAR", "CONTROLADOS", "SIN_EXISTENCIA"] as const;
type Tab = (typeof TABS)[number];

const GRUPOS = ["I", "II", "III", "IV", "V", "VI"] as const;

type EstadoLote = "EN_NIVEL" | "CADUCA" | "CADUCADO" | "SIN_VERIFICAR";
type EstadoInsumo = "EN_NIVEL" | "BAJO_MINIMO" | "SIN_EXISTENCIA";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const q = (searchParams.get("q") ?? "").trim();
  const tabParam = (searchParams.get("tab") ?? "TODOS").toUpperCase();
  const tab: Tab = (TABS as readonly string[]).includes(tabParam) ? (tabParam as Tab) : "TODOS";
  const incluirInactivos = searchParams.get("incluirInactivos") === "1";
  const soloControlados = searchParams.get("controlados") === "1";
  const soloRefrigeracion = searchParams.get("refrigeracion") === "1";
  const grupoParam = (searchParams.get("grupo") ?? "").toUpperCase();
  const grupo = (GRUPOS as readonly string[]).includes(grupoParam) ? (grupoParam as HospGrupoControl) : null;
  const como = { contains: q, mode: "insensitive" as const };
  const hoy = new Date();
  const origenParam = (searchParams.get("origen") ?? "INVENTARIO").toUpperCase();
  const origen: FiltroOrigen = (ORIGENES as readonly string[]).includes(origenParam) ? (origenParam as FiltroOrigen) : "INVENTARIO";
  const almacen = (searchParams.get("almacen") ?? "").trim() || null;

  const condiciones: Prisma.HospInsumoWhereInput[] = [];
  if (!incluirInactivos) condiciones.push({ activo: true });
  if (q) condiciones.push({ OR: [{ clave: como }, { nombre: como }, { presentacion: como }, { sustanciaActiva: como }, { registroSanitario: como }] });
  if (soloControlados) condiciones.push({ OR: [{ controlado: true }, { grupoControl: { in: [...GRUPOS_LIBRO_CONTROL] } }] });
  if (soloRefrigeracion) condiciones.push({ requiereRefrigeracion: true });
  if (grupo) condiciones.push({ grupoControl: grupo });

  const [config, insumosDb, existencias, lotesEmpresa] = await Promise.all([
    prisma.hospConfig.findUnique({ where: { companyId }, select: { diasAlertaCaducidad: true } }),
    prisma.hospInsumo.findMany({
      where: { companyId, AND: condiciones },
      select: {
        id: true, clave: true, nombre: true, presentacion: true, unidad: true, categoria: true,
        controlado: true, grupoControl: true, registroSanitario: true, sustanciaActiva: true, requiereRefrigeracion: true,
        minimo: true, ultimoCosto: true, precioVenta: true, precioFijo: true, ivaTasa: true,
        claveProdServ: true, derivadoDeCfdi: true, activo: true, updatedAt: true,
        _count: { select: { lotes: true } },
        lotes: {
          where: { existencia: { gt: 0 }, ...(almacen ? { almacen } : {}) },
          select: { id: true, lote: true, almacen: true, caducidad: true, existencia: true, costoUnitario: true, recibidoAt: true, invoiceId: true, bloqueado: true, bloqueoMotivo: true },
          orderBy: [{ caducidad: { sort: "asc", nulls: "last" } }],
        },
      },
      orderBy: { nombre: "asc" },
    }),
    prisma.hospMovimientoInsumo.groupBy({
      by: ["insumoId", "loteId"],
      where: { companyId },
      _sum: { cantidad: true },
    }),
    prisma.hospLote.findMany({ where: { companyId }, select: { id: true, almacen: true, costoUnitario: true } }),
  ]);

  const diasAlerta = config?.diasAlertaCaducidad ?? 90;
  const movs = existencias.map((e) => ({ insumoId: e.insumoId, loteId: e.loteId, cantidad: Number(e._sum.cantidad ?? 0) }));
  const existenciaDe = new Map<string, number>();
  for (const m of movs) existenciaDe.set(m.insumoId, r2((existenciaDe.get(m.insumoId) ?? 0) + m.cantidad));
  const lotesMapa = new Map(lotesEmpresa.map((l) => [l.id, { almacen: l.almacen, costoUnitario: Number(l.costoUnitario) }]));

  // Origen de cada insumo y conteo por origen (sobre la búsqueda y filtros).
  const origenPorId = new Map(insumosDb.map((i) => [i.id, origenDe({ derivadoDeCfdi: i.derivadoDeCfdi, lotes: i._count.lotes })]));
  const porOrigen = {
    INVENTARIO: [...origenPorId.values()].filter((o) => o === "INVENTARIO").length,
    CFDI: [...origenPorId.values()].filter((o) => o === "CFDI").length,
    TODOS: origenPorId.size,
  };
  const delOrigen = new Set(insumosDb.filter((i) => pasaOrigen(origen, origenPorId.get(i.id)!)).map((i) => i.id));
  const { porInsumo: almacenDe, resumen: almacenes } = repartirPorAlmacen(movs, lotesMapa, delOrigen);

  const estadoLote = (caducidad: Date | null): { dias: number | null; estado: EstadoLote } => {
    if (!caducidad) return { dias: null, estado: "SIN_VERIFICAR" };
    const dias = diasDesde(hoy, caducidad);
    if (dias < 0) return { dias, estado: "CADUCADO" };
    if (dias <= diasAlerta) return { dias, estado: "CADUCA" };
    return { dias, estado: "EN_NIVEL" };
  };

  const enAlmacen = (id: string) => !almacen || almacenDe.get(id)?.has(almacen) === true;
  const insumos = insumosDb.filter((i) => delOrigen.has(i.id) && (enAlmacen(i.id) || (almacen != null && i.lotes.length > 0))).map((i) => {
    // Con almacén elegido, la existencia es la de ESE almacén (kardex por lote).
    const existencia = almacen ? r2(almacenDe.get(i.id)?.get(almacen) ?? 0) : existenciaDe.get(i.id) ?? 0;
    const minimo = Number(i.minimo);
    const ultimoCosto = i.ultimoCosto == null ? null : Number(i.ultimoCosto);
    const estado: EstadoInsumo =
      existencia <= 0 ? "SIN_EXISTENCIA" : minimo > 0 && existencia < minimo ? "BAJO_MINIMO" : "EN_NIVEL";
    const lotes = i.lotes.map((l) => {
      const { dias, estado: estadoL } = estadoLote(l.caducidad);
      const existenciaL = r2(Number(l.existencia));
      const costoL = Number(l.costoUnitario);
      return {
        id: l.id,
        lote: l.lote,
        almacen: l.almacen,
        caducidad: l.caducidad,
        existencia: existenciaL,
        costoUnitario: costoL,
        valor: r2(existenciaL * costoL),
        recibidoAt: l.recibidoAt,
        invoiceId: l.invoiceId,
        diasParaCaducar: dias,
        estado: estadoL, bloqueado: l.bloqueado, bloqueoMotivo: l.bloqueoMotivo,
      };
    });
    const banderas = banderasControl(i.grupoControl);
    return {
      id: i.id,
      clave: i.clave,
      nombre: i.nombre,
      presentacion: i.presentacion,
      unidad: i.unidad,
      categoria: i.categoria,
      controlado: i.controlado,
      grupoControl: i.grupoControl,
      sustanciaActiva: i.sustanciaActiva,
      registroSanitario: i.registroSanitario,
      requiereRefrigeracion: i.requiereRefrigeracion,
      ...banderas,
      minimo,
      existencia,
      ultimoCosto,
      precioVenta: i.precioVenta == null ? null : Number(i.precioVenta),
      precioFijo: i.precioFijo,
      valor: r2(existencia * (ultimoCosto ?? 0)),
      ivaTasa: i.ivaTasa == null ? null : Number(i.ivaTasa),
      claveProdServ: i.claveProdServ,
      derivadoDeCfdi: i.derivadoDeCfdi,
      origen: origenPorId.get(i.id)!,
      // Desglose por almacén (sólo sin filtro de almacén: con filtro ya es uno).
      porAlmacen: almacen ? null : Object.fromEntries(almacenDe.get(i.id) ?? []),
      activo: i.activo,
      estado,
      // Bajo mínimo incluye el que ya no tiene nada: es el más urgente de pedir.
      bajoMinimo: minimo > 0 && existencia < minimo,
      lotesPorCaducar: lotes.filter((l) => l.estado !== "EN_NIVEL").length,
      lotes,
    };
  });

  const cumple: Record<Tab, (i: (typeof insumos)[number]) => boolean> = {
    TODOS: () => true,
    BAJO_MINIMO: (i) => i.bajoMinimo,
    POR_CADUCAR: (i) => i.lotesPorCaducar > 0,
    CONTROLADOS: (i) => i.controlado || i.exigeLibroControl,
    SIN_EXISTENCIA: (i) => i.estado === "SIN_EXISTENCIA",
  };
  const porTab = Object.fromEntries(TABS.map((t) => [t, insumos.filter(cumple[t]).length])) as Record<Tab, number>;

  const lotesCaduca = insumos.flatMap((i) => i.lotes.filter((l) => l.estado === "CADUCA"));
  const lotesCaducados = insumos.flatMap((i) => i.lotes.filter((l) => l.estado === "CADUCADO"));

  return NextResponse.json({
    hoy: hoy.toISOString(),
    tab,
    q: q || null,
    filtros: { controlados: soloControlados, refrigeracion: soloRefrigeracion, grupo, origen, almacen },
    almacenes,
    porOrigen,
    kpis: {
      valorInventario: r2(insumos.reduce((s, i) => s + i.valor, 0)),
      claves: insumos.length,
      clavesBajoMinimo: porTab.BAJO_MINIMO,
      clavesSinExistencia: porTab.SIN_EXISTENCIA,
      clavesControladas: porTab.CONTROLADOS,
      clavesRefrigeracion: insumos.filter((i) => i.requiereRefrigeracion).length,
      lotesPorCaducar: lotesCaduca.length,
      valorEnRiesgo: r2(lotesCaduca.reduce((s, l) => s + l.valor, 0)),
      lotesCaducados: lotesCaducados.length,
      valorCaducado: r2(lotesCaducados.reduce((s, l) => s + l.valor, 0)),
      diasAlerta,
    },
    porTab,
    insumos: insumos.filter(cumple[tab]),
  });
});

const CATEGORIAS = ["MEDICAMENTO", "MATERIAL_CURACION", "SOLUCION", "EQUIPO", "REACTIVO", "OTRO"] as const;

const createSchema = z.object({
  companyId: z.string().min(1),
  clave: z.string().trim().min(1).max(40).optional(),
  nombre: z.string().trim().min(1).max(200),
  presentacion: z.string().trim().max(120).nullable().optional(),
  unidad: z.string().trim().min(1).max(30).default("pieza"),
  categoria: z.enum(CATEGORIAS).default("MEDICAMENTO"),
  controlado: z.boolean().optional(),
  grupoControl: z.enum(GRUPOS).nullable().optional(),
  registroSanitario: z.string().trim().max(60).nullable().optional(),
  sustanciaActiva: z.string().trim().max(120).nullable().optional(),
  requiereRefrigeracion: z.boolean().default(false),
  minimo: z.number().min(0).max(1_000_000).default(0),
  precioVenta: z.number().min(0).nullable().optional(),
  ultimoCosto: z.number().min(0).nullable().optional(),
  ivaTasa: z.number().min(0).max(1).nullable().optional(),
  claveProdServ: z.string().trim().max(10).nullable().optional(),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Datos inválidos";
    return NextResponse.json({ error: first }, { status: 400 });
  }
  const { companyId, clave: claveDada, ...datos } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  // Sin clave explícita, la misma llave que usaría la derivación desde CFDI
  // (descripción normalizada): así una compra posterior empata con lo capturado.
  const clave = claveDada ? claveDada.toUpperCase() : claveDeInsumo(null, datos.nombre);
  if (!clave) return NextResponse.json({ error: "No se pudo formar una clave con ese nombre" }, { status: 400 });

  const existente = await prisma.hospInsumo.findUnique({
    where: { companyId_clave: { companyId, clave } },
    select: { id: true, nombre: true },
  });
  if (existente) {
    return NextResponse.json(
      { error: `Ya existe un insumo con la clave ${clave} (${existente.nombre})`, insumoId: existente.id },
      { status: 409 }
    );
  }

  // Grupo de control: el que venga; si no viene, la propuesta por nombre (el
  // responsable sanitario la confirma). Un grupo I-III marca `controlado`.
  const propuesta = datos.grupoControl === undefined ? sustanciaControladaPorNombre(datos.nombre) : null;
  const grupoControl = datos.grupoControl !== undefined ? datos.grupoControl : (propuesta?.grupo ?? null);
  const sustanciaActiva = datos.sustanciaActiva !== undefined ? datos.sustanciaActiva : (propuesta?.sustancia ?? null);
  const controlado = datos.controlado ?? exigeLibroControl(grupoControl);

  let insumo = await prisma.hospInsumo.create({
    data: {
      companyId,
      clave,
      nombre: datos.nombre,
      presentacion: datos.presentacion ?? null,
      unidad: datos.unidad,
      categoria: datos.categoria,
      controlado,
      grupoControl,
      sustanciaActiva,
      registroSanitario: datos.registroSanitario ?? null,
      requiereRefrigeracion: datos.requiereRefrigeracion,
      minimo: datos.minimo,
      precioVenta: datos.precioVenta ?? null,
      // Capturado a mano al dar de alta: la tabla de factores no lo mueve.
      precioFijo: datos.precioVenta != null,
      ultimoCosto: datos.ultimoCosto ?? null,
      // Sin tasa explícita: medicinas y soluciones a 0 %, lo demás al 16 %.
      ivaTasa:
        datos.ivaTasa !== undefined
          ? datos.ivaTasa
          : datos.categoria === "MEDICAMENTO" || datos.categoria === "SOLUCION"
            ? 0
            : 0.16,
      claveProdServ: datos.claveProdServ ?? null,
      derivadoDeCfdi: false,
    },
  });
  // Sin precio capturado pero con costo: el de la tabla de factores, si la hay.
  if (datos.precioVenta == null && datos.ultimoCosto != null && (await precioAlEntrar(prisma, companyId, insumo.id, datos.ultimoCosto)) != null) {
    insumo = await prisma.hospInsumo.findUniqueOrThrow({ where: { id: insumo.id } });
  }

  registrarBitacora({
    companyId,
    userId: user.id,
    actorEmail: user.email,
    accion: "hospital.insumo.crear",
    entidad: "HospInsumo",
    entidadId: insumo.id,
    detalle: { clave, nombre: datos.nombre, categoria: datos.categoria, controlado, grupoControl, grupoControlPropuesto: propuesta != null },
    req,
  });

  return NextResponse.json(
    {
      ...insumo,
      ...banderasControl(insumo.grupoControl),
      grupoControlPropuesto: propuesta != null,
      minimo: Number(insumo.minimo),
      precioVenta: insumo.precioVenta == null ? null : Number(insumo.precioVenta),
      ultimoCosto: insumo.ultimoCosto == null ? null : Number(insumo.ultimoCosto),
      ivaTasa: insumo.ivaTasa == null ? null : Number(insumo.ivaTasa),
      existencia: 0,
      estado: "SIN_EXISTENCIA",
      lotes: [],
    },
    { status: 201 }
  );
});
