import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { cerrarFaltante, cerrarLineas, crearSolicitudArea, lineasArea, marcarPedidoEnviado, requisicionarLineas } from "./bandeja-compras";
import { aprobarRequisicion, cancelarRequisicion, recibirManual } from "./requisiciones";

const skip = process.env.DB_TESTS_SKIP === "1";

describe.skipIf(skip)("bandeja de compras: del área al pedido y lo que no surtieron", () => {
  let companyId = "";
  let proveedorA = "";
  let proveedorB = "";
  const compras = "u-compras";
  const director = "u-director";

  beforeAll(async () => {
    const c = await prisma.company.create({
      data: { rfc: `BAN${Date.now() % 1000000}AA1`, razonSocial: "Hospital bandeja iTest", regimenFiscal: "601", codigoPostal: "72000" },
    });
    companyId = c.id;
    proveedorA = (await prisma.supplier.create({ data: { companyId, rfc: "PRA010101AA1", razonSocial: "PROVEEDOR A" } })).id;
    proveedorB = (await prisma.supplier.create({ data: { companyId, rfc: "PRB010101AA1", razonSocial: "PROVEEDOR B" } })).id;
  });

  afterAll(async () => {
    await prisma.hospSolicitudArea.deleteMany({ where: { companyId } });
    await prisma.solicitudAdjudicacion.deleteMany({ where: { companyId } });
    await prisma.solicitudCotizacionPartida.deleteMany({ where: { cotizacion: { solicitud: { companyId } } } });
    await prisma.solicitudCompra.deleteMany({ where: { companyId } });
    await prisma.supplier.deleteMany({ where: { companyId } });
    await prisma.company.delete({ where: { id: companyId } });
    await prisma.$disconnect();
  });

  const bandeja = () => lineasArea(prisma, companyId, { soloBandeja: true });

  it("el área pide sin proveedor y cae en la bandeja con su urgencia", async () => {
    const s = await crearSolicitudArea(companyId, { id: "u-area", nombre: "Enfermería" }, {
      area: "Hospitalización",
      urgencia: "SEMIURGENTE",
      lineas: [
        { descripcion: "Guantes de látex caja", unidad: "caja", cantidad: 10 },
        { descripcion: "Cubrebocas tricapa", unidad: "caja", cantidad: 4, urgencia: "URGENTE" },
      ],
    });
    expect(s.folio).toMatch(/^SA-\d{4}-0001$/);
    const b = await bandeja();
    expect(b.map((l) => [l.descripcion, l.urgencia, l.estado])).toEqual([
      ["Cubrebocas tricapa", "URGENTE", "EN_BANDEJA"],
      ["Guantes de látex caja", "SEMIURGENTE", "EN_BANDEJA"],
    ]);
  });

  it("compras arma la requisición; si se cancela, las líneas regresan a la bandeja", async () => {
    const b = await bandeja();
    const [r] = await requisicionarLineas(companyId, compras, [
      { supplierId: proveedorA, lineas: b.map((l) => ({ lineaId: l.id, cantidad: l.cantidad, precioUnitario: 100 })) },
    ]);
    expect(await bandeja()).toHaveLength(0);
    const todas = await lineasArea(prisma, companyId, {});
    expect(todas.every((l) => l.estado === "POR_AUTORIZAR" && l.requisicion?.folio === r.folio)).toBe(true);
    // Dos compradores no se llevan la misma línea.
    await expect(requisicionarLineas(companyId, compras, [{ supplierId: proveedorB, lineas: [{ lineaId: b[0].id, cantidad: 1, precioUnitario: 1 }] }])).rejects.toThrow(/otra requisición/);

    await cancelarRequisicion(r.id, companyId);
    expect(await bandeja()).toHaveLength(2);
  });

  it("autorizada, pedida y con faltante: la orden se cierra en lo recibido y lo demás regresa", async () => {
    const b = await bandeja();
    const guantes = b.find((l) => l.descripcion.startsWith("Guantes"))!;
    const cubrebocas = b.find((l) => l.descripcion.startsWith("Cubrebocas"))!;
    const [r] = await requisicionarLineas(companyId, compras, [
      { supplierId: proveedorA, lineas: [{ lineaId: guantes.id, cantidad: 10, precioUnitario: 50 }, { lineaId: cubrebocas.id, cantidad: 4, precioUnitario: 80 }] },
    ]);
    await aprobarRequisicion(r.id, companyId, director);
    await marcarPedidoEnviado(r.id, companyId, compras, "WHATSAPP");
    let todas = await lineasArea(prisma, companyId, {});
    expect(todas.find((l) => l.id === guantes.id)?.estado).toBe("PEDIDA");

    const partidaGuantes = todas.find((l) => l.id === guantes.id)!.partida!.id;
    await recibirManual(partidaGuantes, companyId, 6);
    todas = await lineasArea(prisma, companyId, {});
    expect(todas.find((l) => l.id === guantes.id)?.estado).toBe("PARCIAL");

    const f = await cerrarFaltante(partidaGuantes, companyId, compras, "REENVIAR", "sólo traía 6");
    expect(f).toMatchObject({ falta: 4, ordenCancelada: false });
    const partida = await prisma.solicitudPartida.findUniqueOrThrow({ where: { id: partidaGuantes } });
    expect([Number(partida.cantidad), Number(partida.importe)]).toEqual([6, 300]);
    const orden = await prisma.solicitudAdjudicacion.findFirstOrThrow({ where: { solicitudId: r.id } });
    expect(Number(orden.total)).toBe(620); // 6×50 + 4×80

    const [regreso] = await bandeja();
    expect(regreso).toMatchObject({ id: guantes.id, cantidad: 4, surtidoPrevio: 6, intentos: 1, proveedoresIntentados: ["PROVEEDOR A"] });
  });

  it("lo que no se consigue se cierra por desabasto y sale de la bandeja", async () => {
    const [l] = await bandeja();
    await cerrarLineas(companyId, compras, [l.id], "DESABASTO", "sin existencia con ningún distribuidor");
    expect(await bandeja()).toHaveLength(0);
    const todas = await lineasArea(prisma, companyId, {});
    expect(todas.find((x) => x.id === l.id)?.estado).toBe("DESABASTO");
  });

  it("faltante total de una orden de una sola línea: la requisición se cancela", async () => {
    const s = await crearSolicitudArea(companyId, { id: "u-area", nombre: null }, { area: "Quirófano", lineas: [{ descripcion: "Sutura vicryl", cantidad: 2 }] });
    const linea = (await bandeja()).find((x) => x.solicitud.folio === s.folio)!;
    const [r] = await requisicionarLineas(companyId, compras, [{ supplierId: proveedorB, lineas: [{ lineaId: linea.id, cantidad: 2, precioUnitario: 300 }] }]);
    await aprobarRequisicion(r.id, companyId, director);
    const partidaId = (await prisma.solicitudPartida.findFirstOrThrow({ where: { solicitudId: r.id } })).id;
    const f = await cerrarFaltante(partidaId, companyId, compras, "REENVIAR", "");
    expect(f.ordenCancelada).toBe(true);
    expect((await prisma.solicitudCompra.findUniqueOrThrow({ where: { id: r.id } })).estado).toBe("CANCELADA");
    expect((await bandeja()).map((x) => x.id)).toContain(linea.id);
  });
});
