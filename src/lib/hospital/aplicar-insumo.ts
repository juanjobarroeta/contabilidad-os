// ─────────────────────────────────────────────────────────────────────────────
// Aplicar un insumo a un paciente: «lo aplicado sale con su lote».
//
// Una sola transacción deja tres huellas amarradas entre sí:
//   1. HospMovimientoInsumo SALIDA_APLICACION (kardex, cantidad negativa) y
//      el lote con menos existencia,
//   2. HospCargo FARMACIA en la cuenta del episodio (precio de venta del
//      insumo o, si no tiene, el costo del lote), ligado al lote,
//   3. HospNota MEDICAMENTO_APLICADO en el expediente, ligada al cargo.
// Así la conciliación expediente ↔ cuenta (lámina 17) sale sola: el cargo
// tiene nota y la nota tiene cargo.
//
// FEFO: sin `loteId` se toma el lote que caduca primero con existencia; los
// sin caducidad al final. v1 NO parte una aplicación entre lotes: si el lote
// no cubre la cantidad, 409 y que el piso aplique en dos movimientos.
//
// Controlados (LGS arts. 234/245): si el grupo del insumo lleva libro de
// control (I-III), la salida sólo se registra con la receta que la ampara
// (`recetaRef`: folio de la receta especial en I-II, de la ordinaria retenida
// en III) y con el prescriptor —nombre y cédula— que sale del médico
// (`medicoId`) o llega explícito. Queda en el movimiento del kardex, que es
// de donde se imprime el libro (GET /farmacia/libro-control).
//
// IVA por contexto (criterio 9/IVA/N): el cargo nace con `ivaContexto` —
// SUMINISTRO_HOSPITALARIO en hospitalización, ambulatorio y urgencias (tasa
// de HospConfig.ivaMedicinasHospitalizacion), VENTA_DIRECTA en consulta o
// cuando se pide (tasa del insumo)— y con la tasa ya resuelta (ver cuenta.ts).
// ─────────────────────────────────────────────────────────────────────────────

import type { HospIvaContexto, PrismaClient } from "@prisma/client";
import { HospitalError } from "./errores";
import { esActivo, r2 } from "./util";
import { exigeLibroControl, nombreReceta } from "./controlados";
import { ivaContextoPorEpisodio, ivaTasaPorContexto } from "./cuenta";

export interface AplicarInsumoArgs {
  companyId: string;
  episodioId: string;
  insumoId: string;
  loteId?: string | null;
  cantidad: number;
  usuarioId?: string | null;
  usuarioNombre: string;
  nota?: string | null;
  fecha?: Date;
  medicoId?: string | null;
  /** Receta o indicación que ampara la salida. Obligatoria si el insumo es controlado I-III. */
  recetaRef?: string | null;
  /** Prescriptor; si falta se toma del médico (`medicoId`). Obligatorios en controlados I-III. */
  prescriptorNombre?: string | null;
  prescriptorCedula?: string | null;
  /** Contexto de IVA del cargo; sin él lo decide el tipo de episodio. */
  contexto?: HospIvaContexto | null;
}

/** Un folio de receta con menos de esto no identifica nada. */
const RECETA_MIN = 3;

const formatearCantidad = (n: number) => (Number.isInteger(n) ? String(n) : String(r2(n)));
const limpiar = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim();
  return t ? t : null;
};

export async function aplicarInsumo(db: PrismaClient, args: AplicarInsumoArgs) {
  const cantidad = Number(args.cantidad);
  if (!(cantidad > 0)) throw new HospitalError(400, "La cantidad debe ser mayor que cero");
  const fecha = args.fecha ?? new Date();

  return db.$transaction(async (tx) => {
    const [episodio, insumo, config, medico] = await Promise.all([
      tx.hospEpisodio.findUnique({ where: { id: args.episodioId }, select: { id: true, companyId: true, estado: true, folio: true, tipo: true } }),
      tx.hospInsumo.findUnique({
        where: { id: args.insumoId },
        select: { id: true, companyId: true, nombre: true, unidad: true, categoria: true, precioVenta: true, ivaTasa: true, activo: true, grupoControl: true },
      }),
      tx.hospConfig.findUnique({ where: { companyId: args.companyId }, select: { ivaMedicinasHospitalizacion: true } }),
      args.medicoId
        ? tx.hospMedico.findUnique({ where: { id: args.medicoId }, select: { id: true, companyId: true, nombre: true, cedula: true } })
        : Promise.resolve(null),
    ]);
    if (!episodio || episodio.companyId !== args.companyId) throw new HospitalError(404, "Episodio no encontrado");
    if (!esActivo(episodio.estado)) {
      throw new HospitalError(409, `El episodio ${episodio.folio} está ${episodio.estado === "ALTA" ? "dado de alta" : "cancelado"}: no se aplican insumos`);
    }
    if (!insumo || insumo.companyId !== args.companyId) throw new HospitalError(404, "Insumo no encontrado");
    if (!insumo.activo) throw new HospitalError(409, `El insumo ${insumo.nombre} está dado de baja`);
    if (args.medicoId && (!medico || medico.companyId !== args.companyId)) throw new HospitalError(404, "Médico no encontrado");

    // Controlados: la salida se ampara con receta y prescriptor identificado.
    const grupo = insumo.grupoControl;
    const recetaRef = limpiar(args.recetaRef);
    const prescriptorNombre = limpiar(args.prescriptorNombre) ?? limpiar(medico?.nombre);
    const prescriptorCedula = limpiar(args.prescriptorCedula) ?? limpiar(medico?.cedula);
    if (exigeLibroControl(grupo)) {
      const quien = `${insumo.nombre} es controlado (grupo ${grupo})`;
      if (!recetaRef) {
        throw new HospitalError(400, `${quien}: indica el folio de la ${nombreReceta(grupo)} que ampara la salida (recetaRef)`);
      }
      if (recetaRef.length < RECETA_MIN) throw new HospitalError(400, `${quien}: el folio de la receta es demasiado corto`);
      if (!prescriptorNombre) throw new HospitalError(400, `${quien}: indica el médico que prescribe (medicoId o prescriptorNombre)`);
      if (!prescriptorCedula) {
        throw new HospitalError(
          medico ? 409 : 400,
          medico
            ? `${quien}: el médico ${medico.nombre} no tiene cédula profesional registrada; captúrala en Médicos o indica prescriptorCedula`
            : `${quien}: falta la cédula profesional del prescriptor (prescriptorCedula)`
        );
      }
    }

    // El lote: el indicado, o el primero en caducar (FEFO) con existencia.
    const lote = args.loteId
      ? await tx.hospLote.findUnique({ where: { id: args.loteId } })
      : await tx.hospLote.findFirst({
          where: { insumoId: insumo.id, existencia: { gt: 0 } },
          orderBy: [{ caducidad: { sort: "asc", nulls: "last" } }, { recibidoAt: "asc" }],
        });
    if (!lote || lote.insumoId !== insumo.id || lote.companyId !== args.companyId) {
      throw new HospitalError(
        args.loteId ? 404 : 409,
        args.loteId ? "Lote no encontrado para ese insumo" : `${insumo.nombre}: sin existencia en farmacia`
      );
    }
    const existencia = Number(lote.existencia);
    if (existencia < cantidad) {
      throw new HospitalError(
        409,
        `El lote ${lote.lote} de ${insumo.nombre} sólo tiene ${formatearCantidad(existencia)} ${insumo.unidad}; ` +
          `una aplicación no se parte entre lotes — aplica ${formatearCantidad(existencia)} y el resto de otro lote`
      );
    }

    // Descuento atómico: si otra aplicación se adelantó y ya no alcanza, el
    // WHERE no coincide y no se descuenta de más.
    const descontado = await tx.hospLote.updateMany({
      where: { id: lote.id, existencia: { gte: cantidad } },
      data: { existencia: { decrement: cantidad } },
    });
    if (descontado.count !== 1) {
      throw new HospitalError(409, `El lote ${lote.lote} ya no tiene existencia suficiente (otra aplicación se adelantó)`);
    }

    const costoUnitario = Number(lote.costoUnitario);
    const precioUnitario = r2(Number(insumo.precioVenta ?? costoUnitario));
    const categoria = insumo.categoria === "MEDICAMENTO" || insumo.categoria === "SOLUCION" ? "FARMACIA" : "MATERIAL";
    const etiqueta = `${insumo.nombre} · lote ${lote.lote} · ${formatearCantidad(cantidad)} ${insumo.unidad}`;

    // IVA por contexto: suministro (tasa de la config) o venta directa (tasa del insumo).
    const ivaContexto: HospIvaContexto = args.contexto ?? ivaContextoPorEpisodio(episodio.tipo);
    const ivaTasa = ivaTasaPorContexto({
      contexto: ivaContexto,
      categoria,
      ivaTasaInsumo: insumo.ivaTasa == null ? null : Number(insumo.ivaTasa),
      ivaMedicinasHospitalizacion: config?.ivaMedicinasHospitalizacion == null ? null : Number(config.ivaMedicinasHospitalizacion),
    });

    const cargo = await tx.hospCargo.create({
      data: {
        companyId: args.companyId,
        episodioId: episodio.id,
        fecha,
        categoria,
        descripcion: etiqueta,
        cantidad,
        precioUnitario,
        ivaTasa,
        ivaContexto,
        importe: r2(cantidad * precioUnitario),
        origen: "FARMACIA",
        loteId: lote.id,
        medicoId: args.medicoId ?? null,
        creadoPorUserId: args.usuarioId ?? null,
      },
    });

    const movimiento = await tx.hospMovimientoInsumo.create({
      data: {
        companyId: args.companyId,
        insumoId: insumo.id,
        loteId: lote.id,
        tipo: "SALIDA_APLICACION",
        cantidad: -cantidad,
        costoUnitario,
        fecha,
        episodioId: episodio.id,
        cargoId: cargo.id,
        usuarioId: args.usuarioId ?? null,
        usuarioNombre: args.usuarioNombre,
        recetaRef,
        prescriptorNombre,
        prescriptorCedula,
      },
    });

    const amparo = recetaRef
      ? ` Receta ${recetaRef}${prescriptorNombre ? ` · prescribe ${prescriptorNombre}${prescriptorCedula ? ` (céd. ${prescriptorCedula})` : ""}` : ""}.`
      : "";
    const texto =
      `${etiqueta} — descontado de farmacia y cargado a la cuenta.${amparo}` + (args.nota?.trim() ? ` ${args.nota.trim()}` : "");
    const nota = await tx.hospNota.create({
      data: {
        episodioId: episodio.id,
        tipo: "MEDICAMENTO_APLICADO",
        fecha,
        texto,
        autorUserId: args.usuarioId ?? null,
        autorNombre: args.usuarioNombre,
        medicoId: args.medicoId ?? null,
        cargoId: cargo.id,
      },
    });

    const loteActualizado = await tx.hospLote.findUniqueOrThrow({ where: { id: lote.id } });
    return { cargo, movimiento, nota, lote: loteActualizado };
  });
}
